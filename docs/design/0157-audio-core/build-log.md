# Audio core M1: build log

The coordinator's log of each wave review ([plan, "Wave reviews"](../../plans/2026-11-audio-core-m1.md#wave-reviews)): what landed, the numbers measured, deviations from the design, and reserve days used. The tickets are GitHub issues #42–#104. Work merges into the integration branch `claude/audio-core-m1-refinement-dde0d2`, and each milestone goes to master with the owner's approval.

## Baseline (2026-11-09, master `5b0888c`)

- `npm run typecheck`: green.
- `npm test`: 3 failures, all in `src/plugins/plugins.test.ts`. Its source-scan cases test `startsWith("/")`, which is false for Windows paths. Some timeouts also show up in full runs (editorBoot, renderPlugins, renderTextures, babylonPreviewRouting, piratesSample, physics3d) and pass when rerun alone.
- `npm run test:e2e` (Chromium): 193 passed, 3 failed, 1 skipped. The failures are `codefiles.spec.ts:38`, `particles.spec.ts:168` and `selection.spec.ts:48`, editor specs unrelated to audio.
- Rust 1.99.1 with `wasm32-unknown-unknown`. `wasm-opt` isn't installed, so `build:audio` skips it and the size gate measures unoptimised wasm.

## MS0

- **H0** (#51, Sonnet, no leaves): `hrir-licence.md` recommends the IRCAM IRC_Composite_C data as Chromium processed it, with SADIE II (Apache-2.0) as the fallback, so MS6 runs as planned. Confidence is medium-high: IRCAM's own page couldn't be fetched (a TLS error), so its wording comes from Debian's libmysofa copyright file. **Owner:** confirm the decision; decide whether to send the courtesy letter in Appendix A (nothing has been sent); check IRCAM's page before B7.

## MS1 wave 1 (A0.1, A0.2, A0.4)

Leads: A0.1 Opus, A0.2 and A0.4 Sonnet. Haiku leaves: A0.1 L1 (`build.mjs`) and L2 (source hash); A0.2 L1–L3 (schema tables), L4 (byte vectors) and L5 (TS round trip); A0.4 L1 (settings parse). Every leaf had its own worktree, cut from its lead's skeleton commit. No merge conflicts.

**Landed**
- A0.1 (#52): the `native/audio/` workspace; `audio-core` with a fixed region layout (architecture §5.1); an empty `audio-dsp`; `audio-wasm` with all 19 §5 exports stubbed (K2); deterministic init, with identical addresses across fresh instances checked in Rust and in Node; `--import-memory` and a 256 KB stack set in `build.rs`; `build.mjs` and `npm run build:audio`; the source hash with `sourceHash.test.ts`, where the TS and Rust hashes agree on the real tree.
- A0.2 (#53): `audio-wire` describes the whole M1 wire once and `gen_wire` generates the Rust and TS code (K1), with the schema hash, 26 hand-derived byte vectors that pass in both languages, and a 1,000-case fuzz. Refused reads throw `WireError` with a code, never a raw `RangeError`.
- A0.4 (#54): the `myco.audio` plugin (manifest, activation, World service with a stub `load()`), the K3 selector, and every §2 setting parsed (K13) with about 30 tests.
- Coordinator glue: `audio-wasm` depends on `audio-wire`, its error codes alias the schema's, and `myco_audio_schema_hash` returns the real hash. `build:audio` added to `package.json`.

**Numbers**
- Mixer wasm 24,761 B (24.2 KB) against the 150 KB gate; the test-hooks wasm 24,793 B. Unoptimised (no `wasm-opt`).
- Schema hash `4acdb631…`; source hash `ad87c445…`; ABI 1.0.
- `cargo test` green (43 tests). `npm test`: only the baseline `plugins.test.ts` failures; the timeouts pass when rerun alone.
- Chromium e2e: 193 passed, 3 failed. `particles.spec.ts:168` is in the baseline; `physical.spec.ts:41` and `shadergraph.spec.ts:72` passed when rerun alone (flakes).

**Deviations from the design**
- §4.1's kinds table had a garbled row. STREAM_OPEN is kind 5, and HRIR data is a `format = 2` CLIP_CHUNK rather than a kind of its own. Fixed in `api-and-models.md` and the tree.
- The error codes, which the spec left open, are -1…-16 in `schema.rs`. A0.1's provisional codes were mapped onto them.
- The vectors live in `crates/audio-wire/vectors/wire.json`, not `native/audio/vectors/` (§4.4), so they stay in the crate A0.2 owns.
- `backend.ts` stays in `src/engine/audio/` and the plugin re-exports it. Moving it would make the engine import the plugin, which `plugins.test` forbids. It moves at BB2 (noted on #72).
- `spatialAudio.test.ts` needed more than an import change: `vi.resetModules` and `applyTestPlugins`, because the plugin setup loads Howler before the mock applies.
- `AudioBackendSetting` still lists `"howler"` and `"fmod"`, for the FMOD code A0.5 deletes (noted on #57).
- The §5 ABI table has no `stream_open` export, which B3 needs (noted on #93).
- The generated Rust has 54 `unused_mut` warnings. To fix in the generator at a later schema touch.

**Bugs the leaves caught:** L4's hand-derived vectors found a codec offset bug (each body written over its header). It was fixed in `gen/codec.rs`; the generated readers and writers never had it. The coordinator's review found that the first fuzz couldn't tell a refusal from a bounds error, which led to `WireError`.

**Reserve used:** none.

## Owner decisions (2026-11-09)

- One-shots get **no completion `Promise`** in M1: scripts poll `handle.playing`. Recorded in ADR 0157's open questions, and #69 is closed.
- H0: no letter for now. The owner handles the licence follow-ups (the letter, and checking IRCAM's page before B7). #51 is closed.
- A0.7's WebKitGTK check runs in a **Docker container** (Xvfb, a PulseAudio null sink, the monitor recorded and the tone checked in the signal) rather than on an owner machine. Docker Desktop with the Linux engine is available on the build machine.

## MS1 wave 2 (A0.3, A0.10, A0.5)

Leads: A0.3 Opus with three Haiku leaves (L1 `bufferPool.ts`, L2 `counters.rs`, L3 `unlock.ts`). A0.10 ran as one Haiku worker and A0.5 as one Sonnet worker, each reporting to the coordinator. No merge conflicts.

**Landed**
- A0.3 (#55): the loader (compile on main, a 64-page imported memory, schema-hash and ABI checks, `CoreLoadError`), the worklet `processor.ts` and the `coreDriver` it shares with Node tests, the host and `CoreLink` in `context.ts`, the unlock layer, the buffer pools (8 × 16 KB STATUS, 4 × 64 KB BATCH), and the status writer in `audio-core` serialising every K1 field from `counters.rs` (K12). `probe.ts` is a stub returning "supported" that `service.ts` calls (K8). There's a dev-only tone page at `src/plugins/audio/runtime/worklet/devTone.html` (in `npm run dev`, click to hear 440 Hz). The tone is a sine mixed by the shell, since voices land in A1.2.
- A0.10 (#56): the Blink sources §5 lists, staged byte-identical under `native/audio/third_party/blink/` from Chromium `cbba46fd94646232cfd2318ac962138c2a98c1f9`, with `PROVENANCE.md` (SHA-256 per file), `PORTS.md` with the header template, the notices (Blink BSD-3-Clause, microfft MIT, libm MIT), and `portsNotices.test.ts`.
- A0.5 (#57): FMOD is removed (backend, test, guide, Engine wiring, editor fields, types). `"fmod"` and `"howler"` remain only as parser inputs that report problems.
- Coordinator: the engine library build ships `myco_audio.wasm` beside its chunks (`BESIDE_BUNDLE`, which now resolves `../` paths). The player, editor and engine builds all carry the wasm and the worklet processor chunk.

**Numbers**
- Mixer wasm 28,621 B (28.0 KB) against the 150 KB gate. Source hash `a04e02aa…`.
- `cargo test` 62 passed. `npm test`: 3,034 passed, and only the 3 baseline `plugins.test.ts` cases fail. `npm run build` green. Chromium e2e: 194 passed, 3 failed (`selection.spec.ts:48` is in the baseline; `physical` and `shadergraph` are the flakes seen in wave 1).
- Proved headlessly with the real wasm: identical init addresses; a STATUS block every 6 quanta; the ping echoed; 8 buffers circulating for 10,000 quanta with immediate RECYCLE; STATUS still flowing (every 48 quanta) with no batches; a trap giving silence plus a flag. In a real Chromium AudioWorklet: about 7.8 STATUS blocks/s with no rAF loop, the ready flag set, the ping echoed, 0 underruns. **Not yet heard:** the browser pane has no audio output. A0.7 checks the tone in the signal.

**Deviations**
- The status writer's state lives in the first `STATUS_AREA_BYTES` (about 16 KB) of the core-state region. Later carvers of that region start after it.
- `audio-core` keeps its own copy of the §4.3 offsets, because it doesn't depend on `audio-wire`. Two drift tests read the writer's output back through the generated readers, one in Rust and one in TS.
- The upstream file `reverb_input_buffer.*` doesn't exist at the pinned commit, and `reverb_convolver` doesn't need it. Helper headers (`audio_bus`, `vector_math`, `fft_frame`, `direct_convolver`…) aren't staged; each port fetches what it needs from the same commit (noted on #87).
- `THIRD_PARTY_NOTICES.md` and the design had libm as "MIT OR Apache-2.0". Its 0.2.16 `Cargo.toml` says MIT; corrected.
- `autocrlf` rewrote the staged Chromium files on checkout and broke their hashes. `native/audio/third_party/.gitattributes` (`* -text`) keeps them byte-exact.

**Reserve used:** none.

## MS1 wave 3 (A0.7, A0.8, A0.6, A0.9)

Leads: A0.8 Opus with one Haiku leaf (L1 `audioLifecycle.test.ts`); A0.6 Sonnet with two (L1 `probe.ts`, L2 `probe.test.ts`). A0.7 and A0.9 ran as single Sonnet workers. No merge conflicts.

**Landed**
- A0.7 (#58), the MS1 → MS2 gate, **passed**:
  - **WebKitGTK 2.52.6** in Docker (`tools/audio-smoke/`, one script: Xvfb, a PulseAudio null sink, the monitor recorded): after an `xdotool` click, 440.0 Hz at RMS 0.0707 (-23 dBFS), exactly the dev tone's 0.1-amplitude sine. **With no gesture the context stays `interrupted`**, and `media-playback-requires-user-gesture` off doesn't lift that. A construct-only website autoplay policy of ALLOW does, but wry/Tauri doesn't expose it, so on Linux the unlock layer's first gesture starts audio. AudioWorklet and SIMD are present.
  - **WebView2** (Chromium 157, the Tauri dev shell): **running at load with no gesture**. The tone was confirmed by a WASAPI loopback capture at 440 Hz, and was silent with the tone off. The loopback level is 2.3× the expected RMS, probably Windows audio processing (not verified).
  - **Second World:** in Chromium, two Worlds get one host and one AudioContext.
- A0.8 (#59): the host is a page singleton reached only through `acquireAudioHost`; World shares (keys 1..255); `releaseWorld`, then `onIdle`; `reconfigure` bumps `busEpoch` and remaps buses by name, unknown names to the root; `pendingPreset` for the rebuild; `connectHostToEngines`, with `Engine._onAudioConfigured` carried by a small `src/engine/core/audioConfigure.ts` registry so the plugin doesn't import Engine. 23 lifecycle tests, and a singleton test running the real `load()`.
- A0.6 (#60): `probe.ts` checks AudioWorklet, `simd128`, `getOutputTimestamp` and MessageChannel, then gives one warning and falls back to `"babylon"` (12 tests). `docs/guide/audio-minimum-versions.md`. In Playwright WebKit and Firefox, `addModule` and node creation work on a suspended context, so the "create the context in the gesture" fallback isn't needed. `getOutputTimestamp` is Safari 14.1 (below the `simd128` floor). Android System WebView matches Chrome (AudioWorklet 66, SIMD 91), so a never-updated WebView on Android 7–8 gets the fallback. At C3, record the phone's WebView version; Google Play sets no minimum OS.
- A0.9 (#61): `Unlock.watch()` re-arms on `interrupted`, and on `suspended` unless the page suspended on purpose (the host's `pageSuspended` flag, which A3.4b drives). 15 tests.
- Coordinator: the architecture §9 matrix filled from these measurements; A0.8's seams noted on #63, #65, #66, #84 and #86.

**Integration fixes at the merge**
- A0.8's singleton test was written against the probe stub. With A0.6's real probe merged, its fake context lacked `getOutputTimestamp` and the core was refused. Added to the fake.
- A0.9 saved `unlock.ts` with a cp1252 `§`. Vitest and tsc accepted it, but rolldown refused it, so `npm run build` failed. Re-encoded as UTF-8, and no other non-UTF-8 source remains. **For future briefs:** check `npm run build`, not only typecheck and vitest, on any task that adds non-ASCII text.

**Numbers:** wasm unchanged (28.0 KB). `cargo test` 62 passed. `npm test`: 3,075 passed, with the 3 baseline failures plus `piratesSample` (a known timeout that passes alone). `npm run build` green. Chromium e2e: 194 passed, 2 failed (`selection.spec.ts:48` is in the baseline; `physical.spec.ts:41` is the known flake).

**Deviations**
- A0.6 linked its guide page from `docs/README.md`, a coordinator file. Kept.
- A0.8 added `src/engine/core/audioConfigure.ts`, outside its file list, to keep the renderer out of `service.ts`'s imports.
- The owner's machine wasn't needed for A0.7 (Docker), but container timing isn't a soak: C3 still needs real Linux hardware or the owner's decision.

**Reserve used:** none.

## MS1 complete (2026-11-09)

Exit check met with `backend: "core"`: a tone after a click in Chromium (dev page), WebView2 and WebKitGTK (A0.7); STATUS flows with frames stopped (A0.3); FMOD gone (A0.5); an old engine gets one warning, then the fallback (A0.6). Typecheck, `npm test`, `npm run build`, `cargo test` and Chromium e2e are at the baseline, and the committed wasm matches its source hash. The default backend is unchanged (`"babylon"` is still Howler). Ready for the owner's approval to merge to master.
