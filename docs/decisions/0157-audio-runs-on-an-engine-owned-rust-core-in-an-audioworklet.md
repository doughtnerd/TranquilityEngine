# 0157. Audio runs on an engine-owned Rust core in an AudioWorklet, replacing Howler

- **Status:** Accepted, amended by 0158 (size gates are tripwires; M2 is 0158) and 0166 (M4: a music stream pool; every queued per-voice stamped record applies inside its voice instead of splitting the quantum, built in M4-0; see 0167 and `docs/design/0166-audio-music/build-log.md` D7) (revision 3: refined by the approved technical design in `docs/design/0157-audio-core/`; see "Revision 3" at the end. Revision 2 followed the RFC round in `docs/rfc/0157/`)
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** 0006, 0099
- **Amends:** 0074 (spatial audio is no longer through Howler; its fields and behaviour are kept), 0097 (its model is kept; the Web Audio bus graph is replaced), 0098 (the interface gains a status channel, handles and priority)
- **Related:** 0156 (withdrawn), 0065, 0133, 0040, 0010, 0011, 0034

## Context

The owner's goal is **AAA-quality mixing and control built into the engine**, as a reason to choose an engine meant for fully open-source use.

**Today:**
- Audio is Howler plus a Web Audio bus graph (0006, 0074, 0097) behind an internal backend interface (0098).
- It plays clips, spatial sources through Howler's panner, buses with a few effects, snapshots and voice-activity ducking.
- It has no voice priority or limits, no events or parameters, no HRTF, no occlusion, no routable streaming (streamed clips are HTML5 audio: no effects, no spatial) and no profiler.
- Howler also does the unlocking after the first user gesture (`AudioSource.ts:2-3`). There is no unlock step outside it.

FMOD was considered (0099, then 0156). It's proprietary and licensed per title, so an open-source engine can't ship it. "AAA audio built in" would really mean "AAA audio if you buy FMOD".

**Spikes** in `spikes/audio-worklet/` (README there) tested an engine-owned core: a Rust mixer compiled to wasm, running in the browser's AudioWorklet. All were measured 2026-11-09 on one AMD Ryzen AI Max+ 395 core, mostly single runs.

| Finding | Number |
|---|---|
| Mixer speed, wasm vs native | within ±3% in V8, JavaScriptCore and SpiderMonkey; ~1.15 µs per mixed voice per quantum (linear-interpolation resampling, 4 one-second test clips, so cache-warm) |
| Mixed voices | 256: 0.31 ms (12% of a quantum). 1,024: 1.2 ms (44%) |
| Virtual voices | 4,096 logical, 256 mixed: +0.03 ms |
| Runs inside AudioWorklet | Chromium on Windows (also real-time on real hardware), Chromium/WebKitGTK/Firefox 157 on Linux in containers with no audio device; same output RMS in all three; worklet overhead 1–7%. macOS not run |
| HRTF (FFT, 256 taps) | ~5 µs per voice; 32 voices 5–7% |
| 3rd-order ambisonics + binaural decode | 256 voices 7–13% (`simd128` halves the encode) |
| Convolution reverb, 4 s stereo | uniform 1.0–1.2 ms; non-uniform with work spread over 16 quanta 0.09–0.12 ms average, max 0.19 ms native, rare maxima up to 1.67 ms in Node wasm |
| Commands main → worklet | one transferable `Float32Array` per frame: ~0.1 ms main thread at 1,024 voices, applied in 1 quantum typically, 3–5 at the tail; at 1,024 voices one 0.55–0.86 ms GC scavenge on the worklet. A SAB ring is 5–10× cheaper, no worklet GC, but needs COOP/COEP |
| Streaming | decoder worker → worklet through a `MessagePort`: 0 underruns under main-thread jank (relayed via main: 23–83 lost quanta); 32k frames buffered survive a 300 ms decoder stall |
| Decoding (symphonia 0.6.1, wasm) | MP3/Vorbis/FLAC/WAV/AAC at 440–830× realtime, 1.5–3× faster than `decodeAudioData`; 4096-frame chunk p99 ≤0.37 ms; seek ≤0.28 ms; MP3+Vorbis+FLAC+WAV 840 KB |
| Main-thread voice bookkeeping | 4,096 logical voices: 0.08 ms p50 / 0.22 ms p99 with typed arrays + quickselect; 0.9 / 1.7 ms with objects + sort |
| Occlusion rays (Rapier, main thread) | `castRay` 1.5–4.3 µs; ~1 ms buys 150–250 rays |
| Start-up | wasm compile 0.5–15 ms; worklet ready 2–23 ms after node creation; first `AudioContext` on Windows 250–490 ms |
| Output latency | browser ~50 ms (measured); custom WASAPI exclusive ≈ 5–10 ms (estimated; takes the device) |
| Worklet scope | has `Date.now`, `currentFrame`, `Atomics`, `WebAssembly`; lacks `performance`, `TextDecoder`, `setTimeout`, `fetch` |

