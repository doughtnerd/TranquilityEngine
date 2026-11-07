# 0059. The desktop editor opens on a Projects window while the editor loads hidden

- **Status:** Proposed, amended by 0082 (the Projects window creates the editor window once it shows)
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0015, 0022, 0026, 0031, 0038, 0045

## Context

The desktop editor had one window: it loaded the whole editor (three.js, Rapier, the panels) before the start screen appeared over it, then opened the project picked there in the same window. The start screen only needs the recent-projects list, the samples and a folder dialog, but it waited for everything.

Start-up was slow in two places:

- **Dev server:** every start re-ran the `typescriptTranspile()` plugin (tsc; ADR 0015) over all of the editor's and engine's modules. That took about 2.9 s of the ~3.1 s before the start screen appeared, even when no file had changed.
- **Every build:** the editor's start-up bundle held Rapier 2D (its WASM inlined; ~3.4 MB of a ~5 MB entry chunk) and the Shader Graph panel with its graph library, though neither is needed until a 2D scene plays or the panel opens. Rapier 3D was already loaded on demand (ADR 0045).

## Decision

**Two windows in the desktop editor.**

- `projects.html` is the **Projects window** (label `projects`): the start screen (New Project…, Open Project…, recent projects, samples) on its own. It loads no engine or editor code beyond the file system and the start screen, so it shows at once.
- The **editor window** (`editor.html`, label `main`) is created hidden at the same time and loads in the background.
- Picking a project in the Projects window does the picking there: the folder dialog, a new project's scaffolding (without the engine's declarations, which the editor writes when it opens the project), copying a sample. It then hands the editor window `{ kind: "folder", root }` or `{ kind: "sample", id }` over Tauri events (`src/editor/launcher/handoff.ts`):
  - the Projects window pings, and the editor answers `ready` when it loads and on each ping;
  - the Projects window sends `open`; the editor opens the project, shows and focuses itself, then answers `opened`, or sends the error back;
  - the Projects window hides on success, or shows the error and stays.
- **Close Project** in the editor hides the editor window and shows the Projects window again, with its recent list refreshed.
- **Closing windows:** closing the editor window quits the app, after the editor's unsaved-changes guard. Closing the Projects window quits only while the editor is hidden; otherwise it hides (`src-tauri/src/lib.rs`).
- **The start screen's actions** are an interface (`src/editor/startActions.ts`) that each page sets. The editor page uses `session.ts`; the Projects window uses `launcher/actions.ts`. The editor in a browser keeps the start screen over the editor, as before. `projects.html` outside Tauri redirects to `editor.html`.

**Faster start-up.**

- **The tsc plugin keeps its output on disk:** `node_modules/.cache/myco-tsc/`, one entry per source file, reused while the file's text, the TypeScript version and the compiler options match. The dev server, builds and Vitest all use it.
- **Rapier 2D loads on demand**, like Rapier 3D: `physics/physics2dSystems.ts` holds the 2D event buffers, the fixed-step systems and `ensurePhysics2D`, which imports `Physics2DWorld` (and Rapier) the first time a World needs 2D physics.
- **The Shader Graph panel loads the first time it shows.** The property value field it shared with the Material Inspector moved to `ui/ShaderPropertyValue.tsx`.

## Alternatives considered

- **One window, start screen first, then load the editor in it.** No second window to coordinate, but the editor could only start loading after a project was picked. The wait would just move.
- **Show the editor window at once with a splash.** It looks responsive, but the start screen would still wait for the editor bundle.
- **Replace tsc with a faster transpiler.** oxc doesn't lower standard decorators (ADR 0015), and the alternatives would mean a new dependency for the transpiler. The cache gives most of the gain with the same output.

## Consequences

**Positive**
- **Desktop:** the Projects window appears without waiting for the editor, and the editor is usually loaded by the time a project is picked.
- **Dev server:** a cold start reaches the start screen in about 0.6 s, down from about 3.1 s.
- **Builds:** the editor's start-up JavaScript went from ~5.0 MB to ~1.4 MB. Games without 2D physics (and the player bundle's start-up) no longer load Rapier 2D.

**Negative / costs**
- **Two windows to keep in step.** Where a folder picked in one window can be reached from the other depends on Tauri's file-system scope, which is app-wide.
- **The Projects window's theme** is read when it opens, so an Appearance change in the editor shows there after a restart.
- **Disk cache:** `node_modules/.cache/myco-tsc/` grows by one small file per TypeScript source file; deleting it is always safe.
- **First 2D physics load:** the first scene with 2D physics waits for Rapier 2D to load, as 3D already did.

## Deprecates

Nothing.

## Open questions

- Should the Projects window offer more (Unity Hub-style installs, templates, news)? Not needed yet.

## References

- `projects.html`, `src/editor/launcher/`, `src/editor/startActions.ts`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `vite.shared.ts` (`typescriptTranspile`), `src/engine/physics/physics2dSystems.ts`.
