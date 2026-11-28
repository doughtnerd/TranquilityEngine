#!/usr/bin/env node
// `npm run build:audio` (ADR 0157, api-and-models §5): compiles native/audio to WebAssembly and writes
// myco_audio.wasm, the decoder (myco_audio_decode.wasm, and myco_audio_decode_aac.wasm with
// AAC, B4) and hash.json to src/plugins/audio/runtime/wasm/, which is
// committed, so the engine builds without Rust. Modelled on native/nav/build.mjs, without
// wasm-bindgen: the core's exports are plain `extern "C"` functions over imported memory.
// From C1b it also writes the metered test wasm (tools/audio-bench/metered/), which CI's cost gate runs; it is never
// shipped and not size-gated.
// Audio Studio W9 (ADR 0342): also the offline sample render, myco_audio_offline.wasm, into src/engine/audio/sample/wasm/
// (its own module: the mixer's size and ABI are untouched; it embeds the same source hash).
// ADR 0351 A2 (amended by 0359): also the encoder, myco_audio_encode.wasm, a wasm32-wasip1 reactor with libvorbis, libogg
// and libopus, into src/export/wasm/ (editor, Studio and export only; never in a game build). It needs wasi-sdk's clang
// (README "The encoder"); without it the step is skipped and the committed encoder is kept, unless its sources changed.
// Needs the toolchain pinned in rust-toolchain.toml and `rustup target add wasm32-unknown-unknown`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { meter, METER_VERSION } from "../../src/engine/wasm/meter.js";
import { wasmBuildEnv } from "../rustflags.mjs";
import { encoderSourceHash } from "./crates/audio-encode/sourceHash.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/plugins/audio/runtime/wasm/", import.meta.url));
/** The metered build's directory (C1b): test-only, beside the gate that runs it. */
const meteredOut = fileURLToPath(new URL("../../tools/audio-bench/metered/", import.meta.url));
/** The offline sample render's directory (ADR 0342): an engine module (`src/engine/audio/sample/sampleRender.ts`) loads it. */
const offlineOut = fileURLToPath(new URL("../../src/engine/audio/sample/wasm/", import.meta.url));
/** The encoder's directory (ADR 0351 A2): `src/export/audioEncoder*.ts` load it. */
const encodeOut = fileURLToPath(new URL("../../src/export/wasm/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
/** The encoder's target (ADR 0351 §4): the C libraries need a libc. */
const ENCODE_TARGET = "wasm32-wasip1";
/** The wasi-sdk release the encoder is built with (README "The encoder"). */
const WASI_SDK_VERSION = "25.0";
/**
 * The mixer's size tripwire (ADR 0158 amends 0157): a guard against accidental bloat, not a design constraint; raise it
 * with a line in the build log saying why. 320 KB since ADR 0162 M3 (2026-11-12, owner): beds, zones, ambisonic voices
 * and sends took the mixer to ≈ 260 KB, past the 256 KB set before any of them existed. 360 KB since ADR 0171/0172 M5
 * (2026-11-13, W0; design R25, `docs/design/0171-audio-mix/build-log.md`): loudness, lanes, sidechain, the bus order,
 * sends and the reverb run-out project ≈ 347–351 KB from 319,799 B, and only ≈ 7.9 KB were left under 320 KB.
 * 400 KB since M5 W2 (2026-11-13, owner): after the lanes, the per-slot configuration queue and the CPU counters the
 * mixer is 341,168 B (95% of 360 KB), ≈ 15 KB above the design's projection, with loudness (≈ 21 KB) still to come.
 * 512 KB since Audio Studio W6-A (2026-11-22): the mixer was 396,409 B of 400 KB with ADR 0345's instance submixes and
 * effect catalogue DSP still to come.
 * W12 (2026-11-22): ADR 0351's ADPCM voices (4.12) and ADR 0352's plugin effects (5.0: 16-parameter records, `ext.rs`,
 * the plugin slot path, +3.6 KB) take it to 501,602 B; still under, so the gate stays (raise it with a reason when it bites).
 * 576 KB since W14 G2 (2026-11-22; ADR 0360 §3 foresaw the raise): the sound generators (5.1: `audio_dsp::gen`'s PolyBLEP
 * and PolyBLAMP oscillators, noise colours, TPT SVF, ADSRs, LFO and the sfxr blip kernel, each oscillator and synth loop
 * monomorphised per waveform, plus `generator.rs` and the render branch) take the mixer to 538,902 B, +37,300 B (the
 * record estimated 10-15 KB). Not traded for speed or quality: the per-waveform loops keep the per-sample dispatch out.
 */
// 640 KB since the blip-cost and quality task (2026-11-23, owner decision D67, ADR 0360): from 542,629 B (ABI 6.0) to
// ≈ 589 KB, ≈ +46 KB: the blip kernel monomorphised per waveform and low-pass (its fused loop took it from 2.38× to
// 1.47× a sample voice), the `quality` parameter's `high` loops (16-tap minBLEP) for the oscillator, synth and blip, and
// the minBLEP tables (4.2 KB). Not traded for CPU: the per-waveform loops are what keep the blip under 0360's 1.5×.
const MIXER_LIMIT = 640 * 1024;
/** ADR 0162 (api-and-models §5.2): M3's mixer warning, under the gate: a build past it warns but passes. */
const MIXER_WARN = 300 * 1024;
/** The decoder's size tripwire (M1b: 900 KB). 1,000 KB since ADR 0359 §4 (2026-11-22, A7): libopus (fixed point, no
 *  imports) joins every game's decoder for Ogg Opus, +173.5 KB measured by the A0 spike (≈ 978–993 KB projected with
 *  symphonia's `adpcm` for imported WAV IMA sources), and no pure-Rust Opus decoder is mature enough to save it.
 *  1,056 KB since the merge with master (2026-11-23): master's ADR 0331 moved the HRIR and MagLS preparation into the
 *  decoder (`spatial.rs`, +17.5 KB measured on master), which took the Studio's 1,006,855 B decoder to 1,024,411 B, 411 B
 *  over; the preparation was main-thread TypeScript before, so this is wanted growth, not bloat (build log, merge). */
const DECODER_LIMIT = 1056 * 1024;
/** The AAC decoder build's own tripwire (B4; raised 1,100 -> 1,280 KB in M2 by the owner, 2026-11-10: gates are a signal to
 *  look for bloat, and M2's loop points are wanted growth). 1,350 KB since ADR 0359 §4 (A7): the AAC build gets libopus too
 *  (+173.5 KB; the spike projected ≈ 1,317 KB with `adpcm`, over 1,280). It ships beside the default decoder and is fetched
 *  only when a project sets `audio.codecs.aac`. */
const DECODER_AAC_LIMIT = 1350 * 1024;

/** The offline render's size tripwire (Audio Studio W9, 2026-11-22): the kernels, the curve evaluator and the spectral
 *  gate, ≈ 120 KB when it was written. It is fetched only by the Studio and the export's render, never by a game. */
const OFFLINE_LIMIT = 256 * 1024;
/** The encoder's size tripwire (ADR 0359 §1): 1.75 MB. The A0 spike measured 1,483,882 B with every codec and SIMD; the
 *  1.5 MB of ADR 0351 was an estimate, and per CLAUDE.md a tripwire is raised with a reason rather than trading speed
 *  (`-Os` would save ≈ 270 KB at the cost of SIMD resampling). Fetched only by the editor, the Studio and the export. */
const ENCODER_LIMIT = 1792 * 1024;
/** Only +simd128 here: --import-memory and the 256 KB stack are link args in audio-wasm's build.rs. Every wasm build
 *  passes them through `wasmBuildEnv` (../rustflags.mjs), which adds the path remapping that makes the wasm the same
 *  from any checkout (ADR 0432): the repository root becomes `/myco`, CARGO_HOME `/cargo` (symphonia's and libm's panic
 *  locations name registry sources, the mixer's native/common). */
const WASM_RUSTFLAGS = ["-C", "target-feature=+simd128"];
/** Pages of the Memory the hash read instantiates the wasm with (enough for its data and stack). */
const READ_MEMORY_PAGES = 64;

/** Runs `cmd args` in native/audio with inherited stdio, in `env` (this process's by default). */
function run(cmd, args, env = process.env) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
  } catch {
    console.error(`[build:audio] \`${cmd} ${args.join(" ")}\` failed; the output above says why.`);
    process.exit(1);
  }
}

