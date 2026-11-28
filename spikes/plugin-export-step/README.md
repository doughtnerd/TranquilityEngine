# Spike: plugin export steps (ADR 0452 "Build steps from plugins")

Throwaway. Nothing outside `spikes/plugin-export-step/` is changed. Base: branch `claude/admiring-hypatia-n09ol2` at 33f89a4c.

## Question

Can a plugin's **export step** (declares Export options, returns a manifest slice for `game.json` plus files) run everywhere exporting runs, for first-party and third-party plugins, and how should it be packaged?

**Answer: yes, with one new loader and a small set of changes to discovery.** Exporting runs in exactly two kinds of host (Node CLI; the editor page, browser or Tauri webview), and both already compile and `import()` plugin TypeScript through the same `link` + `MemoryTarget` pair. A step needs no new compiler. It needs a `plugin.json` `export` key, an export-only folder excluded from game builds, and a static first-party registry.

## 1. Where exporting runs today

| Host | Entry | Environment | File access | Evidence |
|---|---|---|---|---|
| CLI `npm run export -- <dir>` | `src/export/cli.mjs` -> `main.ts` -> `node.ts` `exportProject` | Node 22, engine TS loaded via `src/server/tsLoader.mjs` hooks | `node:fs` behind `nodeFiles(root)` / `nodeFolder(out)` (`node.ts`); `readProject` (`src/server/project.ts:63`) reads the folder into Maps | `cli.mjs:5-9`, `node.ts:105` (`planWebBuild`), `node.ts:116` (`writeWebBuild`) |
| Editor Export, desktop (Tauri webview) | `src/editor/ui/ExportDialog.tsx` -> `src/editor/exportBuild.ts` | WebView page (same bundle as the browser editor) | platform `FileSystem` (`src/engine/platform/FileSystem.ts`, `TauriFileSystem.ts`) via `fileSystemFolder(fs, out)` (`buildWriter.ts`); project bytes via `project.textOf` / asset URL `fetch` (`exportBuild.ts` `projectFiles`); player files `fetch`ed from `player/` beside the editor | `exportBuild.ts:150` (`planWebBuild`), `:153` (`writeWebBuild`) |
| Editor Export, browser | same code | Browser page | File System Access (Chromium) when the project folder has a writable FS; else read-only `BrowserFileSystem` and the dialog says "use the CLI" | `ExportDialog.tsx:196` |
| Desktop *app build* (`tauri build`) | Rust commands `myco_build_toolchain`, `myco_build_desktop_app` via `src/editor/hostToolchain.ts` | Tauri host process | n/a: it builds the already-written package; no plugin code runs in it | `hostToolchain.ts` |
| Studio "Convert now" | `src/studio/encoding/studioEncoding.ts` | page | runs `processAudio` only, not `planWebBuild`, so it is not an export host for steps | `studioEncoding.ts:20` imports only the `WebBuildPlan` type |

So the shared code is `planWebBuild` (`src/export/webBuild.ts`, pure: "No file access here", header) plus `writeWebBuild` (`buildWriter.ts`, takes `project: FileSource`, `folder: BuildFolder`). Platform differences are already injected as adapters (`FileSource`, `BuildFolder`, `transcode`, `bake`, `audio.encoder`, `audio.cache`). A step fits that style: it gets a `read` function, never `fs`.

`writeWebBuild` already runs several post-plan passes that edit the plan and rewrite `game.json` (`withAudioEffects` -> `audioEffects.ts:85`, `withRenderedSamples` -> `sampleRenders.ts:121`, `withCompiledClips`, `withMeteredAnimationNodes`, `buildWriter.ts:~96-112`). A `withExportSteps(plan, ...)` pass belongs exactly there.

## 2. How plugins load in each host today

