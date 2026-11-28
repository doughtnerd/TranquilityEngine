# Mesh LOD and occlusion culling: goal and constraints

Written 2026-11-28 from the owner's brief; the record numbers come later (0445, 0459 proposed).

## Goal (owner's words, condensed)

Cut the triangles and draw calls Myco's 3D scenes spend on distant and hidden objects, with as little work for a
solo developer as possible: **LOD levels generated at import**, a Unity-style **`LODGroup`**, optional **dithered
crossfade**, and **CPU software occlusion culling** in Rust/wasm SIMD. Editor support: LOD bar, level preview,
generation settings, occlusion debug view.

## Constraints

- Babylon 9.32 is the only renderer (0075, 0081); no Babylon, three.js, Rapier or Howler types in the public API (0010).
- Level choice is the engine's, renderer-neutral and per camera (shadow cascades, probes, editor views included), not
  Babylon's `addLODLevel`; it must work with thin-instance batches (0108) and be unit-testable.
- Occlusion core: a new Rust crate/workspace beside `native/anim/` (not `native/nav/`, frozen). simd128 like 0370.
- New dependencies (meshoptimizer) need a record. No test-only hooks. Editor CSS uses theme tokens.
- Every record carries a "Path to a high-end pipeline" section: how this CPU work hands over to GPU-driven culling
  and Hi-Z later (HDRP-class rendering; the brief calls this O24, which does not exist yet on master, see below).
- Out of v1: authored LOD import (`MSFT_lod`, `_LOD0` names), baked PVS, GPU Hi-Z.

## Platforms and low end

- Editor: browser (Chromium) and Tauri desktop. Games: web player, desktop (Tauri), Android export (0155).
- Low end: ADR 0169's floor, an emulated Pixel 8 (Android 14, Chrome 113, 4 cores, 2 GB). Not runnable in this
  container (no KVM): runners are provided for the owner's emulator; 4x CPU throttling is used as a labelled estimate.
- Chrome 113 has wasm SIMD (the animation core already requires it).

## Today (read from the code on master 6a0740ca)

- Culling: Babylon frustum culling only (`FrameGraphCullObjectsTask`, `render/babylon/frameGraph.ts:596`); shadow
  casters culled per cascade (`render/babylon/shadowCulling.ts`). No LOD, no occlusion.
- No engine-side world bounds per renderer; bounds come from Babylon meshes. `MeshData` has no stored bounds.
- `RenderStats.triangles` is always 0 (`BabylonRenderer.ts:826`); draw calls are real.
- `.mycomesh` is version 4 (`scene/bakedModel.ts:41`); a version mismatch falls back to loading the source file.
- Quality tiers: `QualityTier` in `core/graphics.ts:81`; automatic quality steps whole tiers only (`render/autoQuality.ts`).
- Animator rig LOD: `lodMetric` off/distance/screenSize, `lodEvery2 = 20`, `lodEvery4 = 40`
  (`plugins/animation/runtime/components/Animator.ts:79-93`), computed in `features/playback/view.ts:142`.

## Who uses it today

No shipped games and no outside users: only the samples. No compatibility flags or migrations are needed beyond
the `.mycomesh` version bump (which already falls back cleanly).

## Open question O24

The brief cites open question O24 (HDRP-class rendering, GPU-driven culling). `docs/architecture/open-questions.md`
on master ends at O23; the nearest text is ADR 0399's "path to HDRP-class" constraint. These records propose adding
O24 to open-questions.md.