/** Fails with a fix-it message unless cargo runs and the wasm32 target is installed. */
function checkToolchain() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("[build:audio] cargo is not on PATH. Install Rust via rustup (https://rustup.rs), then reopen the shell.");
    process.exit(1);
  }
  let installed = null;
  try {
    installed = execFileSync("rustup", ["target", "list", "--installed"], { cwd: root, encoding: "utf8" });
  } catch {
    // rustup is absent (e.g. a non-rustup toolchain): the target check is skipped, cargo reports any gap.
  }
  if (installed !== null && !installed.split(/\r?\n/).map((line) => line.trim()).includes(TARGET)) {
    console.error(`[build:audio] the ${TARGET} target is not installed. Run: rustup target add ${TARGET}`);
    process.exit(1);
  }
  console.log("[build:audio] toolchain ok");
}

/** Runs audio-wire's generator, or logs a skip while crates/audio-wire doesn't exist yet. */
function genWire() {
  if (!existsSync(fileURLToPath(new URL("crates/audio-wire/Cargo.toml", import.meta.url)))) {
    console.log("[build:audio] crates/audio-wire absent, skipping gen_wire");
    return;
  }
  run("cargo", ["run", "-p", "audio-wire", "--bin", "gen_wire"]);
}

/** Builds audio-wasm for wasm32 in release; returns the built .wasm's path. */
function buildWasm() {
  const args = ["build", "-p", "audio-wasm", "--target", TARGET, "--release"];
  run("cargo", args, wasmBuildEnv(WASM_RUSTFLAGS));
  return fileURLToPath(new URL(`target/${TARGET}/release/myco_audio.wasm`, import.meta.url));
}

