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

Exit check met with `backend: "core"`: a tone after a click in Chromium (dev page), WebView2 and WebKitGTK (A0.7); STATUS flows with frames stopped (A0.3); FMOD gone (A0.5); an old engine gets one warning, then the fallback (A0.6). Typecheck, `npm test`, `npm run build`, `cargo test` and Chromium e2e are at the baseline, and the committed wasm matches its source hash. The default backend is unchanged (`"babylon"` is still Howler). Ready for the owner's approval to merge to master. Merged: master is at `8214a93`.

## Owner decisions after MS2 (2026-11-09)

- **HRIR (H0, #51):** option (a) confirmed, and no courtesy letter. Our copy comes from Chromium's Blink resources at `cbba46fd` (see `tools/hrir/PROVENANCE.json`). `Ircam-RnD/m4dp-audio-modules` (ISC) is not the source and holds no IRC_Composite data. Recorded in `hrir-licence.md`. The owner still checks IRCAM's terms page before B7.
- **HRTF memory:** the panner's about 300–315 KB at 16 voices is accepted. A3.5 raises architecture §5.1's 140 KB figure to the measured value instead of cutting voices. Shrinking it (fewer partitions, a shared spectrum cache, int16 kernels) is a follow-up for after the roadmap, not an M1 gate.
- **`npm audit` (DOMPurify via monaco-editor):** it was already in the tree before this work, so it doesn't block audio milestones.

## MS1 merged to master (2026-11-09)

The owner approved; master fast-forwarded to `a524ad8` and was pushed to origin.

## MS2 wave 1 (A1.2, A1.1)

Two Opus leads. A1.2 had four Haiku leaves (L1 `resample.rs`, L2 `ramp.rs`, L3 `pan.rs`, L4 `golden_native.rs`) and A1.1 had three (L1 `ids.ts`, L2 `handle.ts`, L3 `audioHandle.test.ts`). No merge conflicts. Every test leaf passed against its lead's implementation on the first merge, with no expectation changed.

**Landed**
- A1.2 (#62): core voices (`voices.rs`: slots, a live list, PLAY/STOP/SET_PARAMS/FADE, mixed or virtual, loops, ended reporting carried over when STATUS's list is full, round-robin playheads, late counting). `scheduler.rs`: `submit` validates every record before applying any; asap records apply at once; stamped records apply at their exact sample, splitting the quantum; a late record starts at offset 0 and is counted. `panner.rs` (K11): direction to azimuth by the W3C algorithm, then the gains of Blink's `equal_power_panner` (ported in `audio-dsp/src/pan.rs`), with the 2x2 gain matrix ramped linearly, so it stays continuous across azimuth 0. `clips.rs` (K11): the `ClipStore` API over a `Vec`, whose body A1.3b replaces. A linear resampler and ramps in `audio-dsp`. `myco_audio_submit` is live. A PLAY with a new generation replaces the voice in that slot (A1.1's steal contract), and the old id is reported once in `ended`.
- A1.1 (#63): the main-thread voice table (preallocated struct of arrays, a free list, generational ids, bus-then-global stealing, `endedReason` kept for one generation, a deduplicated stop/fade command queue for A1.4, `onFree` for `mixer.voiceEnded`, `remapBuses`, and `releaseWorld` hooked to A0.8's lifecycle listener). `AudioHandle` per §1. The STATUS mirror ignores stale ids, and frees ended voices in `onmessage` while the tab is hidden.

**Numbers:** mixer wasm 55,179 B (53.9 KB, unoptimised) against the 150 KB gate; source hash `c30277e2…`. 18 native goldens pass (one-shot, pitch, loop, stop and fade shapes, stamped and late records, spatial gains, moving source, generation replace), and so does `process_never_allocates` under a counting allocator. `cargo test` 129 passed. `npm test`: 3,141 passed, only the baseline failures. A 20,000-frame steady-state test shows the voice table and mirror don't allocate. `npm run build` green.

**Deviations and fixes**
- A1.2 added the `clips` field and accessors to `core.rs` (A0.1's file; no other writer this wave). `audio-core` now depends on `audio-wire` and `libm`.
- `portsNotices.test.ts` split lines on `\n`, so CRLF working copies on Windows failed the header check once `pan.rs`, the first real port, existed. It now splits on `\r?\n`.
- Not yet applied in the core: `lpHz`, bus routing, SET_MIXED, SET_PAUSED, SEEK, BUS_*, MASTER, RESET. These records are parsed and skipped by length; they land in later tasks.
- Follow-ups noted on #66 (A1.4): `readStatus` allocates a new block per message, and bus limits must be reset after a remap.

**Reserve used:** none.

## MS2 wave 2 (A1.3b, A1.3a, A1.4, A1.5, A1.7) and H1 started

Contracts K4 (`hostClock.ts`, the loopback host's signature in `testing.ts`) and K9 (the `clipRegistry.ts` interface) were committed first (`6ee93eb`). Leads: A1.3b Opus with one leaf (size classes); A1.3a Sonnet with two (pcm and chunker, the encoded cache); A1.4 Sonnet with one (the clock map); A1.7 Sonnet with three (the backend and spatial test rewrites, the loopback cases). A1.5 ran as one Haiku worker. H1 (MS6) started in parallel as the plan advises (Opus, three leaves), because the longest dependency chain runs through HRTF. No merge conflicts.

**Landed**
- A1.3b (#64): a size-class slab arena (4 classes per power of two from 4 KB, a free list per class, growth only in `clip_reserve`), the `ClipStore` body behind A1.2's K11 API, the clip ABI (`clip_reserve`, `chunk_ptr`, `commit`, `free`), clip events flushed into STATUS (resident, refusedGrow, refusedCeiling), arena counters, and RESET (clears voices and pending records, and clips unless `keepClips`). **Gap found and assigned to A1.3b:** the plan gave nobody the worklet shell's routing of CLIP_BEGIN, CLIP_CHUNK and CLIP_UNLOAD to the clip ABI. A1.3b added it to `coreDriver.ts` (sized from frames, never `bodyBytes`; 256 KB per quantum; views re-created after growth).
- A1.3a (#65): the clip registry (state machine, ids with an 8-bit generation that never reach the reserved HRIR range, refcounts and holders, unload deferred one frame), `decodeAudioData` on main, int16 conversion, paced CLIP_CHUNKs, the 32 MB encoded-bytes cache, and an optional `nextSeq` dep so the registry shares the port's envelope counter.
- A1.4 (#66): the command writer (pooled 64 KB BATCHes, carry-over, the overflow flag), a status reader into one preallocated block, `coreBackend` (plays, stops, fades, pitch, buses, pause through the voice table; clips through the registry; `onBusRemap` sends BUS_CONFIG and resets bus limits; BUS_MIX, MASTER; RESET 0 once nothing is live; spatial gains from A1.5's `spatial.ts`; `at` stamped on its frame), the clock map v1, the `debug.ts` stub (K10), and `service.ts` registering the core backend once the host starts.
- A1.5 (#67): ports of Blink's `distance_effect` and `cone_effect` to `spatial.ts`, plus a listener-space direction helper (55 tests, hand-derived values).
- A1.7 (#68): the browser and fake `HostClock`, `makeFakeBackend()`, `createLoopbackHost` on the real wasm in Node, and `audioBackend`/`spatialAudio` tests rewritten onto the fake (the Howler mock is gone).

**MS2's acceptance check passes:** in the loopback (`coreBackend.test.ts`), a WAV plays through the real wasm, registry, shell and `coreBackend`, and its end reaches `playing = false`. `audioLoopback.test.ts` runs a 440 Hz clip through raw records, ends reach STATUS, and status buffers return at once (no starvation idle, at 20 Hz or hidden).

**Numbers:** mixer wasm 63,333 B (61.8 KB) against the 150 KB gate; source hash `57f30108…`. `cargo test` 156 passed. Audio tests 320 passed (4 skipped: A1.7's coreBackend-shaped loopback cases, now covered by the coreBackend loopback test and left for A3.4a's REPLAY and B3b's seek). `npm test` at the baseline (timeouts pass alone). `npm run build` green.

**Integration fixes at the merge**
- A1.7's L2 found the fake backend's `setListener` copying engine `Vector3`s with a spread, which drops their getters. A1.7 copies x/y/z explicitly now.
- A1.7's `testing.ts` imported `node:fs/promises`, which broke `tsc -p tsconfig.engine.json` in `npm run build` but not `npm run typecheck`. It's now a variable specifier. **Lesson (again):** run `npm run build`, not only typecheck.
- `audioLoopback.test.ts` used voice id 7 (generation 0, invalid), so the core rightly dropped the PLAY. It now uses `0x0001_0007`.
- `coreBackend.test.ts`'s WAV check expected equal-power centring for a flat voice. A non-spatial mono voice plays at full level on both channels (A1.2's goldens, Web Audio's upmix); corrected.

**Deviations**
- Clip-memory ceiling: no new ABI export. The wasm Memory's `maximum` encodes it, the main-side registry checks it first, and a full arena reports refusedGrow.
- The arena's list heads live in the `Arena` struct (80 classes); the layout's 32 head slots are unused (noted in layout.rs).
- The status decoder makes `link.lastStatus` a reused block; listeners must copy what they keep.
- H1 notes for later tasks: no fft/2 convolver latency (H4 aligns its null tests by 256 frames, #90); the format = 2 layout for H2's converter (#88); the panner is sized by partition count (about 19 KB at 48 kHz, about 31 KB at 4 partitions), so 16 voices take about 300 KB at 48 kHz, more than architecture §5.1's 140 KB. To reconcile at A3.5.
- `npm ci` reports 2 audit findings (1 critical) in the existing dependency tree; not introduced here. To look at before MS2 reaches master.

**Reserve used:** none.

## MS2 wave 3 (A1.6), H2, and the milestone check

**Landed**
- A1.6 (#70, Sonnet lead, two Haiku leaves): the whole §1 public surface (K10): `playOneShot` returns an `AudioHandle`, never throws, and gives an inert handle on refusal (an unknown clip warns once); `Audio.volume`, a readable `muted`, `time`, `status`, `debug()`; `Bus.peak` (0 until A2.3); `AudioSource.priority = 128`; clamps with one warning each (volume, pitch 0.0625..16, priority 0..255, non-finite `at`, non-finite position); `at` ignored while locked; the locked queue (`unlockQueue.ts`: 32 one-shots within 1 s, owned and looping voices wait). The public types live in `src/engine/audio/backend.ts` and are re-exported from `myco.ts`. The `AudioBackend`/`AudioVoice` members are required, and the fakes and the Howler backend implement them. No completion Promise (the owner's decision).
- H2 (#88, Sonnet lead, two Haiku leaves): `tools/hrir/convert.mjs` turns the 240 IRCAM IRC_Composite_C WAVs (fetched from Chromium cbba46fd, provenance with SHA-256s) into `myco_hrir.bin`, the format = 2 table: **247,696 B** (44.1 kHz, 256 frames), against the design's ≈0.75 MB estimate. Delays are removed by the port of Chromium's group-delay extraction (10.74–46.11 frames); peak 0.835, no scaling. 53 of the 240 source files are byte-identical upper-hemisphere duplicates, consistent with Chromium's `kMaxElevations`. `hrir.ts` resamples (windowed sinc) and scales the delays to the context rate, then loads the table through `clipRegistry.acquireReserved` under the reserved id (not counted in the ceiling; re-sent on rebuild). `coreBackend` fetches it on the first spatial play and reports `hrtfReady` in `debug().core`. The asset ships beside the engine bundle (BESIDE_BUNDLE) and in the player and editor builds. The IRCAM notice and guide acknowledgement are added. **Open for H3:** the core doesn't accept format 2 yet (the wire convention is on #89).

**The milestone check found a startup race.** With `audio.backend: "core"` in flappy's project, the editor's first sound came before the core's World service finished loading, so `audioBackend()` cached the Howler fallback for the page and `"core"` never took effect. A fix worker made plays wait as locked voices in a stand-in backend while the core is loading. When the core registers they go to it, and on a real failure (`noteCoreUnavailable`) they go to Babylon/Howler with the single warning. Holders keep the same voice object, so AudioSource and handles need no restarts. `service.ts` now registers the core only after its first ready STATUS, and calls `noteCoreUnavailable` on a load error, ABI mismatch, shell error, or no STATUS within 5 s (nothing called it in those cases before). `audioSystem.ts` starts the service for any World with the view, so script-only one-shots don't wait forever; the core therefore also loads in the editor's edit World before Play (with `"core"` only). Verified in the browser, on the first Play after load: `CoreBackend`, logicalVoices 1, mixedVoices 1, 0 traps.

**MS2 exit check (with `backend: "core"`):** one-shots and AudioSources play with pitch, pan, distance and loops from `decodeAudioData` clips; the loopback plays a WAV through the real wasm; `audioBackend`, `spatialAudio` and `audioHandle` run green on the fake and loopback hosts; flappy's music plays on the core in Chromium (checked through `Audio.debug()` counters, since the browser pane has no audio output; not heard by a person).

**Numbers:** mixer wasm 63,333 B (61.8 KB; HRTF not linked yet); `cargo test` 198 passed; `npm test` 3,380+ passed, with only the baseline failures and known timeouts that pass alone; `npm run build` green; Chromium e2e 193 passed, 3 failed (`selection.spec.ts:48` in the baseline; `selection.spec.ts:147` and `shadergraph.spec.ts:72` passed alone).

**Not in MS2 / follow-ups:** `npm audit` shows a critical DOMPurify advisory via `monaco-editor` (the editor's code editor, not audio); its fix is a breaking Monaco downgrade, so it's separate work. `debug.ts` lists no voices yet (A2.5).

**Reserve used:** none.

## MS2 complete (2026-11-09)

Ready for the owner's approval to merge to master. Merged: master is at `8214a93`.

## Owner decisions after MS2 (2026-11-09)

- **HRIR (H0, #51):** option (a) confirmed, and no courtesy letter. Our copy comes from Chromium's Blink resources at `cbba46fd` (see `tools/hrir/PROVENANCE.json`). `Ircam-RnD/m4dp-audio-modules` (ISC) is not the source and holds no IRC_Composite data. Recorded in `hrir-licence.md`. The owner still checks IRCAM's terms page before B7.
- **HRTF memory:** the panner's about 300–315 KB at 16 voices is accepted. A3.5 raises architecture §5.1's 140 KB figure to the measured value instead of cutting voices. Shrinking it (fewer partitions, a shared spectrum cache, int16 kernels) is a follow-up for after the roadmap, not an M1 gate.
- **`npm audit` (DOMPurify via monaco-editor):** it was already in the tree before this work, so it doesn't block audio milestones.

## MS3 (BB1, BB2): Babylon replaces Howler

Run as two sequential waves, one Sonnet lead each, in their own worktrees (no Agent tool for the leads, so they wrote their leaves L1–L3 themselves). The coordinator gave BB2 the single-writer edits it needed (`package.json`, `package-lock.json`, `vite.engine.config.ts`, `Engine.ts`'s import, the Howler line in `THIRD_PARTY_NOTICES.md`); nothing else wrote them that wave.

**Landed**
- BB1 (#71): `src/plugins/audio/runtime/babylonBackend.ts`. AudioEngineV2 is created on the first play through a dynamic import of `AudioV2/webAudio/webAudioEngine`, with `resumeOnInteraction`, `resumeOnPause` and the unmute UI off. It runs on the core host's context when one exists ("core" that failed to load), else on one page context with the host's `Unlock` layer watching it. Mixer buses map to `AudioBus` (parents first, roots on the main bus); one `StaticSound` per voice over a per-URL shared buffer, `StreamingSound` for `stream` clips; setters before the sound is ready are applied when it is; `at` maps to `waitTime`; `maxVoices` is per-sound `maxInstances` plus a per-bus cap that stops the oldest voice. Pure mappings in `babylonMapping.ts` (bus plan, spatial settings, the listener quaternion, checked against Babylon's own matrix maths); AudioV2 mocks in `src/plugins/audio/testing/babylonMocks.ts`. `babylonImports.test.ts` now allows the audio backend, limited to `@babylonjs/core/AudioV2/*`.
- BB2 (#72): `applyMix` puts each bus's resolved gain (volume, mute, solo, snapshot, ducking) on its `AudioBus` with a 15 ms ramp; voice counts are exact for every way a voice ends, so ducking works. `howlerBackend.ts`, `howler` and `@types/howler` are gone. `busGraph.ts` is now the test-only `src/plugins/audio/testing/webAudioReference.ts` (for A2.2c's parity harness). `backend.ts` lives in `src/plugins/audio/runtime/`; `Engine.ts` imports `mixer` from `../audio/mixer`, and the engine still imports no plugins. Guide: the fallback's limits under Limits in `docs/guide/audio-mixer.md`. New `@slow` spec `tests/e2e/audio-babylon.spec.ts`.

**MS3 exit check:** `npm run build` green with no Howler (the only "howler" strings in `dist/` are the settings migration's problem text); `audioMixer.test.ts` ducking passes; flappy (the new spec) and pirates (the same check run against its menu's play-on-awake source) play on the default backend in Chromium: backend `babylon`, context running, a voice on its bus, no console errors. A0.6's fallback now lands on Babylon.

**Numbers:** `npm test` 340 files, 3,460 passed, no failures; Chromium e2e 193 passed, 4 skipped, 0 failed (BB2's run); `npm run build` green after a clean `npm ci`.

**Deviations and limits of the fallback (documented in the guide)**
- No stereo pan: nothing in `PlayRequest` or `AudioVoice` carries one.
- Streamed clips have no pitch (`StreamingSound` has no playback rate).
- A voice stopped by the bus cap reports `reason` null (the fallback has no "stolen").
- No bus effects and no snapshot low-pass: Babylon exposes bus nodes only through underscore internals.
- The host context is shielded from `engine.dispose()`'s `close()` while the backend tears down.
- A container restart stopped BB2's first lead; its uncommitted work was saved as a WIP commit, finished and verified by a second lead, and squashed into one commit.
- Fixed in passing: double-encoded `§` in `core/unlock.ts` comments.

**Reserve used:** none.

## MS3 complete (2026-11-09)

Ready for the owner's approval to merge to master.

## MS3 merged; MS4 wave 1 (A2.1)

MS3 merged to master (`d1e5287`, fast-forward) with the owner's approval; #71, #72 and #45 closed.

**Landed: A2.1 (#73, Opus lead, leaves written by the lead).** `audio-core/src/bus.rs`: the bus tree from BUS_CONFIG (bad parents and cycles repaired onto the first root, as `settings.ts` does; mixed deepest first), BUS_MIX gain ramped per frame from the next quantum, `lpHz` stored and ramped per quantum for A2.2a, MASTER volume and mute ramped; voices render into their bus's buffer (unknown index: bus 0). `fx.rs` (K5): 4 effect slots per bus fed from BUS_CONFIG's existing effect records, dispatching to pass-through stubs `audio-dsp/src/{biquad,compressor,convolver}.rs` that A2.2a and A2.2b fill; a slot that keeps its kind keeps its state. `meters.rs`: per-bus L/R peak after the bus gain, instant attack, −20 dB/s fall, the first 32 in STATUS `peaks`. BUS_CONFIG and BUS_MIX entries are checked before anything applies (an overrun refuses the batch). TS: after a remap, `configureBuses` sends each live core voice its new bus index in the same batch (the voices kept stale indices before); a loopback case shows bus volume, mute and the root multiplying.

**Numbers:** mixer wasm 76,913 B (75.1 KB; +13.6 KB with no DSP yet), source hash `c587faa0…`, rebuilt byte-identical at the merge; `cargo test` 241 passed; `npm test` 3,461 passed (one intermittent timeout on a first run, clean on two reruns); `npm run build` green.

**Decisions to carry**
- Meter decay is done in the core at the design's −20 dB/s, not on main; A2.3 reads `peaks` as they are.
- BUS_CONFIG, BUS_MIX and MASTER apply between quanta on arrival; `frameOffset` is ignored (nothing stamps them in M1).
- RESET clears bus DSP state and settles ramps but keeps the tree, gains and MASTER (main doesn't re-send BUS_CONFIG after the idle `RESET 0`; a rebuild gets a fresh core).
- **The reverb return is added before MASTER**, so master mute silences it. `webAudioReference.ts` sends reverb straight to the destination: A2.2c's parity scenes keep master at unity or account for this.
- Snapshot low-pass uses Q = 1 dB (Web Audio's default).
- Dropped buses and effects are counted in `BusArea.dropped`; the wire has no STATUS field for them.
- Per-bus `maxVoices` stays on main (BUS_CONFIG doesn't carry it).

**Reserve used:** none.

## MS4 wave 2 (A2.2b, A2.2a, A2.3, A2.4, A2.5)

Five workers in parallel, each in its own worktree from `4680d94`: A2.2b and A2.2a Opus leads, A2.3 and A2.4 Sonnet leads, A2.5 one Haiku worker. The leads had no Agent tool and wrote their leaves themselves. Coordinator grants: A2.4 the audio plugin's entry in `EDITOR_PLUGINS`; the A2.5 panel registration went through the coordinator into A2.4's `editor/index.ts`. The only merge conflicts were the committed wasm and `hash.json` (rebuilt from the merged source; each rebuild byte-identical to its inputs' expectation).

**Landed**
- A2.2b (#74, critical path): the shared reverb. A zero-latency staged convolver: one head stage of 32 × 128-frame partitions on a 256-point FFT (overlap-save) over the first 4,096 frames, then 2,048-frame tail stages on 4,096-point FFTs that share one frequency-domain delay line (one forward and one inverse FFT per channel per block), the accumulation buffer ported from Blink, and transforms staggered across a 16-quantum cycle (Blink's `convolver_render_phase`) so no quantum runs more than one 4,096-point transform. The IR is generated sample by sample (mulberry32, seed `0x4D59434F`, the `makeImpulse` shape: 1.8 s, decay 3) and normalised as Blink's `reverb.cc` does. FFTs are Myco code (`convolver/fft.rs`) on microfft's 16-point transform only. All memory is in the layout's reverb region: 3,015,744 B at 48 kHz.
- A2.2a (#75): Blink's biquad (`SetLowpassParams`, `SetHighpassParams`, single-precision `pow10` for Q in dB, double history) and `dynamics_compressor.cc` (knee and its 15-step `k` search, makeup gain, detector, adaptive release polynomial, sine warp, linked stereo detection, 6 ms pre-delay).
- A2.3 (#76): the core backend's `voiceStarted/voiceEnded` already count virtual and locked voices; a bus remap used to zero the mixer's counts while voices lived on, so `configureBuses` now restores them from the voice table. `Bus.peak` is max(L, R) from STATUS each frame, 0 while not running and past 32 buses; a remap drops stale peaks.
- A2.4 (#77): Project Settings > Audio moved into `src/plugins/audio/editor/` with every §7 control (per-bus max voices, the voices preset and numbers, spatial, background, clip memory, clip format, AAC, backend), `BusMeters` during play (dB from −60, writes `transform` only on change), and the underruns play stat. Presets: default = the parse defaults (128 / 4,096 / 16); low (48 / 1,024 / 4 HRTF / 64 MB; only the 4 HRTF is from the design, the rest provisional until C3) and high (256 / 8,192 / 32 / 256 MB) were chosen by the worker.
- A2.5 (#78): `Audio.debug()` buses and voices from the voice table, mirror and mixer; the Audio Debug panel (4 Hz, theme tokens). `playheadSeconds` and `owner` read null until something on main sets them.

**MS4 wave 2 numbers:** mixer wasm 96,540 B (94.3 KB; +17.6 KB this wave), source hash `61bd5c8d…`; `cargo test` 280 passed; `npm test` 342 files, 3,483 passed; `npm run build` green; project settings and `audio-babylon` e2e specs pass (10).
- Reverb: max error against f64 direct convolution 2.0e-7 to 4.4e-7 of peak (gate 1e-6); native 0.025–0.030 ms average per quantum, p99.9 0.10–0.20 ms (gates 0.1, 0.35 ms); the wasm build measured the same in Node.
- Biquad coefficients within 1.15e-8 of the cookbook; compressor within 7.3e-7 of a line-by-line upstream reference (tolerance 1e-5); default makeup +3.66 dB.
- 32 buses × (lowpass, highpass, compressor, snapshot low-pass): about 0.2–0.3 ms per quantum native.

**Accepted deviations (coordinator)**
- A2.2b: microfft's large sizes inline their recursion (+92 KB for 4,096 points), so the FFTs are built on its 16-point transform; H1's HRTF FFT isn't reused (its size dispatch pulls every size, +28 KB). **H3 will bring those 28 KB when it links HRTF** (budget: about 122 KB of 150 KB).
- A2.2b: the tail shares one frequency-domain delay line instead of Blink's per-stage FFT pairs (same output, about a tenth of the transforms); the head is one 256-point stage (architecture §6.1) instead of Blink's direct stage plus doubling stages.
- A2.2b doc corrections, recorded here rather than editing the design: architecture §5.1's reverb memory is about 3.0 MB at 48 kHz (not 2.7 MB); Chromium at the pinned commit runs every reverb stage on the audio thread (architecture says a background thread for the tail).
- The convolver runs only while a send exists; removing every send freezes the tail, which resumes from stale state (A2.1's behaviour; to revisit if audible).
- A2.2a: the pre-delay line is sized for 48 kHz (288 frames; held above 48 kHz); no reduction metering; parameters clamped to `DynamicsCompressorNode`'s ranges; `reset()` gives a fresh node's state.
- Integration fix: A2.5's panel imported `editor/session`, which `plugins.test.ts` forbids; it reads `editor.scene.playState` through the SDK now.
- Staged `reverb.cc` (A2.2b's normalisation) in `native/audio/third_party/blink/` with its SHA-256; PORTS rows for A2.2a and A2.2b updated. `THIRD_PARTY_NOTICES.md` already covers the Blink files through PORTS.md.

**Open:** per-bus memory is 10.9 KB (32 buses ≈ 350 KB, design ≈ 3 KB per bus) because every effect slot reserves a compressor; a coordinator task moves the compressor out of the slot union (wave 3).

**Reserve used:** none.

## MS4 wave 3 (A2.2c, A2.6, A2.7) and the bus-memory change

Four workers in parallel from `5e9918f`: A2.2c, A2.6 and A2.7 Sonnet leads, and an Opus worker on the coordinator's bus-memory change. No conflicts besides the committed wasm.

**Landed**
- Bus memory (coordinator): `FxState`'s union is gone; a bus holds its slots (152 B each: kind, params, a biquad) and **one compressor outside them**. A second compressor is dropped, counted in `BusArea.dropped`, and keeps its place. `BUS_BYTES` 10,944 → 4,224 B (32 buses ≈ 350 → 135 KB; just over the ≈4 KB target, the rest is the 2,400 B compressor and the bus buffer). Output unchanged: every golden and port test passed unedited, and A2.7's exact-hash goldens (recorded before this change merged) pass after it. The settings parse now reports more than 4 effects or a second compressor on a bus (kept as authored; the core skips them); the guide says so.
- A2.6 (#80): `samples/sound-lab` (`backend: "core"`; buses with highpass, lowpass, compressor and a reverb send; an "Underwater" snapshot; SFX ducks Music; a moving spatial loop; one script per feature on keys 1–6; tones from the deterministic `tools/makeTones.mjs`, ≈200 KB). Samples are discovered from `samples/*`, so no shared file changed. `tests/e2e/audio-core.spec.ts` (`@slow`) drives one-shots, bus mute, the snapshot, ducking and the moving source through `Audio.debug()` and `Bus.peak`. Underruns: 0 at start, **at most 2 by the end** (headless software rendering shares the CPU; a real fault underruns every quantum). The soak gate's strict zero applies to the gate machines (C3).
- A2.7 (#81): `quality_thdn.rs` (resampler THD+N and image/alias spurs), `quality_null_pan_limiter.rs` (in `audio-core/tests/`, since it drives the core), `audioGolden.test.ts` with 16 scene digests (exact SHA-256 of the f32 output, plus per-block RMS and peak for the failure message; `UPDATE_GOLDENS=1` rewrites), and `.github/workflows/audio-quality.yml` (the repository's CI ran only CodeQL; it now runs `cargo test --workspace --locked` and the audio Vitest on changes under `native/audio/` and `src/plugins/audio/`; first run on master).
- A2.2c (#79): 100 parity scenes (lowpass and highpass sweeps with Q in dB at 48 and 44.1 kHz and the clamps, the snapshot low-pass, the compressor's static curve, steps, noise and pre-delay, the reverb wet and dry, pan at 13 directions), rendered by Chromium's `OfflineAudioContext` with `webAudioReference.ts` and by the core in Node, compared in third-octave bands, envelopes, levels, decay curves and full-waveform nulls. `webAudioReference.ts` now builds the core's seeded IR bit for bit (fed raw to a normalising `ConvolverNode`) and can set gains outright. Committed digests (`reference.json`, 184 KB) let `webAudioParity.test.ts` check the core in Node without a browser (101 tests, ≈3.5 s). An HRTF hook is left for H4.

**Numbers**
- Parity (Chromium 156, core minus reference): biquad and compressor 0.000 dB on every level measure, waveform nulls exact or −103 to −165 dB; compressor pre-delay click at the same frame (288 at 48 kHz); reverb at most 0.01 dB (nulls −104.5 dB at 48 kHz, −109 dB at 44.1 kHz); pan 0.000 dB (nulls exact to −126 dB). No core bug found.
- Quality (linear resampler): THD+N −153.7 dB at whole-number ratios; at 1 kHz −66.4 dB (pitch 1.5) to −47.3 dB (0.5); 10 kHz a semitone up −23.4 dB. **Alias rejection 0 dB** (no anti-alias filter; pinned by a test to flip when M1a.3's resampler lands). Unity null bit-exact; pan power within 2.5e-7 dB through the core (limit 0.01 dB). Thresholds for THD+N and spurs were set from the measurements (design: "set at M1a.3, then ratcheted").
- Mixer wasm 96,641 B (94.4 KB), source hash `7972447e…`; `cargo test` 295 passed, 3 ignored; `npm test` 344 files, 3,605 passed; `npm run build` green.

**Findings for the owner**
- **No master limiter exists, and no task in the plan owns one.** `api-and-models.md` §5 lists `limiter` among `audio-dsp`'s modules and §8 gates "limiter at or below 0 dBFS", but §9's task table never assigns it. Four full-scale voices peak at +12 dBFS; A2.7's ceiling test is `#[ignore]`d.
- **The ADR has no dB figure for parity.** "The ADR's dB tolerance" points at nothing. A2.2c set 0.1 dB on level measures and −90 dB (reverb −80 dB) on waveform nulls, each at least 10× above what it measured.

## MS4 exit check

- Parity spec: passes in Chromium (5 groups; the HRTF group is a `fixme` for H4). **WebKit and Firefox parity in Docker were not run here.**
- Sound-lab spec: passes.
- Mixer wasm 94.4 KB ≤ 150 KB.
- Editor during play with `backend: "core"` (sound-lab, checked in Chromium with screenshots): Project Settings > Audio shows the meter strip; Window > Audio Debug shows status running, backend core, 0 underruns, per-bus gain and peak (Music 0.19, Ambience 0.02) and both loops as playing voices. Cosmetic: "Mixed voices 2 / 0" (`mixedCap` isn't reported until A3.3).
- Chromium e2e: 192 passed, 1 failed, 4 skipped. The failure, `codefiles.spec.ts:38` (the TypeScript worker starts within 20 s), is a pre-existing flake: 2 of 4 repeats fail on master `d1e5287` too, and 2 of 4 on this branch.
- `@slow` audio specs (parity, sound-lab, babylon): 7 passed, 1 skipped (HRTF).

**Reserve used:** none.

## MS4 complete except the limiter (2026-11-10)

Waiting on the owner: the limiter (where it goes) and the parity tolerance; then approval to merge.

**Owner decisions (2026-11-10):** add the master limiter now as a follow-up task in MS4 (A2.8), then merge MS4 once it passes. The parity tolerance stays as A2.2c set it (0.1 dB on levels, nulls below −90 dB, −80 dB for the reverb), recorded in `api-and-models.md` §8.

## MS4 A2.8 (master limiter) and MS4 complete

**Landed: A2.8 (#105, Opus lead).** `audio-dsp/src/limiter.rs`, written here: one gain from max(|L|, |R|), **after MASTER** (the last stage of `bus::mixdown`, so turning master down means less limiting), **zero latency with an instant attack**: each frame gets `CEILING/peak` and is clamped, so the ceiling holds exactly; a 10 ms hold, then a 60 ms exponential release (back within 0.1 dB about 240 ms after the last peak), both scaled to the rate. Under the ceiling it is an exact bypass (no delay, gain exactly 1, the quantum isn't written); a reduction under 1e-5 snaps back to bypass. Four scalars in `BusArea`, no layout region, no wire change (`BusArea.limited` counts quanta it touched, for tests). NaN and infinity are silenced; RESET clears it.

**Deviations from what the owner approved (coordinator flagged them to the owner at the merge):**
- **No look-ahead.** The owner chose "about 1.5 ms look-ahead, ceiling just under 0 dBFS". The worker chose zero latency so nothing moves in time unless the signal really clips (timing goldens and parity alignment stay exact). The cost: the first over-the-ceiling half-cycle is shaped while the gain falls.
- **Ceiling exactly 0 dBFS (1.0).** −0.3 dBFS limited a single normalised voice alone, changed the `pitch-up` golden and broke 13 native tests that play a full-scale clip by itself. No margin for overs between samples. `CEILING` is one constant.

**Changed tests:** four native tests that summed above 1.0 now set MASTER 0.25 and scale their expectations (exact in f32). Goldens: `spatial-gains` (peak 1.070 → 1.0) and `bus-mute` (1.059 → 1.0) re-recorded; the other 14 byte-identical. Parity: ten high-Q filter scenes resonate above 0 dBFS, so `coreRender.ts` renders with MASTER at 1/16 and multiplies back by 16 (powers of two: bit-exact to the unlimited mix) and throws if any output sample reaches 1.0; `reference.json` unchanged, every measure still 0.000 dB.

**Numbers:** mixer wasm 97,792 B (95.5 KB, +1,151 B), source hash `0514ecf1…`, rebuilt byte-identical at the merge; limiter about 0.0005–0.0009 ms per quantum native while limiting, 0.00017 ms bypassed; `cargo test` 311 passed, 3 ignored (A2.7's ceiling test now runs and passes); `npm test` 344 files, 3,605 passed (one intermittent timeout on a first run); `npm run build` green; `@slow` audio specs 7 passed, 1 skipped (HRTF).

**Reserve used:** none.

## MS4 merged (2026-11-10)

Merged to master with the owner's approval ("when the limiter lands, merge MS4").

## MS5 wave 1 (A3.1, A3.2) and A2.9 (the limiter look-ahead)

MS4 merged to master (`85080c9`); its issues closed. Owner decisions (2026-11-10): add the limiter's look-ahead and keep the 0 dBFS ceiling, as a project setting in milliseconds (`audio.limiterLookaheadMs`, default 1.5, 0..5, applied when the core starts); add A3.6, a 4-point resampler, to MS5 wave 2 (#106). Three Opus leads in parallel from `85080c9`.

**Landed**
- A3.2 (#83): most of the clock and scheduler existed from A1.2 and A1.4. Added `lookahead.ts` (pure L, ramps, `firstFrame`, the stamp-or-asap rule), re-anchoring on the first timestamp after a gap (it waited for 10 rejections), timestamp sanity in `browserHostClock`, §8's timing fields in `Audio.debug().core`, and scheduler and loopback tests: `at` lands **exactly** on its frame; late records counted (lateness 408 frames with a host clock 10 ms behind); far-future `at` waits. Choice accepted: an `at` not after the frame the core will be rendering when the batch arrives (up to about Λ ahead of `Audio.time`) goes asap and isn't counted late.
- A3.1 (#82): `selection.ts` each frame over all logical voices: audibility = gain × fade × bus effective gain × (1 + priority/255); `quickselect.ts` (three-way partition, median of three, O(n), no allocation or recursion) for the top `min(voices.mixed, mixedCap)`; 1.2× hysteresis and a 3-frame dwell; inaudible Worlds and paused voices forced virtual; a bus over `maxVoices` has its excess stolen (lowest priority, then audibility). The core applies SET_MIXED with 5 ms fades (demoted voices keep time; promotes resume on the right frame; a promote mid-demote turns round), and has `voices::demote`/`demote_lowest` for A3.3. Fix: a voice stolen while on the core kept sounding until its slot was reused; it's stopped with a 5 ms fade now. `Audio.debug()` shows `"stolen"` (last 60 frames) and `"busMuted"`.
- A2.9 (#107): `limiter.rs` keeps A2.8's path for 0 ms (bit-exact against a copy of A2.8) and adds the look-ahead: a running max of the needed reduction over D+1 frames, A2.8's hold and release on it, then a box-filter average with an integer running sum (exact, no drift); the ceiling still holds exactly and a step becomes a linear ramp that lands on the peak. Latency `round(ms × rate / 1000)` frames (72 at 48 kHz for 1.5 ms); the delay line is 480 frames (5 ms at 96 kHz; at 192 kHz the longest look-ahead is 2.5 ms). New export `myco_audio_set_limiter_lookahead` after init (**ABI 1.1**); the setting, an editor field, the preset path, and `ClockMap`'s `outputLatencyFrames` (subtracted from `Audio.time`; `at` is heard on its frame at 0 and 1.5 ms).

**Numbers**
- Selection, 4,096 voices: p50 0.067 ms, p99 0.097 ms at cap 128; p99 0.131 ms at cap 256 (gate 0.25 ms).
- Limiter, a sine 6 dB over, error against the scaled sine over the first 20 ms (instant → 1.5 ms look-ahead): 100 Hz −18.0 → −27.0 dB, 440 Hz −24.4 → −45.7 dB, 1 kHz −27.9 → −55.5 dB. Cost 0.0018 ms per quantum while limiting.
- Goldens re-recorded at 1.5 ms: 14 of 16 are the old output delayed 72 frames, bit for bit; `bus-mute` and `spatial-gains` differ only where they limit. Parity renders at 0 ms; `reference.json` unchanged.
- Mixer wasm 102,482 B (100.1 KB), source hash `4f78cbbb…`, ABI 1.1; `cargo test` 330 passed, 3 ignored; `npm test` 351 files, 3,673 passed; `npm run build` green; parity, sound-lab, babylon and project-settings e2e 16 passed, 1 skipped (HRTF).

**Integration fixes at the merges**
- `scheduler.rs`: A3.1 added SET_MIXED's dispatch (12 lines) beside A3.2's tests; merged cleanly.
- `CoreBackendHost.preset` carries both A3.1's `maxMixed` and A2.9's `limiterLookaheadMs` (the one source conflict).
- A3.1's `mixed_virtual.rs` checks fades frame by frame in core time, so it runs the core at 0 ms look-ahead.

**Open, assigned in wave 2**
- Nothing tells selection which World has the view (`CoreBackend.setWorldAudible` exists, untested end to end): A3.4b.
- The core's `score` (for its own lowest-score demote) is sent only with PLAY: A3.3 refreshes it.
- `Audio.debug()`'s `mixedCap` is 0 until A3.3.

**Reserve used:** none.

## MS5 wave 2 (A3.4a, A3.3, A3.4b, A3.6) and A3.7

K6 (`recovery.ts`'s `rebuild(reason)` stub) was committed first (`0caec02`). Four leads in parallel from `b1a1dad` (A3.4a, A3.3, A3.6 Opus; A3.4b Sonnet), then A3.7 (Opus, #108, opened when A3.4b found the gap) once A3.6 freed `voices.rs`.

**Landed**
- A3.4b (#86): `deviceChange.ts`, the pure §3.7 classifier (closed → device rebuild; rate changed → rate rebuild; no STATUS for 1 s while running and visible → stall rebuild; interrupted → resume, then device rebuild after 2 s; an outside suspend → resume). `background.ts`: on hidden, `mute` ramps master to 0 over 50 ms, `pause` fades over 30 ms then suspends the context, `play` changes nothing; ended voices are freed from STATUS handling while hidden; the clock re-anchors on visible. **Fix:** `audio.background` never reached the backend. Plays carry their World's key and `audioSystem` reports which World has the view (`setWorldAudible`), so Worlds without the view go virtual and return in time. The Babylon fallback gets mute and pause (owned context only).
- A3.6 (#106): `resample::lagrange` (4-point, 3rd-order Lagrange; beat Catmull-Rom by up to 20 dB on A2.7's rows), the same position arithmetic as `advance`, wrap across the loop seam, edge hold; bit-exact to linear at whole-frame positions. **Alias rejection is unchanged** (0 dB at whole ratios, 0.8–1.5 dB weaker than linear near Nyquist at fractional ratios): it needs band-limiting (the worker proposes an octave mipmap of each clip with half-band levels); the tests pin what is achieved. #106 stays open for the owner's decision.
- A3.3 (#85): `cap_controller.rs` (§6.3's table: drop to max(16, ⌊0.85·cap⌋) on an underrun, a qualifying late command or work-unit p99 over 70%, hold 1 s; recover after 5 s calm under 55% by max(2, configured/32) per second). `cap.rs`: a work-unit model with named coefficients (`wu::MIXED_VOICE` 1,150 for A3.5 to re-measure), a 250 ms p99 kept as the top k, late commands gated on on-time negative-slack batches, `mixedCap` and flag bit 3, and a one-pass lowest-score demote (A3.1's measured about 0.9 ms for 39 demotes among 4,096 voices; this one 18 µs). New export `myco_audio_note_underruns` (**ABI 1.2**). Main re-sends a mixed voice's score when its audibility moves more than 3 dB (at most 64 per frame); `Audio.debug().counters.mixedCap` shows the real cap.
- A3.4a (#84): a trapped core is never called again (silence, one `trap` event); `processorerror` counts as a trap. `AudioHost._replaceCore` makes a new node and Memory in the same context and rebinds `CoreLink` (no new link). `recovery.ts` allows 3 rebuilds per sliding 60 s (`rateLimit.ts`); the 4th leaves the host `"failed"` and silent with one warning, no switch to Babylon. `replay.ts`: RESET 0, BUS_CONFIG, BUS_MIX and MASTER in one REPLAY; the registry re-sends every clip (HRIR first, then by voice priority, from kept bytes); voices replay in stamped chunked REPLAYs as their clips return, positions from a main-side playhead tracker. Test hook `myco_audio_debug_trap_next` (test-hooks feature only).
- A3.7 (#108): the core applies SET_PAUSED: a mixed voice fades out over 5 ms then holds (no rendering, no advancing; it holds at the frame its fade ended, since the 192-byte slot is full), a virtual voice holds at once, resume continues from the held frame through selection's promote. A voice paused before it reached the core (locked or loading) now gets SET_PAUSED after its PLAY.

**Numbers**
- A3.6: THD+N at 1 kHz from −66.4 / −64.9 / −47.3 dB (pitch 1.5 / semitone up / 0.5) to −123.3 / −112.5 / −85.2; 10 kHz a semitone up −23.4 → −35.6; worst spur −49.1 → −87.0 dBc. Cost per mixed voice per quantum in wasm about 1.4–1.9 µs mono f32 (linear 0.93) and 2.4–2.9 µs stereo i16 (measured under heavy load). Nine fractional-pitch goldens re-recorded; parity unchanged.
- A3.3: loopback, 40 configured: a 60 ms stall → cap 34, the 6 quietest demoted; back to 40 after 5 s calm. Selection with the score refresh: p99 0.095 ms (cap 128), 0.120 ms (cap 256).
- A3.4a: loopback, sound back 24 quanta (≈64 ms) after a trap, position within one quantum; Chromium (Sound Lab), a rebuild in 350 ms, Music back at the same level.
- Mixer wasm 115,724 B (113.0 KB), source hash `862929c1…`, ABI 1.2; `cargo test` 380 passed, 4 ignored; audio Vitest 56 files, 800 passed; `npm test` 358 files passed; `npm run build` green; `@slow` audio specs 7 passed, 1 skipped (HRTF).

**Integration fixes at the merges**
- `debug.ts`: A3.3's `mixedCap`, A3.4b's background counters and A3.4a's `recoveries`/`rebuilds` all kept.
- `context.ts`, `coreDriver.ts`: A3.3's, A3.4b's and A3.4a's fields kept; the driver stops after a trap raised by A3.3's `myco_audio_note_underruns` instead of calling the dead core's `process`.
- `sendPlay`: A3.4a's playhead tracking and A3.7's SET_PAUSED kept; `cap::demote_lowest` skips paused voices, as `voices::mixed_live` does.
- The selection benchmark failed its gate several times under parallel load (load average up to 12 on 4 cores) and passed alone each time.

**Open**
- Device and rate rebuilds happen in the same context (§3.7 asks for a new context at the device rate): A3.4c (#109), approved by the owner.
- A rebuild keeps the running preset (`pendingPreset` isn't applied).
- Playheads come from a main-side estimate; the core's `wantsPlayhead` round-robin reports only the STATUS quantum's batch.
- Pitch isn't in the work-unit model (needs a pitch sum from the render); coefficients to be measured in A3.5.
- Wasm headroom: 113.0 KB of 150 KB, and H3 is expected to add about 28 KB. `wasm-opt` isn't installed here.

**Reserve used:** none.

**Owner decision (2026-11-10), A3.6 (#106):** accepted as built and closed. Professional samplers band-limit (windowed sinc, multisampling); game middleware mostly doesn't (FMOD's default resampler is linear; the browser's `AudioBufferSourceNode` is linear), and the 4-point resampler is at or above that. Aliasing is audible only for large pitch-ups (≥ about 1.5×) of bright content; the guide says so (`docs/guide/audio-mixer.md`, Limits). Band-limited resampling (octave mipmaps with half-band levels, per clip or as a quality setting) is a post-M1 option, #110.

## MS5 A3.4c (new-context rebuilds) and MS5 complete

**Landed: A3.4c (#109, Opus, approved by the owner).** `AudioHost._replaceContext`: retire the node, move the host's listeners off the old context, dispose its unlock layer and close it, then `recreate()` (a new `AudioContext` at the device's rate, `addModule`, a node, a new `Unlock`), move `statechange`/`sinkchange`, arm unlock if it starts suspended, rebind the link, `onContextReplaced(rate)`, and wait for the first STATUS. Recovery: a trap rebuilds in the same context; `"device"`, `"rate"` or a closed context get a new context; `"stall"` tries the same context with a 2 s first-STATUS limit, then a new one (a second stall within 10 s goes straight to a new one). The 3-per-60 s limit covers every core made. Across the swap, playheads cross in `Audio.time` seconds; the clock map, writer, limiter latency and HRIR follow the new rate (the HRIR re-resampled from the asset, the registry's kept copy replaced); clips re-decode at their own rate through an `OfflineAudioContext`. **`Audio.time` stays continuous** (a carried `timeOffset`; it holds its value after any reset and never goes backwards), so `at` values computed before the swap keep their meaning. A hidden-page mute now survives a rebuild's MASTER replay.

**Numbers:** loopback 48 → 44.1 kHz: a voice resumes within one quantum (127 clip frames) of its position; `Audio.time` within 0.1 ms of the page clock; `at` after the swap exact, 0 late. Chromium (Sound Lab, `rebuild("device")`): 865 ms at the same rate, 557 ms with the rate forced from 44.1 to 48 kHz; same voices, no errors.

**Open:** a pitch change or pause during the rebuild gap is integrated at the old rate until the replay; plays made during a rebuild lose their `at` (as in A3.4a); `contextRebuilds` isn't in `Audio.debug()`; WebKit and Firefox context recreation unverified (no Docker).

## MS5 exit check (2026-11-10)

- 4,096 voices select in ≤ 0.25 ms p99 in Node: the bench passes on a quiet machine (0.093–0.131 ms p99 earlier runs).
- 4-point resampler replaces linear; THD+N thresholds ratcheted; alias rejection measured (0 dB at whole ratios; accepted by the owner, band-limiting post-M1, #110).
- `at` lands within a quantum in the loopback: exactly on its frame (and after a context swap).
- The cap drops and recovers under load (loopback: 40 → 34 → 40).
- A simulated trap restores voices; the 4th within 60 s goes silent with one warning; device and rate changes rebuild into a new context.
- Mute, pause and play background modes checked on the loopback host (no real hidden tab in this container).
- `cargo test` 380 passed, 4 ignored; `npm test` 360 files, 3,759 passed; `npm run build` green; Chromium e2e 193 passed, 0 failed, 4 skipped; `@slow` audio specs 7 passed, 1 skipped (HRTF). Mixer wasm 113.0 KB, ABI 1.2.
- Merged to master with the owner's standing approval ("merge into master and close tickets before moving on").

**Reserve used:** none.

## MS6/MS7 wave: H3 and B1, then B2

Started from master `4aee234` in parallel: H3 (#89, Opus) and B1 (#91, Opus).

**Landed: B1 (#91).** `native/audio/crates/audio-decode` (cdylib and rlib), symphonia `=0.6.1` (the newest release): WAV, FLAC, MP3, Ogg Vorbis by default, AAC/MP4 behind the `aac` feature. C ABI 1.0 (`myco_decode_*`; contract in `src/lib.rs`'s header): exported memory and its own 16-byte-aligned allocator, `open` from bytes with a format hint, a 32-byte `info` record (frames −1 when unknown, plus `framesEstimate`), `read_f32`/`read_i16` into the caller's buffer, sample-accurate `seek` (drops leading frames itself; a seek to 0 or after the end reopens from the kept bytes, so loops replay bit-identically and isomp4's seek-after-EOF bug is avoided), 64 generation-tagged handles, error codes and messages, no panics across the ABI. `build.rs` embeds the mixer's source hash; the name section is stripped. `build.mjs` builds, gates (900 KB), smoke-tests in Node and copies `myco_audio_decode.wasm`, and fails if the decoder's source hash differs from the mixer's. Fixtures from `tests/fixtures/generate.mjs` (synthesised WAVs; ffmpeg in bit-exact mode for FLAC, MP3 CBR/VBR with and without Xing, Vorbis, M4A).

**Numbers:** decoder 743,428 B (726.0 KB; the `aac` build 1,062,084 B, over the gate); flappy's 82 s stereo `town.mp3` decodes in Node in 147 ms (≈559× realtime) with 4.8 MB peak memory streaming in 4,096-frame reads; WAV and FLAC bit-exact; MP3 26–35 dB, Vorbis 34–38 dB, AAC 31–38 dB SNR; seeks frame-accurate. `cargo test` 399 passed, 4 ignored; `npm test` passes except the flaky `navSample.test.ts` (fails about 1 in 3 alone; navigation, not audio; owner-review entry 11); `npm run build` green. Notices added for symphonia (MPL-2.0) and its dependencies.

**Open for B4:** the `aac` build is over the 900 KB gate; symphonia's MP4 reader ignores the edit list, so AAC keeps 1,024 priming frames. Nothing ships the decoder wasm yet (B2).

**Landed: B2 (#92, Sonnet).** `runtime/decoder/`: `protocol.ts` (K7 messages: init, decodeClip, cancel, the four stream requests; replies incl. `clipChunk`/`clipDone` and `error {id?, streamId?, asset?, message, code?, fatal?}`), `wasm.ts` (typed ABI wrapper; checks ABI major 1 and that the decoder's source hash equals `hash.json`'s), `clips.ts` (whole-clip decode with `read_i16` in 65,536-frame transferred chunks, yielding between chunks so `cancel` gets through; unknown-length MP3 decodes to the end, `lengthKnown: false`), `streams.ts` (stub with final shapes for B3), `handler.ts` (testable without a Worker), `decoder.worker.ts`, `decoderClient.ts` (one shared, lazily spawned worker; abort, dispose and respawn; bytes copied by default so the encoded cache keeps them). The wasm URL resolves on main and goes to the worker in `init`; `myco_audio_decode.wasm` ships in the player, editor and engine-library builds (`BESIDE_BUNDLE`). 38 tests on the real wasm and B1's fixtures; Chromium: first decode 39 ms in a production build (spawn and fetch included), then 4 ms.

**Landed: H3 (#89, Opus).** `clips.rs` routes a format-2 CLIP_BEGIN under a reserved id to the HRTF store (parsed with `HrirDatabase::parse`, clip event 4; `hrtfLoadFailure` 2 on bad data or an unsupported rate); its reserve also takes the bank of 32 HRTF panners (2 partitions below 88.2 kHz, 4 above). `panner.rs`: a flagged mixed spatial voice takes a free panner; equal-power ↔ HRTF crossfades linearly over 45 ms either way, also when the table arrives; a voice that doesn't render frees its panner. H1's port now uses A2.2b's complex FFT (one copy in the wasm), its processing no longer depends on partition count, and kernel interpolation is 1.9× faster (80 → 43 µs native; Chromium-formula references still pass at 2e-5). Main: `hrtfPick.ts` flags the top `voices.hrtf` mixed spatial voices by audibility with 1.2× hysteresis (A3.1's `rankTop`); the first flagged voice starts the HRIR fetch (H2's fetch on the first spatial play removed, so `"equalPower"` or 0 never fetches); replay keeps a voice's panner kind across a rebuild. Chromium (Sound Lab): `hrtfVoices` 1, `hrtfReady` true, no errors.

**Coordinator:** the mixer wasm's name section is stripped (`--strip-all` in `audio-wasm/build.rs`): 138,429 B → 125,340 B (122.4 KB), output unchanged.

**Numbers:** HRTF voice 5–7 µs per quantum static in wasm (4.4–5 native), about 20 µs moving (over the 6.6 µs model; owner-review 13); p99 per quantum ≈ 0.5 ms with 16 HRTF voices turning, in wasm. Mixer wasm 125,340 B, decoder 743,428 B, source hash `a1c70ea4…`, ABI 1.2; `cargo test` 408 passed, 4 ignored; audio Vitest 60 files passed; `npm test` passes except the known flaky `navSample` and a `piratesSample` timeout under load (passes alone); `npm run build` green. Decisions logged: owner-review 12 (32-panner bank, 682 KB), 13 (kernel budget 2), 14 (strip names).

**Landed: B5 (#94), B6 (#96, streaming glue pending B3), H4 (#90).** B5: the clip registry decodes through the worker (int16 at the file's own rate; known-length clips upload as the worker decodes; unknown-length MP3s decode whole first; rebuilds re-decode from kept bytes; unload cancels). B6: `decodeAudioData` removed from the core path (including A3.4c's `OfflineAudioContext` re-decode), the decoder client respawns a crashed worker (3 per 60 s), `noDecodeAudioData.test.ts` guards it, `CoreStreamSeam` for `stream: true`, guide pages for M1b. H4: 30 HRTF parity scenes against Chromium (`audio-parity-hrtf.spec.ts`, `hrtf-reference.json`, `hrtfParity.test.ts`), goldens `hrtf-static` and `hrtf-moving-kind-change`; **48 kHz HRTF misses parity** (owner-review 18) → **H5 (#111)**.

**B3 (#93)** finished on its branch (streaming: rings 4/8/16 by preset of 32,768 + 4,096 frames, a stream voice branch with a 5 ms starve fade, ABI 1.3 `myco_audio_stream_consumed`, a worker stream decoder on a forked wasm instance, a direct worker–worklet port with credits and circulating buffers, waitingForData, reopen after a rebuild; a 300 ms main stall gave 0 starves, 0 underruns and exact output; flappy's `town.mp3` streamed in Chromium with 0 starves). Its branch predates H3, B5 and B6 (conflicts in `voices.rs`, `coreBackend.ts`, `decoderClient.ts`, `debug.ts`), so an Opus worker is merging it and wiring B6's stream seam.

**Landed: the B3 merge (#93, with B6's glue #96), H5 (#111), B3b (#95).**
- B3 merge (Opus): H3's panner path and B3's stream branch both in `voices.rs` (stream voices pan through `mix_range`, so HRTF applies; `stream_hrtf.rs` checks a stream voice equals a clip voice); B6's `CoreStreamSeam` replaced by B3's path (stream voices are ordinary voice-table rows); a decoder worker crash fails its streams once (stop, one warning each) and the next worker reconnects to the worklet, which closes the dead worker's rings. **Fixed:** a lazily respawned worker never got a worklet port (the next stream hung); orphaned rings. On the core a streamed clip is a full voice (spatial incl. HRTF, pitch, loop, bus, effects); only the Babylon fallback plays it flat.
- H5 (Opus): Chromium cuts each 256-frame response out with its delay in, resamples each with media's `SincResampler` (32-tap Blackman, cutoff 0.9, 64-frame requests) and extracts the group delay at the context rate; `hrir.ts` now does the same (the asset keeps its delays: 245,776 B), and HRTF uses Blink's f32 `CalculateAzimuthElevation` (`audio-dsp/src/hrtf/angles.rs`). 48 kHz parity went from 5.7 dB / 3.2 dB ILD / 1.1 frames ITD / nulls −5 dB to 0.05 dB / 0.001 dB / 0.01 frames / nulls −42 to −75 dB; boundary directions match at both rates; one HRTF tolerance at both rates. Staged `audio_bus.cc`, `sinc_resampler.cc/.h`, `panner_handler.cc`, `vector3d_f.cc/.h`, `angle_conversions.h` with SHA-256s.
- B3b (Sonnet): a newer epoch (from SEEK or STREAM_OPEN, whichever arrives first) flushes a stream's ring; the voice fades out over 5 ms from a 1,536-frame tail copy, waits for the new epoch's first chunk and fades in; SEEK now applies to clip voices too (loop wraps, one-shot clamps or ends). `AudioSource.seek` kept `@internal` pending a decision record (owner-review 21).

**Numbers:** mixer wasm 145,201 B (141.8 KB; owner-review 22 on headroom), decoder 743,428 B, ABI 1.3; `cargo test` 443 passed; audio Vitest 69 files passed; `npm test` 372 files passed except the known flaky `navSample`; `npm run build` green.

## MS6 exit check (2026-11-10)

- At most `voices.hrtf` HRTF voices (H3's loopback tests); no clicks across a panner change (45 ms crossfades, also when the table arrives; native tests show no step above the signal's own); parity within tolerance at 44.1 and 48 kHz (H4's spec and Node check, after H5); the HRIR isn't counted in `clipMemoryMB` (reserved id, `acquireReserved`).
- Chromium e2e 193 passed, 0 failed, 4 skipped; `@slow` audio specs 9 passed (parity incl. HRTF at both rates, sound-lab, babylon); selection bench passes.
- Merged to master with the integration branch's finished MS7 tasks (B1, B2, B3, B3b, B5, B6). The default backend is still `"babylon"`, so the core paths stay opt-in.

**Reserve used:** none.

**Landed: B4 (#97, Opus).** AAC in MP4 trimmed in the decoder from the edit list or `iTunSMPB` (symphonia 0.6.1 applies neither), with the exact end taken from the track length when ffmpeg's millisecond edit list only rounds it; MP3 (LAME/Info tag) and Vorbis were already trimmed by symphonia; no mixer change. The decoder is built twice: `myco_audio_decode.wasm` 743,484 B (gate 900 KB) and `myco_audio_decode_aac.wasm` 1,067,758 B (its own gate 1,100 KB), both in `hash.json` and beside the bundle; the AAC one is fetched only with `audio.codecs.aac`. With it off, AAC assets are refused before fetch (`reason` "failed", one warning per asset); files the decoder can't open warn once per asset with their format and the supported list (`core/codecs.ts`). Loop seams bit-exact for clip and stream voices (WAV, FLAC, MP3 with a LAME tag, Vorbis, AAC); goldens `loop-seam-mp3/-vorbis/-aac`; Chromium: a looping streamed `town.mp3` matched the looped decode at 150 dB across the wrap. Coordinator: f32 worker clips scale by 1/32768 like the core. `cargo test` 447 passed; `npm test` passes except the known flaky `navSample`; `npm run build` green.

**Landed: B7 (#98).** Gates verified first: MS5 and MS6 exit checks done; A0.6's fallback on a stubbed old engine (one warning, then Babylon) now tested with the default backend too. `DEFAULT_BACKEND = "core"`; `defaultBackend()` keeps `"babylon"` on macOS desktop (the Tauri shell, detected with `detectPlatform()`, plus macOS from `userAgentData`/`navigator.platform`); browser Safari and Tauri on iOS get the core; an explicit `audio.backend` wins; `"howler"` maps to `"babylon"` explicitly. The editor lists core first; `audio-babylon.spec.ts` sets `"babylon"` explicitly to keep testing the fallback; guide section "Choosing the backend". Samples on the new default in Chromium: flappy, pirates, platformer, arena, navigation on the core with no errors (playground3d has no audio).

## MS7 exit check (2026-11-10)

- Zero underruns under a 300 ms main stall (B3: loopback, and flappy's `town.mp3` streamed in Chromium through a 300 ms busy loop); no old audio after a seek (B3b); the loop golden is bit-exact across the seam (B4: clip and stream, every format with trim data); a VBR MP3 without a header loads (B1 fixture, B5's registry test); samples run on the default backend (B7).
- `npm test` 374 files passed (a glTF Draco test hit a load spike once and passes on reruns); `npm run build` green; Chromium e2e 191 passed, 1 failed, 5 skipped — the failure, `selection.spec.ts:77`, passed 3 of 3 reruns alone (a known flaky spec); `@slow` audio specs 9 passed (parity incl. HRTF, sound-lab on the core, the Babylon fallback).
- Mixer wasm 145,201 B (141.8 KB), decoders 743,484 B and 1,067,758 B (AAC), ABI 1.3.
- Merged to master under the owner's standing instruction; B7 flips the default (owner-review 26, revert by setting `DEFAULT_BACKEND` back).

**Reserve used:** none.

## MS8 wave 1 (A3.5, C4, C2)

**Landed**
- C2 (#101, Sonnet): guide pages "Playing sound" and "Why is there no sound?", `native/audio/README.md` (contributor note), `tools/check-doc-links.mjs` (`npm run check:links`: 220 relative links in 19 files resolve), notices review (the mixer's transitive crates through microfft now credited; the Chromium entry describes the three kinds of notice). Open: the licence of flappy's two MP3s (owner-review 28).
- C4 (#100, Opus; open until the owner signs): `listening-pass.md` (three Sound Lab configurations, 16 items, the objective-thresholds table, sign-off) and Sound Lab keys for each item. Coordinator fix from its finding: `.flac` and `.m4a` are audio assets in the editor and the web export.
- A3.5 (#99, Opus): `audio-bench` (native and Node wasm), architecture §6.1/§6.2/§6.3/§6.5 and §5.1 frozen on the lab VM (shared 4-core 2.1 GHz Xeon): high 5.45 ms p99.9 / 2.36 mean, default 3.90 / 1.48, low 2.35 / 0.66 (wasm; the model within 4% of the means); `cap::wu` re-measured with new pitch, moving-voice and HRTF-kernel terms; fixed H3's kernel budget being exceeded; virtual voices O(1) at a settled pitch. Memory: bus 4,224 B, reverb 3,015,744 B, rings 307,200 B each, HRTF bank 699,200 B (≤ 88.2 kHz) / 1,092,416 B, HRIR table 269,776 B at 48 kHz; block before the arena 4.94 / 6.69 / 9.81 MiB (low / default / high).
- Coordinator: the cap budgets reference-machine time assumed 2× the lab VM (`REFERENCE_SPEEDUP`, owner-review 30); presets aligned with §5.3 (low 64 mixed, high 4,096 logical; owner-review 31).

**Numbers:** mixer wasm 147,356 B (143.9 KB), ABI 1.3; `cargo test` 450 passed, 4 ignored; audio Vitest 68 files passed.

**The 1.3 ms p99.9 exit gate isn't met on the lab VM.** It needs the reference machine and C3's soak (owner hardware); A3.5's proposals are in owner-review 31.

**Landed: C1 (#102, Sonnet).** `samples/stress/` (≈0.9 MB committed): high preset on the core, 32 buses each with high-pass, low-pass and compressor (8 send to the reverb), two snapshots, ducking; **64 MiB of distinct mono clips synthesised at runtime** and served through `Assets.addSource` (pre-decoded before the storm); ≈200 starts a second at pitch 0.5–16 from a shuffled deck; 24 orbiting spatial emitters (HRTF candidates), 8 looping streams; bus fades, mutes and snapshots churning; a counter overlay; a soak mode (`K` or `?soak=<min>`, a `[soak]` line per minute, a copyable PASS/FAIL report, `__stress.report()`) for C3. Bench twins `stress` and `stress-cap` in `audio-bench`; `@slow` spec `audio-stress.spec.ts` (60 s: ≥ 63 MB of clips, > 2,000 logical voices, HRTF peak > 8, 8 streams, 0 starves, the cap adapts above its floor, underruns ≤ 1,000).

**Numbers:** headless Chromium: logical voices hit 4,096 within 20 s, mixed peak 190–250, HRTF 32, the cap ranged 132–256, 1–4 underruns a minute, 0 starves, ≈15,000 starts a minute. Bench on the lab VM: wasm `stress` mean 2.26–2.39 ms, p99 3.5–3.6 ms (over the 2.67 ms quantum without the cap); with the cap it settles at ≈183 mixed voices (mean ≈1.9 ms). `npm test` 374 files passed; `npm run build` green.

**Landed: C1b (#103, Opus).** `tools/audio-bench/meter.mjs` (no dependencies) rewrites the linked `audio-bench` wasm (the same audio-core and DSP code, built like the mixer) to add every executed instruction to an exported `i64` counter; the bench's clock import returns the counter, so the timed region is counted with no change to timing code. `build:audio` writes `tools/audio-bench/metered/audio_bench.metered.wasm` (605 KB, test-only, never shipped) and `metered.json`. `tools/audio-bench/metered-gate.mjs` (`npm run check:audio-metered`, ≈22 s, Node only) runs 13 scenes (low/default/high, high at pitch 16, the stress twins, fx, HRTF still and turning, streams, pitch 4, virtual, updates) against `metered/baseline.json` and fails on any scene +10%; a new `metered` CI job runs it. Proof: a constant +144 K-instruction loop passed (streams +9.8%), +360 K failed (streams +24.6%), reverted byte-identical. Baseline: default 19.5 M instructions per quantum, high 32.5 M. Counts are identical run to run.

## MS8: everything buildable without the owner is done (2026-11-10)

Done: A3.5, C1, C1b, C2, C4's checklist. Waiting on the owner: **C3** (the 30-minute soak with 0 underruns on Windows WebView2 and Chromium, Linux WebKitGTK and the low-end Android phone, using `samples/stress` `?soak=30`; it also sizes the "low" preset and gives the reference-machine numbers for the 1.3 ms p99.9 gate and `REFERENCE_SPEEDUP`), and **C4** (running and signing `listening-pass.md`). Then the 0157 row moves to Partial (M1 done).

## C3: first soak result (owner, 2026-11-10)

**Windows, the Tauri desktop app (WebView2 157, whose user agent reads Edge), 32 cores, 48 kHz, `samples/stress` `?soak=30`, high preset: PASS.** 30 of 30 minutes; underruns 0, late commands 0, stream starves 0, stream errors 0, traps 0, rebuilds 0; dropped plays 35 (the 4,096 logical limit); peaks: logical 4,096, mixed 265, HRTF 32; the cap went 256 → 184 in the first minutes and stayed at 184; work units max 1,792,910 (budget 2,600,000); 58 main-thread stalls over 100 ms (longest 460 ms, minutes 7–8, likely the owner opening the Audio Debug panel) with no underrun. The owner also reports the Sound Lab listening checks look right.

**Findings**
- The Audio Debug panel rendered a row per voice four times a second (≈4,000 rows), which tanked the editor's frame rate; it now shows the 64 most audible voices and counts the rest by state.
- **The cap is held by the work-unit model, not by real load:** a 32-core machine with zero underruns settled at 184 mixed voices, because the modelled p99 (≈1.58–1.79 M work units) sits in §6.3's 55–70% hold band of the provisional budget (owner-review 30), so it never climbs back to 256.

**Still to run for C3:** Windows Chromium (the browser), Linux WebKitGTK, the low-end Android phone.

**Owner decision (2026-11-10): the cap moves only on real trouble.** Following the soak finding, only underruns and qualifying late commands (whose gate includes negative slack) lower the cap and restart its calm; the work-unit model still runs and is reported in STATUS `workUnits` and `Audio.debug()` (`cap_controller::MODEL_DRIVES_CAP = false`; `CapConfig::model_drives` keeps §6.3's original table for tests and the bench's `-cap` scenes, since a bench quantum never underruns). Headless check: the stress sample's 4 underruns on this VM dropped the cap to 184 and it recovered to 256 (it stayed at 184 before). `cargo test` 452 passed; `npm test` 376 files passed; `@slow` audio specs 10 passed; metered gate +0.00%.

## M1 closed by the owner (2026-11-10)

The owner declared M1 complete. What the exit criteria asked for and where it stands at closing:
- **C3 soak:** Windows Tauri (WebView2) passed; Windows Chromium, Linux WebKitGTK and the low-end Android phone were not run before closing. They stay owed as release checks for those platforms, not as M1 blockers; results still go in the C3 section above.
- **Budgets:** frozen on the lab VM (A3.5); the 1.3 ms p99.9 gate at the high preset is unconfirmed on the reference machine, and the "low" preset is unsized until the phone soak. Review entry 31's high-preset proposals stay open.
- **C4:** the owner reported Sound Lab works as expected; the signed checklist in `listening-pass.md` is not filled in.
- **Open proposals carried forward:** pinned `wasm-opt` (review 22), a public seek API (21), the high-preset content budget (31), the Flappy music licence (28), band-limited resampling (#110).

Next: M2 (events and parameters), its own decision record (0158).

## M2 (ADR 0158): E1 foundations (2026-11-10)

ADR 0158 accepted; plan `docs/plans/2026-11-audio-events-m2.md`. E1 landed: `src/engine/core/curve.ts` (the shared curve type), `src/engine/audio/eventFormat.ts` (the `myco.audioevent@1` parser), `audio.parameters` / `audio.automation` / `audio.seed` in `engine/audio/settings.ts`, and the mixer size gate raised to a 256 KB tripwire (ADR 0158 amends 0157; the owner rates download size no design constraint). No Rust changed, so the wasm and its hash are untouched. Deviation: none.

## M2: E2 (core automation and sustain) and E3 in progress (2026-11-10)

**E2** (subagent, merged `782bb8f`): `audio-core/src/automation.rs` and the opcodes SET_LOOP, AUTOMATE, CURVES, PARAM, BUS_AUTOMATE; ABI 1.4. `cargo test` 478 passed; every existing golden and parity digest unchanged; three new goldens. Mixer wasm 147,384 → 178,265 B (the 256 KB tripwire). Automation region 1,564,352 B at the default preset. Metered: old scenes −1.59%..+0.01%, baseline untouched for them; new scenes automation 13.46 M, automation-base 9.65 M, automation-virtual 1.38 M, bus-automation 2.10 M, sustain 5.26 M instructions per quantum. Native cost of evaluation at 256 voices × 3 bindings (shared container): p99.9 25–45 µs vs a 30 µs budget, to re-measure on the lab VM; per-voice low-pass filtering adds ≈195 µs over a 380 µs base. Deviations: per-voice low-pass applies only to voices with a low-pass binding (M1 never applied `lpHz`; unbound voices stay bit-identical); AUTOMATE/PARAM/CURVES apply on arrival; pitch automation ramps per frame; no `group` in STATUS (no voice section exists; main knows it); stream voices ignore SET_LOOP until E4.

**E3** (in progress): the event runtime, `Audio.play`/`setParameter`/`getParameter`, `AudioEventHandle`, `AudioSource` events and the TypeScript fallback evaluator; not yet wired to the core backend. Full `npm test` 379 files green before the E2 merge; after it, audio and engine suites 2,588 passed, metered pass, build green. Handoff: `docs/plans/2026-11-audio-events-m2-handoff.md`.
