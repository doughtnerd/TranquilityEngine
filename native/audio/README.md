# Myco's audio core (`native/audio`)

The Rust half of ADR 0157: a mixer that runs in an `AudioWorklet` as WebAssembly, and a decoder that runs on a worker. The TypeScript half is the audio plugin, `src/plugins/audio/` (the host, the backends, the worklet processor, the editor panels). The design is in [docs/design/0157-audio-core/](../../docs/design/0157-audio-core/README.md); user-facing pages are [Playing sound](../../docs/wiki/guide/playing-sound.md) and [Why is there no sound?](../../docs/wiki/guide/why-no-sound.md). This file is for people changing the core.

## Layout

| Crate | What it is |
| --- | --- |
| `crates/audio-wire` | The wire format between main and the core. One schema (`src/schema/{envelope,batch,status}.rs`) generates the Rust codec, the TypeScript codec and test vectors. No dependencies |
| `crates/audio-dsp` | DSP kernels: resampler, ramps, pan, filters, compressor, convolver, limiter, HRTF. The Chromium ports live here (BSD-3-Clause; see [PORTS.md](PORTS.md)) |
| `crates/audio-core` | The mixer: voices, buses, clip arena, scheduler, streams, status, the adaptive cap. No I/O, no globals |
| `crates/audio-wasm` | The C ABI over imported memory, built as `myco_audio.wasm`. Its `src/lib.rs` is the ABI |
| `crates/audio-decode` | Symphonia behind a C ABI, built as `myco_audio_decode.wasm` (WAV, FLAC, MP3, Ogg Vorbis) and, with the `aac` feature, `myco_audio_decode_aac.wasm` |
| `crates/audio-encode` | The export's encoder (ADR 0351, 0359): PCM, IMA ADPCM, Ogg Vorbis (libvorbis), Ogg Opus (libopus), rubato's FFT resampler, a mono downmix. A `wasm32-wasip1` reactor, `src/export/wasm/myco_audio_encode.wasm`; editor, Studio and export only. See "The encoder" below |

The built files are committed in `src/plugins/audio/runtime/wasm/` (`myco_audio.wasm`, the two decoders and `hash.json`), so the engine builds without Rust. `myco_hrir.bin` beside them is the HRTF data, made by `tools/hrir/convert.mjs` (see `tools/hrir/README.md`; licence in `docs/design/0157-audio-core/hrir-licence.md`).

On the TypeScript side: `runtime/core/` is the host and backend (`context.ts`, `coreBackend.ts`, `recovery.ts`, `background.ts`, `clipRegistry.ts`, `hrir.ts`), `runtime/decoder/` the worker and its client, `runtime/worklet/processor.ts` the `AudioWorkletProcessor`, `runtime/babylonBackend.ts` the fallback, and `runtime/golden/` the goldens.

## Set up

- Rust through rustup. `rust-toolchain.toml` pins the toolchain (and the `wasm32-unknown-unknown` target); rustup installs both on first use. If it doesn't, `rustup target add wasm32-unknown-unknown`.
- Node, for `npm run build:audio` and the Vitest and Playwright suites (`npm install` first).
- No `wasm-bindgen`. `wasm-opt` is off: `build.mjs` runs `-O3` only with `MYCO_WASM_OPT=1` (and `wasm-opt` on `PATH`), for measuring, never for committed builds; it used to run whenever `wasm-opt` was on `PATH`, so the wasm depended on the machine (ADR 0428). The committed wasm is built without it; see decision 22 in `owner-review.md` before changing that.
- Paths are remapped (`../rustflags.mjs`, ADR 0428): the repository root becomes `/myco` and CARGO_HOME `/cargo` in the wasm, so any checkout builds the same bytes.

## Build and test

```
npm run build:audio          # wire, wasm, size gates, hash.json (see below)
cd native/audio && cargo test                      # every crate, natively
cargo test -p audio-core --test bus                # one integration test
npx vitest run src/plugins/audio                   # the TypeScript side, headless
npm run test:e2e:slow -- audio-core                # browser: the Sound Lab on the core (@slow)
npm run test:e2e:slow -- audio-parity              # browser parity with Web Audio (@slow)
npm run check:audio-metered                        # the cost gate: instruction counts vs the baseline (below)
```