/** Builds audio-decode (M1b) for wasm32 in release; returns the built .wasm's path. Its build.rs
 *  adds `--strip-all`; memory is exported (the decoder runs alone in a worker). */
function buildDecoder({ aac }) {
  const args = ["build", "-p", "audio-decode", "--target", TARGET, "--release"];
  // B4: the AAC build has its own target directory, so the two builds don't rebuild each other.
  if (aac) args.push("--features", "aac", "--target-dir", "target/aac");
  run("cargo", args, wasmBuildEnv(WASM_RUSTFLAGS));
  return fileURLToPath(new URL(`${aac ? "target/aac" : "target"}/${TARGET}/release/myco_audio_decode.wasm`, import.meta.url));
}

/** Decodes four of audio-decode's fixtures with the built decoder wasm (FLAC, MP3, Ogg Vorbis, Ogg Opus; the AAC build also an
 *  M4A, trimmed to its source's length), checks each one's frame count, and returns the source hash the decoder
 *  embeds (hex). Exits 1 on a mismatch. */
function smokeDecoder(path, { aac, label }) {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {});
  const fixtures = fileURLToPath(new URL("crates/audio-decode/tests/fixtures/", import.meta.url));
  const cases = [
    ["tone-48000-stereo.flac", 2, 48000],
    ["tone-44100-mono.mp3", 3, 88200],
    ["tone-48000-stereo.ogg", 4, 48000],
    // ADR 0351 A7: Ogg Opus through libopus, the pre-skip and the end trimming honoured.
    ["tone-48000-stereo.opus", 4, 48000],
  ];
  if (aac) cases.push(["tone-48000-stereo.m4a", 5, 48000]);
  for (const [name, hint, frames] of cases) {
    const bytes = readFileSync(`${fixtures}${name}`);
    const p = x.myco_decode_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
    const h = x.myco_decode_open(p, bytes.length, hint);
    const chunk = 4096;
    const out = x.myco_decode_alloc(chunk * 2 * 4);
    let total = 0;
    while (h > 0) {
      const n = x.myco_decode_read_f32(h, out, chunk);
      if (n <= 0) break;
      total += n;
    }
    x.myco_decode_free(out, chunk * 2 * 4);
    if (h <= 0 || total !== frames || x.myco_decode_close(h) !== 0) {
      const message = Buffer.from(x.memory.buffer, x.myco_decode_error_ptr(), x.myco_decode_error_len()).toString();
      console.error(`[build:audio] ${label} decoded ${name} to ${total} frames, expected ${frames} (handle ${h}: ${message})`);
      process.exit(1);
    }
  }
  console.log(`[build:audio] ${label} decodes the FLAC, MP3, Ogg Vorbis, Ogg Opus${aac ? " and M4A" : ""} fixtures`);
  return Buffer.from(x.memory.buffer, x.myco_decode_source_hash(), 16).toString("hex");
}

