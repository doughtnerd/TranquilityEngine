# 0099. FMOD as an optional audio backend: spike, recommendation and stub adapter

- **Status:** Superseded by 0157 (FMOD is not shipped; an engine-owned core instead)
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0097, 0098, 0006, 0010

## Context

The owner asked whether FMOD (Core and Studio) could back the engine's audio. The SDK needs a logged-in fmod.com download, and fmod.com wasn't reachable from the overnight session, so this record rests on web-search summaries and on recall of FMOD's documented HTML5 usage. **Nothing here was verified against the SDK or its docs pages.** Confidence is marked per item.

Second research pass (WebSearch only; fmod.com still can't be fetched from the session, so every row is a search-result paraphrase of the cited page, not the page read in full):

| Topic | Finding | Confidence |
| --- | --- | --- |
| Licence tiers | Free **Indie** licence for non-commercial and small commercial use, with registration and self-certification of budget and revenue. Newer sources (Wikipedia, a Grokipedia summary): Indie for development budget under **$600k**, Basic $600k–$1.8m (about $6,000 per title), Premium over $1.8m (about $18,000 per title). An older EULA excerpt gave **$500k** budget and **$200k** yearly revenue, with Basic about $5k and Premium about $15k. The $500k/$600k split and the revenue cap are unresolved. | Low–medium: prices from third-party sites; confirm on fmod.com/licensing |
| Licence, web and engines | Nothing found on HTML5-specific or web-specific terms. The EULA excerpt says the FMOD engine is "integrated and redistributed in a game application (Product) only": licensing is per shipped title, so each game author needs their own, and the engine can't ship FMOD as part of itself. A logo/credit requirement exists (logo waiver is paid). | Low: read the EULA |
| HTML5 SDK files | `fmodstudio.js`+`.wasm` (release), `fmodstudioP.js`+`.wasm` (SharedArrayBuffer/pthread); all include the reduced Core library by default, which cuts size but drops some Core features (e.g. ogg/mp3 access). No file sizes found. | Medium (official docs page, via search) |
| Cross-origin isolation | The `P` build needs `SharedArrayBuffer`, so cross-origin isolation (COOP/COEP); it enables background streaming and non-blocking file loading. The standard build has no threads and avoids this. | Medium (official docs page) |
| Memory | `ALLOW_MEMORY_GROWTH`: grows from `INITIAL_MEMORY` up to 2 GB; FMOD's own default pool is 16 MB. | Medium (docs) |
| Latency | Official guidance: if the browser's sample rate isn't FMOD's default 48 kHz, a resampler adds CPU and one DSP block of latency, so query the hardware rate and match it with `setSoftwareFormat` before init. On devices that stutter, use 2 blocks of 2048. No measured latency figures found. | Medium (docs) |
| AudioWorklet | Recalled from the earlier pass: browsers with `AudioWorkletNode` use FMOD's AudioWorklet output (async mixing), older ones fall back to ScriptProcessorNode. This pass found no source. | Low–medium |
| Live Update and plugins | **Live Update and profiling can't connect from the web build to FMOD Studio** (the docs say alternatives need proxy servers); third-party reports say plugins don't work on web either. So designers can't audition a running web game in Studio. | Medium (docs + a Godot integration issue) |
| Bank loading | Banks are files in FMOD's virtual filesystem: the docs list `FMOD.FS_createPreloadedFile`; typical use is preloading before `loadBankFile`. Whether banks can be fetched lazily from a URL at runtime without preloading (e.g. fetch + `FS_createDataFile`, or `loadBankMemory`) is **unconfirmed**; a Godot extension reports its custom bank loader broke on web and the stock path worked. | Low |
| Known web shipping | Found only integrations/experiments (Godot GDExtension PR, Defold extension, a GameMaker FMOD extension, Unity WebGL with a silent-audio-until-second-scene bug tied to sample-rate mismatch). No shipped commercial web title was confirmed. | Low |
| Tauri | Nothing found. WebView2 (Chromium) should behave like Chrome; WKWebView and WebKitGTK AudioWorklet and `SharedArrayBuffer` support must be tested. The non-pthread build avoids COOP/COEP. | Unknown |

Implications: use the standard (non-`P`) build so web export and Tauri need no cross-origin isolation; expect no Studio Live Update on web; budget for a 48 kHz vs hardware-rate check; and treat banks as preloaded assets, which means a large bank delays startup.

How FMOD maps to the engine model:

- **Buses.** Mixer buses (0097) map to Core `ChannelGroup`s for plain clips, or to Studio buses (`bus:/Music`) when a project uses banks. `Bus.volume`, `mute` map directly; solo, snapshots and ducking stay computed by the engine's mixer, which pushes gains. FMOD Studio could instead author these (snapshots, sidechain ducking) and the engine would only set parameters.
- **Clips.** `AudioSource.clip` → Core `createSound` + `playSound`, `pitch` → channel pitch, spatial → 3D attributes and min/max distance. This is what the stub implements.
- **Events and parameters.** Studio events (`event:/Weapons/Cannon`) with parameters are FMOD's main value and have no equivalent in the engine yet: they would need an `AudioEvent` component or `Audio.playEvent(path, params)`, bank assets and an editor browser. The stub does not do this.
- **Effects.** Bus effects in 0097 would be DSPs or authored in Studio; not mapped in the stub.

## Decision

We will:

1. **Keep Howler plus the Web Audio mixer (0097) as the default and recommended backend.** It has no licence, size or SDK-download cost and covers the buses, ducking and spatial needs of the planned games.
2. **Keep FMOD as an optional, user-supplied backend** behind the interface of 0098: `audio.backend: "fmod"` with `audio.fmod.sdkPath` and `banks` in `project.json`. The adapter (`audio/fmodBackend.ts`) loads `fmodstudio.js` from that path at runtime. The SDK is never committed or bundled, so licensing stays with the game author. If it fails to load, the engine warns and uses Howler.
3. **Not add event/parameter API until the SDK is in hand.** Revisit then: bank assets, an `AudioEvent` component and an editor event browser are a separate ADR.
4. **Revisit "make FMOD primary" only if** a sound designer needs Studio authoring (events, adaptive music) and the licence, wasm size, and Tauri WebKit behaviour have been verified.

## Alternatives considered

- **FMOD as the only backend.** Licence, per-game credit and a logged-in SDK download block a fresh checkout building and running; rejected.
- **Native FMOD in Tauri via Rust.** Needs a desktop licence, doesn't help the browser build, and splits the audio paths.
- **Other middleware (Wwise, Web Audio only).** Not researched; Wwise has no HTML5 target to our knowledge (unverified).

## Consequences

**Positive**
- The seam exists and is covered by a fake-module test; adopting FMOD is wiring and verification, not a refactor.

**Negative / costs**
- **The adapter is untested with the real SDK.** Method names, argument order, enum names (`MODE_3D`, `STUDIO_INITFLAGS`…), the out-parameter convention and `FMOD_VECTOR` construction are from memory. Expect fixes on first run.
- Effects, events, parameters, VCAs and bank-authored buses are not mapped.

## Deprecates

Nothing.

## Open questions

- Licence terms for web and for engine-bundled use; the $500k vs $600k Indie limit; whether a logo waiver is needed.
- The real wasm size, AudioWorklet behaviour, and bank loading from URLs (preload only, or lazy) in WebView2, WKWebView and WebKitGTK.
- Event API design (0099 follow-up).

## References

- https://www.fmod.com/docs/2.03/api/platforms-html5.html (files, P build, cross-origin isolation, memory, sample rate and buffers, Live Update limit; via search results only)
- https://fmod.com/licensing, https://fmod.com/legal (via search summaries only)
- https://en.wikipedia.org/wiki/FMOD (tier thresholds), https://www.gamedeveloper.com/audio/small-developers-and-creators-can-now-use-fmod-studio-for-free, https://gamefromscratch.com/fmod-studio-now-free-for-indie-game-developers/ (indie licence history), https://www.techjockey.com/detail/fmod (prices, third party)
- https://github.com/utopia-rise/fmod-gdextension/pull/210 and https://github.com/luc4s/FMOD-GODOT/issues/1 (Godot web: bank loading, no Live Update or plugins)
- https://github.com/defold/extension-fmod/pull/18/files (pthread build needs COOP/COEP)
- https://gamineai.com/help/fmod-unity-webgl-bank-loads-audio-silent-first-scene-bus-init-fix (Unity WebGL sample-rate issue; unverified guide)
- `src/engine/audio/fmodBackend.ts`, `docs/guide/fmod.md`