**Libraries that didn't fit:**
- Firewheel's and cpal's web backends need nightly Rust, threads and COOP/COEP.
- Kira's web path runs on the main thread.
- Steam Audio has no wasm build.
- fundsp 0.23's `no_std` mode doesn't compile.

### Terms

- **Quantum:** the 128 frames the browser asks the audio thread for at a time, 2.667 ms at 48 kHz. Everything mixed must finish inside it.
- **AudioWorklet:** a script the browser runs on its own high-priority audio thread.
- **Voice:** one playing sound.
  - **Mixed voice:** actually rendered this quantum.
  - **Virtual voice:** tracked and kept in time but silent and nearly free; it becomes mixed when it's among the most audible.
- **HRTF:** filters that make a sound seem to come from a direction, over headphones.
- **Ambisonic bed:** a cheap shared sound field that many distant sounds are placed into, then rendered once.
- **Partitioned convolution:** reverb from a recorded room response, with its work split across quanta so no single one spikes.
- **Ducking:** lowering one bus while another plays. **Snapshot:** a saved set of bus levels to fade to. See `docs/guide/audio-mixer.md`.
- **LUFS:** perceived loudness.

## Decision

We will replace Howler with an **engine-owned audio core**, written in Rust and compiled to WebAssembly, that mixes on the browser's audio thread. The public audio API stays engine-native (0010): no Rust, wasm, Web Audio or library types in it.

This record commits to **M1 (the core reaching parity, then replacing Howler)**. The later milestones are a roadmap: each needs its own record.

### Placement

Audio becomes a **first-party plugin**, as 0133 already lists it:
- the runtime half is in `src/plugins/audio/runtime/`;
- the editor half (Project Settings > Audio, meters, later authoring) is in `src/plugins/audio/editor/`;
- `Audio`, `AudioSource`, `AudioListener` and `Bus` keep their `myco` exports, as physics and navigation do (`src/myco.ts`);
- the Rust crate lives in `native/audio/`, like `native/nav/` (0065);
- occlusion (later) queries rays through the physics plugin's public ray API, never Rapier directly.

### Threads and data

- **Crate and build.** `native/audio/`, a Cargo workspace on a pinned stable toolchain (`rust-toolchain.toml`). `npm run build:audio` compiles it for `wasm32-unknown-unknown` with `simd128` only, since every target engine accepts it. The output goes to `src/plugins/audio/runtime/wasm/`, committed so the engine builds without Rust.
  - **Plain `extern "C"` exports, no wasm-bindgen:** the worklet lacks the `TextDecoder` and `fetch` the glue needs.
  - **A source-hash check:** the wasm embeds a hash of its sources, and `npm test` fails when the committed wasm is stale.
  - **No threads.** `SharedArrayBuffer` isn't required.
  - **The same crate compiles natively** for `cargo test`, benchmarks and any later native output.
- **One `AudioContext` and one core per page,** created by the audio plugin. Worlds (0034), the editor viewport and play mode are namespaces in it, so clips are decoded once. Only the World with the view is audible, as today. Servers and headless Worlds never load the core.
- **Main thread: intent.** The audio system (a built-in system in the frame loop, 0011):
  - keeps the **voice table in typed arrays**, one per field;
  - computes attenuation, priority and (later) occlusion;
  - chooses which voices are mixed. **The main thread owns virtual-voice selection.**
  - writes **one command batch per frame**.