/** Builds audio-offline (ADR 0342's offline render) for wasm32 in release; returns the built .wasm's path. Its build.rs
 *  adds `--strip-all`; memory is exported (the render runs alone). */
function buildOffline() {
  run("cargo", ["build", "-p", "audio-offline", "--target", TARGET, "--release"], wasmBuildEnv(WASM_RUSTFLAGS));
  return fileURLToPath(new URL(`target/${TARGET}/release/myco_audio_offline.wasm`, import.meta.url));
}

/** Renders a 10 ms stereo impulse through a 100 ms delay (no feedback, 50 % mix) with the built offline wasm, checks the
 *  echo lands 100 ms in, and returns the source hash it embeds (hex). Exits 1 on a mismatch. */
function smokeOffline(path) {
  // ABI 1.1 (ADR 0352 B5): plugin effects go through `myco_ext`; stubs with no plugins (`acquire` 0) bind it here.
  const myco_ext = { acquire: () => 0, release: () => {}, describe: () => 0, process: () => -1, sweep: () => {} };
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), { myco_ext });
  const rate = 48000, frames = 480, channels = 2;
  const pcm = x.myco_offline_alloc(frames * channels * 4);
  const input = new Float32Array(x.memory.buffer, pcm, frames * channels);
  input.fill(0);
  input[0] = input[1] = 1;
  // version 2, 1 effect, 0 lanes, 0 segments, tail cap 10 s; delay (catalogue index 14): 100 ms, 0 %, 50 % (16 parameters).
  const spec = [2, 1, 0, 0, 10, 14, 1, 100, 0, 50, ...new Array(13).fill(0)];
  const sp = x.myco_offline_alloc(spec.length * 8);
  new Float64Array(x.memory.buffer, sp, spec.length).set(spec);
  const h = x.myco_offline_render(pcm, frames, channels, rate, sp, spec.length);
  const n = h ? x.myco_offline_output_frames(h) : 0;
  const out = h ? new Float32Array(x.memory.buffer, x.myco_offline_output_pcm(h), n * channels) : new Float32Array(0);
  const echo = rate / 10;
  if (!h || n <= echo || Math.abs(out[echo * channels] - 0.5) > 0.01) {
    console.error(`[build:audio] myco_audio_offline.wasm rendered ${n} frames, echo ${out[echo * channels]} (want 0.5 at frame ${echo})`);
    process.exit(1);
  }
  x.myco_offline_output_free(h);
  console.log(`[build:audio] myco_audio_offline.wasm renders a delay's echo and tail (${n} frames)`);
  return Buffer.from(x.memory.buffer, x.myco_offline_source_hash(), 16).toString("hex");
}

/** wasi-sdk's root (it holds `bin/clang`), or null: `$WASI_SDK_PATH`, else `native/audio/target/wasi-sdk-<version>-*`
 *  (where the README's steps unpack it), else `/opt/wasi-sdk`. */
function findWasiSdk() {
  const exe = process.platform === "win32" ? "clang.exe" : "clang";
  const candidates = [];
  if (process.env.WASI_SDK_PATH) candidates.push(process.env.WASI_SDK_PATH);
  const local = fileURLToPath(new URL("target/", import.meta.url));
  try {
    for (const name of readdirSync(local)) if (name.startsWith(`wasi-sdk-${WASI_SDK_VERSION}-`)) candidates.push(join(local, name));
  } catch {
    // no target/ yet
  }
  candidates.push("/opt/wasi-sdk");
  return candidates.find((dir) => existsSync(join(dir, "bin", exe))) ?? null;
}

/** Whether rustup lists `target` as installed (true when rustup is absent: cargo reports any gap). */
function hasTarget(target) {
  try {
    const installed = execFileSync("rustup", ["target", "list", "--installed"], { cwd: root, encoding: "utf8" });
    return installed.split(/\r?\n/).map((line) => line.trim()).includes(target);
  } catch {
    return true;
  }
}