| | First-party | Third-party (ADR 0139) |
|---|---|---|
| Static list | `src/plugins/catalogue.ts` `FIRST_PARTY` (manifests only, "no plugin code: the exporter and the server plan with it") | none: discovered from files |
| Discovery/plan | `planPluginCode` (`src/plugins/thirdParty.ts:512`) takes Maps (`json`, `code`, `packages`, `disabled`, `assets`), file-access-free; the editor, exporter and server all call it | same call; `plugins/<folder>/plugin.json` and npm packages whose package.json has `"myco": {"plugin"}` |
| Runtime half | `src/plugins/runtime.ts` `RUNTIME_HALVES` (static imports), `activateGamePlugins` | linked with `link()` then imported: editor `MemoryTarget` (blob URLs, `src/editor/scriptLoader.ts:90`), server `MemoryTarget` (data URLs, `src/server/project.ts:129-143`), game build `buildTarget` (files) and the player `import()`s them (`src/player/main.ts:84-94`) |
| Editor half | `src/plugins/editor.ts` `EDITOR_HALVES`, imported only by the editor page | `plugins/<f>/editor/**`, only when `editor: true` (`thirdParty.ts:217`, `selectPluginCode` `:436`) |
| In the exporter | catalogue only (names/enabled); no first-party code runs | `webBuild.ts:215` plans with `{ editor: false }`, `:236` links `pluginPlan.code` through `buildTarget` (written as files, **not executed**), `:243` records `BuiltPlugin {manifest, module}` into `game.json` `plugins` (`:259`) |

Answer to "does the exporter know the project's plugin set": yes. `planWebBuild` calls `planPluginCode` (`webBuild.ts:215`) and gets `enabled`, `plugins` (dependency order), `runtime`, `code`. It bundles plugin code by passing `pluginPlan.code` and `pluginPlan.npmEntries` to `link()` with `buildTarget`. Nothing in the exporter executes plugin code today.

The compile path for TypeScript: `compileScript` (`src/projectCode/compile.ts`, TypeScript `transpileModule`, `SCRIPT_EMIT`), `link` (`src/projectCode/linker.ts`), npm entries via esbuild-wasm (`src/editor/packages.ts`, Node build in `src/server/packages.ts`, editor build in `src/editor/projectPackages.ts`). It is identical in Node and the page. **`MemoryTarget` already runs plugin code inside Node** (the dedicated server), so executing a plugin entry in the CLI process is an existing, tested pattern.

## 3. Experiment

Files (all under `spikes/plugin-export-step/`):

| File | What |
|---|---|
| `exportStep.ts` | `ExportStep` / `ExportOptionDecl` / `ExportStepContext` / `ExportStepResult`, `exportStepOf(module)`, `runExportSteps` (option defaults, debug-only options, JSON-only slice, path confinement to `plugins/<name>/`, step errors named by plugin). No imports at all. |
| `firstParty.ts` | first-party example: `myco.subtitles` step + static registry |
| `loadSteps.ts` | `loadExportSteps(Maps, engine)`: `planPluginCode` -> first-party steps in catalogue order -> third-party `export` entries (read from raw plugin.json) -> import closure -> `link` into `MemoryTarget` -> `scriptModule(entry)` |
| `fixtures/project/plugins/acme-stamp/` | third-party plugin: `plugin.json` with `"export": "export/index.ts"`, TypeScript entry that imports `../shared/stamp.ts` and `./defaults.json`, `import type { ExportStep } from "myco"` |
| `runNode.mjs` / `runNode.ts` | (a) Node, started like `cli.mjs` (tsLoader hooks), project read by the CLI's `readProject`, `read` over `node:fs` |
| `exportStep.test.ts` + `vitest.config.mts` | (b) editor-shaped run: Maps + Map-backed `read`, no `node:fs` |

### (a) From Node, like the CLI

```
$ node spikes/plugin-export-step/runNode.mjs
enabled third-party plugins: [ 'acme.stamp' ]
steps: [ 'myco.subtitles', 'acme.stamp' ]
export-only files that planWebBuild would ALSO compile into the game: [ 'plugins/acme-stamp/export/index.ts' ]
game.json slices: {"myco.subtitles":{"size":24,"speakerNames":false},"acme.stamp":{"text":"Node CLI: spike-game (stamp v3)","sceneBytes":19}}
files: [
  'plugins/acme.stamp/banner.txt = "Node CLI: spike-game (stamp v3)\\n"'
]
```

With `--debug` the debug-only option exists and `plugins/myco.subtitles/captions.log` is only written when set (covered by a test). The TypeScript step, its relative import, its JSON import and the host `read` all work in Node.

### (b) Editor environment

