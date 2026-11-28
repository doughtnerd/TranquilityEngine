# 0448. Auto-instanced meshes draw through per-pass thin buffers while levels are applied

- **Status:** Proposed
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0108, 0446 (amends §3), 0447, 0276

## Context

0446 §3 applies levels per view by giving each view an object list. An `auto` batch (0108) has one Babylon
`InstancedMesh` per renderer, so with levels each renderer has an instance per level it uses. Thin batches already draw
through one source mesh per pass (each view, the casters, each cascade, each probe capture), with a matrix buffer
holding only what that pass draws.

0446 sets a target: JS CPU no higher with LODs on than without. Measured on the gate scenes after the fixes in the
build log ("CPU against no LOD", 2026-11-28; SwiftShader, 1280×720, High, ms p50, 2 runs):

| Scene | No LOD | LOD (auto, InstancedMesh) | Triangles no LOD → LOD |
|---|---|---|---|
| forest static | 58.0 | 63.2 | 61.4M → 15.0M |
| forest fly | 52.9 | 103.8 | 48.1M → 16.1M |
| city static | 30.6 | 23.5 | 10.3M → 1.8M |
| city fly | 27.7 | 33.3 | 6.9M → 1.4M |

Profiles of the forest fly-through put the remaining cost in the per-instance design:
- **Babylon's per-mesh walk:** every scene mesh is visited each frame (readiness, enabled state, world matrix), and
  each auto instance is frustum-tested and tested against each shadow cascade. The engine has already culled it.
- **Level-switch churn:** a switch disables one instance and enables (or makes) another. Recycling instances within a
  batch (`FREE_FRAMES`) and short frame-counted pools cut this, but don't remove it.
- **Sweeping:** keeping each instance's enabled state in step with what the views drew, for 10k renderers.

0446's own measurements found thin batches at about half the JS CPU of auto (forest 24.8 ms, city 19.5 ms), and its
first-wave spike found per-pass thin sources cost 1.88 ms p50 for 10k instances in each of 5 passes.

## Decision

We will draw `auto` batches like thin batches while levels are applied per view. There is no per-renderer Babylon
object for them then.

- **When:** a World runs the visibility stage (it has an `LODGroup`), the mesh feature's `prepareViews` runs, and the
  editor's tools aren't attached to the view. Without the stage, `auto` draws as 0108 says, one `InstancedMesh` per
  renderer, so scenes without `LODGroup`s don't change.
- **Editor:** with the editor's tools attached (the scene view, editor play mode), `auto` keeps its instances, as thin
  batches already draw as instances there (0108), because picking and selection outlines need per-object meshes.
- **How:** an auto drawable becomes a slot in its batch's matrix list, and each pass's source holds what the pass
  draws. That is the per-pass machinery thin batches already have: `beginPasses`/`add`/`endPasses`, per-cascade
  compaction through `expand`, and the fade buffer for crossfades. Shadow casting stays per renderer: an auto
  drawable that doesn't cast is left out of the casters pass. That differs from thin, where casting is part of the
  batch key.
- **Culling:** the visibility stage's per-view `hidden` bits (and 0447's occlusion later) do it. Pass sources aren't
  culled again by Babylon, as thin pass sources aren't now.
- **Unchanged:** batch keys, the material's `instancing` field, `off`, thin, `LODGroup`, the sidecar and every public
  API. `RenderStats` and the variant report still count each pass source's draw.

## Alternatives considered

- **Keep tuning the `InstancedMesh` path.** That's the work so far: dead instances, frame-counted pools, instance
  recycling, pass-wide reference lookups. City static now meets the target. Forest fly is still about 2×, and the rest
  is Babylon's cost per instance, which tuning can't remove.
- **Freeze Babylon's active meshes, or use `doNotSyncBoundingInfo`/`alwaysSelectAsActiveMesh` on instances.** These
  trim some per-instance work but keep one object per renderer per level, and freezing conflicts with per-view lists
  that change every frame.
- **Make `thin` the default material setting.** Changes behaviour for scenes without `LODGroup`s (per-instance culling
  and picking in games), and the user chooses per material. Out of scope.

## Consequences

**Positive**
- The per-instance Babylon costs go away for LOD scenes, and levels switch by moving a matrix between buffers, with no
  Babylon object made or disposed.
- One application path for auto and thin under LOD: less code to keep correct (pooling, sweeping, instance recycling
  only serve the editor and scenes without LOD).

**Negative / costs**
- Game builds can't pick individual auto renderers through Babylon's scene picking while levels apply. Nothing in the
  engine's public API exposes Babylon picking. Physics raycasts (Rapier) don't depend on it, and the editor keeps
  instances.
- A renderer that moves rewrites its slot each frame it moves, as thin already does. Pass uploads are 64 bytes per
  instance per pass.
- Auto and thin then differ only without LOD and in the editor. That's a mode the tests must cover in both states.

## Deprecates

In game views with levels applied, the per-renderer `InstancedMesh` drawables of `auto` batches, with their frame
pools and instance recycling. They stay for the editor and for scenes without the visibility stage.

## Open questions

- Whether per-instance bounds (for `drawn()` shapes in the variant report) need a replacement in games: today the
  report only runs in the editor.

## References

- `docs/design/lod-occlusion/build-log.md`, "CPU against no LOD (2026-11-28)".
- `spikes/occlusion-gate/profile.mjs` (CPU profiles of the gate scenes), `spikes/lod-apply/` §3 (per-pass thin cost).
- `src/engine/render/babylon/meshBatches.ts`, `src/engine/render/babylon/meshes.ts`.
