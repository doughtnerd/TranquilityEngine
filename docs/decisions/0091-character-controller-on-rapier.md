# 0091. CharacterController and CharacterController2D are colliders driven by Rapier's kinematic character controller

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0019, 0045, 0093

## Context

ADR 0005 (point 7) names an engine-level `CharacterController` with a Unity-like API (`move(delta)`, `isGrounded`, `slopeLimit`, `stepOffset`, `skinWidth`) on each backend's native controller. Neither dimension had one; games moved kinematic bodies by hand. The owner keeps Rapier for 3D (no PhysX migration), so Rapier's `KinematicCharacterController` (in both `rapier2d-compat` and `rapier3d-compat` 0.21) is the controller for both.

## Decision

- **Components:** `CharacterController` (`engine.CharacterController`, extends `Collider`) and `CharacterController2D` (`engine.CharacterController2D`, extends `Collider2D`), public in `src/engine/index.ts`. Being colliders (as in Unity) means raycasts and shape casts hit them, triggers report them, and the collider gizmo, layers and `center` work unchanged.
- **Fields:** `radius`, `height` (caps included), `slopeLimit` (degrees, default 45), `stepOffset` (units, 0.3; 0 = no stepping), `skinWidth` (Rapier's offset, 0.02), `snapToGround` (units, 0.2; 0 = off), `pushBodies` (default on), `mass` (used when pushing). Inherited `center` and `layer`; `isTrigger` and `material` are ignored.
- **Shape:** an upright capsule that never turns with its node (Unity's behaviour), at the node's position + `center` × world scale.
- **API:** `move(motion)` moves the node at once, sliding along obstacles, climbing slopes and steps, snapping to ground; returns `CollisionFlags { below, sides, above }`. `simpleMove(speed)` walks for one frame and applies the World's gravity. `isGrounded`, `collisionFlags`, `velocity` (last move ÷ `deltaTime`). Each collider hit calls `onControllerColliderHit(hit: ControllerColliderHit)` on the node's (and owner's) behaviors: `collider`, `gameObject`, `rigidbody`, `point`, `normal`, `moveDirection`, `moveLength`. Gravity is otherwise the game's to add, as in Unity.
- **Backend:** each controller's collider sits on its own kinematic position-based body owned by the backend (a parentless collider is static, and Rapier's broad phase never pairs two statics, so it would miss static triggers). `move` sets the body's translation directly, propagates it to the collider, runs `computeColliderMovement` (sensors excluded, the controller's layer as the filter) and writes the result to the Transform. Settings are pushed to Rapier only when they change. A controller ignores RigidBodies on its node or above it (`attachedRigidbody` is always null). Before the physics world has created it (the first fixed step), `move` moves the node unobstructed.
- **Collision types:** controller colliders enable every Rapier collision type, so they meet static triggers, kinematic platforms and other controllers; `onCollisionEnter/Stay/Exit` also fire between a controller and solid colliders it touches.
- **Moving platforms:** `moveWithPlatforms` (default on). Before each step, a grounded controller casts its capsule a little way down; if it stands on a kinematic or dynamic body, the body's pose is noted, and after the step the controller is moved (with `move`'s sliding, so walls still stop it) by how far the point under it moved and turned with the body. Rapier's controller would otherwise drag the character by the ground's motion over one timestep inside every `computeColliderMovement` call, which depends on how often `move` is called and does nothing while the character stands still; the backend runs that call with a near-zero timestep to cancel it, and, when `pushBodies` is on, a second call at the real timestep only to apply the push impulses (which scale with the timestep).
- **Starting 3D physics:** `engine.CharacterController` is in `PHYSICS_3D_TYPES`.

## Alternatives considered

- **A component that drives a kinematic RigidBody** (Godot's `CharacterBody`). Needs two components for one job and gives a less Unity-like API; the collider approach keeps one component.
- **A parentless collider moved with `setTranslation`.** Simpler, but static–static pairs aren't detected, so it never entered static triggers (found by the tests).
- **Our own sweep-and-slide on shape casts.** Rapier's controller already handles slopes, steps, snapping and pushing.

## Consequences

**Positive**
- Platformers and first/third-person games get a working controller in 2D and 3D with the same API.
- Raycasts, triggers, layers and gizmos treat controllers as colliders.

**Negative / costs**
- One hidden kinematic body per controller; with `pushBodies`, two controller passes per `move`.
- Platforms carry position only: a turning platform moves the controller round with it but doesn't turn the node.
- `velocity` divides by the frame's `deltaTime`, so it is wrong when `move` runs several times per frame (say, in `fixedUpdate` with several steps).
- `onCollisionEnter/Exit` between a controller and walls is noisier than Unity's (which only calls `OnControllerColliderHit`).

## Deprecates

Nothing.

## Open questions

- Netcode prediction of controllers (0033).

## References

- `src/engine/physics/CharacterController.ts`, `CharacterController2D.ts`, `Physics3DWorld.ts` / `Physics2DWorld.ts` (`moveCharacter`); tests `src/engine/tests/characterController.test.ts`.
- Rapier character controller: https://rapier.rs/docs/user_guides/javascript/character_controller
