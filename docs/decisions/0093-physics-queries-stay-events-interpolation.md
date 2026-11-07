# 0093. Shape casts and overlaps, Stay events, interpolation on by default, and child colliders that follow their node

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0011, 0017, 0019, 0045

## Context

ADR 0005 and 0045 left four gaps for both dimensions: no shape casts or overlap queries, no `Stay` events, `interpolate` reserved but not implemented, and colliders on a body's child node ignoring the child moving relative to the body (they were placed once, when created).

## Decision

- **Queries** (layers last and optional, as `raycast`): `Physics.sphereCast`, `boxCast(center, halfExtents, direction, orientation?)`, `capsuleCast(point1, point2, radius, direction)` → `ShapeCastHit | null` (`collider`, `point`, `normal`, `distance`); `overlapSphere`, `overlapBox`, `overlapCapsule` → `Collider[]`; `checkSphere`. `Physics2D.circleCast`, `boxCast(origin, size, angle)`, `capsuleCast(origin, size, angle)` (vertical capsules) → `ShapeCastHit2D | null`; `overlapCircle`, `overlapBox`, `overlapCapsule`, `overlapPoint` → `Collider2D[]`. Triggers are included, like raycasts. Implemented in `physics/queries3d.ts` / `queries2d.ts`, loaded with the backend; Rapier types stay inside (0010). A cast that starts inside a collider reports distance 0.
- **Stay events:** `onCollisionStay(collision)` and `onTriggerStay(other)` run every fixed step after the one that called Enter, while the pair still touches, on the same nodes as Enter/Exit (collider node, owner, body node). The backends track touching pairs from Rapier's start/stop events; pairs involving a released collider are dropped. The event buffers (`CollisionEvents`, `TriggerEvents`) keep only Enter/Exit (Stay would flood them).
- **Interpolation:** `RigidBody.interpolate` and `RigidBody2D.interpolate` now work and **default to on**. In a World that renders (main view or editor tile), after the fixed steps the Engine asks each physics world to place every awake, interpolating dynamic body `fixedAlpha` of the way from its pose before the last step to its pose after it (rotation by normalized lerp). The Transform shows that pose during update, lateUpdate and render (Unity's semantics), trailing the simulation by up to one step. A new fixed-step system, `engine.PhysicsRestoreInterpolated` (first in the fixed step, before scripts), puts the simulated pose back, so fixed-step scripts and the push stage see it; a script that moved the Transform in between wins (the body is teleported, as before). Headless Worlds (servers, tests) never interpolate. Kinematic and static bodies don't interpolate.
- **Child colliders:** a collider on a descendant of its body's node re-reads its pose relative to the body whenever its Transform version changes, and moves the Rapier collider (`setTranslationWrtParent` / `setRotationWrtParent`) when it changed by more than 1e-5. Relative poses are computed from the two nodes' Transforms, not the Rapier body, so an interpolated body doesn't skew them.

## Alternatives considered

- **Interpolate only the rendered meshes** (Godot 4's physics interpolation leaves node transforms alone). Cleaner for scripts, but it needs a hook into the Babylon render sync for every renderable under a body, a module other sessions are changing; writing the Transform matches Unity and touches only physics and one Engine line.
- **Interpolation off by default** (Unity's default). Then most games stutter whenever the frame rate isn't a multiple of the tick rate; on by default trades one step of latency for smoothness, and only rendered Worlds pay it.
- **Stay in the event buffers.** One entry per touching pair per step; systems that need it can track Enter/Exit pairs.

## Consequences

**Positive**
- Character sensors, area queries, sweeps for projectiles and AI line-of-sight with volume.
- Smooth motion at any refresh rate without game code.
- Articulated colliders (an arm collider on a child node) follow animation-free script motion.

**Negative / costs**
- Rendered bodies trail the simulation by up to one fixed step; `update` reads interpolated positions (use a RigidBody's velocity or a fixed-step read for exact physics positions).
- Every step, each child collider of a moving body re-reads its relative pose (one matrix decompose per collider).
- Stay hooks cost a lookup per touching pair per step, even when no behavior implements them.

## Deprecates

The "reserved" note on `interpolate`; its old default (`false`): scenes that didn't set it now interpolate.

## Open questions

- Raycast-all / cast-all variants returning every hit.
- Per-query trigger inclusion (Unity's `QueryTriggerInteraction`).

## References

- `src/engine/physics/Physics3DWorld.ts`, `Physics2DWorld.ts`, `queries3d.ts`, `queries2d.ts`, `Physics.ts`, `Physics2D.ts`, `physics2dSystems.ts`, `core/Engine.ts` (`stepWorld`).
- Tests: `src/engine/tests/physicsFeatures.test.ts`, `physicsQueries.test.ts`.