- **Audio thread: playback.** The core:
  - owns playheads, voice lifetime, buses, effects and the clock;
  - renders one quantum per call;
  - never allocates inside `process()`.
- **Status channel (audio → main).** Every 6 quanta (every 48 once frames stop arriving), the worklet posts a compact status block, and the host returns each buffer as soon as it has read it:
  - ended voice ids;
  - playheads, for voices that asked for them;
  - stolen and starved voices;
  - peak levels per bus;
  - counters: underruns, late commands, work units per quantum.

  `AudioVoice.playing` and handle state read a **main-thread mirror, up to one frame stale**. The record states this, and tests depend on it. 0097's ducking counts voices from the mirror.
- **Command format.** A versioned, fixed-stride binary layout, defined once in Rust, with TypeScript constants generated from it. A round-trip test keeps the two in step.
  - Batch header: `{version, firstFrame, count}`.
  - Records: `{opcode, voiceId, frame, payload…}`.
  - **Voice ids are index + generation**, so a script handle held after its voice is reused becomes a no-op.
  - **Transport:** postMessage with transferable buffers, recycled by sending them back. When the page is cross-origin isolated, a SAB ring carries the same format.
  - Nothing ever waits on a reply.
- **Clock.** Commands carry an **audio-frame timestamp**. The main thread maps game time to audio frames from `getOutputTimestamp()`/`currentTime`. Plays without `at` are flagged *asap* and apply at the first quantum after they arrive. Only stamped records (`at`, synchronised starts, replays) use a lookahead of clamp(2 frames, 8 quanta, 100 ms). A late stamped command runs at once and is counted. `Audio.time` is seconds on the audio clock, separate from game time, which pauses and scales.
- **Clip memory.** The worklet's wasm memory is private, so clip PCM is copied into it.
  - It goes into a **reserved, pooled clip arena**.
  - Copies arrive in chunks, under a per-quantum byte budget of 256 KB.
  - Growth happens in `onmessage`, never in `process()`.
  - Clips unload when their asset is released, and between editor play sessions.
  - Each preset has a memory ceiling. A load past it is refused with a warning, and playback continues.
  - Clips can be stored as int16 to halve memory.
- **Decoding and streaming.** In **M1a**, clips decode with the browser's `decodeAudioData`, as today. In **M1b**, a decoder worker running symphonia 0.6.1 becomes the single decode path:
  - streams go **straight to the worklet through a `MessagePort`**, in 4096-frame chunks, with about 0.7 s buffered;
  - a stream voice starts in a "waiting for data" state until its first chunk;
  - loops are gapless.

  `decodeAudioData` is then removed, not kept as a second path.
- **Sample rate.** The context runs at the device's rate. Each voice's resampler, which already exists for pitch, absorbs the clip's rate. A device or rate change rebuilds the context and replays state.

### Failure handling

| Failure | Handling |
|---|---|
| Before the first user gesture | The plugin's **unlock layer** (new in M1; Howler did this) listens for the first `pointerdown` or `keydown` and creates or resumes the context, then the core loads. Until then one-shots queue, at most 32 and for at most 1 s, and older ones are dropped. `AudioSource`-owned and looping voices wait for unlock with no timeout. `Audio.status` reads `locked`. |
| Wasm trap or panic in `process()` | `panic = "abort"`. The shell catches the trap (or `processorerror` fires); the plugin performs a **hard rebuild**: a new node and core in the same context, a chunked REPLAY from the main-thread voice table, and clips re-sent from the main-side registry. At most 3 times a minute, then it stays silent with `Audio.status = "failed"` and one warning (no switch of backend mid-session). |
| Core fails to load (no AudioWorklet or `simd128`, fetch, compile or ABI failure, no first STATUS in 5 s) | One warning, then an **automatic switch to the Babylon fallback backend** (basic playback, no effects, no priority), which stays after M1 for engines that can't run the core. |
| Device change, sample-rate change, `interrupted` (WebKit) | `interrupted`: resume, retried for 2 s. A rebuild and replay only when the context is closed, stalls for 1 s or can't resume; `devicechange` alone doesn't rebuild, since browsers follow the default output themselves. |
| Tab hidden, Tauri window minimised | Frame batches stop, so the core finishes every ramp at its target and keeps streams pull-driven. A project setting chooses mute, pause or keep playing in the background (default: mute). |
| Underruns, late commands | Counted from `currentFrame` against `Date.now()`, and shown in `Audio.debug()` and the editor from M1. |
| Decode error, truncated stream | The decoder posts a typed error; the voice fades out; one warning names the asset. |
| Clip memory ceiling or failed `memory.grow` | Refuse the load, keep playing, warn once. |
| Unknown codec (e.g. `.m4a` without AAC) | One warning naming the clip and the setting that enables it. |

