# FMOD backend (ADR 0099, experimental)

**Untested with the real FMOD SDK.** The adapter was written without the SDK (it needs a logged-in fmod.com download) and is only tested against a fake module. Expect to fix API details on first run. The default backend is Howler (ADR 0098); you only need this if you want FMOD.

## Licence

FMOD is licensed per shipped game, and the engine does not bundle it. Read FMOD's licence for your budget and platform (the indie terms and the in-game credit requirement were not verified; see ADR 0099) before shipping.

## Drop the SDK in

1. Download the FMOD Engine **HTML5** SDK from fmod.com (login required). From its `api/studio/lib/upstream/w32/` (or the HTML5 equivalent in your version), take `fmodstudio.js` and `fmodstudio.wasm` (not the `P` pthread build: it needs COOP/COEP headers).
2. Put them in your project, for example `fmod/fmodstudio.js` and `fmod/fmodstudio.wasm`, plus your exported banks (`Master.bank`, `Master.strings.bank`, ...) in `fmod/banks/`. The files must be served to the game like any asset.
3. In Project Settings > Audio choose Backend **fmod** and set the SDK path and banks, or edit `project.json`:

```jsonc
"audio": {
  "backend": "fmod",
  "fmod": { "sdkPath": "fmod", "banks": ["banks/Master.bank", "banks/Master.strings.bank"] }
}
```

`sdkPath` is a URL path relative to where the game is served. If loading fails the console says `[myco] FMOD backend unavailable, using Howler: ...` and Howler plays instead.

## What works (in theory) and what does not

| Works as written, unverified | Not implemented |
| --- | --- |
| Loading the script and wasm, mounting and loading banks | FMOD events and parameters (`Audio.playEvent`) |
| One Core channel group per mixer bus, `volume`/`mute`/solo/snapshots/ducking via the engine mixer | Bus effects (lowpass, highpass, compressor, reverb) |
| `AudioSource` clips through Core `createSound`/`playSound`, pitch, 3D position and distances | VCAs, bank-authored buses, streaming, the pthread build |
| `system.update()` each frame | Editor browsing of banks |

Clips go through FMOD's Core API, so formats follow FMOD's HTML5 build (ogg/mp3 support there is reduced; use wav if a clip stays silent).

## Wiring checklist for the first real run

- Open the browser console: the first thing that fails names the FMOD call (`FMOD ... failed (result N)`). Compare with the SDK's HTML5 examples (`Studio_System_Create`, `initialize`, `loadBankFile`, `FS_createPreloadedFile`, `createSound`, `playSound`, `FMOD_VECTOR`) and fix `src/engine/audio/fmodBackend.ts`.
- `setListener` passes plain objects where FMOD wants `FMOD_VECTOR`s: likely needs `vec()`.
- Verify AudioContext unlock after the first click, and test inside the Tauri window on every OS (WebKitGTK and WKWebView AudioWorklet behaviour was not researched).
