# 0288. One collider shape table for the gizmo, and 2D sizing shared with the backend

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0022, 0039, 0045, 0142, 0257, 0283

## Context

What each collider shape is, and how its handles change it, was spread over the Physics plugin:

- **The collider gizmo** (`editor/colliderGizmo.ts`) dispatched on the collider's class at seven points (2D outlines, 3D wireframes and their cache key, 3D handles, 2D handles, 2D drags, 3D drags): 34 `instanceof` checks. A new collider type meant about seven edits there, plus outline, handle and drag functions in `colliderMath.ts` or `collider3dMath.ts`.
- **3D sizing** was shared through `engine/physics/shape3d.ts`, but **2D sizing was written twice**: in the 2D physics world (`PhysicsWorld2D.colliderShape`) and in the gizmo maths (`worldRadius`, `capsule2DSize`). They differed: the world clamped a character controller's capsule radius to at least 1e-4, the gizmo didn't. The 3D world also clamped every size to 1e-4 after calling `shape3d`, which the gizmo didn't.
- **Dragging a handle back to a field value** worked the scale rules out a third time, in per-shape `drag*` functions exported from the maths files and tested one by one.

## Decision

**Sizing is described once per dimension, beside each other in core** (no physics engine types, ADR 0010):

- `engine/physics/shape2d.ts` (new): `shapeSize2D(fields, scale)` takes a sized 2D collider's fields (`box` size, `circle` radius, upright `capsule` radius and height) and gives the shape as the backend builds it (half extents, radius, radius and half straight part), and `scaledCenter2D`.
- `engine/physics/shape3d.ts` gains `shapeSize3D(fields, scale)` (box, sphere, capsule along an axis) over its existing helpers, and `MIN_SHAPE_SIZE` (1e-4).
- **Both apply the same floor**: every world size is at least `MIN_SHAPE_SIZE` (a capsule's straight part may be zero). The 2D world now floors box half extents and circle radii too, as the 3D world always did; the gizmo draws the floored size, so it and the backend agree for every input.
- `PhysicsWorld2D.colliderShape` and `PhysicsWorld3D.colliderShape` read a collider's fields and call these; their own scale arithmetic and literal clamps are gone. The raw `shape3d` helpers stay for navigation's geometry, unchanged.

**The editor has one table entry per collider type** (`editor/colliderShapes.ts`, `COLLIDER_SHAPES`). An entry gives its Component type and class, whether its pose ignores rotation (character controllers), Edit Collider's tooltip when it differs, and over **plain field values in local units** (`read(collider)` gives them; a mesh still loading gives none):

- 2D: `outline` (world points, open or closed), `handles` (by id), `press(fields, pose, handle, {ctrl})` → a drag (an optional `start` patch, then `drag(localPoint, alt, snap)` → patch), a one-step edit (Ctrl+click removing a vertex), or a refusal with its message;
- 3D: `signature` (for the wireframe cache), `wire`, `handles`, an optional `handleAxis`, and `press(fields, pose, handle)` → `(reach, alt) => patch`, `reach` being how far out along its axis the handle now is.

A patch is field name → value, written through the component field write (ADR 0257) and tidied by the loop. Sizes come from `shape2d`/`shape3d`, so an outline is the simulated shape by construction. **The gizmo is a loop over the table**: outlines, wireframes, handles, the centre handle (the same for every type), and turning pointer moves into the entry's patches. `EDITABLE_COLLIDERS` and the `EditingCollider` type union are derived from it.

`colliderMath.ts` and `collider3dMath.ts` keep only pose maths (local ↔ world, quaternion turns, world centre, ray-to-axis, centre deltas). The per-shape outline, handle and `drag*` functions moved into the entries; none is exported for tests.

## Alternatives considered

- **Shape methods on the Collider Components** (`_outline()`, `_handles()`) — puts editor geometry in runtime classes shipped in every game, and handle ids and field patches are editor vocabulary.
- **Keep per-shape functions and a table of references to them** — keeps the exports the table makes pointless and the tests per function; the property tests over entries cover them all at once.
- **Floor sizes inside the existing `shape3d` helpers** — navigation's geometry calls them, and its outputs would change for degenerate colliders; `shapeSize3D` adds the floor beside them instead.

## Consequences

**Positive**
- A new collider type is one table entry; the gizmo, Edit Collider's types and its tooltip follow.
- The 2D capsule radius, and every degenerate size, is drawn as the backend builds it.
- Tests are per entry and generic: "dragging any handle to where it is leaves the shape unchanged" over random fields and poses (mirrored scales included), and "a ray towards each handle hits the collider there", against the real Rapier worlds through `Physics2D.raycast`/`Physics.raycast`.
- The "A edge collider needs at least 2 points" message reads "An edge collider…".

**Negative / costs**
- A 2D box or circle sized at zero now collides as a 1e-4 speck instead of a zero-sized shape (the 3D rule).
- The table's entries are typed with `any` fields where they are held together; each entry's fields come only from its own `read`.

## Deprecates

`dragBoxEdge`, `dragCircleRadius`, `dragCapsule2DRadius`, `dragCapsule2DHeight`, `boxCorners`, `boxHandles`, `circlePoints`, `circleHandles`, `capsule2DPoints`, `capsule2DHandles`, `pointsOutline`, `pointsHandles`, `pointsHandle`, `movePoint`, `insertPoint`, `removePoint`, `readPoints` and the `pointInPolygon`/`polygonArea` re-export from `colliderMath.ts` (and its internal-tier exemption in `plugins.test.ts`); `boxWire`, `boxHandles3D`, `dragBoxFace3D`, `sphereWire`, `sphereHandles3D`, `dragSphereRadius`, `capsuleWire`, `capsuleHandles3D`, `capsuleHandleAxis`, `dragCapsuleRadius`, `dragCapsuleHeight`, `meshOutline`, `meshWire`, `MESH_WIRE_TRIANGLES` from `collider3dMath.ts` (removed; their rules are the table's entries). `colliderMath.test.ts` (folded into `colliderShapes.test.ts`).

## Open questions

None.

## References

`src/engine/physics/shape2d.ts`, `shape3d.ts`; `src/plugins/physics/runtime/core/PhysicsWorld2D.ts`, `PhysicsWorld3D.ts`; `src/plugins/physics/editor/colliderShapes.ts`, `colliderGizmo.ts`, `colliderMath.ts`, `collider3dMath.ts`; tests `editor/colliderShapes.test.ts`, `colliderTool.test.ts`, `colliderGizmo.test.ts`, `collider3d.test.ts`.