### Public API at M1

Every existing call keeps working: `AudioSource`, `AudioListener`, `Audio.playOneShot`, `Audio.bus`, `Audio.snapshot`, `Audio.masterVolume` (with `Audio.volume` added as an alias), `Audio.muted`. The samples (`samples/flappy`, `samples/pirates`) running unchanged is an acceptance test. Additions are all optional with defaults, so no project needs migrating:

| Addition | Default |
|---|---|
| `Audio.playOneShot(…)` returns an `AudioHandle` (`stop()`, `fade(to, seconds)`, `playing`, `reason`) instead of `void` | — |
| `AudioSource.priority`, `OneShotOptions.priority` (0–255) | 128 |
| `buses[].maxVoices` in `project.json` | unlimited |
| `audio.voices: { mixed, logical }` | 128 mixed, 4,096 logical |
| `Audio.time`, `OneShotOptions.at` (play at an audio-clock time) | now |
| `Audio.status`: `"locked" \| "running" \| "failed"` | — |
| `Audio.muted` getter (only a setter exists today) | — |
| `Audio.debug()`: lists voices with state (playing, virtual, stolen, waiting for data, bus muted, locked) | — |
| `audio.background: "mute" \| "pause" \| "play"` | `"mute"` |

A handle's `reason` says why a sound isn't audible: `virtual`, `stolen`, `busMuted`, `locked`, `failed`, `waitingForData`. There's no event system, so scripts poll `playing`, as with `AudioSource` today.

**Behaviour changes:**

| What | Before | After |
|---|---|---|
| `stream` import setting (0040) | HTML5 audio: no effects, no spatial, bus gain only | M1b: decoded incrementally on the worker. Routable, spatial and gapless; the warning is removed |
| Effects (0097) | Web Audio biquad, compressor and convolver | Ported from Chromium's Web Audio code, so they match by construction (to float rounding) |
| Spatial panning (0074) | Web Audio HRTF panner | A port of Chromium's HRTF panner for the nearest 16 spatial voices (`audio.voices.hrtf`), equal-power for the rest; `audio.spatial: "equalPower"` turns it off. If no HRIR data licence clears, equal-power everywhere |
| A World that loses the view | its voices keep sounding | its voices go virtual (silent, keeping time) |
| `audio.backend` | `"howler"` or `"fmod"` | `"babylon"` or `"core"`; `"babylon"` is the default until M1b passes. Old `"howler"` maps to `"babylon"`, and `"fmod"` to the default, each with a warning |
| Sounds before the first gesture | Queued by Howler | One-shots queued (32, 1 s), then dropped; `AudioSource`-owned and looping sounds start on unlock |

### M1 iterations

The iterations below are the RFC-round sketch. The approved plan is the task table in `docs/design/0157-audio-core/api-and-models.md` §9: **155 person-days (about 31 person-weeks) including a 10% reserve**, roughly 15–17 calendar weeks with one senior, two mid-level and one junior engineer. It grew from the sketch's 16–18 weeks with the platform checks, the two-Engine lifecycle, the parity harness, crash recovery, the metered CI build, HRTF in M1 and the Babylon backend.

| Iteration | Content | Weeks |
|---|---|---|
| M1a.0 | Crate, `build:audio`, hash check, loader, worklet, context, unlock layer, status channel, command format. **Riskiest; first** | 1.5 |
| M1a.1 | Voice table, handles, clips, pitch, pan, 0074 distance models; `decodeAudioData` loading | 2.5 |
| M1a.2 | 0097 buses, solo, mute, snapshots, ducking, effects; bus meters; `Audio.debug()` | 2.5 |
| M1a.3 | Virtual voices, priority, bus limits, clock and `at`, adaptive voice cap | 1.5 |
| M1b | Decoder worker (symphonia), clip arena, streaming, seek, gapless loops; `decodeAudioData` removed | 3 |
| M1c | Golden tests, the metered CI benchmark, sound-lab and stress samples, docs, soak gate | 2 |

