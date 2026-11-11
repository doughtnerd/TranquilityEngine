# Myco's audio core (`native/audio`)

The Rust half of ADR 0157: a mixer that runs in an `AudioWorklet` as WebAssembly, and a decoder that runs on a worker. The TypeScript half is the audio plugin, `src/plugins/audio/` (the host, the backends, the worklet processor, the editor panels). The design is in [docs/design/0157-audio-core/](../../docs/design/0157-audio-core/README.md); user-facing pages are [Playing sound](../../docs/guide/playing-sound.md) and [Why is there no sound?](../../docs/guide/why-no-sound.md). This file is for people changing the core.

## Layout

| Crate | What it is |
| --- | --- |
| `crates/audio-wire` | The wire format between main and the core. One schema (`src/schema/{envelope,batch,status}.rs`) generates the Rust codec, the TypeScript codec and test vectors. No dependencies |
| `crates/audio-dsp` | DSP kernels: resampler, ramps, pan, filters, compressor, convolver, limiter, HRTF. The Chromium ports live here (BSD-3-Clause; see [PORTS.md](PORTS.md)) |
| `crates/audio-core` | The mixer: voices, buses, clip arena, scheduler, streams, status, the adaptive cap. No I/O, no globals |
| `crates/audio-wasm` | The C ABI over imported memory, built as `myco_audio.wasm`. Its `src/lib.rs` is the ABI |
| `crates/audio-decode` | Symphonia behind a C ABI, built as `myco_audio_decode.wasm` (WAV, FLAC, MP3, Ogg Vorbis) and, with the `aac` feature, `myco_audio_decode_aac.wasm` |

The built files are committed in `src/plugins/audio/runtime/wasm/` (`myco_audio.wasm`, the two decoders, `hash.json`, and `testing/myco_audio_test_hooks.wasm`), so the engine builds without Rust. `myco_hrir.bin` beside them is the HRTF data, made by `tools/hrir/convert.mjs` (see `tools/hrir/README.md`; licence in `docs/design/0157-audio-core/hrir-licence.md`).

On the TypeScript side: `runtime/core/` is the host and backend (`context.ts`, `coreBackend.ts`, `recovery.ts`, `background.ts`, `clipRegistry.ts`, `hrir.ts`), `runtime/decoder/` the worker and its client, `runtime/worklet/processor.ts` the `AudioWorkletProcessor`, `runtime/babylonBackend.ts` the fallback, and `runtime/golden/` the goldens.

## Set up

- Rust through rustup. `rust-toolchain.toml` pins the toolchain (and the `wasm32-unknown-unknown` target); rustup installs both on first use. If it doesn't, `rustup target add wasm32-unknown-unknown`.
- Node, for `npm run build:audio` and the Vitest and Playwright suites (`npm install` first).
- No `wasm-bindgen`. `wasm-opt` is optional: `build.mjs` runs `-O3` if it's on `PATH` and skips it otherwise, so a build with it and one without give different wasm. The committed wasm has been built without it so far; see decision 22 in `owner-review.md` before changing that.

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
2. Builds `audio-wasm` for `wasm32` in release with `+simd128`, and again with the `test-hooks` feature into the test-hooks wasm.
3. Builds `audio-decode`, default and `aac`, and decodes a few fixtures with the built wasm as a smoke test.
4. Enforces the size gates: mixer 320 KB (a tripwire since ADR 0158, not a design limit; raised from 256 KB after ADR 0162 M3), default decoder 900 KB, AAC decoder 1,100 KB. A build over a gate fails. The mixer also warns past 300 KB, so a milestone sees its headroom shrink before the gate.
5. Reads the source hash and ABI version out of the wasm and writes `hash.json`.
6. Builds `audio-bench` for `wasm32` the same way, injects an instruction counter (`tools/audio-bench/meter.mjs`) and writes the metered test wasm and `metered.json` to `tools/audio-bench/metered/`. It is never shipped and not size-gated.

Commit the regenerated wasm, `hash.json`, the metered wasm and any generated wire files with the source change.

**The cost gate** (ADR 0157 C1b; CI runs it): `npm run check:audio-metered` runs `audio-bench`'s presets, the Stress twins and focused scenes (effects, HRTF still and turning, streams, pitch 4, virtual voices, parameter updates, and ADR 0158's automation: 256 bound voices and their unbound twin, bound virtual voices, bus automation, sustain loops) through the metered wasm in Node and fails when a scene's wasm instructions per quantum rise more than 10% over `tools/audio-bench/metered/baseline.json`. Counts are the same on every machine and run, unlike wall time. For a change meant to cost more (or to keep a gain), rewrite the baseline with `UPDATE_METERED_BASELINE=1 npm run check:audio-metered` and commit it, saying why. `src/plugins/audio/runtime/wasm/sourceHash.test.ts` recomputes the hash of every `*.rs`, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml` under `native/audio/` (not `target/`, `vectors/` or `tests/`) and fails when the committed wasm is older than the source. Editing even a comment in a hashed file needs a rebuild.

## The wire

Main and the core talk through byte messages (BATCH, REPLAY, STATUS and stream chunks). The schema is `crates/audio-wire/src/schema/*.rs`. `cargo run -p audio-wire --bin gen_wire` writes:

- `crates/audio-wire/src/generated.rs`,
- `src/plugins/audio/runtime/wire.generated.ts`,
- `crates/audio-wire/vectors/wire.json` (the byte vectors both sides test against).

ADR 0158 (ABI 1.4, wire major unchanged) added five opcodes, applied in `audio-core/src/automation.rs` (SET_LOOP in `voices.rs`):

- `0x08 SET_LOOP`: a clip voice's loop region (`loopStartFrame`, `loopEndFrame`, 0 = the clip's end) or, with bit0 clear, its release; stamped.
- `0x09 AUTOMATE`: a voice's bindings (parameter slot, curve id, target volume/pitch/lowpass), at most 8; applies on arrival.
- `0x13 CURVES`: defines curves from `firstCurve` (1,024 ids, 32 keys each), evaluated as `src/engine/core/curve.ts`.
- `0x14 PARAM`: a global (group 0) or instance-group parameter's target and seek speed.
- `0x15 BUS_AUTOMATE`: a bus's bindings to global parameters (volume, lowpass), at most 8.

`gen_wire --check` fails when any is stale; `npm run build:audio` runs the generator for you. Never edit the generated files. A schema change changes the schema hash: `wire.schemaHash.test.ts` and `wire.roundtrip.test.ts` fail until the TypeScript side is updated, which is the point. The wire is frozen for M1 (contract K1); a change needs a review and a version decision.

## Goldens and parity

- **Goldens** (`src/plugins/audio/runtime/golden/*.json`) are digests of what the real wasm renders for fixed scenes. `audioGolden.test.ts` compares them. If a change to the sound is intended: `UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/audioGolden.test.ts`, then read the diff of `golden/*.json` and say in the commit why the sound changed. `crates/audio-core/tests/golden_native.rs` is the native counterpart, with expectations computed from the spec.
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
