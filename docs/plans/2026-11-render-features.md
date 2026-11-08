# Render features behind one shape (follow-up C)

Source: [2026-11-architecture-followups.md](2026-11-architecture-followups.md) section C, whose rules (renderer neutrality, ADRs, testing on this machine, delegation) apply unchanged. Builds on ADR 0127 (material library), 0128 (surface split) and 0129 (frame plan, render policy), all on `master` (`222c4b6`). Needs **ADR 0130**, written and accepted before code.

## What the code does today (read 2026-11-07, `BabylonRenderer.ts` 1,403 lines)

| Concern | Today |
|---|---|
| `sync()` | 12 steps in an order that matters, written inline: sprites, tilemaps, meshes, cameras, shadow casters, sky (before lights: it may drive the sun), lights, particles, fog, environment, readiness, probes (after meshes, with the probe render list and `ready`), water, UI, editor tools |
| `release()` | a 9-branch `instanceof` chain (UI first via `isUIComponent`, then SpriteRenderer, MeshRenderer, Tilemap, WaterSurface, ParticleSystem, Light, Text, Camera). `ReflectionProbe.onDestroy` calls `release()` but no branch handles it (probes drop it at their next sync). |
| `dispose()` | 25 hand-written calls; `BabylonLighting` has no `dispose` and relies on the scene's |
| Lazy loading | written four ways: `particles`/`particlesLoading`; `uiCore`/`uiDraw`/`uiLoading`/`uiModules`/`uiDrawModule`/`uiDrawLoading` (plus the preview UI core); `tools`/`toolsLoading`; `water ??=` (not lazy-loaded at all: imported statically, built on first surface) |
| Warm-up (0080) | `warmUp()` hard-codes the two custom kinds: `warmEffect` (particles, loading the player) and `warmWorldCanvas` (UI, loading the drawing module separately from the UI proper) |
| Diagnostics | `diagnostics()` asks each module by name (`lighting.state()`, `sky.state()`, `water?.state() ?? …`, `particles?.state() ?? null`…) |
| Inline features | sprites (~200 lines: `syncSprite`, `makeSpriteMesh`, `setSpriteGeometry`, `flushSprites`, the batcher) and meshes (~120: `syncMesh`, `instancingFor`, batches) live in the renderer itself, which is also why the editor's sprite/mesh iterators (ADR 0129 part 4) can't move out yet |

Adding WaterSurface touched 8 files and three places in the renderer (sync, release, dispose). The good model is `BabylonParticleHost` (`particles.ts`): the player gets explicit host callbacks (scene, world matrix, textures, materials, raycast, tier scale) and is tested on NullEngine.

## ADR 0130 (outline; written up as [ADR 0130](../decisions/0130-render-features-declare-ownership-phase-and-loading.md), which wins where they differ)

**Title:** "Each render feature declares the Components it owns, its sync phase and whether it loads lazily; the renderer runs features generically."
Related: 0010, 0057, 0069/0076, 0080, 0083, 0103, 0108, 0110, 0112, 0127, 0128, 0129.

