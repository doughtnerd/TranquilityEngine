# 0148. The FMOD backend uses FMOD 2.04's npm package, pthreads build, with the engine served cross-origin isolated

- **Status:** Withdrawn in favour of 0149 (an engine-owned audio core; FMOD can only be a third-party plugin)
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** 0099
- **Related:** 0097, 0098, 0003, 0015, 0041

## Context

0099 added a stub FMOD adapter (`src/engine/audio/fmodBackend.ts`) written without the SDK. It injects `fmodstudio.js` with a `<script>` tag, expects a global `FMODModule`, preloads banks into Emscripten's filesystem and uses the `{ val }` out-parameter convention. It chose the single-threaded build to avoid cross-origin isolation.

The owner now has the FMOD 2.04 SDK, and the HTML5 platform page in its offline manual (`doc/FMOD API User Manual/platforms-html5.html`) changes most of that:

- **New JavaScript API in 2.04.** The manual calls it "a modernized JavaScript API": an npm package, `npm install fmod-2.4.00.tgz`, installed as `fmod`. Each library is an ES module with a `createFMOD(opts)` factory that returns a Promise (`import createFMOD from "fmod/fmodstudioP"`). Calls return values and throw on error (`const system = FMOD.System_Create()`), so out-parameters are gone. TypeScript definitions ship as `fmod.d.ts` and `fmodstudio.d.ts`. Every call in the stub is therefore wrong.
- **Threading.** In the single-threaded build "all mixing / streaming [is] performed on main thread". The AudioWorklet only plays out what the main thread has already mixed. The pthreads (`P`) build mixes, streams and loads on worker threads, and the manual says audio "does not stutter when main thread stalls". The engine's frame already competes with GC pauses and long frames, so the owner chose pthreads.
- **The `P` build needs `SharedArrayBuffer`.** Browsers only give that to cross-origin isolated pages: those served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Nothing serves those headers today: not the Vite dev server (`vite.config.ts`), not Tauri (`src-tauri/tauri.conf.json` sets only `csp: null`), not the export's `serve.mjs`, not `scripts/e2e-server.mjs`.
- **Callbacks don't run from threads.** With pthreads, JavaScript file callbacks only work under `STUDIO_INIT_LOAD_FROM_UPDATE` plus `SYNCHRONOUS_UPDATE`. Loading from memory (`loadBankMemory`, or `createSound` with `OPENMEMORY`) has no callbacks.
- **Codecs.** The release Studio libraries (`fmodstudio`, `fmodstudioP`) contain the *reduced* Core library. It reads **FSB only**, so no WAV, OGG or MP3, which are the formats `AudioSource` clips use. The manual says to use the logging (`L`) libraries "to get the full feature set" and turn logging off with `Debug_Initialize`.
- **Web limits remain.** No Live Update or profiling against FMOD Studio, no geometry, no `loadPlugin`. Studio needs one user gesture before audio starts.
- **Licence.** Licences are per shipped title (0099's research). The SDK can't be committed, and a fresh checkout must still build and run without it.

## Decision

We will:

1. **Get the SDK from FMOD's npm package, kept out of the repo and out of `package.json`.** `npm run fmod:install -- <path/to/fmod-2.4.00.tgz>` unpacks the package into `vendor/fmod/`, which is git-ignored. `npm install` doesn't prune that folder, as it would a `--no-save` install in `node_modules`. A Vite plugin, `fmodSdk()` in `vite.shared.ts` and used by every config, resolves the virtual module `myco:fmod`:
   - to `vendor/fmod/fmodstudioPL.js` when the SDK is present (pthreads, full Core library; logging off at runtime);
   - to `vendor/fmod/fmodstudioL.js` for `myco:fmod/single`, the fallback in item 3;
   - otherwise to a stub that rejects with "FMOD SDK not installed: run npm run fmod:install". A fresh checkout builds, typechecks and tests unchanged.
2. **Load FMOD lazily as its own chunk.** The adapter does `await import("myco:fmod")` only when `project.json` has `audio.backend: "fmod"`. Howler projects never download the wasm. Vite emits the `.js`, `.wasm` and pthread worker files as assets beside the chunk, located through `import.meta.url`. Export (0041) copies them into a game only when that project selects FMOD.
3. **Use the pthreads build, and fall back rather than fail.** Before importing, the adapter checks `globalThis.crossOriginIsolated`:
   - true: load `myco:fmod` (the `P` build);
   - false (for example, a web host that doesn't send the headers): warn once and load `myco:fmod/single`, so banks and events still play, mixed on the main thread;
   - SDK missing or init throwing: warn and keep Howler, as 0099 does.
4. **Serve everything cross-origin isolated** with COOP `same-origin` and COEP `require-corp`:
   - the Vite dev server and preview (`server.headers`, `preview.headers`);
   - Tauri, through `app.security.headers` in `tauri.conf.json` (Tauri 2.1 and later; we're on 2.12);
   - the export's `serve.mjs` and `scripts/e2e-server.mjs`;
   - the export guide, which lists the two headers web hosts must send.

   We use `require-corp` rather than `credentialless` because WebKit (macOS and Linux Tauri) doesn't support `credentialless`. This applies whatever the audio backend is, so every page behaves the same.
5. **Load banks and clips from memory.** The engine fetches bytes through its own asset loader. That covers dev URLs, Tauri project files and exported games alike. It then calls `studio.loadBankMemory(bytes, …)` for banks and `core.createSound(bytes.buffer, OPENMEMORY | …, { length })` for clips. There's no Emscripten filesystem preloading and no file callbacks, which side-steps the pthread callback limits. The `fmod.banks` setting becomes a list of project asset paths. `sdkPath` goes away.
6. **Rewrite the adapter against the 2.04 API.** Values are returned and exceptions are caught, with `createFMOD({ INITIAL_MEMORY })`. Before `initialize`, it matches the output rate (`getDriverInfo(0).systemrate` → `setSoftwareFormat`) and calls `Debug_Initialize` to turn logging off. It calls `mixerSuspend`/`mixerResume` on `visibilitychange`, and initializes on the engine's first user-gesture audio unlock. The adapter keeps its own small interface for the slice of the API it calls, so the engine typechecks without the SDK. When the SDK is present, a test checks that interface against `fmodstudio.d.ts`. The mapping in 0099 is kept: Core channel groups for buses, the engine mixer pushing gains, clips through Core.
7. **Test against the real SDK when it's installed.** The npm package includes Node builds (`fmodstudioN`, no audio output, `OUTPUTTYPE_NOSOUND`). Vitest runs the adapter against it under `describe.skipIf(!sdkInstalled)`: init, bank load, clip play, buses, release. The fake-module tests stay for checkouts without the SDK. A Chromium e2e spec, skipped without the SDK, checks `crossOriginIsolated`, that the `P` build starts, and that a clip plays.
8. **Leave events, parameters, VCAs and bank browsing to a later record**, as 0099 planned. This record is the runtime: SDK, threads, isolation, loading, clips and buses.

## Alternatives considered

- **Single-threaded build (0099).** No headers needed, but mixing runs on the main thread, so every frame hitch becomes an audio glitch. It stays only as the fallback when a host can't isolate.
- **Add `fmod` to `package.json` (`file:` tgz or a private registry).** A fresh checkout's `npm install` would fail without the licensed tarball, and committing the tarball redistributes the SDK.
- **Load the SDK at runtime from a project folder (`sdkPath`, 0099).** The licence would sit with each project, but Emscripten finds its wasm and pthread workers relative to `import.meta.url`. In the desktop editor, project files are served as blob URLs, where that breaks, so the files need real served URLs. Vite's asset handling does this for us. We can revisit if per-project SDKs are needed.
- **Release `fmodstudioP` instead of `fmodstudioPL`.** Smaller, but it reads FSB only, so ordinary WAV/OGG/MP3 clips would need FSB conversion at import. Revisit once the size difference is measured.
- **Native FMOD through Tauri/Rust.** Faster, with Live Update, but desktop only and a second audio path. The owner wants one path for browser and desktop.
- **COEP `credentialless`.** Laxer for cross-origin resources, but unsupported in WebKit.

## Consequences

**Positive**
- Audio mixing and streaming leave the main thread, so GC pauses and long frames no longer glitch audio.
- One FMOD path for browser, desktop editor and exported games, typechecked against FMOD's own definitions.
- Fresh checkouts and Howler projects are unaffected: no SDK, no download, same behaviour.
- Real-SDK tests in Node, headless, whenever the SDK is installed.

**Negative / costs**
- **Cross-origin isolation applies to the whole engine.** Any cross-origin subresource or iframe must send `Cross-Origin-Resource-Policy` or CORS, or it's blocked. None are in use today (checked the HTML entries; the docs link opens a new window, which isn't affected). Every web host for an exported game must send two headers, or FMOD falls back to the main-thread build.
- `fmodstudioPL` is larger than the release build; size not measured yet.
- An editor or player built on a machine with the SDK contains FMOD. Whoever ships that build needs an FMOD licence. Foxfire's public editor builds must be made without the SDK unless the licence allows otherwise.
- Users still need a click or key press before audio starts, and there's no Live Update on web.

## Deprecates

0099 (Proposed) becomes **Superseded by 0148**: its research and its "Howler stays the default" stance carry over. The `<script>`/`FMODModule` loader, FS preloading, `{ val }` calls and the `audio.fmod.sdkPath` setting are removed. `settings.ts` reads an old `sdkPath`, ignores it, and reports it as a problem. `docs/guide/fmod.md` is rewritten.

## Open questions

- Download size of `fmodstudioPL` vs `fmodstudioP` (measure once the package is unpacked).
- Whether `require-corp` breaks anything in the desktop editor's Monaco workers, thumbnails or project asset blobs. To be checked by e2e and by running `tauri:dev`.
- The 2.04 "fetch" bank-loading API the manual's What's New mentions: does it beat `loadBankMemory` for large banks? Its signature is to be read from `fmodstudio.d.ts`.
- Licence terms for an engine editor build that includes FMOD.

## References

- FMOD 2.04 manual, `platforms-html5.html` (npm install, libraries, threading, loading, codecs, pthread callbacks, known issues) and `welcome-whats-new-204.html` (HTML5 improvements); online at https://fmod.com/docs/2.04/api/platforms-html5.html
- 0099 for licence research and the bus/clip mapping
- `src/engine/audio/fmodBackend.ts`, `src/engine/audio/backend.ts`, `src/engine/audio/settings.ts`, `vite.shared.ts`, `src-tauri/tauri.conf.json`, `src/export/webBuild.ts`, `scripts/e2e-server.mjs`
- Tauri security headers: https://v2.tauri.app/security/http-headers/