`npm run build:audio` (`build.mjs`) does, in order:

1. Runs `gen_wire` (regenerates the wire; below), then `bake-magls --check` (ADR 0162 A3: re-bakes `src/engine/audio/magls-o3.bin` and the 16 → 2 bed matrix and fails if either differs from what is committed; run `cargo run -p bake-magls --release` to rewrite the asset after changing the design or the HRIR set).
2. Builds `audio-wasm` for `wasm32` in release with `+simd128`. (There is no test build of it: the loopback tests that need a trap wrap the real instance's `myco_audio_process`, `testing.ts` `trapNext`.)
3. Builds `audio-decode`, default and `aac`, and decodes a few fixtures (Ogg Opus among them) with the built wasm as a smoke test. Both builds compile the vendored libopus fixed point (ADR 0351 A7) with **clang for `wasm32-unknown-unknown`** (`CC_wasm32_unknown_unknown`, else `clang` on PATH; any clang with the WebAssembly backend, no wasi-sdk or libc: the decoder's `opus/cstub/` headers stand in). `cargo test` builds it natively with the system's C compiler.
4. Enforces the size gates (tripwires, not design limits; `build.mjs` says why each was raised): mixer 512 KB, default decoder 1,000 KB and AAC decoder 1,350 KB since libopus (0359 §4). A build over a gate fails. The mixer also warns past 300 KB, so a milestone sees its headroom shrink before the gate.
5. Reads the source hash and ABI version out of the wasm and writes `hash.json`.
6. Builds `audio-bench` for `wasm32` the same way, injects an instruction counter (`tools/audio-bench/meter.mjs`) and writes the metered test wasm and `metered.json` to `tools/audio-bench/metered/`. It is never shipped and not size-gated.
7. Builds the encoder (`audio-encode`) for `wasm32-wasip1` when wasi-sdk is installed, gates it at 1.75 MB, encodes a tone to every codec (decoding the Vorbis with the decoder just built) and writes `src/export/wasm/myco_audio_encode.wasm` and `encode.json`; without wasi-sdk it keeps the committed encoder (see "The encoder").

Commit the regenerated wasm, `hash.json`, the metered wasm and any generated wire files with the source change.

**The cost gate** (ADR 0157 C1b; CI runs it): `npm run check:audio-metered` runs `audio-bench`'s presets, the Stress twins and focused scenes (effects, HRTF still and turning, streams, pitch 4, virtual voices, parameter updates, and ADR 0158's automation: 256 bound voices and their unbound twin, bound virtual voices, bus automation, sustain loops) through the metered wasm in Node and fails when a scene's wasm instructions per quantum rise more than 10% over `tools/audio-bench/metered/baseline.json`. Counts are the same on every machine and run, unlike wall time. For a change meant to cost more (or to keep a gain), rewrite the baseline with `UPDATE_METERED_BASELINE=1 npm run check:audio-metered` and commit it, saying why. `src/plugins/audio/runtime/wasm/sourceHash.test.ts` recomputes the hash of every `*.rs`, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` under `native/audio/` (not `target/`, `vectors/` or `tests/`) and fails when the committed wasm is older than the source. Editing even a comment in a hashed file needs a rebuild.

## The encoder

`crates/audio-encode` (ADR 0351 §4, amended by 0359) turns PCM into what a platform ships. It links three C libraries vendored unmodified under `third_party/` (`libogg`, `libvorbis`, `opus`; each has a `PROVENANCE.md`, the notices are in the root `THIRD_PARTY_NOTICES.md`), so its wasm build needs a C compiler with a libc for wasm: **wasi-sdk 25**. Its host ABI is in `src/lib.rs`'s header; the TypeScript side is `src/export/audioEncoder*.ts`.

- **You only need wasi-sdk to change the encoder.** `npm run build:audio` builds the encoder when it finds wasi-sdk; otherwise it keeps the committed `src/export/wasm/myco_audio_encode.wasm` (and still gates its size), and fails only if the encoder's sources changed since that wasm was built. The encoder has its own source hash (`crates/audio-encode/sourceHash.mjs`, the same rule as its `build.rs`; recorded in `src/export/wasm/encode.json` and checked by `src/export/audioEncoder.test.ts`), so a change to the core never needs wasi-sdk.
- `node native/audio/build.mjs --encoder` builds only the encoder.
- `cargo test -p audio-encode` (or `--manifest-path native/audio/crates/audio-encode/Cargo.toml`) runs its tests natively with the system's C compiler; no wasi-sdk needed.
- Its size tripwire is 1.75 MB (0359 §1). It builds with `+simd128` for Rust and C.

**Installing wasi-sdk 25** (these are the steps the A0 spike and the first build used, on Linux x86-64):

```sh
rustup target add wasm32-wasip1                       # the toolchain is pinned in rust-toolchain.toml
mkdir -p native/audio/target
curl -sSfL -o native/audio/target/wasi-sdk.tar.gz \
  https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz
sha256sum native/audio/target/wasi-sdk.tar.gz          # 52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c
tar -xzf native/audio/target/wasi-sdk.tar.gz -C native/audio/target/
npm run build:audio                                    # or: node native/audio/build.mjs --encoder
```

`build.mjs` looks for wasi-sdk in `$WASI_SDK_PATH`, then `native/audio/target/wasi-sdk-25.0-*/` (where the steps above put it; `cargo clean` removes it with the rest of `target/`), then `/opt/wasi-sdk`. On macOS and Windows take the matching asset of the same release (`wasi-sdk-25.0-arm64-macos.tar.gz`, `wasi-sdk-25.0-x86_64-macos.tar.gz`, `wasi-sdk-25.0-x86_64-windows.tar.gz`) and unpack it the same way, or point `WASI_SDK_PATH` at it. The build passes wasi-sdk's `clang` and `llvm-ar` to the `cc` crate as `CC_wasm32_wasip1` / `AR_wasm32_wasip1`; `WASI_SDK_PATH` alone also works for a plain `cargo build -p audio-encode --target wasm32-wasip1`.

The encoder is built as the other modules are, without `-O3` (`MYCO_WASM_OPT=1` runs it, not for committed builds).

## The wire

Main and the core talk through byte messages (BATCH, REPLAY, STATUS and stream chunks). The schema is `crates/audio-wire/src/schema/*.rs`. `cargo run -p audio-wire --bin gen_wire` writes:

- `crates/audio-wire/src/generated.rs`,
- `src/plugins/audio/runtime/wire.generated.ts`,
- `crates/audio-wire/vectors/wire.json` (the byte vectors both sides test against).

ADR 0158 (ABI 1.4, wire major unchanged) added five opcodes, applied in `audio-core/src/automation.rs` (SET_LOOP in `voices.rs`):

- `0x08 SET_LOOP`: a clip voice's loop region (`loopStartFrame`, `loopEndFrame`, 0 = the clip's end) or, with bit0 clear, its release; stamped.
- `0x09 AUTOMATE`: a voice's bindings (parameter slot, curve id, target volume/pitch/lowpass), at most 8; applies on arrival.
- `0x13 CURVES`: defines curves from `firstCurve` (1,024 ids, 32 keys each; 64 since ADR 0346, whose keys also carry Bézier handles, interp 5: ABI 4.1), evaluated as `src/engine/core/curve.ts`.
- `0x14 PARAM`: a global (group 0) or instance-group parameter's target and seek speed.
- `0x15 BUS_AUTOMATE`: a bus's bindings to global parameters (volume, lowpass), at most 8.

