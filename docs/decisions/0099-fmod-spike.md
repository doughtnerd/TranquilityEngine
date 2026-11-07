# 0099. FMOD as an optional audio backend: spike, recommendation and stub adapter

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0097, 0098, 0006, 0010

## Context

The owner asked whether FMOD (Core and Studio) could back the engine's audio. The SDK needs a logged-in fmod.com download, and fmod.com wasn't reachable from the overnight session, so this record rests on web-search summaries and on recall of FMOD's documented HTML5 usage. **Nothing here was verified against the SDK or its docs pages.** Confidence is marked per item.

What was found or recalled:

| Topic | Finding | Confidence |
| --- | --- | --- |
| Licence | A free indie licence exists for small budgets. Sources disagree on the limit ($500k budget and $200k yearly revenue on fmod.com/licensing as summarised; $600k in a summary of the EULA). The EULA reportedly requires an in-game credit naming FMOD and Firelight Technologies; a logo waiver is a paid option. Licences are per shipped title, so each game author needs their own; the engine can't bundle FMOD under one licence. HTML5 is a listed platform; no separate web licence or `.wasm` redistribution rule was found, and that is unconfirmed. | Low: read the EULA before relying on any of it |
| SDK files | HTML5 SDK ships `fmodstudio.js` + `fmodstudio.wasm`, and `fmodstudioP.*` (pthread build). The standard build has no threads. The reduced Core in the Studio libs lacks some codecs (e.g. ogg/mp3 reported unsupported through that path). | Medium (docs summary) |
| Audio output | Browsers with `AudioWorkletNode` use FMOD's AudioWorklet output (async mixing); older ones fall back to the deprecated ScriptProcessorNode. | Medium |
| Threads | The pthread build needs `SharedArrayBuffer`, so cross-origin isolation (COOP/COEP headers). The standard build avoids that. | Medium |
| Loading | Recalled, unconfirmed: an Emscripten `FMODModule(obj)` factory with `preRun`/`onRuntimeInitialized`, banks preloaded into the virtual FS with `FS_createPreloadedFile`, then `Studio_System_Create`, `initialize`, `loadBankFile`, results via `{val}` out-parameters; event instances, parameters, buses, VCAs and 3D attributes mirror the C API. | Low |
| Size | Not found. Expect a few MB of wasm; measure with the SDK. | Unknown |
| Tauri | Nothing found. WebView2 (Chromium) should behave like Chrome; WKWebView and WebKitGTK AudioWorklet and `SharedArrayBuffer` support must be tested. The non-pthread build avoids COOP/COEP. | Unknown |

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

- Licence terms for web and for engine-bundled use; whether a logo waiver is needed.
- The real wasm size, AudioWorklet and SharedArrayBuffer behaviour in WebView2, WKWebView and WebKitGTK.
- Event API design (0099 follow-up).

## References

- https://fmod.com/docs/2.03/api/platforms-html5.html (via search summary only)
- https://fmod.com/licensing, https://fmod.com/legal (via search summaries only)
- https://github.com/defold/extension-fmod/pull/18/files (pthread build needs COOP/COEP)
- `src/engine/audio/fmodBackend.ts`, `docs/guide/fmod.md`