```
$ npx vitest run --config spikes/plugin-export-step/vitest.config.mts --fsModuleCachePath /tmp/vitest-cache-spike-export
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

Tests: load and run a third-party TS step from Maps only; disabled plugin's step doesn't load; syntax error is a problem naming the file; step can't write `../game.json`; debug-only options only in debug builds; the fixture imports nothing host-specific; `node:` specifiers are visible after compile (a host or `myco plugin check` can refuse them).

**What this does not prove [unverified]:** vitest here is Node, no jsdom/happy-dom is installed, and Playwright was off limits. So the editor-page path (`MemoryTarget` choosing `blob:` URLs, `memoryTarget.ts` `moduleUrl`) was not run. It is the path the editor already uses for every third-party runtime and editor half (`scriptLoader.ts`), so I expect it to work, from code reading only. The Tauri webview is the same page code; also [unverified].

Better for the editor: it **already has the step modules loaded.** `loadProjectCode` (`src/plugins/thirdPartyEditor.ts`) plans with `editor: true` and links *every* selected plugin file (including a new `export/` folder) into the page; `loadedScriptModule(path)` (`scriptLoader.ts:83`) returns any module. The editor host can take steps from that instead of linking a second time (and the Export dialog can list the declared options with no extra work).

## 4. Findings and constraints

1. **`export/` must be excluded from game builds and the server.** `selectPluginCode` (`thirdParty.ts:436`) keeps everything in an enabled plugin's folder except `editor/`; `webBuild.ts:258` lists every linked file in `game.json` `scripts`, and the player `import()`s each (`player/main.ts:84-87`). The experiment printed this: `plugins/acme-stamp/export/index.ts` is in `plan.code` for a game build. An `isExportHalfPath` (like `isEditorHalfPath`) must drop it unless the host is an exporter or the editor. Otherwise export code (and its imports) ships in every game and runs at launch.
2. **plugin.json needs an `export` key.** `parsePluginManifest` (`thirdParty.ts:91`, result built at `:169`) copies only known keys. ADR 0139 says unknown keys are "kept and ignored", but the code drops them. The spike reads the raw plugin.json. Real change: add `export` to `ThirdPartyManifest` and `FoundPlugin`, validate as `runtime`/`editor` are (`.ts`, inside `export/`, exists), and for npm plugins add the entry to `npmPluginEntries` as `<pkg>/<export>`.
3. **Name clash in `game.json`.** ADR 0452 says the slice is stored under `plugins.<name>`, but `GameManifest.plugins` is already `readonly BuiltPlugin[]` (`format.ts:59`). Use a new key (the spike's slices map fits `pluginData`) or amend the ADR; a first-party plugin has no `BuiltPlugin` entry anyway.
4. **Export code must be host-neutral.** The step gets `ctx.project.read` (the host's `FileSource`), never `fs`. It must not import `node:*`, DOM/`document`, or `myco/editor`. `compileScript` exposes the compiled imports, so `node:` specifiers can be refused at load time (test shows it). A host-neutral subset also matters because `link` executes every file given to it, so the loader passes only the entry's import closure (the spike's `closure()`), not the plugin's runtime half (whose top level would otherwise run in the exporter).
5. **`import "myco"` in an export entry** resolves through `MemoryTarget(engine)`, which also sets `globalThis.__myco`. The spike passed `{}`. A real CLI would have to import the engine (as `server/project.ts:21` does with `../myco`); the exporter already pulls parts of it (`node.ts:17` `bakeModelFile`). Keeping steps type-only on `"myco"` (the interface types) avoids that cost. `ExportStep` types need adding to the public `myco` exports (missing today).
6. **Trust.** Same as ADR 0139 "Trust": runtime and editor halves are unsandboxed, full access; in the desktop editor that is the file system. An export step runs in the same process (CLI) or page, so it adds no new trust level. The `read`-only context and path confinement are hygiene, not a sandbox: a step could still call `fetch` or, in Node, `process`/dynamic `import("node:fs")` (the load-time import check would not catch dynamic non-literal imports). Say so in the guide.
7. **First-party steps are static imports,** like `runtime.ts`/`editor.ts`. They must live in a file the exporter can import in Node and the page, so not in `editor/` (imports `src/editor/sdk`, page-only) and not in `runtime/` (imports the engine, Babylon, Rapier). Precedent for a first-party export-time import from a plugin folder: `buildWriter.ts:25` imports `plugins/animation/editor/compile/compiler`, so pure code under `editor/` already leaks into the exporter; that naming is a habit, not a guarantee.
8. **Discovery of options before running.** The dialog needs option declarations before a build; the CLI needs them to parse `--plugin-option`. In the editor the loaded modules give this; in the CLI `loadExportSteps` before `planWebBuild`. Order: steps are loaded after `planPluginCode` (need `enabled`), run inside `writeWebBuild` (need the `FileSource`), and their slices merged into `game.json` there.

## 5. Packaging options compared

| | Separate `export` entry (`plugin.json` `export`, `export/` folder) | Editor half registers the step | Runtime half registers the step |
|---|---|---|---|
| Runs in CLI | **yes** (loaded by `MemoryTarget` like the server does) | **no**: the CLI and server plan with `editor: false`; first-party `EDITOR_PLUGINS` imports Preact/editor SDK, which Node can't load | only if the CLI activates runtime halves: needs the engine, World, Babylon/Rapier in Node, and a `ctx` for registration |
| Runs in editor page | yes (already loaded) | yes | yes (already active) |
| Ships in game | not if excluded (finding 1) | never | **always**: step code and its imports in every game build, contradicting ADR 0452's "a release build carries no step it doesn't use" |
| Third-party cost | one folder, one manifest key | none | none |
| Host-neutrality | enforced by a separate entry | not enforceable | not enforceable |
| New machinery | `export` key, `isExportHalfPath`, loader (spike's `loadSteps.ts`, ~70 lines) | n/a | n/a |

## 6. Recommendation

**Separate `export` entry**, exactly as ADR 0452 says, loaded by a new `loadExportSteps` that reuses `planPluginCode` + `link` + `MemoryTarget` unchanged.

- Third-party: `plugin.json` `"export": "export/index.ts"` (npm: `<pkg>/<entry>`), default export or `exportStep` named export (`exportStepOf`). Add `isExportHalfPath`; game builds and the server leave `export/` out, the editor keeps it (it already links everything) and exporters link only its import closure.
- First-party: `src/plugins/<name>/export.ts`, and a `src/plugins/exports.ts` registry shaped like `RUNTIME_HALVES` (`{ [K in FirstPartyPlugin]?: ExportStep }`), imported only by `src/export/` and the editor's Export; add a check (like `check:filenames`) that these files import no `node:*`, `src/editor/`, or `src/engine` rendering code. Keep the catalogue manifests-only.
- Hook: `withExportSteps(plan, { steps, values, read, debug, platform, log })` in `writeWebBuild`, beside `withAudioEffects`. It writes slices under a new `game.json` key and files under `plugins/<name>/`.
- Options in `BuildOptions` become `pluginOptions: Record<plugin, Record<key, value>>`; the CLI parses `--set plugin.key=value`; the dialog renders `ExportOptionDecl`s.
- Launch steps (ADR 0452) read `game.json[pluginData][name]`.

## 7. Open risks

- Real browser / Tauri webview run of the loader [unverified]; needs a Playwright or Vitest browser spec (the project rule says one spec at the end, coordinator only).
- npm-packaged export entries [unverified]: `extraEntries` through esbuild would work like runtime entries (`link` already supports `extraEntries`), but not exercised.
- Executing a plugin entry at export time means a broken or hostile `export/` runs in the CLI/editor before the user sees anything; the editor already has this property for editor halves. Dynamic `import("node:fs")` evades the specifier check.
- Plugin version skew: a slice written by plugin vX read by a launch step of vY. Include the plugin's `version` in the slice envelope (`{version, data}`), or key `pluginData` by name and store versions beside.
- Determinism: steps get no clock or random seed from the host; reproducible builds depend on step authors. Consider passing `ctx.now` fixed per build.
- Large binary outputs (`files` as `Uint8Array` held in memory until written): acceptable for the sizes in ADR 0451/0452 (strings, audio media) but audio media already streams through `processAudio`; a step that wants that needs a streaming `write` in the context.
- Editor path: steps loaded in the editor reflect the last project code load; an unsaved edit of `export/` code is not in an export (same as scripts today: "Unsaved changes aren't in the build").
- The `export` key is a new `plugin.json` field, a public SDK/manifest change: needs the ADR 0139 amendment and an SDK_VERSION decision.
