# 0010. Engine node graph is authoritative over three.js

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0004: no three.js escape hatch)
- **Related:** 0004, 0005, 0008, 0011, 0019, 0020, 0021

## Context

Three things want to own "where things are":

1. The engine node graph and `Transform` components (0008).
2. three.js's `Object3D` tree, which has its own parent/child links, position/quaternion/scale, and matrix update logic.
3. The physics world (0005), whose bodies have positions and rotations the simulation changes every step.

If more than one is treated as the source of truth, they drift, and bugs show up as objects jittering, snapping back, or rendering one frame late.

## Decision

- **three.js is never exposed to game code.** It is wrapped entirely by engine-native code:
  - No public API returns or accepts three.js types. There is **no `Object3D` escape hatch**, which amends the escape hatch allowed in 0004.
  - Public math types (`Vector2`, `Vector3`, `Quaternion`, `Matrix4`, `Color`) are engine types. They may use three.js math internally but aren't three.js classes.
  - Custom shaders are engine **`Shader` / `Material` assets**: GLSL source plus declared uniforms and textures. The render backend builds the three.js materials. This replaces 0004's "custom shaders through `ShaderMaterial`".
  - Lighting, cameras, post-processing, UI (0020) and particles (0021) are reached only through engine components.
  - Users can't attach their own three.js objects. A feature games need means a new engine component.
- **The engine is authoritative.** Hierarchy lives in the engine's `Hierarchy` component; local position, rotation and scale live in `Transform` storage.
- **three.js is a render mirror.**
  - A node gets an `Object3D` only when it has something to draw or hear (renderer, light, camera, positional audio, particles). Logic-only nodes have no three.js object.
  - Mirrored `Object3D`s are added **flat** under one root per scene, with `matrixAutoUpdate = false`. The render-sync system copies each node's computed **world matrix** into `object3D.matrix` / `matrixWorld`. three.js never computes hierarchy for engine nodes.
  - Exception: content imported as a unit (a glTF model's internal bones and meshes) keeps its own three.js subtree under the node's `Object3D`, because three.js's animation system expects it.
- **Physics is a simulation mirror with write-back.**
  - Dynamic bodies: after each physics step, the engine reads body poses and writes them into `Transform` (world → local relative to the parent).
  - Kinematic bodies: the engine pushes `Transform` world poses to the backend before each step.
  - Static bodies: pushed when their Transform changes.
  - Teleporting a dynamic body (setting its Transform from script) is a flagged operation that resets the body pose in the backend.
- **Transform propagation** (local → world matrices) runs once per frame after `lateUpdate`, plus on demand when script reads `transform.worldPosition` on a node marked dirty.
- **Interpolation**: render sync can blend between the last two physics poses using the fixed-step remainder, so motion is smooth when render and physics rates differ (0011). Enabled per `RigidBody` (`interpolate: true`).

## Alternatives considered

- **Transform wraps `Object3D` directly** (the engine's Transform *is* an Object3D; three.js does hierarchy and matrices). Least code at first. But it ties core data to three.js, forces an `Object3D` on logic nodes, makes headless runs and tests depend on three.js, and still needs physics write-back. Rejected for coupling.
- **Mirror the full hierarchy into three.js** (nested `Object3D`s matching the node tree, `matrixAutoUpdate` on). three.js recomputes matrices the engine already has, and every reparent must be done twice. Flat mirroring avoids both.
- **Physics authoritative for bodies' nodes.** Fine for dynamic bodies (and effectively what write-back does) but awkward for kinematic and scripted motion. The per-body-type rules above cover it.

## Consequences

**Positive**
- One source of truth; core runs without three.js (tests, tooling, server).
- Logic nodes are cheap.
- Hierarchy changes touch engine storage only.

**Negative / costs**
- With no escape hatch, every rendering feature a game needs must be wrapped by the engine first. That's more engine work and slower access to new three.js features, in exchange for a stable API and freedom to change renderers later.
- Engine-internal code must remember that mirrored objects are flat (`object.parent` and `getWorldPosition` don't reflect the node graph).
- Matrix copying each frame for every rendered node (cheap; a dirty flag can skip unchanged nodes).

## Deprecates

- `Transform.createModelMatrix()` and the hierarchy/`lateUpdate` parenting logic in `src/engine/Transform.ts`.
- gl-matrix-based model matrix generation in the legacy renderer.

## Open questions

- ~~"Manual three.js" nodes with user-owned `Object3D` subtrees.~~ Resolved: no. three.js is not exposed (above).
- Whether non-uniform scale on parents is allowed (it complicates world → local write-back for rotated children).

## References

- Fix Your Timestep! (Glenn Fiedler), interpolation section.