ADR 0346 (ABI 4.2) adds time parameters, in `schema/studio.rs`: a binding whose `param` has bit 14 set (bit 15 clear) reads `voiceTime`, `clipTime` or `sequenceTime` (`TIME_*` in bits 0-1) instead of a parameter slot, and `0x1D TIME` re-anchors a group's sequence clock (`value` seconds at its frame, moving `rate` seconds per second; stamped, applied at its frame without splitting the quantum).

ADR 0342 (ABI 4.3) adds `0x0B LOOPS`: a clip voice's loop program, up to `VOICE_LOOPS_MAX` (4) loops with direction (forward, ping-pong, backward), repeat count, equal-power seam crossfade, hold points (start == end), activation (always, held until the key-off, or a parameter against a threshold), exit (finish, jump, crossfade) and re-entry; applied on arrival like AUTOMATE. A SET_LOOP with `looping` clear is the program's key-off. Programs live in a pool of 256 in the automation region (`automation.rs` `PROGRAMS`; full, a program falls back to its first region as a SET_LOOP loop) and run in `audio-core/src/voice_loops.rs`. Ambisonic voices don't run programs; stream voices loop in the decoder worker (below).

ABI 4.4 adds two AUTOMATE targets for voices (ADR 0345's voice level, ADR 0343's entry curves): `3` highpass, a cut-off floor in Hz (the highest curve wins; the voice's high-pass runs at `max(hpHz, floor)`, a floor at or below 20 Hz is none) and `4` pan, −1..1 (curves summed and clamped), applied just before the panner of a non-spatial voice: equal-power on a mono voice, normalised so 0 is the identity (`√2·cos θ`, `√2·sin θ`), balance on a stereo one. Buses ignore both.

ADR 0345 (ABI 4.5) adds `0x0C SUBMIX` and the `Submixes` region (64 slots, ≈ 320 KB on every preset; `audio-core/src/submix.rs`): instance submixes. A SUBMIX configures slot `voiceId` with an instance `group`, an output `bus` and an insert chain of up to `SUBMIX_EFFECTS_MAX` (8) effects, each a `SUBMIX_FX_*` kind, an on flag and the catalogue's parameters in its order (`effects/catalogue.ts`); no effects frees the slot. The voices of that group on that bus mix into the slot (their dry and HRTF output; a voice routed so pans without the bed), and after the voices and the HRTF flush each slot runs its chain and adds into its bus's input (`Core::process`: `voices::render`, `submix::render`, `bus::mixdown`). The chain dispatches on the kind (`submix::run_chain`): low-pass, high-pass and compressor today; an unknown kind passes the signal through, so a new effect is a new kind (a constant in `schema/studio.rs`, a branch in `run_chain`, its state in `SubmixEffect` or a pool) with no record change. Main owns the pool (`runtime/core/submixes.ts`, `settings.voices.submixes`).

ADR 0345 (ABI 4.6) adds the catalogue's DSP, `audio-dsp/src/fx/` (one implementation for bus chains, submixes and, later, the offline sample render: no worklet assumptions, caller-owned memory): three-band EQ, low/high/band-pass with drive, saturation, distortion, bit-crush, chorus, delay, an eight-line FDN reverb, a granular pitch shifter, an LPC formant shifter, a look-ahead-free limiter, a sidechain compressor, gain, and the compressor. `audio_dsp::fx::Effect` is one slot (kind, the catalogue's parameters in its order, their smoothed values, small state); the wire kinds are `SUBMIX_FX_EQ` (4) to `SUBMIX_FX_GAIN` (16). Submixes run them all (the sidechain compressor needs a bus); bus chains take them as `BUS_FX_CATALOGUE + kind` (16 + kind) in BUS_CONFIG and BUS_SLOT, eight effects a bus (`BUS_SLOT_MAX_EFFECTS`), any number of compressors (a second legacy compressor runs as the catalogue's). Delay lines, reverb networks, grains and catalogue compressors live in the `FxMem` region (`audio-core/src/fxmem.rs`: `FX_MEMORY_SECONDS` = 20 s of stereo at the rate, 7.7 MB at 48 kHz, 16 KB blocks, first fit; freed by a sweep after every configure). Catalogue parameters glide over 20 ms when edited (filters in octaves). A sidechain compressor's key (`p[3]`, a bus slot) is measured pre-fader and ordered before its reader (`bus_order::compute_full`'s extra edges). Main's table of kinds is `runtime/core/effectKinds.ts`; `engine/audio/busCapability.ts` `CORE_EFFECT_TYPES` lists what the core runs.

ADR 0344 / 0345 (ABI 4.8) finish the mix's core features. BUS_AUTOMATE keeps 16 bindings a bus and takes two more target kinds, their arguments in the target's upper bits (`AUTO_TARGET_*`): **fx** (5), a catalogue parameter of an effect in the bus's chain (slot in bits 8-15, parameter in 16-23, bit 24 a log2 curve: the core takes 2^value), handed to the effect once a quantum before the chain runs (`audio_dsp::fx::Effect::automate`: reached across the quantum); and **send** (6), the curves' dB summed per receiving slot and multiplied onto that send as a gain ramped across the quantum (`bus_sends::feed`). A bus effect type's bits 16-23 hold catalogue parameters against automation (a snapshot override in force). `0x1F SUBMIX_AUTOMATE` gives an instance submix fx bindings read from global parameters, its group's locals or its group's `sequenceTime` (`submix::render`). BUS_RAMP takes the law `Decibel` (4): the lane ramps geometrically (linear in dB; `Ramp::set_target_db`, the lane's bit in `BusLanes::db`; a ramp to or from 0 stays linear), which snapshot fades use. STATUS `fxStarved` and `fxStarvedOwner` (the M4 reserve at 172) report effects the effect memory couldn't hold and whose the last was.

ADR 0347 (ABI 4.11) adds per-voice **spread**: SET_VOICE_FX mask bit 4 and `spread` (the u16 at offset 50 that was `reserved`), hundredths of a degree, 0 a point source, 36,000 all round, ramped over `rampFrames`. A spatial voice's samples split before its panner (`audio-core/src/spread.rs`): a point part, `√(1 − s/360)`, goes on to the panner (equal-power, HRTF or the bed), and a diffuse part, `√(s/360)`, is decorrelated by two all-pass cascades (`audio-dsp/src/decorrelate.rs`, one an ear) and added to the voice's output, split between the ears by the arc's mean equal-power gains; a stereo voice keeps its image (left channel to the left ear's cascade). The interaural correlation of a centred voice is `1 − s/360` (`tests/spread.rs`). The state (spread ramp, last gains, decorrelator) is in the mixed-voice pool entry, which grew from 448 to 560 B. The same ADR gives its four reverb presets (`smallStone`, `canyonHall`, `metalTunnel`, `forest`) their own generated responses (`audio-dsp/src/convolver/presets.rs`, indices 5-8).