/** Builds audio-encode (ADR 0351 A2) for wasm32-wasip1 in release with wasi-sdk's clang at `sdk`; returns the built
 *  .wasm's path. +simd128 for Rust (here) and C (its build.rs; 0359 §1); paths are remapped as for the other modules. */
function buildEncoder(sdk) {
  const exe = process.platform === "win32" ? ".exe" : "";
  run("cargo", ["build", "-p", "audio-encode", "--lib", "--release", "--target", ENCODE_TARGET, "--target-dir", "target/encode"], {
    ...wasmBuildEnv(WASM_RUSTFLAGS),
    CC_wasm32_wasip1: join(sdk, "bin", `clang${exe}`),
    AR_wasm32_wasip1: join(sdk, "bin", `llvm-ar${exe}`),
  });
  return fileURLToPath(new URL(`target/encode/${ENCODE_TARGET}/release/myco_audio_encode.wasm`, import.meta.url));
}

/** The WASI imports the encoder may call (0359 §1), as stubs: no file descriptors, an empty environment. */
function wasiStubs(memory) {
  const view = () => new DataView(memory().buffer);
  return {
    wasi_snapshot_preview1: {
      fd_write: (_fd, iovs, count, written) => {
        const v = view();
        let n = 0;
        for (let i = 0; i < count; i++) n += v.getUint32(iovs + i * 8 + 4, true);
        v.setUint32(written, n, true);
        return 0;
      },
      random_get: (ptr, len) => {
        new Uint8Array(memory().buffer, ptr, len).fill(4);
        return 0;
      },
      clock_time_get: (_id, _precision, at) => {
        view().setBigUint64(at, BigInt(Math.round(performance.now() * 1e6)), true);
        return 0;
      },
      environ_sizes_get: (count, size) => {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      proc_exit: (code) => {
        throw new Error(`the encoder exited (${code})`);
      },
    },
  };
}

/** Instantiates an encoder wasm with the stubs (and runs `_initialize` when the module has it). */
function instantiateEncoder(path) {
  let x = null;
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), wasiStubs(() => x.memory));
  x = exports;
  x._initialize?.();
  return x;
}

/** Encodes one second of a stereo tone with the built encoder to each codec, checks each result's shape (the Vorbis one
 *  through `decoderPath`'s decoder to its exact frame count), and returns the encoder's source hash (hex). Exits 1 on a
 *  mismatch. */
function smokeEncoder(path, decoderPath) {
  const x = instantiateEncoder(path);
  const rate = 44100, frames = rate, channels = 2;
  const fail = (what) => {
    console.error(`[build:audio] myco_audio_encode.wasm: ${what}`);
    process.exit(1);
  };
  const encodeTo = (codec) => {
    const bytes = frames * channels * 4;
    const p = x.myco_encode_alloc(bytes);
    const pcm = new Float32Array(x.memory.buffer, p, frames * channels);
    for (let i = 0; i < frames; i++) pcm[i * 2] = pcm[i * 2 + 1] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    const r = x.myco_encode_run(p, frames, channels, rate, codec, 0.4, 0, 0);
    x.myco_encode_free(p, bytes);
    if (r !== 0) fail(`codec ${codec} failed (${r}): ${Buffer.from(x.memory.buffer, x.myco_encode_error_ptr(), x.myco_encode_error_len()).toString()}`);
    const out = Buffer.from(new Uint8Array(x.memory.buffer, x.myco_encode_output_ptr(), x.myco_encode_output_len()));
    const info = { rate: x.myco_encode_output_rate(), frames: x.myco_encode_output_frames(), preSkip: x.myco_encode_output_pre_skip() };
    x.myco_encode_output_free();
    return { out, ...info };
  };
  const pcm = encodeTo(0);
  if (pcm.out.toString("latin1", 0, 4) !== "RIFF" || pcm.out.length !== 44 + frames * channels * 2) fail("the PCM output isn't the expected WAV");
  const adpcm = encodeTo(1);
  if (adpcm.out.length !== Math.ceil(frames / 1024) * channels * 516) fail(`the ADPCM output is ${adpcm.out.length} bytes`);
  const opus = encodeTo(3);
  if (opus.out.toString("latin1", 28, 36) !== "OpusHead" || opus.rate !== 48000 || opus.preSkip <= 0) fail("the Opus output has no OpusHead or pre-skip");
  const vorbis = encodeTo(2);
  if (vorbis.out.toString("latin1", 0, 4) !== "OggS" || vorbis.frames !== frames) fail("the Vorbis output isn't Ogg");
  const { exports: d } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(decoderPath)), {});
  const p = d.myco_decode_alloc(vorbis.out.length);
  new Uint8Array(d.memory.buffer, p, vorbis.out.length).set(vorbis.out);
  const h = d.myco_decode_open(p, vorbis.out.length, 4);
  const chunk = 4096;
  const buf = d.myco_decode_alloc(chunk * channels * 4);
  let total = 0;
  for (let n = h > 0 ? d.myco_decode_read_f32(h, buf, chunk) : 0; n > 0; n = d.myco_decode_read_f32(h, buf, chunk)) total += n;
  if (h > 0) d.myco_decode_close(h);
  if (total !== frames) fail(`its Vorbis decodes to ${total} frames, expected ${frames}`);
  console.log("[build:audio] myco_audio_encode.wasm encodes PCM, ADPCM, Opus and Vorbis (decoded to its exact length)");
  return Buffer.from(x.memory.buffer, x.myco_encode_source_hash(), 16).toString("hex");
}

