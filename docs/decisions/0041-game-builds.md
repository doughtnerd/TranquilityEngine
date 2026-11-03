# 0041. Games build to a static web player, packaged for desktop through Tauri

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0015, 0024, 0030, 0031, 0032

## Context

Since 0031 there has been no way to turn a project into a game: the samples play only through the editor's Play button, and the old Flappy-only `build:game` is gone (open question O14). What exists:

- Project scripts (`scripts/**/*.ts`) compile at runtime with the TypeScript compiler (`scriptLoader.ts`, 0030), and the dedicated server reads a project folder in Node through the same compiler (`src/server/project.ts`, `tsLoader.mjs`).
- Scene loading looks assets up synchronously (`Assets`), so JSON must be loaded and binary assets given URLs before a scene loads.
- `Engine.create` builds the Worlds from `project.json`'s bootstrap (0032); storage picks IndexedDB in browsers and the app data folder under Tauri (0024).
- The editor ships as a Tauri app (`src-tauri/`), and its samples ship beside it as static files (0031).

The user chose the direction: first a **static web build** (a player you can host or open locally, with the engine plus the project's files and compiled scripts), then a **desktop package** of that same player through Tauri.

## Decision

We will build games as a **prebuilt, project-independent web player plus the project's files**, and package that folder for desktop with a **generated Tauri project**.

### The player

- `player.html` + `src/player/main.ts`, built by `vite.player.config.ts` (`typescriptTranspile()`, `oxc: false`, `base: "./"`) into `dist/player/`, with `files.json` listing its output. It knows nothing about any project.
- The engine is a **second entry with a fixed name, `myco.js`**, built with `preserveEntrySignatures: "strict"`, so its exports are the public API. The player imports the same module, so the game and its scripts share one engine (one registry, one `World.current`), as the editor's shim gives in play mode. Neither an import map nor a global shim is needed.
- At start the player reads `game.json`, fetches the project's JSON files (and plain `.js` text assets, as the editor serves them), points binary assets at their URLs, imports the compiled scripts in load order, and calls `Engine.create` with `project.json`, the full-window container and a `loadScript` for a code bootstrap. Start-up Worlds whose bootstrap config names no scenes load the manifest's main scene, as they load the open scene in play mode. The canvas letterboxes at the display settings' aspect ratio and the page takes `display.backgroundColor`. Saves use the default storage (0024): IndexedDB in a browser, the app data folder in the desktop package.
- On a `file://` page, an inline script explains that the game must be served over HTTP (browsers block module scripts there).

### The web build layout (`src/export/format.ts`)

```
index.html  assets/   the player (player.html renamed)
myco.js               the engine module
game.json             { format: 1, name, mainScene, files: [...], scripts: [{ source, module }] }
project/              the project's files as they are
code/                 scripts compiled to JS (scripts/a/B.ts → code/scripts/a/B.js);
                      JSON a script imports → code/<path>.json.js (export default …)
serve.mjs  README.txt a dependency-free local server (`node serve.mjs [port]`), and how to run it
```

- **Scripts** compile with the editor's `compileScript` (now with `sourceMap: false` for builds), ordered and checked by its `loadOrder`, and their import specifiers rewritten to **relative file paths**: `"myco"`/`"tranquility"` to `myco.js`, scripts to their compiled files, JSON to its module. A script that doesn't compile or resolve fails the export, listing every problem (a build missing a behavior would run the wrong game).
- **File selection** (`isExportedFile`): everything in the project except hidden files and folders (`.myco/`), `node_modules`, `dist`, `target`, test output, TypeScript sources, and the root `tsconfig.json`, `jsconfig.json` and `sample.json`. Asset sidecars (`*.meta.json`) are ordinary files and go in.
- **The main scene** is `scenes/main.scene.json`, else the first scene (the editor's rule), or `--scene`. A code bootstrap (`"bootstrap": "scripts/Boot.ts"`) must be one of the project's scripts.
- An output folder must be **new, empty, or an earlier build** of the same kind (replaced). A folder inside the project is refused unless it's under a skipped folder (`dist/`), since the next export would copy it in.

### Exporting

- **CLI:** `npm run export -- <projectDir> [--out DIR] [--target web|desktop] [--scene PATH] [--build|--no-build]` (`src/export/cli.mjs` → `main.ts` → `node.ts`). It reads the project with the dedicated server's `readProject`, through the server's `tsLoader.mjs` hooks, plans the build with `planWebBuild` (`webBuild.ts`, no file access), and copies the player from `dist/player/`, building it first if it's missing. The default output is `<projectDir>/dist/<target>`.
- **Editor:** an **Export…** button in the project toolbar opens **Build / Export**. The editor build ships `dist/player/` beside itself at `player/` (the `playerFiles()` plugin, like `samples()`; the dev server serves it once built), and the dialog writes the same plan through the platform `FileSystem`: player files fetched from `player/`, project files from what the editor holds (text as last saved, binaries by their URLs). It needs a writable `FileSystem` (the desktop editor, or a browser one with folder access, feature-detected by `canWrite`); otherwise it explains and points to the CLI. Unsaved scene edits aren't in a build, and the dialog says so.
- `npm run build:editor` builds the player first, so `npm run build`, the Tauri editor's `beforeBuildCommand` and the e2e server all ship it.

### Desktop packages

- `--target desktop` writes the web build to `<out>/web/` and a **generated** Tauri v2 project to `<out>/src-tauri/` (`desktop.ts`): `tauri.conf.json` with `frontendDist: "../web"`, product name and window title from `project.json`'s `name`, window size from `display`, a minimal Rust shell (`tauri` + `tauri-plugin-fs` only) and a capability that allows file access in the app data folder only (for storage, 0024). It doesn't copy the editor's `src-tauri/`, which carries editor permissions (dialogs, any folder, opener) and the editor's identity; that app is untouched.
- **Icons** come from `tauri icon` (no Rust needed) over the project's icon, or a neutral generated SVG (not Myco branding).
- If `cargo` is installed, the exporter runs `tauri build` with the repo's Tauri CLI (installers in `src-tauri/target/release/bundle/`); otherwise, or with `--no-build`, it writes the project and a README with the commands. Re-exporting keeps `src-tauri/target/` so rebuilds are incremental. The editor's dialog shows the CLI command for this target, since the editor can't run a toolchain.
- Optional exporter-only settings in `project.json`, under `build`: `icon` (a square PNG or SVG in the project), `identifier` (reverse-DNS; default `com.myco.game.<name>`, which also decides where saves go) and `version` (`x.y.z`; default 0.1.0). They aren't part of `ProjectSettings`, the engine never reads them, and the Project Settings panel can surface them later.

## Alternatives considered

- **Bundle each project with Vite (a per-project app build).** Smallest output and tree-shaken, but every export needs Node, Vite and the repo's toolchain, and the editor (a static app in Tauri) couldn't export at all. The prebuilt player makes exporting a file copy plus the TypeScript transpile the editor already does.
- **Import map + global shim for `"myco"` (the editor's approach).** Works, but needs the export to know the engine's export names and keeps scripts' bare specifiers dependent on an import map. A fixed-name engine entry gives a real module, and relative specifiers work in any host and webview.
- **Copy the editor's `src-tauri/` for desktop packages.** Ships the editor's permissions and identity; generating a small, game-specific project is safer and lets the name, identifier, window and icon follow the project.
- **A single-file HTML build (everything inlined).** Would open from `file://`, but binary assets and modules as data URLs make large files, and module loading from data URLs differs across WebKit and Chromium (0030 already hit this). A static folder plus `serve.mjs` is simpler.

## Consequences

**Positive**
- Any project, samples included, becomes a hostable game in seconds, from the command line or the editor, running the same compiled JavaScript as play mode and the dedicated server.
- The player is tested once (e2e: Flappy and Arena exports boot in Chromium and WebKit) rather than per project.
- Desktop packages reuse the web build unchanged; the Tauri project is small and editable.

**Negative / costs**
- Every build carries the whole engine (about 4 MB minified, 1.5 MB gzipped: three.js and Rapier's inlined WebAssembly), unused parts included.
- Opening `index.html` from disk doesn't work; the build ships `serve.mjs` and explains.
- The first desktop build compiles Tauri (minutes) and needs Rust and the platform's Tauri prerequisites.
- The editor exports only the files it knows (its asset extensions: images, audio, JSON, JS); the CLI copies every file.

## Deprecates

Nothing. O14 is resolved by this record.

## Open questions

- Smaller builds: per-project tree-shaking, or splitting physics and networking out of the engine chunk.
- Desktop packages from the editor itself (it would need a shell or a bundled toolchain), and mobile targets.
- Code signing and notarisation of installers; app store packaging.

## References

- `src/export/` (format, planner, Node exporter, desktop generator, CLI), `src/player/main.ts`, `player.html`, `vite.player.config.ts`, `src/editor/exportBuild.ts`, `src/editor/ui/ExportDialog.tsx`; tests `src/export/export.test.ts`, `src/editor/exportBuild.test.ts`, `tests/e2e/export.spec.ts`.
