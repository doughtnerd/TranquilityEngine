# 0295. Zone and occluder gizmos share the 3D shape kit with the collider gizmo

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0045, 0133, 0147, 0162, 0231, 0257, 0266, 0284, 0288

## Context

ADR 0288 folded the collider gizmo's wireframes, handles and drags into one collider shape table in the Physics plugin's editor half (`colliderShapes.ts`), with pose maths in `collider3dMath.ts` and the loop in `colliderGizmo.ts`. The Audio plugin's two 3D gizmos kept a copy of each piece:

- **The reverb zone gizmo** (`zoneMath.ts`, `AudioReverbZoneGizmo.ts`): `dragZoneFace` was `box3D.press` line for line; `rotate`, `axesOf` and `closestOnAxis` were copies of `collider3dMath`; `zonePoseOf` was `pose3DOf`; `startZoneDrag` was `drag3D`'s press-ray-to-reach loop.
- **The zone outline matched the runtime's zone volume only by a comment.** `zoneGeometry` re-derived what `zoneVolumeFromMatrix` (`runtime/core/zoneWeights.ts`, the zone manager's sizing) computes from the world matrix, "sized exactly as" it.
- **The occluder gizmo** (`AudioOccluderGizmo.ts`) sized colliders with its own switch on collider type ids and its own mesh bounds, through the zone geometry. The sizes had drifted: it clamped a negative size to 0 (a negative-size BoxCollider was outlined flat) while `engine/physics/shape3d.ts`, which the physics world builds with, takes the magnitude. It drew a capsule as its bounding box and turned a character controller's capsule with the node, which the backend doesn't.

The plugin import rules (ADR 0133, `plugins/plugins.test.ts`) forbid the Audio plugin importing the Physics plugin's editor half, and its manifest doesn't depend on Physics, so even a value import of the physics runtime is out.

Building this also showed that both gizmos' `pose3DOf` read a mirrored node's pose inconsistently: `worldRotation` decomposes a negative-determinant matrix with a negated x scale, `worldScale` gives column lengths only, so T·R·S of the pose wasn't the node's matrix and a mirrored node's shapes were drawn turned wrong.

## Decision

**One 3D shape kit in the editor** (`src/editor/shapeKit3d.ts`), offered to plugins through the SDK as the namespace `shapeKit3d` (`myco/editor`, ADR 0147). It holds what every 3D handle gizmo shares, as pure functions over plain arrays:

- **pose maths**: `rotate`, `axesOf`, `worldCenter`, `centerDelta`, `closestOnAxis`, `poseMatrix` (the pose as the engine's column-major T·R·S), and `pose3DOf(node)`, whose T·R·S is the node's world matrix (a mirrored node gets a negative x scale, as `worldRotation` assumes);
- **wireframes**: `Volume3D` (an oriented box or a sphere) with `volumeWire` and `shellWire` (the blend shell `d` outside it), `sizedShapeWire` (a shape as `shapeSize3D` sizes it: box, sphere, capsule), `meshWire`/`meshSignature` (triangle edges, or the bounding box above 2000 triangles);
- **handle rules**: `faceHandles`/`facePress` (a box face: the opposite face stays, Alt moves both, never below `MIN_EXTENT`), `radiusHandles`/`radiusPress` (over the largest scale axis), `blendAxis`/`blendHandle`/`blendPress` (the blend-shell handle on the +x/+y diagonal);
- **entries and the drag**: `HandleShape3D<F>` (wire, handles, optional handle axis, press → `(reach, alt) => FieldPatch`), `resizeAxis`, and `axisDrag(shape, fields, pose, handle, pressRay)` → a function from a later pointer ray to the patch, the handle following the point on its axis nearest the ray from where the press was. Also `MIN_EXTENT` and `tidy` (4 decimals, as gizmos write fields).

**Physics keeps its collider shape table on the kit.** `ColliderShape3D` extends `HandleShape3D`; the box, sphere, capsule and mesh entries draw with `sizedShapeWire`/`meshWire` and take their face and radius rules from the kit; the gizmo's 3D drag is `axisDrag`. `collider3dMath.ts` is deleted.

**Audio gets a zone shape table** (`plugins/audio/editor/zoneShapes.ts`, replacing `zoneMath.ts`): a box zone and a sphere zone entry (`ZONE_SHAPES`, `zoneShapeFor(shape)`), each a `HandleShape3D` over the zone's fields plus `volume` and `shell`; both carry the blend-shell handle. The zone gizmo is a loop over it, writing patches through the component field write (ADR 0257) tidied, as the collider gizmo does.

**Zone outlines and the runtime share one pose-to-volume function**: `zoneVolumeFromMatrix`. The zone manager calls it with the node's world matrix; a zone entry calls it with `poseMatrix(pose)`, and draws the volume it returns (centre, half extents, radius) along the node's turned axes (the volume's box rows up to sign). **Zones size a negative size or radius by its magnitude**, as `shape3d` sizes colliders (it was clamped to 0).

**The occluder tool reads colliders through the collider table, over an SDK seam**: a new contribution point, `registerComponentWireframe({ id, types, wire(component) })` (registry `componentWireframes`, lookup `componentWireframe(component)` by Component type id). The Physics plugin's editor half registers `colliderWireframes`: the 3D colliders' wireframes from its table, the same (cached) ones its collider tool draws. The occluder tool draws `componentWireframe(collider)`, so a capsule is a capsule, a mesh its triangles, a character controller upright, a negative size its magnitude: the simulated shape. With the Physics plugin off nothing is drawn, as occlusion is then inert anyway.

## Alternatives considered

- **Audio imports the collider table directly** — the import rules forbid reaching another plugin's editor half, and a value import of the physics runtime would make Audio depend on Physics.
- **An engine-level collider reader in `shape3d.ts`** (type id + field values → shape fields, as `engine/nav/geometry.ts` reads colliders) — a fourth copy of the field-to-shape mapping (backend, gizmo table, navigation), and the occluder would still draw its own wireframes; the SDK seam reuses the table itself.
- **A `_shapeFields()` member on the Collider Components** — puts an editor need in runtime classes shipped in every game; the Physics runtime is outside this change.
- **The kit as plain named SDK exports** — names like `rotate` and `circle` are too generic beside the SDK's other exports; one namespace keeps them together.
- **Zones keep "negative counts as 0"** — the editor would then size colliders and zones by two rules; one rule (the magnitude) is what users meet everywhere.

## Consequences

**Positive**
- A drag or pose bug in a 3D gizmo is fixed once; a new zone or collider shape is one table entry.
- Zone entries get the collider entries' property tests ("dragging any handle to where it is leaves the volume and the shell unchanged", random fields and poses, mirrored scales included), and "every outline point is on the volume `zoneVolumeFromMatrix` builds from a real node's world matrix".
- The occluder outline is the physics shape; the negative-size and upright-character drifts are gone.
- A mirrored node's colliders and zones are drawn where they are.

**Negative / costs**
- One more contribution point and one more SDK namespace (experimental until v1, as the SDK is).
- A zone typed with a negative size now covers its magnitude instead of nothing (a behaviour change for such scenes).
- The occluder tool draws nothing for a collider type no plugin offers a wireframe for.

## Deprecates

`src/plugins/physics/editor/collider3dMath.ts` (moved into the kit), `resizeAxis` from `colliderShapes.ts` (the kit's), `MIN_EXTENT` and `tidy` from `colliderMath.ts` (the kit's), `pose3DOf` from `colliderGizmo.ts` (the kit's); `src/plugins/audio/editor/zoneMath.ts` and `zoneMath.test.ts` (replaced by `zoneShapes.ts` and its test); `zonePoseOf`, `geometryOf`, `zoneHandles` from `AudioReverbZoneGizmo.ts`; `colliderVolume` and `meshBounds` from `AudioOccluderGizmo.ts`. The pose-maths tests of `collider3d.test.ts` moved to `src/editor/shapeKit3d.test.ts`.

## Open questions

- `PhysicsWorld3D.colliderShape` and `engine/nav/geometry.ts` still each map collider fields to shapes; they could read the collider table's fields through one engine-level description later (navigation is being ported).
- 2D poses (`colliderMath.ts`) still read `worldScale`, so a mirrored 2D node has the same inconsistency; 2D mirroring turns differently in the 2D world (ADR 0288's tests note it) and is left for its own change.

## References

`src/editor/shapeKit3d.ts`, `src/editor/sdk/contributions.ts` (`ComponentWireframeContribution`, `componentWireframes`, `componentWireframe`), `src/editor/sdk/plugins.ts` (`registerComponentWireframe`); `src/plugins/physics/editor/colliderShapes.ts`, `colliderGizmo.ts` (`colliderWireframes`), `index.ts`; `src/plugins/audio/editor/zoneShapes.ts`, `AudioReverbZoneGizmo.ts`, `AudioOccluderGizmo.ts`; `src/plugins/audio/runtime/core/zoneWeights.ts`. Tests: `src/editor/shapeKit3d.test.ts`, `audio/editor/zoneShapes.test.ts`, `AudioReverbZoneGizmo.test.ts`, `audioInspectors.test.ts` (occluder gizmo), `physics/editor/colliderShapes.test.ts`, `collider3d.test.ts`, `runtime/core/zoneWeights.test.ts`.