M1a ships behind `audio.backend: "core"`. The **Babylon backend** (Babylon's AudioEngineV2, internal behind 0098, never public per 0010) replaces Howler as the other backend, and Howler is deleted when it lands. The default flips to `"core"` once M1b passes; Babylon remains the automatic fallback for engines that can't load the core.

### Gates

**Soak gate.** 30 minutes of the stress sample with zero underruns on real hardware:
- Windows on WebView2 and on Chromium;
- Linux on WebKitGTK;
- one low-end device: an **Android phone** running the lowest Android version that Google Play currently accepts for publishing apps (the exact version is looked up when the soak is set up, since Google raises it over time), playing the web build in its Chrome and Android System WebView.

macOS (WKWebView) is the owner's low priority. It's a gate for macOS releases, and until it passes macOS desktop builds default to the Babylon backend.

**Performance budgets.**
- **Re-measured first.** In M1a.3, with real content: a 4-point (or windowed-sinc) resampler and at least 64 MB of distinct clip data. The table below is then frozen.
- **Worst case, not averages:** p99.9 over ≥5 runs. Convolvers stagger their tail work so two never land in the same quantum.

| Item (per quantum, 2.667 ms) | "High" preset | Budget (p99.9) |
|---|---|---|
| Mixed voices | 256 of 4,096 logical | 0.6 ms (re-measure) |
| Buses, effects, limiter, meters | 8–32 buses | 0.2 ms |
| Reserve (M2 layers, M3 spatial, M4 stems) | | 0.5 ms |
| **Total** | | **≤ 1.3 ms** |

- **Presets by measured device class,** not assumed headroom: "high" for the reference class, and "low" defined by the low-end Android soak device. Its 64 voices and one reverb are a starting point, to be lowered if that phone needs it.
- **Adaptive voice cap.** When the core's work units per quantum pass 70% of budget, the mixed-voice cap drops, and it recovers slowly.
- **Main thread, as a share of frame time:**
  - command batch ≤ 0.1 ms;
  - voice bookkeeping ≤ 0.25 ms;
  - later, occlusion ≤ 6% of a frame.
- **CI benchmarks count instructions** with a metered test build of the wasm (landing in M1c; benchmarks before that are informational), not wall time. A rise of more than 10% fails the build.

**Sizes** (lazy, never loaded by servers):
- mixer core ≤ 150 KB;
- decoder ≤ 900 KB (MP3, Vorbis, FLAC, WAV);
- AAC opt-in, +370 KB;
- spatial (M3) is a separate lazy module, and HRTF data is an asset with its size stated in M3's record.

**Testing.**
- `cargo test` for DSP units.
- Golden-output tests in Vitest: load the committed wasm in Node, render N quanta, compare digests. They are **bit-identical across wasm engines and within a tolerance on native** (`libm` differs).
- The command-format round trip.
- Updated fake backends (`audioBackend.test.ts`, `spatialAudio.test.ts`).
- One `@slow` Playwright spec that plays the sound-lab sample offline and checks levels.
- WebKit and Firefox runs use the Playwright Docker image (`mcr.microsoft.com/playwright`); the README says which tests need it.

**Docs.**
- A "Playing sound" guide page and a "Why is there no sound?" checklist.
- A contributor note: the TypeScript side needs no Rust; the Rust side needs the pinned toolchain, `wasm32-unknown-unknown`, `npm run build:audio` and `cargo test`.
- `spikes/` is reference only, not a starting point.

### Platforms and minimum versions

- **Cross-platform is a requirement.** Every feature must work in the browser and in the desktop editor on Windows, macOS and Linux. Nothing may depend on one platform. Platform-specific paths (a SAB ring, native output) are optional speed-ups over a path that works everywhere.
- **Who runs where (owner, 2026-11-09):**
  - The **editor** targets desktop (Windows, macOS, Linux) and the web browser only.
  - **Published games** run on the web, on desktop, and on **Android**: building games for Android through Tauri is intended, with its own export record still to come, extending 0041.
  - On Android the core runs in the Android System WebView, the same AudioWorklet path as the browser. A native Android audio output (AAudio/Oboe) would be a later option like the desktop native-output note, not part of M1.
- **The command transport defaults to postMessage on every platform.** The SAB ring is used only where the page is already cross-origin isolated and that has been verified on all three desktop webviews. It's never required.
- **Minimum versions:** the lowest browser and webview versions that support everything the core needs: AudioWorklet, WebAssembly `simd128`, transferable `ArrayBuffer`s, `AudioContext.getOutputTimestamp`.
  - `simd128` is likely the binding constraint: Chromium/Edge/WebView2 91, Firefox 89, Safari 16.4, recalled and not yet checked.
  - M1a.0 confirms these, finds the matching WebKitGTK version, and documents them. The loader refuses older engines with one clear message and stays silent with `Audio.status = "failed"`.

### Sound quality

- **The listening pass is manual,** a checklist per effect, preset and resampler mode, before each milestone ships.
- **Automated objective checks back it:**
  - frequency-response sweeps for filters and EQ;
  - aliasing and THD+N measurements for the resampler and pitch;
  - null tests against reference implementations;
  - loudness checks on presets;
  - golden digests.

  Regressions are caught by CI; people judge taste.

### Licences

- Dependencies are MIT/Apache-2.0.
- symphonia is MPL-2.0, file-level: its files stay as published. It's listed in `THIRD_PARTY_NOTICES.md`.

### Roadmap (not decided here; each gets its own record)

- **M2: events and parameters.**
  - Event assets with random, sequence, switch, blend and layer containers.
  - Game parameters driving properties through curves; states.
  - `Audio.play(event, params)` returning an `AudioHandle`.
  - Editor authoring in the plugin's editor half.
  - The curve format is shared with the planned animation system and is not frozen here.
- **M3: spatial.**
  - A 3rd-order ambisonic bed for distant voices (per-voice HRTF moved into M1).
  - Occlusion through physics ray queries under a frame-share budget.
  - Reverb zones; non-uniform convolution; Doppler.
- **M4: interactive music.**
  - Tempo and bar grid, and transitions quantised to beats or bars.
  - Stingers: short phrases played over the music.
  - Stems: layers faded in and out.
- **M5: profiler and live mix.** A voice and CPU view built on the status channel, LUFS metering, and live mix editing in play mode on web and desktop.
- **Native output.** An opt-in WASAPI exclusive mode in Tauri (~5–10 ms) takes the device from every other app. It's a note, not a milestone, revisited if latency-critical games need it.

## Alternatives considered

- **FMOD (0099, 0156).** It has the best authoring tool today, but it's proprietary and licensed per title. It has no Live Update on web, and its threaded build needs COOP/COEP. It stays possible as a third-party plugin behind 0098.
- **Keep Howler, extend the Web Audio graph; or M1 on plain Web Audio and the core from M3.**
  - Cheapest, and Web Audio *is* sample-accurate: `AudioBufferSourceNode.start(when)` and `AudioParam` automation.
  - Virtual voices and priority are main-thread bookkeeping that would work over it too.
  - Rejected because the goal needs what Web Audio can't give:
    - one DSP implementation whose output matches in every browser (HRTF and compressor quality vary by engine);
    - custom DSP (non-uniform convolution, ambisonics, LUFS), which would need a worklet anyway;
    - deterministic headless tests;
    - a native path.
  - Doing M1 on Web Audio would build the bus graph twice.
- **Babylon's AudioEngineV2 as the main engine.** It's already in the bundle and covers playback, buses, spatial and unlock: parity in weeks, not months. But it has no effects, voice management, events or diagnostics, and runs on browser nodes that differ per engine, so the goal would still need a core later. It's kept as the fallback backend instead (revision 3).
- **Adopt Firewheel or Kira.** Their web backends need nightly Rust, threads and COOP/COEP, or run on the main thread. We'll borrow their designs: Firewheel's node and parameter model, Kira's clocks and tweens.
- **C/C++ (miniaudio, SoLoud) through Emscripten.** It works, but adds a second native toolchain beside navigation's Rust.
- **Native audio only, in Tauri.** Desktop only. IPC round trips of 1.3 ms, with 10–30 ms outliers, rule out frame-accurate sync, and web builds would need a second engine.
- **Steam Audio.** No wasm build.

## Consequences

**Positive**
- A reason to choose the engine: priority and virtual voices, a sample-accurate clock and routable streaming at M1, then events, HRTF, occlusion, interactive music and live mixing, with no licence, on web and desktop.
- Audio leaves the main thread; game-frame hitches don't glitch audio, and streams survive main-thread stalls.
- Deterministic output, testable headless in Node and `cargo test`.
- The Babylon backend gives a way back during M1, and basic sound on engines that can't run the core afterwards.

**Negative / costs**
- About 31 person-weeks (155 person-days with reserve) for M1 alone, per the approved design. M2–M5 are each a project; the authoring UI is likely bigger than the DSP.
- We own DSP quality. Every effect and preset needs a listening pass; the owner runs it.
- Audio contributors need Rust; the committed wasm keeps everyone else Rust-free, as with navigation.
- Browser output latency stays ~50 ms.
- Main-thread state mirrors are up to a frame stale, which scripts must tolerate.

## Deprecates

- **0006** is superseded. Howler, `howlerBackend.ts` and the `howler` dependency are deleted when the Babylon backend lands (design task BB2).
- **0099** is superseded. In M1a, `fmodBackend.ts`, `tests/fmodBackend.test.ts`, `docs/guide/fmod.md` and the `"fmod"` backend value are removed, along with the FMOD wiring in `Engine.ts:13,177`.
- **0156** is withdrawn and never built.
- **0074, 0097, 0098** are amended (header). 0097's `busGraph.ts` moves to a test-only Web Audio reference for the parity harness. `implementation-status.md` rows and the decisions index are updated when this record is accepted.

## Open questions

- macOS real-time behaviour (low priority; a gate for macOS releases).
- User-written DSP (custom effects as wasm modules), later.

Settled at acceptance (2026-11-09):
- **Sound quality:** manual listening backed by automated objective checks (see Sound quality).
- **COOP/COEP:** postMessage is the default everywhere; the SAB ring is optional and only where isolation already works on every desktop platform (see Platforms).
- **Minimum versions:** the lowest that support all required features, confirmed in M1a.0.

Settled during M1 (2026-11-09):
- **One-shot completion:** no `Promise` in M1 (owner). Scripts poll `handle.playing` and `handle.reason` once per frame, as the engine does everywhere else. A `Promise` can be added later without breaking anything.

## RFC round

Reviews by an architect, a senior engineer and a mid-level engineer are in `docs/rfc/0157/`. Revision 2 took:
- the status channel and state ownership;
- the unlock layer;
- the clip-memory design;
- the clock time base;
- the failure table;
- splitting M1 behind a flag, with estimates, the soak gate, and Howler kept as a fallback;
- re-measuring and worst-case budgets, presets by device class and the adaptive cap;
- split size budgets;
- work-unit CI benchmarks;
- the command format with generation ids, and recycled buffers;
- the `AudioHandle`, priority, limits and diagnostics in M1;
- the behaviour-change table, the glossary and docs;
- marking 0074, 0097 and 0098 as amended;
- correcting the Web Audio sample-accuracy claim;
- `simd128` only;
- M2–M5 as a roadmap, and native output as a note;
- a single decode path after M1b.

**Not taken:**
- **The architect's suggestion to keep audio in the engine core:** 0133 (accepted) already lists Audio as a plugin, and navigation shows the pattern.
- **A macOS gate for deleting Howler:** the owner rates macOS low priority. It gates macOS releases instead, and macOS desktop builds keep Howler until it passes.
- **A completion callback:** it stays an open question, because the engine avoids event systems.

## References

- `spikes/audio-worklet/README.md` and its sub-READMEs: `spatial/`, `decode/`, `messaging/`, `native-out/`, `wasapi/`, `tauri-ipc/`, `occlusion/`, `bookkeeping/`.
- `docs/rfc/0157/architect.md`, `senior-engineer.md`, `mid-junior-engineer.md`.
- 0074, 0097, 0098 (the API and model kept); 0065 (the Rust → wasm pattern); 0133 (plugins); 0040 (`stream`).
- symphonia https://github.com/pdeljanov/Symphonia; SADIE II https://www.york.ac.uk/sadie-project/database.html; Firewheel https://github.com/BillyDM/Firewheel; Kira https://github.com/tesselode/kira.

## Revision 3 (2026-11-09): refinements from the approved technical design

The technical design in `docs/design/0157-audio-core/` (an architect's and a senior engineer's documents, two review rounds, coordinator review), approved by the owner, refined this record. The decision is unchanged: an engine-owned Rust core in an AudioWorklet, M1 first. What changed:

- **Fallback backend:** Babylon's AudioEngineV2 replaces Howler. It's chosen automatically when the core can't load, and kept after M1 for such engines. A core that loads and then exhausts its recoveries stays silent.
- **Reused code:**
  - ported from Chromium's Web Audio code (BSD, notices kept, listed in `native/audio/PORTS.md` and `THIRD_PARTY_NOTICES.md`): biquad, dynamics compressor, staged convolver, HRTF panner, equal-power panner, distance and cone;
  - **microfft** (MIT) as the FFT; 14 KB of wasm for the sizes we need;
  - designs borrowed from Kira, Firewheel and SoLoud.
- **HRTF moves into M1:** a port of Chromium's HRTF panner with its Composite HRIR data, for the nearest 16 spatial voices, so 3D sound keeps today's character. It's gated on clearing the data's licence first; the fallbacks are SADIE II data with the same code, or equal-power.
- **Clock:** plays apply *asap*; only stamped records use the lookahead.
- **Status:** every 6 quanta, not once per frame.
- **Recovery:** a hard rebuild with a chunked REPLAY. The worklet's memory is imported and initialised deterministically, so a soft recovery can be added later without an ABI change.
- **Pre-unlock queue:** one-shots only; owned and looping voices wait.
- **New settings:** `audio.clipMemoryMB`, `audio.clipFormat`, `audio.spatial`, `audio.voices.hrtf`.
- **Behaviour changes added:** a World that loses the view goes virtual; effects match by construction.
- **Estimate:** 155 person-days (about 31 person-weeks) with reserve, replacing 16–18 weeks.
- **Settled after revision 3 (2026-11-09):**
  - The owner (Chris Carlson) runs the human listening pass.
  - The low-end soak device is an **Android phone** running the lowest Android version that Google Play currently accepts for publishing apps (the exact version is looked up when the soak is set up, since Google raises it over time), playing the web build in its Chrome and Android System WebView.
  - The low end is a **starting point, not an absolute**. If the core shows significant performance gaps on it, the low end moves up to a more capable device class, rather than the design being squeezed to fit.
  - This makes Android's browser and WebView a runtime the core must serve at the "low" preset. If that Android version's WebView lacks AudioWorklet or `simd128`, the device gets the Babylon fallback, and the soak then measures the fallback. A0.6 checks which.

## Amended by ADR 0172 (M5), 2026-11-13: `loadPermille` (design section 4.7)

The design's STATUS section ([architecture.md §4.7](../design/0157-audio-core/architecture.md)) reserves `loadPermille` as 0, "unmeasured in M1". M5 keeps the field and still writes 0, and fills the figure another way (0172 §1.10; [0171 change 6](0171-audio-profiler-loudness-metering-and-live-mixing.md)).

- **The wire field stays 0, reserved.** The worklet has no clock, so the core can't measure its own time.
- **The CPU figure is computed on main** from cumulative counters: the shell writes the clock fields (busy milliseconds and quanta, as f64 totals, with the clock's step), the core writes five work-unit totals (voices, buses and effects, spatial, music, loudness). Main reads a window of 96 quanta and reports a percentage. On a coarse clock (a step over 1 ms) it widens the window, and past that it hides the line with a reason instead of a number.
- **Work units don't drive the cap.** The 2026-11-10 owner decision stands: only underruns and qualifying late commands lower the cap.
- Floor-phone microseconds stay estimates at 0.6 ns per metered instruction; no floor run was made (0172 §3.3).

Built by Cp1 (counters, Wave 2); the reader and the Profiler line are Cp2 and Pf tasks, in [the build log](../design/0171-audio-mix/build-log.md) as they land.
