#!/usr/bin/env node
// `npm run build:audio` (ADR 0157, api-and-models §5): compiles native/audio to WebAssembly and writes
// myco_audio.wasm, the test-hooks wasm, the decoder (myco_audio_decode.wasm, and myco_audio_decode_aac.wasm with
// AAC, B4) and hash.json to src/plugins/audio/runtime/wasm/, which is
// committed, so the engine builds without Rust. Modelled on native/nav/build.mjs, without
// wasm-bindgen: the core's exports are plain `extern "C"` functions over imported memory.
// From C1b it also writes the metered test wasm (tools/audio-bench/metered/), which CI's cost gate runs; it is never
// shipped and not size-gated.
// Needs the toolchain pinned in rust-toolchain.toml and `rustup target add wasm32-unknown-unknown`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { meter, METER_VERSION } from "../../tools/audio-bench/meter.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../src/plugins/audio/runtime/wasm/", import.meta.url));
/** The metered build's directory (C1b): test-only, beside the gate that runs it. */
const meteredOut = fileURLToPath(new URL("../../tools/audio-bench/metered/", import.meta.url));
const TARGET = "wasm32-unknown-unknown";
/** The mixer's size tripwire (ADR 0158 amends 0157): 256 KB. A guard against accidental bloat, not a design constraint; raise it with a line in the build log saying why. */
const MIXER_LIMIT = 256 * 1024;
/** ADR 0162 (api-and-models §5.2): M3's mixer warning, under the gate: a build past it warns but passes. */
const MIXER_WARN = 230 * 1024;
/** The decoder's size gate (M1b): 900 KB. */
const DECODER_LIMIT = 900 * 1024;
/** The AAC decoder build's own gate (B4; raised 1,100 -> 1,280 KB in M2 by the owner, 2026-11-10: gates are a signal to look for
 *  bloat, and M2's loop points are wanted growth). It ships beside the default decoder and is fetched only when a project sets
 *  `audio.codecs.aac`. */
const DECODER_AAC_LIMIT = 1280 * 1024;
/** Only +simd128 here: --import-memory and the 256 KB stack are link args in audio-wasm's build.rs. */
const WASM_RUSTFLAGS = "-C target-feature=+simd128";
/** Pages of the Memory the hash read instantiates the wasm with (enough for its data and stack). */
const READ_MEMORY_PAGES = 64;

/** Runs `cmd args` in native/audio with inherited stdio; `env` adds variables. */
function run(cmd, args, env = {}) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
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
function buildWasm({ testHooks }) {
  const args = ["build", "-p", "audio-wasm", "--target", TARGET, "--release"];
  if (testHooks) args.push("--features", "test-hooks", "--target-dir", "target/test-hooks");
  run("cargo", args, { CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: WASM_RUSTFLAGS });
  const dir = testHooks ? "target/test-hooks" : "target";
  return fileURLToPath(new URL(`${dir}/${TARGET}/release/myco_audio.wasm`, import.meta.url));
}

/** Builds audio-decode (M1b) for wasm32 in release; returns the built .wasm's path. Its build.rs
 *  adds `--strip-all`; memory is exported (the decoder runs alone in a worker). symphonia's panic
 *  locations name its sources under CARGO_HOME, so that prefix is remapped to `/cargo` (the wasm
 *  then doesn't depend on where the registry lives). CARGO_ENCODED_RUSTFLAGS takes precedence over
 *  the target's RUSTFLAGS and keeps a path with spaces in one argument. */
function buildDecoder({ aac }) {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const flags = [...WASM_RUSTFLAGS.split(" "), `--remap-path-prefix=${cargoHome}=/cargo`];
  const args = ["build", "-p", "audio-decode", "--target", TARGET, "--release"];
  // B4: the AAC build has its own target directory, so the two builds don't rebuild each other.
  if (aac) args.push("--features", "aac", "--target-dir", "target/aac");
  run("cargo", args, { CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") });
  return fileURLToPath(new URL(`${aac ? "target/aac" : "target"}/${TARGET}/release/myco_audio_decode.wasm`, import.meta.url));
}

/** Decodes three of audio-decode's fixtures with the built decoder wasm (FLAC, MP3, Ogg Vorbis; the AAC build also an
 *  M4A, trimmed to its source's length), checks each one's frame count, and returns the source hash the decoder
 *  embeds (hex). Exits 1 on a mismatch. */
function smokeDecoder(path, { aac, label }) {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {});
  const fixtures = fileURLToPath(new URL("crates/audio-decode/tests/fixtures/", import.meta.url));
  const cases = [
    ["tone-48000-stereo.flac", 2, 48000],
    ["tone-44100-mono.mp3", 3, 88200],
    ["tone-48000-stereo.ogg", 4, 48000],
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
  console.log(`[build:audio] ${label} decodes the FLAC, MP3, Ogg Vorbis${aac ? " and M4A" : ""} fixtures`);
  return Buffer.from(x.memory.buffer, x.myco_decode_source_hash(), 16).toString("hex");
}

/** Runs `wasm-opt -O3` on `path` in place if wasm-opt is on PATH; logs a skip otherwise. */
function optimize(path) {
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
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
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
 *  instruction counter (tools/audio-bench/meter.mjs) and writes it with metered.json (the source hash it was built
 *  from) to tools/audio-bench/metered/. Test-only: never copied into a build, not size-gated. */
function buildMetered(sourceHash) {
  run("cargo", ["build", "-p", "audio-bench", "--lib", "--release", "--target", TARGET, "--target-dir", "target/bench"], {
    CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: WASM_RUSTFLAGS,
  });
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
  const mixerBuild = buildWasm({ testHooks: false });
  const testBuild = buildWasm({ testHooks: true });
  optimize(mixerBuild);
  optimize(testBuild);
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
  const testBytes = statSync(testBuild).size;
  console.log(`[build:audio] myco_audio_test_hooks.wasm: ${testBytes} bytes (${(testBytes / 1024).toFixed(1)} KB), not gated`);

  mkdirSync(`${out}testing`, { recursive: true });
  copyFileSync(mixerBuild, `${out}myco_audio.wasm`);
  copyFileSync(testBuild, `${out}testing/myco_audio_test_hooks.wasm`);
  if (decoderBuild) copyFileSync(decoderBuild, `${out}myco_audio_decode.wasm`);
  if (aacBuild) copyFileSync(aacBuild, `${out}myco_audio_decode_aac.wasm`);

  const identity = readIdentity(`${out}myco_audio.wasm`);
  console.log(`[build:audio] source hash ${identity.sourceHash}, ABI ${identity.abiVersion}`);
  for (const [label, hash] of [["myco_audio_decode.wasm", decoderHash], ["myco_audio_decode_aac.wasm", aacHash]]) {
    if (hash !== null && hash !== identity.sourceHash) {
      console.error(`[build:audio] ${label} embeds source hash ${hash}, the mixer ${identity.sourceHash}; rebuild both.`);
      process.exit(1);
    }
  }
  const bytes = { "myco_audio.wasm": mixerBytes, "testing/myco_audio_test_hooks.wasm": testBytes };
  if (decoderBuild) bytes["myco_audio_decode.wasm"] = decoderBytes;
  if (aacBuild) bytes["myco_audio_decode_aac.wasm"] = aacBytes;
  writeHashJson(identity, bytes);
  buildMetered(identity.sourceHash);
}

main();
