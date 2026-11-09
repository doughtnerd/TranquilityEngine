# 0144. The editor shell reaches plugins only through contribution points

- **Status:** Proposed — built in the same change
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0057, 0060, 0065, 0082, 0103, 0133, 0134, 0135, 0137, 0138, 0142

## Context

ADR 0133 makes features plugins and the editor shell core; 0134, 0138, 0140 and 0142 moved most feature code into `src/plugins/<name>/editor/`. Some plugin code still lived in, or was named by, the shell (`src/editor/`), and ownership ran backwards in places:

- **Tilesets.** `src/editor/tilesetAssets.ts` (94 lines) imported `plugins/tilemaps/runtime/tileset` by deep path, and the Tilemaps editor half imported it back in four files (`index.ts`, `TilesetInspector.tsx`, `tilesetFormat.ts`, `TileThumb.tsx`). The Assets panel (`ui/Assets.tsx`) called it for **Create Tileset from Slices**, and the Hierarchy's Create menu built **Tilemap** nodes itself (`nodeCreate.ts`).
- **Particles.** `particleAssets.ts` (creating effects; the plugin's `particleAssets.ts` re-exported it), `particlePreview.ts` (installed by `cameraPreview.ts`) with `ui/ParticlePreviewOverlay.tsx` (rendered by `ScenePanel.tsx`), `particleMigration.ts` (called from `session.ts` when a scene opens), and Create **Particle System** in `nodeCreate.ts`/`hierarchyActions.ts`.
- **Navigation.** `playStats.ts` imported `navAgentCount` from `plugins/navigation/runtime` for the Play Stats panel's "nav agents".
- **Physics.** `prefetch.ts` imported `plugins/physics/runtime/core/index` and `plugins/physics-rapier/runtime/rapier2d`/`rapier3d` to fetch them while the editor idles (ADR 0082).

The boundary test (`plugins/plugins.test.ts`) only stopped the shell importing a plugin's editor half, so all of these passed. A disabled plugin's Create entries and actions also stayed in the menus.

0133 names "New… entries" an editor contribution and lists Hierarchy menu items as "later, through its own small ADR". The Assets panel's New… menu already comes from asset kinds' `create` (0134), but that is for files, not nodes, so it can't serve the Hierarchy.

## Decision

We will make the shell reach plugin code only through contribution points, add the five small ones that were missing, and reuse two existing ones. All are registries made with `createRegistry` in `src/editor/sdk/contributions.ts`, registered through `EditorPluginContext` (undone on deactivate) and exported from `myco/editor`.

**New contribution points**

- **Hierarchy create entry** (`HierarchyCreateContribution`, `hierarchyCreateEntries`, `registerHierarchyCreateEntry`): `{ id, label, name, after?, createAsset?(), components(position, asset) }`. `newNodeKinds()` (`nodeCreate.ts`) lists the built-in kinds with each entry after the one its `after` names (registration order; not found: last). The Hierarchy's "+" and right-click menus and the menu bar's Create menu use it. `createNode`/`newNodeEntry` take a built-in kind or an entry's `id`; `createNodeIn` calls `createAsset` first when the creator gave no asset and passes `asset:<path>` (or "" when it failed, keeping the status it set). The Tilemaps plugin contributes **Tilemap** (`after: "sprite"`), the Particles plugin **Particle System** (`after: "reflection-probe"`, `createAsset` writes a new effect), so the menu order and labels are unchanged.
- **Asset action** (`AssetActionContribution`, `assetActions`, `registerAssetAction`): `{ id, label, writes?, appliesTo(project, targets), run(project, targets) }`, where a target is `{ path, slice? }`. The Assets context menu lists applicable actions right after Open / Sprite Editor… for selected files and for selected slices, disabled in a read-only project when `writes`; the files `run` resolves to are selected. The Tilemaps plugin contributes **Create Tileset from Slices** (`myco.tilemaps.tileset-from-slices`).
- **Play stats counter** (`PlayStatsCounterContribution`, `playStatsCounters`, `registerPlayStatsCounter`): `{ id, label, count(world) }`, `null` for nothing to show. `WorldStats.agents` becomes `counters: { label, value }[]`, shown on the Nodes row joined by " · ". The Navigation plugin contributes "nav agents". Internal tier: it is given the `World`, like viewport tools (0138).
- **Scene-open migration** (`SceneOpenMigrationContribution`, `sceneOpenMigrations`, `registerSceneOpenMigration`): `{ id, failure, migrate(scene) }`, run one at a time in registration order after the scene's history is attached, while the scene stays open; a failure reports `Couldn't <failure> <path>`. The Particles plugin contributes the embedded-effect move (0060), with the same message as before.
- **Idle prefetch** (`IdlePrefetchContribution`, `idlePrefetches`, `registerIdlePrefetch`): `{ id, load() }`, called with the script compiler once the editor is idle and the engine's chunks are in (0082). The Physics plugin contributes its core and every registered backend's code; to reach backends without importing another plugin's internals, `PhysicsBackendRegistration` gains an optional `prefetch()` (fetch without starting), which the Rapier plugin sets to its dynamic imports.

**Reused contribution points**

- The particle preview is the Particles plugin's **viewport tool** `myco.particles.preview` (0138): its `install` runs `installParticlePreview(view.engine)` on each scene view and returns the cleanup. It claims no input and never becomes the active tool.
- Its controls are a **panel extension** on the `scene` panel (0133's `panelExtensions`): the Scene panel renders `scene` extensions over the scene view where the overlay used to be (`ui/panelExtensions.tsx`, split from `ui/panels.tsx` so `ScenePanel.tsx` can import it). Its CSS moves with it (`particlePreview.css`).

**Moves.** `tilesetAssets.ts` (and its test) → `src/plugins/tilemaps/editor/`; `particleAssets.ts` merges into the plugin's `particleAssets.ts` (`effectFolder`, `createParticleEffect`); `particlePreview.ts`, `particleMigration.ts` (and test) and `ui/ParticlePreviewOverlay.tsx` → `src/plugins/particles/editor/`.

**The boundary.** The shell's non-test code imports nothing from a plugin's folder (`src/plugins/<name>/…`), not even its `runtime/index`. It may import the plugin host modules directly under `src/plugins/` (`manifest`, `order`, `enabled`, `runtime`, `runtimeContext`, `thirdParty`, `thirdPartyEditor`, `editorApply`), which are the plugin system the shell drives, and only `main.tsx` may import `editorBoot`. `plugins/plugins.test.ts` enforces this with an explicit list of host modules.

## Alternatives considered

- **One generic "menu item" contribution for every menu** (VS Code's `menus` with `when` clauses) — one point instead of two, but the Hierarchy needs node entries and an asset to write first, and the Assets menu needs selection targets; a generic shape would push those into untyped callbacks. Two small typed points are clearer.
- **Reuse asset kinds' `create` for the Hierarchy** — it makes files, not nodes, and the Hierarchy's entries aren't tied to one asset kind (Tilemap's tileset is optional).
- **Let plugins prefetch in `activate`** — activation runs at boot, before the layout loads; fetching then competes with the first frame, which is what 0082's idle ordering avoids.
- **A scene-view preview contribution point for the particle preview** — the viewport tool's `install` already gives a per-scene-view install with cleanup; a new point would duplicate it.
- **Keep `plugins/<name>/runtime/index` imports allowed in the shell** — the one use (`navAgentCount`) is better as a counter, and allowing it would let the shell name plugins again.

## Consequences

**Positive**
- The shell names no plugin: disabling Tilemaps or Particles removes their Create entries, Create Tileset from Slices, the particle preview and the migration; disabling Navigation removes the agent count.
- Ownership runs one way for tilesets and particles; the Tilemaps and Particles editor halves no longer import back from the shell for their own assets.
- The boundary is a test, so new shell→plugin imports fail CI.

**Negative / costs**
- Five more contribution points in the SDK (still experimental until v1, 0133).
- The particle preview overlay is loaded lazily on the first Scene panel render instead of with the panel.
- Built-in Create kinds that belong to plugins by component (Water, UI elements, Fog, Reflection Probe) are still listed by `nodeCreate.ts`; they import no plugin code and move when their plugins want them to.

## Deprecates

- `src/editor/tilesetAssets.ts`, `particleAssets.ts`, `particlePreview.ts`, `particleMigration.ts`, `ui/ParticlePreviewOverlay.tsx`: moved (above), not kept as re-exports.
- `NewNodeKind`'s `"tilemap"` and `"particle-system"` members (now entry ids; `NodeKind` accepts both); `WorldStats.agents` (now `counters`).
- The old boundary test (editor halves only): replaced by the stricter one.

## Open questions

- Should Water, the UI elements, Fog and Reflection Probe become Create entries of their plugins (Water, UI, Environment)?
- The plugin host modules could move under `src/editor/` or a `src/pluginHost/` folder so the rule reads "nothing under `src/plugins/`"; left for when third-party loading settles (0139).

## References

- `src/editor/sdk/contributions.ts`, `src/editor/sdk/plugins.ts`, `src/editor/nodeCreate.ts`, `src/editor/hierarchyActions.ts`, `src/editor/ui/Assets.tsx`, `src/editor/playStats.ts`, `src/editor/session.ts`, `src/editor/prefetch.ts`, `src/editor/ui/panelExtensions.tsx`
- `src/plugins/tilemaps/editor/index.ts`, `src/plugins/particles/editor/index.ts`, `src/plugins/navigation/editor/index.ts`, `src/plugins/physics/editor/index.ts`, `src/plugins/physics/runtime/backend.ts`, `src/plugins/physics-rapier/runtime/index.ts`
- Tests: `src/plugins/plugins.test.ts`, `src/plugins/shellContributions.test.ts`
