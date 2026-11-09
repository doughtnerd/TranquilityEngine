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