/** Writes src/export/wasm/encode.json: the encoder's source hash, ABI and size. */
function writeEncodeJson(sourceHash, bytes) {
  const x = instantiateEncoder(`${encodeOut}myco_audio_encode.wasm`);
  const v = x.myco_encode_abi_version();
  const json = { sourceHash, abiVersion: `${v >> 8}.${v & 0xff}`, bytes };
  writeFileSync(`${encodeOut}encode.json`, JSON.stringify(json, null, 2) + "\n");
  console.log(`[build:audio] wrote ${encodeOut}encode.json`);
}

/** ADR 0351 A2: builds, gates, smoke-tests and copies the encoder when wasi-sdk and the wasm32-wasip1 target are
 *  installed. Otherwise it keeps the committed encoder, gating its size, and fails only when the encoder's sources
 *  changed since it was built (the README says how to install wasi-sdk). `decoderPath`: the decoder wasm the smoke test
 *  decodes the Vorbis output with. */
function encoderStep(decoderPath) {
  const sources = encoderSourceHash(root);
  const committed = `${encodeOut}myco_audio_encode.wasm`;
  const sdk = findWasiSdk();
  if (!sdk || !hasTarget(ENCODE_TARGET)) {
    const why = !sdk ? `wasi-sdk ${WASI_SDK_VERSION} isn't installed` : `the ${ENCODE_TARGET} target isn't installed (rustup target add ${ENCODE_TARGET})`;
    let built = null;
    try {
      built = JSON.parse(readFileSync(`${encodeOut}encode.json`, "utf8")).sourceHash;
    } catch {
      // no committed encoder yet
    }
    if (built !== sources || !existsSync(committed)) {
      console.error(`[build:audio] audio-encode's sources changed (${sources}; the committed encoder was built from ${built ?? "nothing"}) and ${why}. Install it as native/audio/README.md "The encoder" says, then rebuild.`);
      process.exit(1);
    }
    console.log(`[build:audio] ${why}: keeping the committed myco_audio_encode.wasm (its sources are unchanged)`);
    gate(committed, ENCODER_LIMIT, "myco_audio_encode.wasm");
    return;
  }
  const build = buildEncoder(sdk);
  optimize(build);
  const bytes = gate(build, ENCODER_LIMIT, "myco_audio_encode.wasm");
  const hash = smokeEncoder(build, decoderPath ?? `${out}myco_audio_decode.wasm`);
  if (hash !== sources) {
    console.error(`[build:audio] myco_audio_encode.wasm embeds source hash ${hash}, sourceHash.mjs computes ${sources}: the two rules disagree.`);
    process.exit(1);
  }
  mkdirSync(encodeOut, { recursive: true });
  copyFileSync(build, committed);
  writeEncodeJson(hash, bytes);
}

