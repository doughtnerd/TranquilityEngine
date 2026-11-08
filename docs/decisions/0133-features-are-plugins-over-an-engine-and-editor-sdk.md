# 0133. Features are plugins, each with a runtime half and an editor half, built on a public engine and editor SDK

- **Status:** Proposed
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0022, 0026, 0027, 0030, 0032, 0040, 0041, 0045, 0046, 0060, 0061, 0065, 0080, 0083, 0116, 0119, 0125, 0127, 0128, 0129, 0130, 0131

## Context

Every asset type the editor knows needs the same things:
- how to recognise its files;
- a label and an icon;
- what opening it does;
- a panel or inspector;
- load, save, undo and redo;
- policies for how it may be used;
- sometimes project settings, Components, systems and a way to draw it.

Today each of these is written once per asset type, in shared files that branch on the type. An architecture review on 2026-11-08 measured it:

- **Asset-kind knowledge is spread over about 12 tables in 7 files.** These include:
  - `assetBrowser.ts`: the `AssetKind` union, `assetKind`, `CODE_KINDS`, `canAddToScene` and `nodeForAsset`;
  - `ui/Assets.tsx`: labels, the open dispatch, a second `opens` list and the "New…" menu;
  - `ui/AssetPreview.tsx`: `ICONS`;
  - `ui/AssetInspector.tsx`, `assetImport.ts` and `assetFieldKinds.ts`;
  - `thumbnails/keys.ts`: `previewKind`, a second type detector that already disagrees with `assetKind` (the `.env` regex and the model extensions).

  Adding a kind touches about 7 files. `"particlesubgraph"` appears in 5 of them.
- **Asset editing is copied per type.** The same write queue appears in 6 stores (`material`, `sky`, `formation`, `particle`, `tileset`, `shaderGraphAssets.ts`), five of which set up their own undo history. The edit, save, outside-change and read-only logic is written again inside `ShaderGraphPanel.tsx`, `particleGraph/GraphEditor.tsx` and `SkyPanel.tsx`. The copies have drifted:
  - `forgetGraphHistory` is never called, so a new file at a renamed or deleted file's path inherits that file's undo stack;
  - open editors keep the old path after a move;
  - materials have no undo;
  - the "read-only project" message exists in 30 copies.
- **The Project and Worlds panels** each carry their own draft and persist machinery for `project.json` (ADR 0116 mentions their shared write queue).
- **The runtime is already moving per feature.**
  - Render features declare the Components they own, their phase and how they load (0130).
  - Field metadata and a lazy Inspector-sections registry are on the Component declaration (0131).
  - Physics 2D, physics 3D and navigation load lazily, but each is wired in about five places with its own loader.

The owner wants two things from one design:
- the way the engine and editor themselves are built out, feature by feature;
- a way for advanced users to write their own asset kinds and features.

Constraints:
- Babylon.js, three.js, Rapier and Howler never appear in the public API, and a renderer change should only need a new backend adapter (0010, 0075, 0127–0130).
- Game builds carry no editor code (0041).
- Editor start-up stays fast, and heavy editor parts load on first use (0059, 0083).
- Project scripts and npm packages are already compiled and bundled in the editor (esbuild-wasm, with `"myco"` external; 0030, 0125).
- Scenes already keep Components whose script is missing (`src/editor/componentEdits.ts`, `SceneLoader.ts`).

## Decision

We will build features as **plugins**. A plugin is a feature: it bundles a manifest, a **runtime half** and an **editor half**, and it registers **contributions** into **contribution points**. The engine and editor expose those contribution points, plus the shared building blocks a feature needs, as a public **SDK**. First-party features and user-written features use the same SDK.

### What a plugin is