1. **Neutral: sync phases and ownership, `render/renderFeatures.ts`.** No backend types.
   - `SyncPhase` = `"content"` (sprites, tilemaps, meshes) → *core: cameras, shadow casters* → `"lighting"` (sky, then lights, then fog/environment: order within a phase is registration order) → `"effects"` (particles) → *core: content readiness, probe render list* → `"capture"` (probes) → `"surfaces"` (water) → `"overlay"` (UI). The phase list and its core gaps are the documented dependency rules ("sky before lights", "probes after meshes", "UI last") as data, with a unit test per rule.
   - `RenderFeatureSpec`: `name`, `phase`, `owns: (c: Component) => boolean` (built from Component classes; UI uses `isUIComponent`), `lazy: boolean`, and `needed(world)` for lazy ones (default: the World has a Component it owns).
   - A pure `ownerOf(specs, component)` (first match, so UI's Text ownership is explicit) and `byPhase(specs)` used by every backend.
2. **Babylon: one feature interface, `render/babylon/feature.ts`.**
   ```ts
   interface BabylonFeature {
     sync(world: World, ctx: FeatureSyncContext): void; // ctx: the view camera, delta times, `ready`, probe render list…
     release?(c: Component): void;
     warm?(content: WarmContent): WarmItem[];          // ADR 0080: each feature builds its own warm items
     state?(): Partial<RenderDiagnostics>;             // merged into diagnostics()
     dispose(): void;
   }
   ```
   `lazyFeature(spec, load: () => Promise<BabylonFeature>)` does once what the four loaders do: load on first `needed`, ignore results after dispose, log and retry on failure, report `loading` (the first-frame hold, ADR 0120, waits on it as it waits on `uiLoading` today), and replay buffered settings (the particle preview).
3. **Shared services stay explicit host arguments**, as `BabylonParticleHost` does: the material library (0127), the shadow casters, the probe lookup, the render policy (0129), the texture loader. No god-context object.
4. **The renderer keeps a feature list** and runs `sync` by phase, `release` by `ownerOf`, `dispose` in reverse registration order, `diagnostics` by merging `state()`, and `warmUp` by asking each feature (loading a lazy one if the content needs it). Cameras, the frame plan, shadows, the warmer and the editor tools stay core (they aren't Component features).
5. **Sprites and meshes become features** (`babylon/sprites.ts`, `babylon/meshes.ts`), each with a drawn-object iterator; `editorContext` reads those (finishing ADR 0129 part 4).
6. **Components unchanged**: they keep calling `world.render?.release(this)` and know nothing of features (ADR 0128's seam stays).

Alternatives to record: a `Map<ComponentClass, handler>` for release only (fixes the chain, leaves sync/dispose/lazy as is); a context object passed to every feature (simpler signatures, but hides dependencies and grows without bound); an ECS-style system per Component type (matches the hidden ECS, but render features own GPU state across types, e.g. lighting owns lights, fog and environment).

Consequences to record: a new renderable Component is one feature file plus one registration line (no renderer edits, no `RenderSurface` edits); lazy loading, disposal and diagnostics can't be forgotten; a feature is testable on NullEngine with fake hosts; cost: one indirection per feature per frame, and phases make ordering explicit but coarser (a dependency inside a phase relies on registration order, documented beside the list).

## Build plan

Single writer on `BabylonRenderer.ts`; workers own disjoint module files in worktrees cut from `master` (check the merge-base).

**Wave 0 — coordinator.** Write ADR 0130, README row (Proposed), ask for acceptance.

**Wave 1 — coordinator.** The contracts: `render/renderFeatures.ts` (types, `ownerOf`, `byPhase`, the phase list) with its unit tests, and `render/babylon/feature.ts` (`BabylonFeature`, `FeatureSyncContext`, `lazyFeature`) with NullEngine tests of the lazy wrapper (load once, dispose during load, failure then retry, buffered settings). Commit before wave 2 so workers branch from it.

**Wave 2 — parallel workers (Sonnet), one module each, no renderer edits:**
- **2a sprites:** move `syncSprite`/`makeSpriteMesh`/`setSpriteGeometry`/`flushSprites`/`spriteSnap`/`spriteSize` and the batcher wiring into `babylon/sprites.ts` as a feature with a host (materials, policy, settings, sort order) and a drawn-sprites iterator; move the renderer-level tests in `spriteBatching.test.ts` to it.
- **2b meshes:** `syncMesh`/`syncMeshes`/`instancingFor` and `MeshBatches` wiring into `babylon/meshes.ts` with a drawn-meshes iterator and `casters()`; adjust `instancing.test.ts`.
- **2c adapters:** make `BabylonTilemaps`, `BabylonSky`, `BabylonLighting` (add `dispose`), `BabylonProbes` (add `release`), `BabylonWater` and `BabylonParticles` implement `BabylonFeature` (thin `sync(world, ctx)` adapters over today's signatures; `warm` on particles from `warmEffect`). One worker, six files, no shared files with 2a/2b.
- **2d UI:** a `babylon/uiFeature.ts` that owns the UI core, drawing, preview UI core and the warm-up's world canvas (today's `syncUI`, `syncPreviewUI`, `loadUIDraw`, `warmWorldCanvas`), lazy.

**Wave 3 — coordinator.** Rewire `BabylonRenderer`: the feature list, phased `sync`, `release`/`dispose`/`diagnostics`/`warmUp` loops, the first-frame hold reading `loading`; delete the four loaders and the `instanceof` chain; `editorContext` iterators from 2a/2b. Expect the renderer near 700 lines.

**Wave 4 — checks and merge.** Fresh-agent review against ADR 0130 and neutrality. `npm run typecheck`, `npm test`, then Chromium (software GL) and WebKit e2e, compared with the master baseline (memory: e2e baseline; rerun unlisted failures alone and on master). Manual: the editor with Flappy, a 3D sample with lights/sky/probes/water/particles/UI, editor play mode. Docs: 0130 status row; update 0080 (warm-up asks features), 0083, 0129 part 4. Ask before pushing.

## Loose ends that ride along or follow

- e2e shader specs reading the private `meshRenderers` map: once 2b's drawn-meshes iterator exists, extend `diagnostics().drawn` with material name, id and readiness and move `shadergraph`/`shadersubgraph`/`shaderassets` specs to it (wave 3 or a follow-up).
- Playstats: a cheap stats getter instead of the full `diagnostics()` (`src/editor/playStats.ts`); easy once `state()` is per feature.
- Overlay port cost (renderer-neutral line/shape lists from `editorOverlays.ts`): later, own ADR.
- Stale worktrees: the two `worktree-agent-*` from 0129, the merged `claude/material-library-306b29` / `claude/render-surface-split-373326`, and the locked `tmp-d-merge` folder (ask before deleting).
