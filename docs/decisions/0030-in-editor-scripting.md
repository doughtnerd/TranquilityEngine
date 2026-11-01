# 0030. Write and run project scripts inside the editor

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0010, 0013, 0015, 0017, 0019, 0022, 0024, 0026

## Context

Game code is TypeScript: `GameBehavior` subclasses registered with `@behavior` (0007), data components and systems registered with `defineComponent` / `defineSystem` (0017). Registration happens when a module is imported, so a scene can only use types whose modules have been loaded.

Today every script comes from the editor's own build. `src/editor/projects.ts` imports the Flappy demo's `game.ts`, so a project folder opened in the editor can't bring its own scripts. Adding or changing one means rebuilding the editor. 0022 left hot reload of game scripts open (O3), leaning towards Vite HMR. The desktop editor, though, runs from built files inside Tauri with no dev server or Node process to do HMR.

The owner wants script and component creation inside the editor, light but capable enough that leaving it is optional. The usual way to get that is to embed an existing code editor rather than build one. Constraints:

- Scripts use standard decorators. The editor's Vite builds compile them with the TypeScript compiler (`typescriptTranspile()` in `vite.shared.ts`) because oxc doesn't lower them. Any in-editor compiler must produce the same output.
- three.js, Rapier and Howler never appear in the public API (0010). The engine's published declarations are already checked for this, and they're exactly what scripts should be typed against.
- The editor runs in Tauri with files through the platform FileSystem (0024), and in a plain browser on the read-only bundled demo.

## Decision

### Where scripts live

- A project's scripts are the `.ts` files under `scripts/` in the project folder, at any depth. Every one is loaded, because registration happens on import. Scripts import each other by relative path.
- Scripts import the engine as `"tranquility"`:

  ```ts
  import { GameBehavior, behavior, field } from "tranquility";
  ```

  That's the only bare import allowed for now. Other npm packages are out of scope (see open questions).
- A project folder gets a generated `tsconfig.json` and the engine's declarations at `.tranquility/types/tranquility.d.ts`. External editors such as VS Code then type-check scripts the same way the built-in one does. The editor rewrites the declarations when the engine version changes.

### Compiling and loading in the editor

- **Compile:** each script is compiled on its own with the TypeScript compiler's `transpileModule`, using the same options as `typescriptTranspile()` (ES2022, ES modules, `useDefineForClassFields`, standard decorators) plus inline source maps. Type errors don't block running: they show in the code editor, as in a Vite dev server. TypeScript moves from a build-only tool to a lazily loaded part of the editor bundle. It's never part of a shipped game.
- **Load:** each compiled module becomes a `blob:` URL loaded with dynamic `import()`. Before that, the editor rewrites its imports:
  - relative imports point at the other scripts' blob URLs, which are loaded first, in dependency order (an import cycle is reported as an error);
  - `"tranquility"` points at a generated shim module that re-exports the editor's own engine instance (`globalThis.__tranquility`, holding every runtime export of `src/engine/index.ts`). Scripts and the editor then share one registry and one World.
- **Errors:** a script that fails to compile or throws while loading is reported in the status bar and on the script's file. The other scripts still load.

### Reloading

- Saving a script recompiles it and the scripts that import it, then imports them again.
- **The registry gains editor-only replacement.** It's `@internal` and never exported publicly. While reloading, `registerComponent`, `defineComponent` and `defineSystem` replace an existing registration with the same id or name instead of throwing.
- **The Editor World catches up** by rebuilding every document node that uses a replaced type (`WorldSync`, 0026). Field values come from the scene document, so nothing typed in the Inspector is lost. A field that no longer exists is kept in the document and warned about, as the loader does today. A newly declared field shows up with its default.
- **During play mode** a reload waits until Stop; the Runtime World keeps the code it started with. Changing code under a running game is out of scope.
- **Deleted script, or a type removed:** the scene loader in the Editor World skips components of unknown types with a warning instead of throwing (it still throws in games). The document keeps the entry, and the Inspector shows it as a "Missing script" card that can be removed. Saving keeps it in the file.

### The code editor