/**
 * Runs `wasm-opt -O3` on `path` in place when MYCO_WASM_OPT=1 (and wasm-opt is on PATH). Off by default (ADR 0432): it
 * used to run whenever wasm-opt was on PATH, so the committed modules depended on the builder's machine; the committed
 * ones are built without it. Pinning Binaryen so every build runs the same pass is a separate, pending decision (the
 * UI program plan's notes).
 */
function optimize(path) {
  if (process.env.MYCO_WASM_OPT !== "1") {
    console.log(`[build:audio] wasm-opt off (MYCO_WASM_OPT=1 runs it; not for committed builds): ${path}`);
    return;
  }
  try {
    execFileSync("wasm-opt", ["--version"], { stdio: "ignore" });
  } catch {
    console.log(`[build:audio] wasm-opt not on PATH, skipping -O3 for ${path}`);
    return;
  }
  run("wasm-opt", ["-O3", path, "-o", path]);
}

/** Exits 1 when `path` is larger than `limit` bytes; returns its size. */
function gate(path, limit, label) {
  const size = statSync(path).size;
  console.log(`[build:audio] ${label}: ${size} bytes (${(size / 1024).toFixed(1)} KB), limit ${limit / 1024} KB`);
  if (size > limit) {
    console.error(`[build:audio] ${label} is ${size - limit} bytes over its ${limit / 1024} KB limit (ADR 0157). Shrink what the wasm links, then rebuild.`);
    process.exit(1);
  }
  return size;
}

/** ADR 0162 A3: `bake-magls --check` re-bakes src/engine/audio/magls-o3.bin from the HRIR set, compares it byte for byte,
 *  checks audio-dsp's baked bed matrix against its design and runs the bake check (12 of 12 azimuths, ILD within 1.7 dB
 *  below 2 kHz). A failure stops the build. Native (not wasm), release. */
function checkMagls() {
  run("cargo", ["run", "--release", "-p", "bake-magls", "--", "--check"]);
}

/** Instantiates the wasm on a fresh Memory and reads its source hash (hex) and ABI version ("1.0"). */
function readIdentity(path) {
  const memory = new WebAssembly.Memory({ initial: READ_MEMORY_PAGES });
  const module = new WebAssembly.Module(readFileSync(path));
  // ABI 5.0 (ADR 0352): the core imports `myco_ext` (plugin effects); no plugin runs here.
  const myco_ext = { acquire: () => 0, release: () => {}, describe: () => 0, process: () => -1, sweep: () => {} };
  const { exports } = new WebAssembly.Instance(module, { env: { memory }, myco_ext });
  const sourceHash = Buffer.from(memory.buffer, exports.myco_audio_source_hash(), 16).toString("hex");
  const v = exports.myco_audio_abi_version();
  return { sourceHash, abiVersion: `${v >> 8}.${v & 0xff}` };
}

/** Writes hash.json. */
function writeHashJson(identity, bytes) {
  const path = `${out}hash.json`;
  const json = { sourceHash: identity.sourceHash, abiVersion: identity.abiVersion, bytes };
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`[build:audio] wrote ${path}`);
}

/** C1b: builds audio-bench's wasm as the mixer is built (release, +simd128; the same audio-core and DSP), injects the
 *  instruction counter (src/engine/wasm/meter.js) and writes it with metered.json (the source hash it was built
 *  from) to tools/audio-bench/metered/. Test-only: never copied into a build, not size-gated. */
function buildMetered(sourceHash) {
  run("cargo", ["build", "-p", "audio-bench", "--lib", "--release", "--target", TARGET, "--target-dir", "target/bench"], wasmBuildEnv(WASM_RUSTFLAGS));
  const built = fileURLToPath(new URL(`target/bench/${TARGET}/release/audio_bench.wasm`, import.meta.url));
  let metered;
  try {
    metered = meter(readFileSync(built));
  } catch (e) {
    console.error(`[build:audio] the metered build failed: ${e.message}`);
    process.exit(1);
  }
  mkdirSync(meteredOut, { recursive: true });
  writeFileSync(`${meteredOut}audio_bench.metered.wasm`, metered.bytes);
  const json = { sourceHash, meterVersion: METER_VERSION, bytes: metered.bytes.length, ...metered.stats };
  writeFileSync(`${meteredOut}metered.json`, JSON.stringify(json, null, 2) + "\n");
  const kb = (metered.bytes.length / 1024).toFixed(1);
  console.log(`[build:audio] audio_bench.metered.wasm: ${metered.bytes.length} bytes (${kb} KB), test-only, not gated; ${metered.stats.segments} counted segments`);
  console.log("[build:audio] check the core's cost against the baseline: npm run check:audio-metered");
}