**Stream loops** (ADR 0342; decoder ABI 1.4). A stream voice's loop program reaches the decoder worker as its first region plus a `StreamLoopProgram` (`runtime/decoder/protocol.ts`): the region's seam crossfade, shape, repeat count and the program's later loops. The worker wraps sample-accurately (it reads the region's end, seeks back to its start) and crossfades the seam with `myco_decode_seam` (`audio-decode/src/seam.rs`, the clip voice's `audio_dsp::fade_shapes`), so the ring still holds one continuous signal and the core is unchanged. Streams loop forward only (a ping-pong or backward loop plays forward, warned once), and a parameter activation reads as always.

**Versions after the merge with master (2026-11-23).** The core's ABI is generated from `schema.rs` (`CORE_ABI`, ADR 0328), where its history is: master's 5.0 (the INIT record, the memory exports, ADR 0327/0328) and the Audio Studio's 4.1–5.1 (the records above, plugin effects through `myco_ext`, generators) were built apart, so the joined core is **6.0**. The decoder is **1.6**: the Studio's 1.4 (`myco_decode_seam`) and 1.5 (Opus, `myco_decode_adpcm`) beside master's 1.4 (`myco_hrir_prepare`, `myco_magls_prepare`, ADR 0331).

`gen_wire --check` fails when any is stale; `npm run build:audio` runs the generator for you. Never edit the generated files. A schema change changes the schema hash: `wire.schemaHash.test.ts` and `wire.roundtrip.test.ts` fail until the TypeScript side is updated, which is the point. The wire is frozen for M1 (contract K1); a change needs a review and a version decision.

## Goldens and parity

- **Goldens** (`src/plugins/audio/runtime/golden/<suite>/*.json`, one folder per suite; `golden/replay.ts` replays and digests them) are digests of what the real wasm renders for fixed scenes. `audioGolden.test.ts` compares `golden/core/`. If a change to the sound is intended: `UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/audioGolden.test.ts`, then read the diff of `golden/core/*.json` and say in the commit why the sound changed. `crates/audio-core/tests/golden_native.rs` is the native counterpart, with expectations computed from the spec.
- **Parity** checks the core against Chromium's own Web Audio nodes. `reference.json` and `hrtf-reference.json` in `tests/e2e/audio-parity/` hold committed digests of the reference renders, so `src/plugins/audio/testing/webAudioParity.test.ts` and `hrtfParity.test.ts` run in Node. `tests/e2e/audio-parity.spec.ts` and `audio-parity-hrtf.spec.ts` (tagged `@slow`) check the digests against the installed Chromium and rewrite them with `PARITY_UPDATE=1`. Tolerances are in `tests/e2e/audio-parity/analysis.ts` and `hrtfAnalysis.ts`; loosening one needs a reason in the commit.
- `crates/audio-dsp/tests/quality_*.rs` and `crates/audio-core/tests/quality_*.rs` measure THD+N, sweeps and null tests natively.
- Device smoke tests (WebKitGTK in Docker, WebView2) are in `tools/audio-smoke/`.

## Docs

`node tools/check-doc-links.mjs` checks every relative link and heading anchor in the audio guide pages, the 0157 design docs and the notes in this directory (no dependencies; pass paths to check others). Run it after moving or renaming a heading.

## Adding a port from Chromium

1. Stage the upstream file unchanged from the pinned commit (the one in [PORTS.md](PORTS.md)) into `third_party/blink/`, and add a row with its upstream path and `sha256sum` to `third_party/blink/PROVENANCE.md`. Don't stage from another commit; a new pin means a new row for every file and a new pin line.
2. Write the Rust (or TypeScript) module. Its first lines are the header from PORTS.md "Header rule": `SPDX-License-Identifier: BSD-3-Clause`, one `Ported from chromium/src/<path> @ <commit>` line for each upstream file you draw on, the copyright line copied from the upstream file, and the licence conditions as that file states them. Files differ: copy the clauses of the file you port (some have a clause 3 naming Apple Computer, some only two clauses, and files from `media/`, `ui/` and `base/` carry `The Chromium Authors` under Chromium's LICENSE).
3. Add a row to the table in PORTS.md (upstream files, the module, the task, what differs).
4. Credit anything new in `THIRD_PARTY_NOTICES.md`.
5. `npx vitest run src/plugins/audio/portsNotices.test.ts` checks the headers, the pin and the staged files' hashes.

A new Cargo dependency is a decision: say why in the commit (and an ADR if it's big), keep it `default-features = false`, check it against the wasm size gate, and add its name, version, licence and source to `THIRD_PARTY_NOTICES.md` under the wasm that contains it (`cargo tree -p audio-wasm -e normal --target wasm32-unknown-unknown` and `-p audio-decode [--features aac]` list what ships). No GPL or LGPL.

## Rules of the road

**Ownership.** Each piece of state has one writer (architecture §4.1). Main writes voice intent (the voice table), the bus tree and parameters, and the unlock queue. The core writes playheads, lifetimes, ramps, filter state, bus DSP state and meters, and the audio clock. The worker writes stream cursors. Mixed versus virtual is main's choice; the core may only demote, and main never promotes against it. Anything shared crosses as a message or a status block; there are no shared mutable structures between threads except the rings and arena regions the design names.

**In the core.** No allocation, I/O, locks or global state after `init`; `audio-core` is `no I/O, no globals`. Keep `process` bounded: the work-unit model prices every operation, and a new operation needs its price. Transcendentals go through `libm` so native and wasm agree bit for bit. Don't grow the 192-byte voice slot without changing architecture §5.1.

**Files with one writer.** These change in one place at a time, so two branches don't collide (the coordinator names who): `package.json` and the lock file; `native/audio/Cargo.toml`, `rust-toolchain.toml` and `build.mjs`; the wire schema and `wire.generated.ts`; `crates/audio-wasm/src/lib.rs` (the C ABI; add an export by filling a stubbed one, not by renumbering); `src/plugins/audio/editor/index.ts`; `THIRD_PARTY_NOTICES.md` and `PORTS.md`; `docs/architecture/implementation-status.md`; the frozen budget table in `architecture.md` §6. The full list and the contracts K1 to K13 are in [docs/plans/2026-11-audio-core-m1.md](../../docs/plans/2026-11-audio-core-m1.md).

**Public API.** Babylon, Rapier and the rest must not appear in the public audio API (ADR 0010). A public API change (a new `Audio` member or `AudioSource` field) needs a decision record; `AudioSource.seek` is `@internal` until one exists.