- The code editor is **Monaco** (the `monaco-editor` package), loaded lazily the first time a script is opened, so starting the editor doesn't pay for it. Its language workers load through Vite's worker imports.
- **Code panel:** scripts open in a new dockable Code panel (0025 layout), one tab per open file, with an unsaved-changes marker and Ctrl/Cmd+S to save. Double-clicking a script in the Assets panel opens it, as does an "Open script" action on a script's Inspector card.
- **Type information:** Monaco's TypeScript service gets the engine's declarations as the module `"tranquility"` and every project script as a model. That gives autocomplete, errors, go-to-definition and rename across files, all inside the webview. The theme follows the editor's colours.
- **New Script** (in the Assets panel, and at the bottom of the Add Component list):
  - it asks for a name and writes `scripts/<Name>.ts` from a template: a `GameBehavior` with `@behavior("game.<Name>")` and an example `@field`;
  - it loads the new script, and from Add Component it also adds the new component to the selected nodes;
  - templates for a data component and a system follow the same pattern.
- **Read-only projects** (the bundled demo in a browser) open scripts read-only.

### Editing outside the editor

- The desktop editor watches `scripts/` (the Tauri fs plugin's watch feature) and reloads changed files, whatever wrote them.
- "Open in external editor" opens the file or the project folder with the system's default app (Tauri opener plugin). Together with the generated `tsconfig.json`, VS Code or any TypeScript editor works without setup.

### Games

A project's game build compiles `scripts/**/*.ts` with Vite (0015) as ordinary modules, with `"tranquility"` aliased to the engine library. Runtime compilation exists only in the editor. Building a project folder (rather than the demo) into a game is still to be designed; this record only fixes how its scripts are found and imported.

## Alternatives considered

- **CodeMirror 6 with a community TypeScript integration.** The editor core is much smaller, but TypeScript autocomplete needs the TypeScript compiler in a worker either way, which is most of Monaco's size. It's also more pieces to assemble and keep working. Worth revisiting if Monaco's size or styling becomes a problem; the Code panel hides which editor it uses.
- **External editor only** (watch the folder, reload on change). The least work, and kept as an option, but it doesn't meet "you don't have to leave the engine".
- **esbuild's WASM build to compile.** Faster and can bundle, but it's a multi-megabyte download on top of TypeScript, which Monaco already brings. Its decorator lowering also isn't the compiler the builds use. Per-file `transpileModule` is fast enough for scripts.
- **A Vite dev server alongside the desktop editor**, for real HMR. It needs a bundled Node runtime as a Tauri sidecar: heavy, and a second process to manage.
- **Full VS Code in the webview** (openvscode-server, Theia). Needs a server process and turns the editor into an IDE host. StackBlitz WebContainers needs a commercial licence for this use.
- **Import maps instead of rewriting imports.** Cleaner, but a page can't change its import map after modules have loaded, and reloads need new URLs for changed modules.

## Consequences

**Positive**
- A project folder can carry its own scripts; the editor build no longer has to know a game's code.
- Writing, running and fixing scripts happens in one window, with real TypeScript tooling.
- The public API's declarations become the scripting contract, which keeps 0010 and 0019 honest.
- External editors keep working, and get the same types.

**Negative / costs**
- Monaco and the TypeScript compiler add several MB to the editor bundle (lazily loaded, never in games).
- The registry gets an editor-only replacement path, and the scene loader an editor-only "skip unknown types" mode.
- Rewriting imports and managing blob URLs is code the editor must keep correct (dependency order, cycles, revoking old URLs).
- Scripts run with the editor's permissions, including file access in the opened folder. That's the same trust as running any project's code, but worth knowing.

## Deprecates

- **The editor build importing the demo's `game.ts` as its only script source.** It stays while the bundled demo needs it in a plain browser. The demo moves to `scripts/` with `"tranquility"` imports once runtime loading works, and the hard-coded import goes.
- **0022's leaning for O3** (Vite HMR into the Editor World). It's replaced by in-editor compilation and reloading; O3 is resolved by this record.

## Open questions

- npm packages in project scripts (bare imports other than `"tranquility"`): pre-bundled into the project, fetched from a CDN, or not supported.
- Whether to type-check all scripts before Play and refuse to start on errors, or only warn.
- Keeping a running game's state across a reload during play mode.
- How a project folder is built into a game (scripts, assets, settings), probably its own record.

## References

- Monaco editor: https://microsoft.github.io/monaco-editor/
- TypeScript `transpileModule`: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- Tauri fs plugin (watch) and opener plugin: https://v2.tauri.app/plugin/file-system/ , https://v2.tauri.app/plugin/opener/
- `vite.shared.ts` (`typescriptTranspile()`), `src/engine/core/registry.ts`, `src/editor/projects.ts`, `src/editor/document/WorldSync.ts`