function main() {
  checkToolchain();
  genWire();
  checkMagls();
  const mixerBuild = buildWasm();
  optimize(mixerBuild);
  const mixerBytes = gate(mixerBuild, MIXER_LIMIT, "myco_audio.wasm");
  if (mixerBytes > MIXER_WARN) {
    console.warn(`[build:audio] warning: myco_audio.wasm is ${mixerBytes - MIXER_WARN} bytes over the ${MIXER_WARN / 1024} KB warning line (ADR 0162 §5.2; the gate stays ${MIXER_LIMIT / 1024} KB). Look for bloat before it reaches the gate.`);
  }
  // The decoder (M1b): built, gated, smoke-tested and copied once its crate exists.
  // B4: and its AAC build, beside it.
  let decoderBuild = null;
  let decoderBytes = 0;
  let decoderHash = null;
  let aacBuild = null;
  let aacBytes = 0;
  let aacHash = null;
  if (existsSync(fileURLToPath(new URL("crates/audio-decode/Cargo.toml", import.meta.url)))) {
    decoderBuild = buildDecoder({ aac: false });
    optimize(decoderBuild);
    decoderBytes = gate(decoderBuild, DECODER_LIMIT, "myco_audio_decode.wasm");
    decoderHash = smokeDecoder(decoderBuild, { aac: false, label: "myco_audio_decode.wasm" });
    aacBuild = buildDecoder({ aac: true });
    optimize(aacBuild);
    aacBytes = gate(aacBuild, DECODER_AAC_LIMIT, "myco_audio_decode_aac.wasm");
    aacHash = smokeDecoder(aacBuild, { aac: true, label: "myco_audio_decode_aac.wasm" });
  }
  // The offline sample render (ADR 0342): its own module, so the mixer's size and ABI don't change.
  const offlineBuild = buildOffline();
  optimize(offlineBuild);
  const offlineBytes = gate(offlineBuild, OFFLINE_LIMIT, "myco_audio_offline.wasm");
  const offlineHash = smokeOffline(offlineBuild);
  mkdirSync(out, { recursive: true });
  mkdirSync(offlineOut, { recursive: true });
  copyFileSync(offlineBuild, `${offlineOut}myco_audio_offline.wasm`);
  copyFileSync(mixerBuild, `${out}myco_audio.wasm`);
  if (decoderBuild) copyFileSync(decoderBuild, `${out}myco_audio_decode.wasm`);
  if (aacBuild) copyFileSync(aacBuild, `${out}myco_audio_decode_aac.wasm`);

  const identity = readIdentity(`${out}myco_audio.wasm`);
  console.log(`[build:audio] source hash ${identity.sourceHash}, ABI ${identity.abiVersion}`);
  for (const [label, hash] of [["myco_audio_decode.wasm", decoderHash], ["myco_audio_decode_aac.wasm", aacHash], ["myco_audio_offline.wasm", offlineHash]]) {
    if (hash !== null && hash !== identity.sourceHash) {
      console.error(`[build:audio] ${label} embeds source hash ${hash}, the mixer ${identity.sourceHash}; rebuild both.`);
      process.exit(1);
    }
  }
  const bytes = { "myco_audio.wasm": mixerBytes };
  if (decoderBuild) bytes["myco_audio_decode.wasm"] = decoderBytes;
  if (aacBuild) bytes["myco_audio_decode_aac.wasm"] = aacBytes;
  bytes["myco_audio_offline.wasm"] = offlineBytes;
  writeHashJson(identity, bytes);
  buildMetered(identity.sourceHash);
  // The encoder (ADR 0351 A2): its own source hash, not the core's, so a core change never needs wasi-sdk.
  encoderStep(decoderBuild);
}

// `node native/audio/build.mjs --encoder`: only the encoder (its smoke test decodes with the committed decoder).
if (process.argv.includes("--encoder")) {
  checkToolchain();
  encoderStep(null);
} else {
  main();
}
