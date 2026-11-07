# 0125. Project scripts import npm packages from the project's node_modules, are type-checked before Play, and reload into a running game

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0030 (amends: its three remaining open questions), 0024, 0038, 0041, 0007, 0017, 0018, 0032

## Context

ADR 0030 compiles a project's `scripts/**/*.ts` in the editor and loads each as a module. It left three questions open, and `implementation-status.md` lists them as the 0030 gaps:

- **npm packages.** The loader refuses every bare import except `"myco"` (and the legacy `"tranquility"`). A project can't use `gl-matrix`, `simplex-noise`, `mitt` or anything else from npm.
- **Type errors.** Scripts compile one by one with `transpileModule`, which ignores types; type errors only show as squiggles in the Code panel. Nothing stops Play when a script has them, so a typo in a property name fails at runtime.
- **Reload during play** (open question O3). Saving a script while playing waits until Stop; the running game keeps its code. Iterating on game feel means Stop, save, Play, and replaying to the moment being tuned.

Constraints:

- The desktop editor runs in Tauri with no Node process (0030); the browser editor opens folders through the File System Access API (0038). Both read the opened folder through the platform `FileSystem`, `node_modules/` included (the Tauri fs scope covers the folder recursively; a directory handle covers its subfolders).
- Game builds (0041, `npm run export` and the editor's Export…) compile scripts with the same compiler as play mode, so a build runs the same JavaScript. Packages must too, and must work offline.
- npm packages ship as ES modules or CommonJS, often many files with `package.json` `exports` maps, and sometimes reach for Node built-ins.
- Monaco's TypeScript worker (0030) already holds the engine's declarations, every script and JSON file, with `strict` on. The generated project `tsconfig.json` is strict too.
- A behavior's state lives in its own properties (`@field`s and plain class fields). Systems are looked up from the catalog by name each frame (0032); data components are stored per World keyed by their definition object (0017).

## Decision

### npm packages, from the project's own `node_modules`

- **Where packages come from:** the project folder's `package.json` and `node_modules/`, installed with `npm install` in the project folder. No CDN, no editor-managed install: the folder works offline and builds the same anywhere. `node_modules/` is never listed in the Assets panel and never copied into builds (as today).
- **Which imports:** any bare specifier in a script other than `"myco"`/`"tranquility"` (`"mitt"`, `"@scope/pkg"`, `"pkg/sub/path"`) is a package import.
- **Bundling with esbuild** (`esbuild-wasm`, pinned): the editor collects the package specifiers every script imports and bundles them together, one entry point per specifier, as ES modules with code splitting, so packages that share a dependency share one copy. esbuild handles CommonJS interop and tree shapes; `"myco"` stays external (a package written for Myco gets the editor's engine). Our own resolver, an esbuild plugin reading through the project's `FileSystem`, does Node resolution: `exports` maps (via the `resolve.exports` package, conditions `browser`, `import`, `module`, `default`), then `browser`/`module`/`main` fields, extension and `index` probing, and walking up nested `node_modules`. A `browser` field mapping to `false` gives an empty module. `process.env.NODE_ENV` is `"development"` in the editor and `"production"` in builds.
- **Loading:** each output chunk becomes a module URL like a script (`blob:` in browsers, `data:` in Node), its imports between chunks rewritten the same way; scripts' package imports point at their entry chunk. esbuild-wasm (about 14 MB of WebAssembly, 3.8 MB gzipped) loads on first use, only for projects that import packages, in a worker. The bundle is cached for the session, keyed by the specifiers and `node_modules/.package-lock.json` (else `package.json`), so a script reload doesn't rebundle unless the imports or the install changed.
- **Problems** are reported against the scripts that import them, and only those scripts are skipped: a package that isn't installed ("run `npm install` in the project folder"), one that needs a Node built-in (`fs`, `path`…) with no browser replacement, or a bundling error.
- **Types:** for each package the editor reads its declarations (`types`/`typings`/`exports` `types`, else `@types/<name>`) and the `.d.ts` files they reference, and gives them to Monaco's TypeScript service at `file:///node_modules/…`, as it does for `"myco"`. A package without declarations becomes `declare module "<name>";` (untyped, no error).
- **Game builds** (0041) bundle the same way with esbuild in Node (`esbuild-wasm`'s Node build, so the output matches the editor's) and write the chunks to `code/deps/`, with scripts importing them by relative path. The dedicated server (`myco-server`) loads them like the editor. esbuild-wasm's Node build runs its service in a child `node` process; on Node 26 for Windows OpenSSL's random generator fails there ("entropy source strength too weak") when first used from inside the WebAssembly, so a preload passed through `NODE_OPTIONS` (`src/server/esbuildPrewarm.cjs`) uses it once first.

### Type-checking before Play

- **Play checks first:** with scripts in the project, Play asks Monaco's TypeScript service (loaded on demand if it isn't yet) for the syntactic and semantic errors of every script, with the same strict settings as the Code panel and the generated `tsconfig.json`. It checks the text the Code panel holds, so unsaved edits count (overwriting them with the files on disk would lose them). The status bar shows "Checking scripts…". A check that fails to run doesn't stop Play.
- **On errors, Play stops at a dialog** listing them (`path:line: message`, the first 50). Clicking one opens the script in the Code panel at that line. **Play anyway** starts the game; **Cancel** stays in edit mode. A **Don't check before Play** checkbox turns the check off (a per-user preference, also in Settings > General, as `checkScriptsBeforePlay`).
- Warnings and suggestions don't stop Play. Builds don't type-check (out of scope here).

### Reloading scripts into a running game

- **Saving a script while playing reloads it into the game** instead of waiting for Stop (a change while the game is still starting still waits). The scripts are compiled and loaded again as in edit mode (0030), then every World of the running game swaps to the new types:
  - **Behaviors:** each component whose class a script registered is replaced by an instance of the class now registered under the same id. The old instance gets `onDisable` (if active), its waits and async flows are cancelled (0018), and **every own property is copied** to the new instance (`@field`s, private counters, node and component references, arrays, objects). Properties the new class adds keep their initial values; properties it dropped are copied anyway (harmless). References to other replaced components, directly or as items of arrays, `Map`s and `Set`s, are pointed at their replacements. The new instance takes the old one's place (same node, order, enabled state), is not awoken or started again, and gets `onEnable`. Static properties of a replaced class (`static instance`) are copied onto the new class the same way.
  - **Data components** redefined with the same id keep their rows: each World's store moves to the new definition, copying the fields both schemas have; new fields start at 0.
  - **Systems** follow the catalog: a redefined system runs its new code from the next frame, a removed one stops.
- **What doesn't survive:** module-level variables (modules run again); async flows started in `awake`/`start` (they stop, like Unity coroutines on a domain reload); subscriptions a script made with a closure (they keep calling the old code until the old instance's handler is removed). Code that subscribes in `onEnable` and unsubscribes in `onDisable` reloads cleanly.
- **When a script fails to load** (a syntax error, a missing package), types it registered aren't replaced: their components keep running their old code, and the status bar says so. A component whose type disappeared also keeps its old code until Stop.
- After Stop, the Editor World rebuilds from the document as after any reload (0030). The Runtime World is still thrown away on Stop: reloading never writes play-mode state into the scene (that's Keep values, 0022).

## Alternatives considered

- **Packages from a CDN (esm.sh, jsDelivr).** No local install, but needs a network, versions drift from what's installed, and builds would have to vendor them anyway. The owner chose the project's `node_modules`.
- **Our own module loader instead of a bundler:** resolve and load package files one by one like scripts, with a small `require()` runtime for CommonJS. No 14 MB download, but CommonJS interop, dynamic `require` and per-file loading are long tails esbuild already handles.
- **Rolldown** (Vite 8's bundler): already installed natively for builds, but the editor would need `@rolldown/browser` with a WASI file system shim; younger than esbuild-wasm and untested here.
- **Type-check with our own TypeScript program on the main thread or a new worker:** works headless, but needs the TypeScript lib files bundled again and a third copy of the compiler; Monaco's worker already has everything and gives the same errors the Code panel shows.
- **Warn only, or block with no way past:** warning only lets a broken game start unnoticed; blocking hard gets in the way when the error is in code the scene doesn't use.
- **Keep only `@field` values across a reload:** predictable, but resets timers and caches mid-game, which defeats the point. **Swapping the prototype of the old instance** keeps everything, but breaks `#private` fields and leaves new fields uninitialised. **Restarting the scene with the new code** loses the state being tuned.

## Consequences

**Positive**
- Projects can use the npm ecosystem, offline, with types, in the editor, play mode, builds and the dedicated server alike.
- A type error is caught before Play, with a one-click way past it.
- Tuning a running game is save-and-see: state, positions and timers stay.

**Negative / costs**
- Two new dependencies: `esbuild-wasm` (14 MB of WebAssembly, 3.8 MB gzipped, in the editor build only; lazily loaded, never in games) and `resolve.exports` (small).
- A Node-style resolver to keep correct; exotic packages (Node built-ins, `require` of computed paths) won't bundle.
- Play waits for the type check (well under a second once Monaco's worker is warm; the first check in a session loads Monaco).
- Hot swapping is best effort: closures and module state are the script's own to manage, and a behavior whose invariants depend on `awake` having run with the new code may misbehave until Stop.

## Deprecates

- **0030's rule that a reload during play waits until Stop**, and its three open questions (npm packages, type-checking before Play, state across a reload). O3 in `open-questions.md` is resolved by this record.
- The loader's "scripts can import `myco`, other scripts and the project's JSON files only" error, now only for packages that can't be found.

## Open questions

- Type-checking in builds (`npm run export --typecheck`?).
- A disk cache of package bundles (`.myco/deps/`) if bundling large packages on each project open proves slow.
- Hot reload of a code bootstrap (0032): it isn't run again.
- `#private` fields aren't own properties, so they start fresh in the new instance; copying them would need the old class's accessors.

## References

- esbuild browser API and plugins: https://esbuild.github.io/api/#browser , https://esbuild.github.io/plugins/
- `resolve.exports`: https://github.com/lukeed/resolve.exports
- Unity's domain reload and serialization on script changes: https://docs.unity3d.com/Manual/DomainReloading.html
- `src/editor/scriptLoader.ts`, `src/editor/packages.ts`, `src/editor/scriptCheck.ts`, `src/engine/core/World.ts` (`_swapScriptTypes`), `src/engine/editor/index.ts` (`captureScriptTypes`, `swapScriptTypes`), `src/server/packages.ts`, `src/export/webBuild.ts`
