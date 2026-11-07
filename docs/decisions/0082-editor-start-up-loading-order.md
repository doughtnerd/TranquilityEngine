# 0082. The editor loads in order: the Projects window or start screen first, the editor and engine behind it

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0015, 0059 (amended: when the editor window is created), 0083

## Context

`npm run tauri:dev` was slow to show anything on Windows (WebView2): in devtools nearly every request started at once and CSS alone took ~30 s. Measured here with the Vite dev server in Chromium (Playwright, both windows simulated with a stubbed Tauri API; scripts in the PR):

- **Both windows loaded at once.** Tauri created the hidden editor window (`main`, ADR 0059) at start-up beside the Projects window. The Projects window needs ~50 dev modules (1.2 MB); the editor ~310 modules (17 MB, including the 5.8 MB pre-bundled `three`). In dev every module and every CSS file is its own request on one host, so the Projects window's few waited behind the editor's many. Projects card: **1.6 s** after a server restart with warm caches (0.4 s when the editor window isn't there), **7.8 s** on cold caches.
- **A cold dependency cache reloaded both windows.** Vite's dependency scanner compiles JSX itself and never sees the `preact/jsx-runtime` import that tsc (`typescriptTranspile()`) adds, so on a cold cache it found it late, re-bundled the dependencies and sent a full reload to every open page (logged: `optimized dependencies changed. reloading`).
- **The browser editor's start screen waited for everything.** `editor.html` statically imported the layout, the session and the engine, so its start card showed after ~310 modules (0.9 s warm).
- **Opening a project was serial.** The renderer's chunk (`BabylonSurface` imports `BabylonRenderer` dynamically) started loading only after the project's scripts had compiled with `typescript` (8 MB in dev), and the desktop editor window showed itself before the renderer existed, so the scene view could appear blank for a moment.

The production build was already split well (Projects window 16 requests / 100 KB gzip; editor start 23 requests / 550 KB) and gains less.

## Decision

We will load the editor in order, each stage starting once the one the user sees is up:

- **Projects window first (desktop).** The editor window's entry in `src-tauri/tauri.conf.json` is `create: false`. The Projects window renders, waits two animation frames and an idle callback (1.5 s at most), and creates the editor window from that same config entry (`launcher/editorWindowStart.ts`: `new WebviewWindow("main", options)`), which then loads hidden in the background as before. Picking a project before then creates it at once (`startEditorWindow` is idempotent). The capability adds `core:webview:allow-create-webview-window`. If the Projects window is closed while the editor window is being created, the editor page destroys itself (nothing would ever show it). The hand-off protocol of ADR 0059 is unchanged.
- **Start screen first (browser).** `src/editor/main.tsx` renders the start screen from the modules it needs (theme, start screen, New Project and About dialogs) while `App`, the shortcuts, the panel registry and the session load as dynamic imports; then `App` replaces it. The start actions load the session before running, so a click during loading waits instead of failing. `window.openTestProject` (the e2e hook) is set at once and loads the session too.
- **Background prefetch.** Once the editor is up (and after a `?sample=` sample has opened): the panels the layout shows load at once and the rest when idle (ADR 0083); then `prefetchWhenIdle()` (`src/editor/prefetch.ts`) loads the engine's lazily loaded chunks (Babylon renderer, editor tools, particles, UI document parsers), then the script compiler and both physics engines. In the desktop app this happens in the hidden editor window while the user is still on the Projects window.
- **Project open in parallel.** `loadProject` starts `prefetchEngine()` before compiling the project's scripts, so the renderer's chunks load alongside the compiler instead of after it.
- **Show the desktop editor once the scene view can draw.** `RenderSurface.started` (new, optional; `BabylonSurface` resolves it when `BabylonRenderer.create` finishes, false if it fails) is awaited by `session.sceneViewStarted()` (4 s at most) before the editor window shows itself after a hand-off. It doesn't wait for an animation frame: a hidden window gets none.
- **Dev server.** `vite.config.ts` pre-bundles `preact/jsx-runtime` (`optimizeDeps.include`), and `server.warmup` transforms the Projects window's and the editor's entry modules as the server starts. `engineTypes()` (`vite.shared.ts`, the engine's declarations for the Code panel) keeps its output in `node_modules/.cache/myco-types.json`, reused while every engine source, tsc and the options match: the emit took several seconds on the server's thread (27 s on a busy machine) the first time a project opened, stalling every other request; after a restart it is 0.5 s.

## Alternatives considered

- **Create the editor window from Rust** (`WebviewWindowBuilder::from_config` in a command) — equivalent at run time, but needs a new command and couldn't be compiled or tested in the environment this was built in; the JS API reads the same config entry, so window settings still live in one place.
- **Create the editor window only when a project is picked** — the Projects window would show fastest, but every project open would then wait for the whole editor to load; idle-time creation gets both.
- **Bundle the dev server's modules (e.g. a pre-built editor in dev)** — removes the request count but loses Vite's per-module HMR and fast restarts; the request count matters little once the two windows no longer compete.
- **Keep both windows and lower the editor window's priority** — WebView2 has no per-window network priority.

## Consequences

**Positive**
- Simulated `tauri dev` (Chromium, dev server): Projects card **1.6 s → 0.4 s** after a server restart (warm caches), **7.8 s → 4.0 s** on cold caches (no reload any more; the rest is Vite's first dependency bundling). The editor window is still ready ~1.1 s after start.
- Browser editor: start card **0.9 s → 0.3 s**, 311 → ~80 dev requests before it shows.
- The renderer is ready by the time a picked project's editor window shows.

**Negative / costs**
- More moving parts at start-up: a window created from JavaScript (needs the extra capability), a start-screen shell that is replaced by `App`, a prefetch list in `prefetch.ts` that must follow the engine's chunk boundaries (a stale entry only loses the head start).
- The browser's `?sample=` path pays one more dynamic-import round trip (shell, then `App`): about the same time to open in measurements (±0.3 s noise).
- The Tauri window behaviour itself has no automated test (no Tauri e2e harness); the Projects window → editor window flow must be checked by hand on Windows.

## Deprecates

ADR 0059's "both windows load at start-up": the editor window is now created by the Projects window. Nothing removed.

## Open questions

- `three` (5.8 MB pre-bundled in dev) is still in the editor's start-up graph because `scene/models.ts` builds the built-in meshes with three.js geometry synchronously. Moving that behind the loaders' dynamic import would take it out (ADR 0081's open question on baking models touches the same file).
- Monaco and its TypeScript worker (~100 MB of dev requests) load on idle after a project opens (`preloadCodeEditor`); on slow machines that may still compete with the first seconds of editing.

## References

- `src/editor/launcher/editorWindowStart.ts`, `src/editor/main.tsx`, `src/editor/prefetch.ts`, `src/editor/session.ts` (`sceneViewStarted`), `src/engine/render/RenderSurface.ts`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `vite.config.ts`.
- Measurement scripts and numbers: the PR for branch `claude/editor-startup-perf`.