- **One plugin per feature, not per asset type.** A plugin contributes any number of asset kinds, Components, systems and so on. For example, Materials and Shaders can be one plugin, and Particles owns effect, sub-graph and custom-block assets.
- **Two halves, like Unity packages.**
  - `runtime/` holds Components, systems, World services and asset loaders.
  - `editor/` holds asset kinds, asset document formats, panels, inspector sections, settings sections, importers, thumbnails and the "New…" entries.
  - The editor half may import the runtime half, never the reverse, and a lint or import check enforces this.
  - A pure tool may have only an editor half.
- **A plugin is a thin manifest over registries.** The plugin object only groups contributions; the depth is in each contribution point's registry. There is no central plugin host with a large lifecycle interface.

### The SDK

- **`myco`** is the existing runtime API plus the runtime contribution points.
- **`myco/editor`** is new. Only `editor/` code may import it. It holds:
  - the editor contribution points;
  - the asset document module (load, save, undo and redo through 0027's `UndoTree`);
  - the shared graph view (`src/editor/graph/`: canvas, history, clipboard, and later groups and notes);
  - inspector fields, panels and editor services.
- **Internal tier.** Everything else is `@internal` and for first-party plugins only.
- **Stability.** Before v1, both public entry points are labelled experimental. From v1, an API report (for example API Extractor) checks every change to them against semver.
- **First-party plugins version in lockstep with the engine.** Their manifests carry the engine's version. Only third-party plugins declare an SDK version range.

### Contribution points (v1)

| Half | Contribution point | Builds on |
|---|---|---|
| Runtime | Components, with field metadata | 0131 |
| Runtime | Systems | 0032 |
| Runtime | World services: a loader, what needs the service (Component types or World kinds), dispose | 0032, 0045, 0065 |
| Runtime | Asset loaders | |
| Runtime, **internal only** | Render features, warm-up content | 0130, 0080 |
| Editor | Asset kinds | 0040, 0061, 0119, 0131 |
| Editor | Asset document formats: parse, format, migrate, default document | 0026, 0027 |
| Editor | Openers: a panel or the inspector | |
| Editor | Inspector sections | 0131 |
| Editor | Panels | |
| Editor | Project settings sections: a set of owned `project.json` keys with read, write and validate | 0116 |
| Editor | Importers, thumbnails and previews, "New…" entries | |
| Editor | Editor services | |

An asset kind carries more than detection, label and icon. It also states the asset's **policies**:
- which fields may reference it (0131's `kind`);
- whether it can be added to a scene, and as what node;
- how exports process it (0119);
- whether it is read-only or an importer sidecar (0040).

**Not in v1:** user preferences, toolbar buttons, viewport gizmos and tools (these are tied to the overlay renderer, which isn't renderer-neutral yet), and Hierarchy menu items. Each comes later through its own small ADR.

**Every registry supports unregistering.** That is required for disabling a plugin and for live reload.

### Drawing (ADR 0010)

- The render-feature contribution point stays **internal** (first-party only). Render features are Babylon adapters (0130), and exposing them would put Babylon in the public API.
- Third-party plugins draw by composing renderer-neutral building blocks: meshes, materials, shader graphs, sprites, particles, UI and lines.
- A renderer-neutral render-feature SDK would need its own ADR. This is the one place where first-party plugins can do something third-party plugins cannot.

### How plugins talk to each other

- **Hard dependencies are the default.** A manifest declares the plugins it depends on, with version ranges. Load order follows the dependency graph, and cycles are refused. Enabling a plugin enables its dependencies. Each plugin has one public module that others may import, and a lint rule blocks imports of anything else inside another plugin.
- **Optional coupling goes through services.** A plugin publishes a named, typed service. Others look it up as "that plugin's service, if it is enabled": World services at runtime and editor services in the editor. For example, Tilemaps can give tiles colliders when Physics 2D is on, without depending on it.
- **No global event bus.** A bus hides who depends on whom. A real need for one gets its own ADR.

### Where plugins live and how they are found

- **The manifest** is `plugin.json`. It holds:
  - name, version and SDK version range;
  - dependencies;
  - the entry points of both halves;
  - a `server` flag (`false` for halves that only draw, such as Sky);
  - the static parts of each asset kind: extensions, label and icon.

  With these, the Assets browser can recognise and label files without running plugin code (0059, 0083). Behaviour is registered from the entry modules.
- **First-party plugins** live in `src/plugins/<name>/{runtime,editor}/` and are compiled into the editor and player. `src/engine/` and `src/editor/` shrink to the core and the editor shell.
- **Third-party plugins** are found in two places, using one manifest format:
  - inside the project at `plugins/<name>/`, compiled like `scripts/` (0030);
  - as npm packages in the project's `node_modules` that their `package.json` marks as Myco plugins, bundled the way packages are (0125).
- **Trust.** Plugins run with the same access as project scripts (0030), with no sandbox, like Unity packages or VS Code extensions. The guide will say so.

### What stays core

- **Engine core:** World, the ECS, GameObject and Transform, scene files and prefabs, the scene loader and overrides, assets, time, input, `Engine`, the renderer core and the shared render services (0127–0130), and netcode.
- **Editor shell:** the docking and panel frame, Hierarchy, Viewport, the Inspector frame, the Assets browser frame, undo, the scene document and commands (0026), the Code panel, Play, Export, and the graph view.
- **Plugins:** everything else. Examples: Sprites, Tilemaps, Meshes and models, Materials and Shaders, Particles, Sky, Environment, Water, Physics 2D, Physics 3D, Navigation, Audio, UI and Post-processing.

### Per project

- **`project.json` lists the enabled plugins.** The first-party defaults are on.
- **Export and the dedicated server** bundle only the runtime halves of enabled plugins. The server also skips halves marked `server: false`. A 2D game then ships without Rapier 3D or navigation.
- **Editor lifecycle:**
  - When a project opens, the editor reads the manifests and registers each enabled plugin's contributions.
  - Heavy parts (panels, compilers) load on first use (0083).
  - Disabling a plugin unregisters what it contributed.
  - Saving a third-party plugin's source re-registers its editor half live (0125's reload). Runtime-half changes take effect at the next Play.
- **A disabled or missing plugin never destroys data.**
  - Its Components are treated like a missing script: kept untouched in scene files, shown as "missing (plugin X disabled)" and skipped at runtime with a reported problem.
  - Its asset files show as generic files with a hint to enable the plugin.

### Migration

- **Incremental, not all at once.** Built-in features move across one at a time and keep working throughout.
- **The pilot is Sky.** It covers an asset kind, an asset document with undo, a panel, a Component and a render feature, and it settles those contribution points. Material and Shader come second, to stress-test the design.
- **Each contribution point gets its own ADR when it is designed.** The asset kind and asset document ADRs are written during the Sky pilot; the review's candidates 2 and 3 become those modules. The review's World-services candidate becomes the World services contribution point, and its `project.json` section editor becomes project settings sections.

## Alternatives considered

- **One plugin per asset type.** This matches the original framing, but features such as Materials and Shaders, Particles and Navigation each span several asset kinds plus Components and settings, so they would be split apart for no gain.
- **Plugins for first-party structure only, with no third-party loading.** This is cheaper, with no semver and no loader, but the owner wants users to write asset kinds. The design keeps the cost down by reusing 0030's and 0125's compile and bundle pipeline.
- **A central plugin host with one large lifecycle interface** (activate, deactivate, onAssetOpened, onSave, …). That is a shallow module that every plugin must learn in full. Per-registry interfaces are smaller, and each can be tested alone.
- **Expose Babylon to plugins for drawing.** This contradicts 0010 and the goal of being able to swap renderers.
- **Design a renderer-neutral render-feature SDK now.** It is large and not needed for the pilot. It stays a later ADR.
- **A global event bus for plugin communication.** It hides dependencies. Declared dependencies and typed services make every coupling visible.
- **Per-asset linear, in-memory undo (as today) or one global undo across scene and assets.** Linear in-memory undo loses history on a crash and keeps no branches. Global undo is confusing with several panels open. Each asset document gets 0027's persistent tree instead.
- **Code-only registration with no static manifest.** Every plugin's code would have to run before the Assets browser could label files, which hurts start-up (0059).

## Consequences

**Positive**
- **Locality:** a feature's runtime, editor, assets, settings and tests sit in one folder. Adding an asset kind becomes one plugin, not edits to 7 shared files.
- **Leverage:** saving, undo, outside-change detection, rename and delete handling are written once in the asset document module, so the stale-undo and stale-path bugs are fixed for every kind. Materials get undo.
- The SDK is used by our own features, so it is tested by real use before users depend on it.
- Smaller game builds: only the runtime halves of enabled plugins ship.
- Users can write asset kinds and features with the same tools we use.

**Negative / costs**
- **A large migration.** Every built-in feature moves into `src/plugins/` and onto contribution points. Until it's done there are two ways of doing things.
- **Public SDK surface means semver obligations** from v1, and an API report in CI.
- **Third-party plugins can't draw custom render passes** until a renderer-neutral render-feature SDK exists.
- **Plugins run with full trust.** A malicious plugin can do what a malicious project script can.
- **Plugin loading adds editor start-up work** (reading manifests, registering). It must stay within the 0059 budget.
- **Every registry needs unregistering and must handle re-registration,** which some current registries don't do.

## Deprecates

- The asset-kind tables in `assetBrowser.ts`, `ui/Assets.tsx`, `ui/AssetPreview.tsx`, `ui/AssetInspector.tsx`, `assetImport.ts`, `assetFieldKinds.ts` and `thumbnails/keys.ts`. These are replaced by asset kind contributions, kind by kind, as features move across.
- The per-type write queues and history wrappers in `materialAssets.ts`, `skyAssets.ts`, `formationAssets.ts`, `particleAssets.ts`, `tilesetAssets.ts` and `shaderGraphAssets.ts`, and the save logic in panel components. The asset document module replaces them.
- The per-subsystem `ensurePhysics2D`, `ensurePhysics3D` and `ensureNavigation` wiring in `World`, `SceneManager` and `Engine`. World services replace it.
- The draft and persist code in `ui/ProjectSettingsPanel.tsx` and `ui/WorldsPanel.tsx`. Project settings sections replace it.

Each is removed when the last feature using it has moved.

## Open questions

- **The interfaces of each contribution point**, starting with asset kinds and asset documents. These are designed in the Sky pilot, comparing at least two alternative designs.
- **The exact `plugin.json` schema**, and how an npm package marks itself as a plugin (a `package.json` field, or a `myco-plugin` keyword).
- **How the editor half of a project-local plugin is compiled and type-checked** against `myco/editor` (the Monaco declarations and the generated `tsconfig.json`).
- **A renderer-neutral render-feature SDK** for third-party drawing.
- **The later contribution points:** user preferences, toolbar buttons, viewport gizmos and tools, Hierarchy menu items.
- **Plugin settings UI:** where enabling and disabling plugins lives (Project settings or a Plugins window), and how dependency prompts read.

## References

- Architecture review, 2026-11-08: candidates 2 (asset documents), 3 (asset-kind registry), 5 (World services), 6 (`project.json` sections).
- [docs/plans/2026-11-architecture-followups.md](../plans/2026-11-architecture-followups.md): the render-seam review that led to 0127–0131.
- Unity package layout (`Runtime/`, `Editor/`): https://docs.unity3d.com/Manual/cus-layout.html
- VS Code contribution points: https://code.visualstudio.com/api/references/contribution-points
- API Extractor: https://api-extractor.com/
- [GLOSSARY.md](../../GLOSSARY.md)
