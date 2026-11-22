# 0329. One linker links a project's code into a memory or a build target

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0296 (extended), 0041 (amended), 0030, 0080, 0125, 0139, 0275

## Context

Linking a project's code means: compile each script (0030), parse the JSON files scripts may import, collect the npm package specifiers the scripts import plus the npm plugins' entries (0125, 0139), bundle them, order the scripts, and rewrite every import to where its module is. It was written twice: `loadScripts`/`loadPackages` in `src/editor/scriptLoader.ts` (module URLs, imported; also used by the dedicated server through `server/project.ts` and by `plugins/thirdPartyEditor.ts`), and `compileForBuild` in `src/export/webBuild.ts` (files under `code/`). Only the destination differs. The pure helpers were tested; the two orchestrations weren't, and had drifted:

- **A plugin entry that can't be bundled** was reported by a build, dropped silently by the editor (then thrown later, as a deferred `activate` failure, when `loadedPluginModule` missed it), and a `ServerError` from a different place on the server.
- **Warmed asset references (0080)** came from the selected code in the editor, but from every script file in a build, so a build warmed assets named by disabled plugins and by editor halves.
- **Module state:** export and the server imported the linker from `src/editor` and shared its module globals (last URLs, package cache, loaded modules, generation).
- Duplicates: `isEngineModule`, "parse JSON, swallow, report against importers", "specifiers = scripts' ∪ plugin entries". A bundling failure threw raw out of a build. `loadProjectScripts` in `server/project.ts` was dead.
- The editor set `globalThis.__myco` (the engine for the console, tests and the `"myco"` shim) only as a side effect of linking, so a project with no scripts never had it; the player sets it explicitly.

## Decision

We will link a project's code through one module, the **project code linker** (`src/projectCode/`), outside `src/editor`, which every host imports:

- **`link(input, target)`** (`linker.ts`): `input` is `{ code, json, packages, extraEntries, isAsset }`: the host's selected code (`planPluginCode`'s `code`, 0275), the JSON files, the node_modules source, the npm plugin entries and what counts as a project file. It returns `{ loaded, problems, assetRefs, specifiers, entries, output }`. It never throws for a problem in the project's code.
- **One problem list**, for every host: scripts that don't compile, unsatisfied imports (`loadOrder.ts`), modules that fail to load, and every plugin entry that can't be bundled (`the plugin entry can't be bundled: …`). A failed bundle is a problem for each specifier, not an exception.
- **Asset references from the selected code** in every host: `assetRefs` are the files the linked code names that `isAsset` says exist.
- **A real seam, `LinkTarget`, with two adapters.** A target opens one link and emits packages (it may reuse what it emitted for the same key), JSON modules and script modules, and says what a module writes to import the engine, the editor SDK or another module:
  - the **memory target** (`memoryTarget.ts`, `MemoryTarget`): module URLs, imported in this realm, with inline source maps; `"myco"` is a shim over the engine the host passes in, which the constructor publishes as `globalThis.__myco` (as the player does). Its instance holds the last link's modules and the package bundle: `scriptModule`, `packageModule`, `pluginModule`.
  - the **build target** (`buildTarget.ts`): files under `code/`, packages under `code/deps/`, relative imports, `"myco"` at the engine file beside the player, no source maps.
- **Per-host state lives in a target instance**: the editor's in `editor/scriptLoader.ts`, the server's in `server/project.ts`; no module globals shared between hosts.
- **Hosts keep only policy.** The editor (`scriptLoader.ts`: `loadScripts`, `replaceScripts`) loads what it can, shows problems in the status line, swaps registrations and sets the warmed asset references; the server and a build stop on any problem (`ServerError`, `ExportError`). A plugin whose entry didn't link still gets the editor plugin set's deferred failure, so its dependants are skipped.
- `compileScript` and `resolveScript` moved verbatim into `projectCode/compile.ts` (with the compiler options), `loadOrder` into `projectCode/loadOrder.ts`.

## Alternatives considered

- **Share only the duplicated helpers** — the orchestration is where the drift was; two orchestrations would drift again.
- **One linker with a `mode` flag** — the differences (import now vs write a file; URL vs relative path; cache vs none) would be `if`s through the pipeline; a target interface keeps each destination in one place and lets a new host (Android, 0155) add an adapter.
- **Keep the linker in `src/editor`** — export and the server would keep importing the editor and sharing its state.

## Consequences

**Positive**
- Locality: one place decides what a problem is; a failing plugin entry is reported the same in the editor, the server and a build.
- Builds warm only assets the built code names.
- One suite (`src/projectCode/linker.test.ts`) runs both targets over the same fixtures.
- `globalThis.__myco` is set in the editor whether or not a project has scripts.

**Negative / costs**
- The linker still imports `moduleImports.ts`, `packages.ts` and `projectPaths.ts` from `src/editor` (pure, engine-free modules shared with the editor's type service); moving them is a separate change.
- In the editor, a plugin entry that can't be bundled is now reported twice: as a link problem and as the plugin failing to activate.
- A build computes the packages cache key (reads `node_modules/.package-lock.json`) it doesn't use.

## Deprecates

`compileForBuild`, `DEPS_DIR` in `webBuild.ts` and webBuild's `isEngineModule` (removed); the editor loader's `loadPackages`, `packageSpecifiers`, `loadedPackageModule`, module globals and the `compileScript`/`resolveScript`/`loadOrder`/`rewriteImports` re-exports (removed or moved); `loadProjectScripts` in `server/project.ts` (removed, dead).

## Open questions

None.

## References

- `src/projectCode/{linker,compile,loadOrder,memoryTarget,buildTarget}.ts`, `src/projectCode/linker.test.ts`; hosts `src/editor/scriptLoader.ts`, `src/server/project.ts`, `src/export/webBuild.ts`, `src/plugins/thirdPartyEditor.ts`.
- Architecture review 2026-11-22 (pass 13), card 2 and small fixes 2 and 4.
