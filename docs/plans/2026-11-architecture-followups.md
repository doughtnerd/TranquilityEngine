# Architecture follow-ups (handoff, 2026-11-07)

An architecture review on 2026-11-07 picked six ways to make modules deeper in the render and editor code that changes most often. Two are done and on `origin/master` (`ab0f205`):

- **ADR 0127**: renderer-neutral material resolution (`src/engine/render/materialResolution.ts`) plus a per-scene Babylon material library (`src/engine/render/babylon/materialLibrary.ts`).
- **ADR 0128**: `RenderSurface` is down to a runtime core plus one `diagnostics()` snapshot. The editor now goes through an editor viewport handle (`src/engine/render/editorViewport.ts`), with a Babylon adapter (`render/babylon/editorTools.ts`) and a fake (`render/fakeViewport.ts`).

Both ADRs are still **Proposed**. Ask the owner to accept them before building on them.

This file covers the four candidates left (A–D below) and some loose ends.

## Rules for every item

- **Renderer neutrality (ADR 0010; the owner's explicit goal).** A future renderer switch, or a home-grown renderer, must not need a rewrite of anything except a thin backend adapter.
  - Policy that doesn't depend on Babylon goes in `src/engine/render/`, never under `render/babylon/`.
  - It speaks engine types only (`Camera`, `GameObject`, `Ray`, `ScreenRect`, `LocalPose`, `PostEffects`…).
  - No Babylon bit values or objects cross the seam.
- **Vocabulary.** Use module, interface, implementation, depth, seam, adapter, leverage, locality. Apply the deletion test before adding a module.
- **ADRs and status.** A public or editor-facing interface change needs an ADR (`docs/decisions/0000-template.md`; take the next free number, 0129+ as of now). Add its row to `docs/README.md` and update `docs/architecture/implementation-status.md`.
- **Testing on this machine.**
  - Chromium's WebGPU fails to start in e2e here (`dxcompiler.dll` error 87), and on master too. Run Chromium e2e with `E2E_SOFTWARE_GL=1 npx playwright test --project=chromium`.
  - Before blaming a change for an e2e failure, compare against master in a temporary worktree (`git worktree add --detach .claude/worktrees/tmp-master-e2e master`, then `E2E_PORT=4190`).
  - Specs already failing on master in both browsers:
    - `cameras.spec.ts:36` (flaky)
    - `export.spec.ts:158`
    - `playstats.spec.ts:36`
    - `postprocessing.spec.ts:21` and `:52`
  - Chromium-only failures on master:
    - `assetbrowser.spec.ts:208`
    - `lighting.spec.ts:55`
    - `shadergraph.spec.ts:72`
    - `shadersubgraph.spec.ts:69`
    - `spriteeditor.spec.ts:140`
    - `thumbnails.spec.ts:151` and `:177`
  - The unit test `lobby.test.ts` also fails on master.
  - Don't run unit tests and e2e at the same time; it causes timing flakes.
- **Delegation (owner's preference).** The strongest model coordinates. Parallel sessions or subagents each own disjoint files and work in their own worktrees cut from **master** (check the merge-base; a session was once cut from a stale branch). The coordinator merges, reviews with a fresh agent, runs the full checks, then merges to master. Ask before pushing.

## Suggested order

1. **A + B together**, as one piece of work, because both edit `BabylonRenderer.render()` and the camera preview code.
2. **C** after A + B, because it reshapes `sync`/`release`/`dispose` in the same file.
3. **D** at any time, in parallel. It doesn't touch the renderer.

---

## A. Frame plan: one module decides which cameras draw where (Worth exploring, in-process)

**Where.** In `src/engine/render/babylon/BabylonRenderer.ts`:
- `render()`
- `viewCameras()` and `targetCameras()`
- `previewRect()` and `previewView()`
- `postSettings()` and `scenePostSettings()`

The tested downstream piece is `cameraPasses` in `render/babylon/frameGraph.ts` (`babylonFrame.test.ts`).

**Problem.** The rules that decide a frame are inline and untested:
- UI goes on the first view when editor tools exist, otherwise on the last.
- The overlay goes only on view 0.
- The layer mask is `this.fill ? 0xffffffff : 0x0fffffff`.
- The editor view previews the scene camera's post-processing minus depth of field.
- The backdrop rule.
- Fog's `affectsSkybox` blends the clear colour.
- Render-texture cameras come after canvas cameras.
- The preview inset overrides the orthographic aspect.

The background, fog-blend and post-resolution code is copied for canvas cameras, target cameras and the preview.

**Change.** Add a pure module in `src/engine/render/` (not `babylon/`).
- **Input:** the World's cameras, the editor state (tools present, preview rectangle, editor World or not), the quality tier, the clear colour and the sky fog.
- **Output:** the ordered views, each with:
  - target and viewport;
  - clear colour and backdrop;
  - resolved post-processing and tone mapping;
  - UI and overlay flags;
  - "editor-only content visible" as a **flag**, not a Babylon layer mask.

The renderer then only maps views to Babylon cameras and runs them.

**Tests.** In-process, with plain component objects. Examples:
- play mode puts screen UI over the view camera;
- render-texture cameras never see editor content;
- fog tints the clear colour.

**ADRs it touches:** 0051, 0056, 0071, 0109, 0111.

## B. Editor policy out of the runtime renderer (Worth exploring, ports & adapters on the 0128 viewport port)

**Where.** In `BabylonRenderer.ts`:
- `this.fill`, used in `render()`, `sync()`, the particle host (`editor: this.fill`) and UI (`interactive: !this.fill`);
- the sprite-mesh rule `fill || tools !== null || toolsLoading` (search `spriteMeshes` or `toolsLoading`);
- the camera-preview inset and its second UI core (`previewRect`/`previewView`, `uiModules`);
- `setSelected`/`selectedNodes` for the particle preview;
- `scenePostSettings`.

Also `render/babylon/editorContext.ts`, which reads the renderer's private `sprites`/`meshRenderers` maps.

**Problem.** Editor state decides runtime behaviour. Whether sprites batch (ADR 0108) depends on whether the editor helpers have loaded, and commit 42f2858 had to fix editor play mode because of it. Every game build carries these paths, gated by booleans.

**Change.** The renderer offers explicit, renderer-neutral knobs:
- a draw policy ("keep per-object meshes");
- extra views the caller contributes (the camera-preview inset, the scene-post preview), fed into A's frame plan;
- a "which components are playing" predicate for particles.

The editor viewport handle (ADR 0128) sets these. Editor helpers read drawn meshes through a query on the mesh and sprite code, not through private maps.

**Tests.** A test on the draw policy: "batches in a game, per-object meshes with editor tools". It replaces today's dependence on load timing.

**ADRs it touches:** 0022, 0051, 0057, 0108. Update the implementation-status note about the batching exception. Probably a new ADR, because it changes what the viewport handle does.

## C. Render features behind one shape (Worth exploring, local-substitutable on NullEngine)

**Where.** In `BabylonRenderer.ts`:
- `sync()` pulls `world._componentsOfType(X)` per type, in an order that matters: sky before lights, probes after meshes, UI last;
- `release()` is an `instanceof` chain;
- `dispose()` is written out by hand;
- lazy loading is re-implemented four times (`particles`/`particlesLoading`, `uiCore`/`uiDraw`/`uiLoading`/`uiModules`, `tools`/`toolsLoading`, `water ??=`).

Also the `onDestroy` → `world.render?.release(this)` calls in `render/components.ts`, `WaterSurface.ts` and `Tilemap.ts`.

**Problem.** Adding a renderable Component (WaterSurface was the example) touched 8 files and three places inside the renderer.

**Change.** Each feature declares the Component types it owns, whether it loads lazily, and its place in the order. The renderer keeps a feature list and does lazy loading, release dispatch, disposal and diagnostics collection once.

Shared services stay **explicit host arguments**, not a god-context:
- the material library (0127);
- the shadow casters;
- the probe lookup.

Components keep calling `world.render?.release(this)` and stay unaware of features.

**Model to follow:** `BabylonParticleHost` in `render/babylon/particles.ts`, and its tests on NullEngine.

**ADRs it touches:** warm-up (0080) must ask each feature for its warm content; keep on-demand loading (0083).

## D. Field metadata on the Component declaration, not hard-coded in the Inspector (Worth exploring, in-process; public API change, so an ADR)

**Where.** `src/editor/ui/Inspector.tsx`:
- `assetListFor()` has about 8 type/field pairs that map to an asset kind (MeshRenderer.mesh/material/materials, MeshCollider.mesh, Camera.targetTexture, ParticleSystem.effect, NavGroup.formationAsset, PostProcessing.lut, ReflectionProbe.bakedMap, Environment.map);
- the hidden fields for ParticleSystem and Tilemap;
- per-type sections (Environment, NavChunk, ReflectionProbe);
- the `navNote()` switch.

Also `src/engine/core/registry.ts` `FieldOptions` (only `replicate`, `predicted`, `quantize`, `choices`) and `src/editor/assetBrowser.ts` `AssetKind`.

**Problem.** Whether a field is an asset of a given kind belongs to the field. Today it's rediscovered by matching type and field names. User script Components get no filtered asset pickers, and `src/editor/ui/` has no unit tests.

**Change.**
- `@field(AssetRef, { kind, hidden })`; the Inspector reads it from `listComponents`' field info.
- Per-type extras move into an Inspector-sections registry keyed by Component type. Each section lives beside its feature's UI and can stay lazy (0083).

**Tests.** "This field offers materials" becomes an in-process unit test on field metadata.

---

## Loose ends from 0127/0128

- **Playstats snapshot cost.** `src/editor/playStats.ts` calls the full `diagnostics()` snapshot a few times a second just to read `.stats`. Consider a lighter getter; this is perf only.
- **Private-map e2e specs.** `tests/e2e/shadergraph.spec.ts`, `shadersubgraph.spec.ts` and `shaderassets.spec.ts` still read the private `render.renderer.meshRenderers` map. Move them to `diagnostics().drawn`, extended with material names if needed.
- **Overlay port cost.** Editor overlays and gizmos (`render/babylon/editorOverlays.ts`, about 1,079 lines, and `editorGizmo.ts`) would have to be ported to any new renderer. A possible later deepening: overlays produce renderer-neutral line and shape lists that each adapter only draws.
- **Leftover branches and worktrees.** The branches `claude/material-library-306b29` and `claude/render-surface-split-373326` and their worktrees can be deleted. Both are merged.
