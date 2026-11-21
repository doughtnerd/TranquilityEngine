# 0301. One 2D node frame that keeps mirroring

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0039, 0092, 0105, 0137, 0288, 0295, 0305

## Context

A node's 2D pose (where it is, how it is turned, how it is scaled) was rebuilt in four places from two lossy reads: `Transform.worldRotation2D` (`atan2` of the matrix's first column) and `Transform.worldScale` (column lengths, so never negative). For a node scaled (-1, 1) those read "turned half a turn, not mirrored": the same matrix, but every offset placed through that pose lands upside down.

- **Physics write-back flipped bodies (confirmed).** `PhysicsCore.writeBack` wrote the body's angle through `Transform._setWorldPose2D`, which set the local rotation to π on a node whose local scale x is -1: world `R(π) · diag(-1, 1) = diag(1, -1)`. An X-mirrored dynamic body became Y-mirrored on its first awake step.
- **Shapes and anchors landed flipped.** `PhysicsWorld2D` turned a collider's `center` and polygon points by π (`colliderWorldPose`, `pointsShape`), and its `jointDesc` mixed world-matrix anchors (`pointOf`, right) with the π body rotation (`relativePose`); `core/tilemap2d.ts` read the same pose (its `mirrored` and negative-scale branches could never run, the scale being unsigned); the 2D collider and joint gizmos (`colliderGizmo.ts` `poseOf`, `jointGizmo.ts`) drew them where the runtime put them, upside down.
- No test covered a mirrored 2D node. ADR 0295 left this as its second open question, as a gizmo issue; the runtime was wrong too.

## Decision

**One engine module reads a 2D frame from a world matrix: `src/engine/scene/frame2d.ts`** (`@internal`, pure functions over plain arrays).

- **`Frame2D`**: `position` (with z), `angle` (radians), signed per-axis `scale`, and `mirrored` (the determinant is negative), such that `T(position) · R(angle) · diag(scale)` is the matrix's XY part (shear aside). `frame2DFromMatrix(m, o)`, `frame2DOf(node)` (identity without a transform), `frame2D(position, angle, scale)`.
- **The mirror rule: a mirrored frame carries its mirror on x.** Its scale x is negative, y positive, and its angle is that of its unmirrored x axis. A node scaled (-1, 1) and turned θ reads angle θ and scale (-1, 1). A node scaled (1, -1) is the same matrix as `R(π) · diag(-1, 1)` and reads so; every point still lands where the matrix puts it.
- **Points and directions**: `frameToWorld`, `frameToLocal`, `frameDirection`, `upright2D` (the same frame without its turn, for a character controller's upright capsule).
- **The inverse writes a pose back keeping the mirroring**: `localAngle2D(angle, scale, parentMatrix, localScale)` gives the local Z rotation that makes the node's frame angle `angle` while its world scale (so its mirroring) stays as it is. `Transform._setWorldPose2D` (physics write-back) and the `worldRotation2D` setter use it.

**Every 2D pose reader moves onto it.** `Transform.worldRotation2D` is the frame's angle. `PhysicsWorld2D` reads node poses, the collider scale (now signed, so the shape is rebuilt when a node's mirroring changes), the shape's centre and a slider's axis through the frame; joint anchors come from the joint class through the frame (ADR 0305). `core/tilemap2d.ts` takes the frame's pose and signed scale: a mirrored tilemap collides mirrored, its outlines keep their winding, a one-way platform's up is the node's +Y in the world and its top is whichever edge is higher along it. The collider gizmo and its shape table place 2D shapes by the frame (`Pose2D` and `colliderMath.ts` are deleted); the joint gizmo turns and mirrors 2D axes with it.

**Shape sizing keeps `engine/physics/shape2d.ts`, fed the signed scale**: sizes take its magnitude (as before), `center` and points take its sign. A character controller's upright capsule sits at `center` × signed scale, unturned.

## Alternatives considered

- **Mirror carried on y** (or "whichever axis the node's own local scale flips") — a matrix alone can't say which axis the author flipped; Unity-style 2D flips a sprite with scale x = -1, so x is the common case and the one that reads the node's own rotation back unchanged.
- **Keep `atan2` and add a signed scale beside it** — the angle and scale would still not compose back to the matrix for a mirrored node; the point of the module is that they do.
- **Decompose the full 3D matrix (`Mat4.decompose`) for 2D too** — it already negates x for a negative determinant, but it allocates a quaternion and gives back a 3D rotation that 2D code would have to turn into an angle; the 2D frame is a few multiplies.
- **Fix each reader in place** — four copies of the mirror rule is what produced the bug.

## Consequences

**Positive**
- A mirrored 2D body stays mirrored; its colliders, polygon points, joint anchors, tilemap shapes and gizmo outlines are where its world matrix puts them.
- The mirror rule lives in one module; a runtime test (`physics/mirror2d.test.ts`) pins a mirrored body's matrix through steps and every collider point to `Physics2D.raycast`, and the collider shape table's raycast property test now includes mirrored nodes.

**Negative / costs**
- `Transform.worldRotation2D` changes for mirrored nodes: a node scaled (-1, 1) reads its own turn instead of turn + π; a node scaled (1, -1) reads turn + π. Unmirrored nodes read as before.
- A mirrored tilemap collides mirrored now (it used to collide as if unmirrored).
- Shear (a turned child of a non-uniformly scaled parent) is still dropped, as before.

## Deprecates

`src/plugins/physics/editor/colliderMath.ts` (`Pose2D`, `toWorld`, `toLocal`: replaced by `Frame2D`, `frameToWorld`, `frameToLocal`); `poseOf` in `colliderGizmo.ts`; the 2D pose maths test in `colliderGizmo.test.ts` (moved to `src/engine/scene/frame2d.test.ts`); `pointOf` in `PhysicsWorld2D.ts`. Closes ADR 0295's second open question.

## Open questions

- 3D poses keep `Mat4.decompose` (with its negated-x rule) and unsigned scales in `PhysicsWorld3D`; 3D mirroring of physics shapes is not covered here.

## References

`src/engine/scene/frame2d.ts`, `src/engine/scene/Transform.ts`, `src/plugins/physics/runtime/core/PhysicsWorld2D.ts`, `core/tilemap2d.ts`, `src/plugins/physics/editor/colliderGizmo.ts`, `colliderShapes.ts`, `jointGizmo.ts`. Tests: `src/plugins/physics/mirror2d.test.ts`, `src/engine/scene/frame2d.test.ts`, `src/plugins/physics/editor/colliderShapes.test.ts`, `jointGizmo.test.ts`.
