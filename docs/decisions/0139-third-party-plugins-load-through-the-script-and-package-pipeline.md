# 0139. Third-party plugins are found in the project and its npm packages, and load through the script and package pipeline

- **Status:** Proposed
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0030, 0041, 0125, 0133, 0134, 0135, 0137, 0138

## Context

ADR 0133 made features plugins with a runtime half and an editor half over a public SDK (`myco` and `myco/editor`), and said third-party plugins come from two places: `plugins/<name>/` inside the project, and npm packages in the project's `node_modules`. It left open the exact `plugin.json` schema, how a package marks itself a plugin, and how a project-local editor half is compiled and type-checked.

What exists today:
- **First-party plugins only.** `RUNTIME_PLUGINS` (`src/plugins/runtime.ts`) and `EDITOR_PLUGINS` (`src/plugins/editor.ts`) are compiled in. Their manifests are TypeScript objects (`PluginManifest`: name, version, title, description, dependencies, server). `project.json`'s `plugins.disabled` turns them off (`src/plugins/enabled.ts`), and the Project settings' Plugins category lists them (`ui/PluginsSection.tsx`).
- **Project scripts** (`scripts/**/*.ts`) compile one file at a time with `ts.transpileModule` in the editor, Node (server) and the exporter alike (`scriptLoader.ts`, `export/webBuild.ts`). Imports of `"myco"` point at the host's engine; npm packages are bundled with esbuild-wasm with `"myco"` external (0125). Saving a script reloads every script; during Play the new types swap into the running game.
- **Type declarations.** `virtual:myco-types` (`vite.shared.ts`) emits `myco`'s `.d.ts` files from `tsconfig.engine.json`. Monaco serves them as the `myco` package, and a project folder gets them in `.myco/types/myco/` with a generated `tsconfig.json` mapping `myco` there. There is no `myco/editor` declaration yet.
- **Public surface.** `myco` doesn't export the plugin types (`RuntimePluginContext`, `ContributionPoint`) or the physics backend contribution point (0137 deferred it), so a third party can't write a runtime half or a backend against `myco` alone.

## Decision

We will load third-party plugins by treating their source as project code: a project-local plugin's `.ts` files are scripts, and an npm plugin's entry modules are package imports. Discovery, validation and ordering are one shared, file-access-free module (`src/plugins/thirdParty.ts`) used by the editor, the exporter and the dedicated server.

### `plugin.json`

```json
{
  "name": "acme.spinner",
  "version": "1.2.0",
  "title": "Spinner",
  "description": "Spins things.",
  "sdk": "^1.0.0",
  "dependencies": { "myco.physics": "*", "acme.core": "^2.0.0" },
  "runtime": "runtime/index.ts",
  "editor": "editor/index.ts",
  "server": true,
  "assetKinds": [{ "id": "spin", "extensions": [".spin.json"], "label": "Spin", "icon": "M4 12a8 8 0 1 0 16 0" }]
}
```

