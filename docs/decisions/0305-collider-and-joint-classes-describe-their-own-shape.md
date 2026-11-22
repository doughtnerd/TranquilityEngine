# 0305. Collider and joint classes describe their own shape

- **Status:** Accepted, amended by 0345 (ball joints describe their swing and twist limits and drive)
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0039, 0045, 0092, 0105, 0137, 0288, 0295, 0301

## Context

A collider's fields were read for its shape three times, and a joint's kind and anchor rule four times:

- **Colliders**: `PhysicsWorld2D.colliderShape` and `PhysicsWorld3D.colliderShape` were `instanceof` chains turning each class's fields into `ShapeFields2D`/`3D`; each class also hand-wrote a `_shapeSignature()` string (`Collider2D.ts`, `Collider.ts`, both character controllers, the tilemap collider) that had to change whenever its fields did; and the editor's collider shape table (`colliderShapes.ts`) read the same fields itself in every entry's `read`. `colliderWorldPose` asked `instanceof CharacterController` for "upright" and `instanceof CapsuleCollider` for the capsule's turn. A new collider type touched the class, its signature, the world's chain and the table.
- **Joints**: `PhysicsWorld2D/3D.jointDesc` and the joint gizmo (`jointGizmo.ts` `kindOf2D/3D`) each dispatched on the class with `instanceof`, and each wrote the connected-anchor rule (auto, connected node or world, ropes and springs from the connected body's origin). The gizmo took anchors to world space through its own pose (`poseOf`, `pose3DOf`), the runtime through the world matrix, and the gizmo drew an unknown joint as `fixed` where the runtime threw.

ADR 0295 left the first copy (`PhysicsWorld3D.colliderShape` beside the table) as its first open question, and rejected a `_shapeFields()` member then because the Physics runtime was outside that change.

## Decision

**Each runtime collider class gives its backend-neutral shape fields: `_shapeFields()`** (`@internal`).

- 2D: `ShapeFields2D` (`engine/physics/shape2d.ts`) is a sized shape (`SizedShapeFields2D`: box, circle, capsule) or `polygon`/`edge` with its `points`, or `source` (the shapes a 2D shape source on the node offers, ADR 0136, merged as `merge`: the tilemap collider). 3D: `ShapeFields3D` (`shape3d.ts`) is a sized shape (`SizedShapeFields3D`: box, sphere, capsule with its `axis` index and optional `upright`) or `mesh` (`mesh` reference, `convex`). `shapeSize2D`/`shapeSize3D` take the sized parts.
- **The rebuild signature is derived**: `shapeSignature(fields)` (`shape2d.ts`, a JSON string). `_shapeSignature()` is deleted from every class and from the core's collider interface.
- **The worlds switch on `fields.kind`**: `colliderShape`, the mesh source, `meshShape` (`convex`), and `colliderWorldPose` (an upright capsule doesn't turn; a capsule turns onto its `axis`) read the fields; the 3D collider `instanceof` chain is gone. The tilemap collider stays the 2D world's special case for its own state (`_tileState`), as before.
- **The collider shape table reads only fields**: an entry's fields are the class's `_shapeFields()` of its kind plus `center` (`read2D(kind)`, `read3D(kind)`); a polygon or edge entry cleans the points, a mesh entry loads the mesh named by its fields. Entries keep their outlines, handles and drags. 3D wireframe signatures are `shapeSignature`.

**Each joint class gives its kind, its own fields and its anchors in world space.**

- `jointKind` (public getter, type `JointKind` = `fixed | hinge | slider | ball | rope | spring`, `engine/physics/types.ts`, exported from `myco`).
- `_jointFields()` (`@internal`): `JointFields2D`/`JointFields3D`, the kind with what builds it (a hinge's or slider's axis in local space and limits while on; a rope's or spring's length, null for "the anchors' distance when made"; a spring's stiffness and damping).
- `_worldAnchors()` (`@internal`): the anchor and the connected anchor in world space now, one rule: `anchor` in the node's space; `connectedAnchor` in the connected node's space (world space with none); with `autoConfigureConnectedAnchor` the same point, except that a rope or spring (`isDistanceJoint`) measures from the connected body's origin. 2D goes through the node's 2D frame (ADR 0301), 3D through the world matrix.
- `PhysicsWorld2D/3D.jointDesc` switch on the fields' kind and take the anchors from `_worldAnchors`; the joint gizmo draws `jointKind`, `_worldAnchors` and the fields' axis and limits. There is no fallback kind: a joint class must say what it is, so the gizmo and the runtime can't disagree. Live settings (motor, spring, ball limits) stay with the axis and ball joint classes, and the hand-written `_jointSignature` stays (a limit change is applied live, not rebuilt).

No physics engine type appears in any of it (ADR 0010).

## Alternatives considered

- **An engine-level reader from type id and field values** (as `engine/nav/geometry.ts` reads colliders) — a fourth copy of the mapping, and it can't see a third-party collider class; the class owning its description is the one place that changes with its fields.
- **The table stays the description** (ADR 0295's choice) — the runtime can't import the editor table, so the runtime chain would stay.
- **Derive the joint signature from `_jointFields`** — limits and spring settings are applied to a live joint; rebuilding on them would reset the rest angle a hinge's limits count from.
- **Keep a `fixed` fallback in the gizmo** — it drew something the runtime doesn't build.

## Consequences

**Positive**
- A new collider or joint type is its class (fields, kind, signature for free) plus, for an editable collider, one table entry.
- The gizmo and the runtime share the anchor rule and the world mapping, so a joint is drawn where it is built, mirrored 2D nodes included.

**Negative / costs**
- Runtime classes carry `_shapeFields`/`_jointFields`/`_worldAnchors` (small, internal); `jointKind` is new public API.
- The gizmo draws an auto-anchored rope or spring to its connected body's origin (as the runtime builds it), not the connected node's, when that node sits below its body.

## Deprecates

`_shapeSignature()` on every collider class and on the core's `ColliderComponent`; the `instanceof` chains in `PhysicsWorld2D.colliderShape`/`jointDesc`, `PhysicsWorld3D.colliderShape`/`colliderWorldPose`/`jointDesc`; `kindOf2D`/`kindOf3D` and the anchor code in `jointGizmo.ts`; the field reads in `colliderShapes.ts` entries (`capsuleAxes` now takes the axis index). Closes ADR 0295's first open question for the physics world; navigation's own collider reading (`engine/nav/geometry.ts`) is left as it is while navigation is being ported.

## Open questions

- `engine/nav/geometry.ts` still maps collider fields to shapes by type id; it could read `_shapeFields()` once the navigation port settles.

## References

`src/engine/physics/shape2d.ts`, `shape3d.ts`, `types.ts`; `src/plugins/physics/runtime/Collider2D.ts`, `Collider.ts`, `CharacterController2D.ts`, `CharacterController.ts`, `TilemapCollider2D.ts`, `Joint2D.ts`, `Joint.ts`, `core/PhysicsWorld2D.ts`, `core/PhysicsWorld3D.ts`, `core/PhysicsCore.ts`; `src/plugins/physics/editor/colliderShapes.ts`, `jointGizmo.ts`, `jointMath.ts`. Tests: `physics/editor/colliderShapes.test.ts`, `jointGizmo.test.ts`, `physics/mirror2d.test.ts`, `engine/tests/physics*.test.ts`, `polygonCollider.test.ts`.
