# 0045. 3D physics on Rapier 3D, loaded on demand, with the 2D API's shape

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0011, 0014, 0017, 0032, 0039, 0043, 0044

## Context

ADR 0005 chose Rapier for v1 physics (`@dimforge/rapier2d-compat` and `@dimforge/rapier3d-compat`), named the 3D components (`RigidBody`, `BoxCollider`, `SphereCollider`, `CapsuleCollider`, `MeshCollider`) and kept PhysX as a later 3D upgrade behind the same component API. Only 2D was built (`Physics2DWorld`). 0014 makes the physics dimension a scene setting (`"physics": "2d" | "3d" | "none"`); until now a `"3d"` scene loaded with a warning and no physics.

## Decision

- **New dependency: `@dimforge/rapier3d-compat`** (0.21, the same release as the 2D package; its WASM is embedded). It is **loaded on demand**: `ensurePhysics3D` imports the backend module (`physics/Physics3DWorld.ts`) the first time a World needs 3D physics, so games without it never download Rapier 3D. The engine library keeps `@dimforge/*` external (0015).
- **Components** (public, `src/engine/index.ts`), mirroring the 2D ones field for field:
  - `RigidBody` (`engine.RigidBody`): `bodyType`, `mass`, `useGravity`, `gravityScale`, `drag`, `angularDrag`, `constraints` (`freezePosition` and `freezeRotation` per axis), `collisionDetection`, `interpolate` (reserved); `velocity` (a live `Vector3`), `angularVelocity` (degrees per second around each axis, 0019), `addForce`, `addTorque` (force or impulse).
  - `Collider` base with `center` (`Vector3`), `isTrigger`, `layer`, `material` (friction, bounciness) and `attachedRigidbody`; `BoxCollider` (`size`), `SphereCollider` (`radius`), `CapsuleCollider` (`radius`, `height` with the caps included, as in Unity, and `direction` `x | y | z`), `MeshCollider` (`mesh`, a mesh reference (0044) or empty for the node's MeshRenderer's; `convex` for the convex hull, which dynamic bodies need).
  - `Physics` facade: `gravity` and `raycast(origin, direction, maxDistance, layers)` → `RaycastHit`.
  - `Collision` (passed to `onCollisionEnter/Exit`), and the `CollisionEvents` / `TriggerEvents` buffers of `PhysicsEvent` for systems (0017).
- **Same behaviour as 2D:** the same sync rules (0010: dynamic bodies write back, kinematic bodies follow their Transform, static colliders follow when moved), the same layers and collision matrix (shared code), colliders on child nodes join their ancestor's body, and the same hooks: `onCollisionEnter/Exit` and `onTriggerEnter/Exit` on the collider's node, owner and body node. Their parameter types widen to `Collision2D | Collision` and `Collider2D | Collider`; a World uses one or the other.
- **Sizing** follows the node's world scale like 2D: boxes per axis, spheres by the largest axis, capsules by the largest axis across them and the scale along them, mesh vertices per axis. The rules live in one place (`physics/shape3d.ts`), shared with the editor's gizmos.
- **Gravity:** `physics.gravity` in `project.json` may have a third number, z; 3D uses `[x, y, z ?? 0]`, 2D ignores z. The Project panel shows the z field.
- **Starting it:** a scene with `"physics": "3d"` starts 3D physics, and so does a scene that **doesn't say** but contains a 3D body or collider (in it or its prefabs), so a 3D scene works without editing its settings. New Empty 3D projects write `"3d"`.
- **Systems:** `engine.Physics3DPush`, `Physics3DStep`, `Physics3DWriteBack` and `Physics3DEvents` run in the fixed step after the 2D ones (0011), in every World, doing nothing without a 3D physics world (0032).
- **Editor gizmos:** every 3D collider is drawn as a green wireframe (mesh colliders by their triangle edges, or their bounds above 2000 triangles); with Edit Collider on, box colliders get a handle per face (Alt: symmetric), spheres six radius handles, capsules four radius and two height handles, and all a centre handle that moves `center` across the plane facing the camera. Handles drag along their axis to the point nearest the pointer's ray, and each drag is one undo step, as for 2D (0039).

## Alternatives considered

- **PhysX now** (0005's planned 3D upgrade). Unity-exact behaviour, but a second integration style (manual memory management) and a heavier download for a first 3D release; the component API is designed so it can replace Rapier 3D later.
- **Load Rapier 3D eagerly, like 2D.** Simpler, but every game would carry another ~2 MB for physics it may not use.
- **Separate hook names for 3D** (`onCollisionEnter3D`). Unity does the opposite (the 2D hooks carry the suffix); renaming the existing 2D hooks would break games, and a World never mixes the two, so one set of names with wider types is simpler.
- **Requiring `"physics": "3d"` in every 3D scene.** Strictly per 0014, but a scene whose colliders silently do nothing is a trap; detecting 3D components when the setting is absent costs one scan at load.

## Consequences

**Positive**
- 3D games get bodies, colliders, triggers, events and raycasts with the same API shape as 2D.
- Games without 3D physics don't pay for it.
- Collider gizmos and physics always agree on sizes.

**Negative / costs**
- A second Rapier build to keep in step with the 2D one.
- Exact (concave) mesh colliders on dynamic bodies only collide with primitive shapes (warned).
- The same gaps as 2D: no joints, `CharacterController`, interpolation, `Stay` events, shape casts or overlap queries, and child colliders don't follow their node if it moves relative to its body.

## Deprecates

The load-time warning "3D physics is not implemented yet" for `"physics": "3d"` scenes.

## Open questions

- `CharacterController` (0005) on Rapier's kinematic character controller.
- Joints, shape casts and overlap queries for both dimensions.
- Whether a 2D scene with 3D colliders (or the reverse) should be an error, as 0014 says, or a warning.

## References

- Rapier JavaScript: https://rapier.rs/docs/user_guides/javascript/getting_started_js
- ADR 0005 (backend choice and component names), 0039 (collider editing).