- **Required:** `name` (lower case, `[a-z0-9][a-z0-9._-]*`; the `myco.` prefix is reserved for first-party plugins), `version` (semver `x.y.z`), `sdk` (a semver range of the Myco SDK, the engine's version, `SDK_VERSION`), and at least one of `runtime` and `editor`.
- **Optional:** `title`, `description`, `dependencies` (plugin name → semver range; first-party plugins carry the engine's version), `server` (default `true`; `false` for a runtime half the dedicated server skips), `assetKinds` (the static part of each asset kind: `id`, `extensions` lower case with the dot, `label`, `icon` as a 24×24 SVG path).
- **Unknown keys** are kept and ignored, so later fields don't break older editors.
- **Ranges** are the npm subset: exact, `^`, `~`, `>=`/`>`/`<=`/`<`/`=`, `x`/`*` wildcards, space-separated (and) and `||` (or). Pre-release tags are compared but not specially matched.

### Where plugins are found

- **In the project:** every `plugins/<folder>/plugin.json`. Entries are paths relative to that folder and must be `.ts` files in it. **The editor half is the `editor/` folder**: the `editor` entry must be inside it, the `runtime` entry outside it.
- **In npm packages:** every dependency or devDependency listed in the project's `package.json` whose own `package.json` has `"myco": { "plugin": "plugin.json" }` (the manifest's path in the package). Entries are paths relative to the package and are imported as `<package>/<entry>`, so a package with an `exports` map must export them. They are usually prebuilt JavaScript; TypeScript works too (esbuild compiles it).
- **One name, one plugin.** A second plugin with a name already taken (first-party, or found earlier: project folders before packages) is refused.

### Checks and order

Before anything runs, `checkPlugins` refuses, with a message naming the plugin:
- an invalid manifest (each problem listed);
- an `sdk` range the running engine doesn't satisfy ("acme.spinner needs Myco SDK ^2.0.0; this is 1.0.0");
- a missing entry file;
- a missing dependency, or one whose version doesn't satisfy the range;
- a dependency cycle;
- anything depending on a refused plugin ("needs acme.core, which has a problem").

The rest activate in dependency order after the first-party plugins, through the same `activateRuntimePlugins` and `activatePlugins` as first-party halves. These take a `provided` set, so a dependency that is active but outside the list (a first-party plugin with no editor half) counts as present.

### Compiling both halves

- **Project plugins are scripts.** `isScriptPath` now covers `plugins/<folder>/**/*.ts` as well as `scripts/**/*.ts`. Plugin files are read, edited in the Code panel, compiled, reloaded and watched like scripts, with relative imports, JSON and npm packages.
- **Which files load.** Before a load, `selectPluginCode` keeps `scripts/`, plus the files of enabled, valid plugins. A plugin's `editor/` folder is kept only in the editor.
- **What each module exports.** A half's entry exports `activate(context)` (or a default export with one). Its Components are decorated as in scripts and claimed with `context.registerComponents`.
- **`myco/editor` resolves to the editor SDK** (`src/editor/sdk/index.ts`) through a shim, as `myco` does. Only files in a plugin's `editor/` folder may import it (a load problem otherwise). Runtime files may not import editor files. Editor files may import the plugin's runtime files.
- **npm entries** are added to the package bundle's entry points, with `myco` and `myco/editor` external.

### Type-checking

- `virtual:myco-types` also emits the editor SDK's declarations: `editor/sdk/index.d.ts` and the files it reaches.
- `editor.d.ts` re-exports that, so `myco/editor` resolves next to `myco` in Monaco and in `.myco/types/myco/`.
- The generated `tsconfig.json` maps `myco/editor` and includes `plugins/**/*.ts`. The repository's own `tsconfig.json` maps `myco/editor` to `src/editor/sdk/index.ts`.
- Play's type check covers plugin files like scripts.

### In the editor

- **Opening a project and every script reload** discover and check the plugins, load the selected code, then sync the third-party halves: every active third-party half is deactivated and the enabled ones activate again from the freshly loaded modules.
- **Live reload.** Saving an editor-half file re-registers its contributions at once. During Play only editor halves re-sync. Runtime-half changes reach the Editor World on Stop and the game at the next Play (script Components still swap live, as 0125 does).
- **Static asset kinds** from `plugin.json` register with the editor half, or alone when there's no editor half. A kind the editor half registers with the same id replaces the static one.
- **The Plugins category** lists third-party plugins after the first-party ones, with their source (project folder or npm package), and the refused ones with why. Enabling and disabling use the same `plugins.disabled` list. Third-party plugins default **on**: putting one in the project or installing its package is the opt-in. Changing the list reloads the project code.
- **Problems** (refused plugins, failing activation) join the script problems in the status bar.

### Exports and the dedicated server

- **Game builds** (`planWebBuild`) compile the enabled plugins' runtime files with the scripts and bundle npm runtime entries with the packages. The editor half is never compiled.
- **`game.json`** gets `plugins: [{ manifest, module }]`. The player imports the scripts, then activates the third-party runtime halves after the first-party ones.
- **The server** loads the same runtime code, minus plugins whose manifest says `server: false`, and activates them with `server: true`. A refused plugin fails a build and stops the server with its message, as a broken script does.

### Public SDK additions

- **`myco`** exports, in its own block of `src/myco.ts`:
  - the plugin types a runtime half needs: `PluginManifest`, `RuntimePlugin`, `RuntimePluginContext`, `ContributionPoint`;
  - `SDK_VERSION`;
  - the physics backend contribution point: `PHYSICS_BACKENDS`, `registerPhysicsBackend`, `physicsBackends` and every backend interface type (`PhysicsBackend`, `PhysicsBackend2D/3D`, `PhysicsWorldBackend`, the shape, body, collider, joint and query descriptions).
- **`myco/editor`** is the editor SDK, experimental until v1 like `myco`. In the editor build it is `src/editor/sdk/index.ts`.

### Trust

Plugins run with the same access as project scripts (0030): no sandbox, full access to the editor, the game and, in the desktop editor, the file system. Installing a package or copying a plugin folder is trusting its author. The guide says so.

## Alternatives considered

- **Bundle every half with esbuild (project plugins too).** One compiler for both sources, but project plugins would lose 0125's per-script reload during Play, its error reporting per file and Play's type check, and decorators would compile differently from scripts.
- **A `myco-plugin` keyword instead of a `package.json` field.** A keyword can't say where the manifest is, and keywords are search metadata. The field also leaves room for later package-level options.
- **Third-party plugins off until enabled.** Safer against a stray package, but adding a plugin folder and then having to tick it is an extra step with no security gain, because the scripts in the same folder already run.
- **Generate `myco/editor` declarations by hand.** They would drift from the SDK. Emitting them with `myco`'s declarations keeps them true, at the cost of some extra `.d.ts` text.
- **Live-swap runtime halves during Play.** Re-activating a runtime half disposes its World services in the running game. 0133 already chose "next Play".

## Consequences

**Positive**
- Third-party plugins need no new compiler: they reuse the script loader, the package bundler, the reload, the Play type check and the export path.
- One discovery and check module serves the editor, builds and the server, so they agree on what loads.
- Backend authors can write a physics backend against `myco` alone.

**Negative / costs**
- `myco/editor` exposes the editor SDK's reachable types (Preact component types, `SettingsDraft`, `OpenScene`). They become an implicit API until an API report pins them (0133).
- `isScriptPath` widening means plugin files count as scripts everywhere scripts are listed (the Code panel, problems, moves: a script can't leave `scripts/` or `plugins/`).
- Every script reload re-activates every third-party half. This is cheap for small plugins, but a plugin with heavy `activate` work pays it on every save.
- npm plugin entries resolve through `exports`, so a badly packaged plugin fails with a resolution message.

## Deprecates

Nothing. This settles ADR 0133's open questions on the `plugin.json` schema, the npm marker and compiling and type-checking project-local editor halves.

## Open questions

- An API report for `myco` and `myco/editor` before v1 (0133).
- Plugin settings stored per plugin in `project.json` (a `plugins.<name>` object) once a plugin needs them.
- A plugin registry or marketplace: out of scope.

## References

- `src/plugins/thirdParty.ts` (manifest parsing, semver ranges, discovery, checks, code selection), `src/plugins/thirdPartyEditor.ts` (the editor's sync), `src/editor/scriptLoader.ts`, `src/editor/packages.ts`, `src/export/webBuild.ts`, `src/player/main.ts`, `src/server/project.ts`, `src/server/run.ts`, `vite.shared.ts` (`engineTypes`), `src/editor/scriptingSetup.ts`.
- Example plugin: `src/plugins/fixtures/spinner-project/` (a project with a `plugins/spinner/` plugin: a Component, an editor note and a static asset kind).
- Guide: [docs/guide/plugins.md](../guide/plugins.md).
- npm semver ranges: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#dependencies
