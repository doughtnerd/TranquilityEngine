# 0092. Joints are components that link a node's body to another node's body, or to the world, on Rapier impulse joints

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0010, 0013, 0019, 0042, 0045

## Context

ADR 0005's backend interface lists joints; neither physics world had any. Rapier provides impulse joints in 2D and 3D (fixed, revolute, prismatic, spherical (3D), rope, spring) with limits and motors on the single-axis ones. Scene files can already reference nodes from fields (`@field(GameObject)`, stored as `{ "$node": id }`, 0042).

## Decision

- **Components** (public; 3D in `physics/Joint.ts`, 2D in `physics/Joint2D.ts`): `FixedJoint`, `HingeJoint`, `SliderJoint`, `BallJoint`, `RopeJoint`, `SpringJoint`, and `FixedJoint2D`, `HingeJoint2D`, `SliderJoint2D`, `RopeJoint2D`, `SpringJoint2D`. Godot-style names (hinge, slider, ball) rather than Unity's `ConfigurableJoint`/`CharacterJoint`.
- **Common fields** (`Joint` / `Joint2D` base): `connectedBody` (a node reference; empty = the world), `anchor` (joint node's local space), `autoConfigureConnectedAnchor` (default on) and `connectedAnchor` (connected node's local space, world space when connected to the world), `enableCollision` (default off). The joint moves the RigidBody on its node or the nearest one above it (`body`); the connected node's body likewise (`connectedRigidbody`).
- **Single-axis joints** (`AxisJoint`, `AxisJoint2D`: hinges and sliders): `axis` (3D hinges and both sliders; node local space), `useLimits` + `limits {min, max}` (degrees for hinges, units for sliders), `useMotor` + `motor {targetVelocity, force}`, `useSpring` + `spring {spring, damper, targetPosition}` (ignored while the motor is on). Positive values turn this body counterclockwise around the axis (right-hand rule) or move it along the axis, relative to the connected body.
- **Rope and spring:** `autoConfigureDistance` (default on: the anchors' distance when the joint is made) with `maxDistance` / `restLength`; springs have `spring` and `damper`. With auto anchors their connected anchor is the connected body's origin, since a coinciding anchor would mean length 0.
- **Rest pose:** a joint rests in the pose its bodies have when it is made: hinge angles, slider positions and limits count from there, and bodies turned relative to each other are not snapped together. In 3D each body holds the joint frame (x along the axis) in its own frame (`setLocalFrame1/2`). In 2D the hinge's starting angle offsets its limits and spring target; fixed joints store the relative angle; 2D sliders whose two bodies start at different rotations are turned to match (warned), because Rapier 2D's prismatic joint takes no frames.
- **The world:** a joint without `connectedBody` links to a fixed body the backend makes at the body's pose (one per joint), so frames start out matching.
- **Backend:** joints are pushed after bodies and colliders each fixed step. A change to the joint type, anchors, axis, connected node, `useLimits`, `enableCollision` or rope/spring distances rebuilds it; limits, motor and spring values update the live joint. Joints are released when their component goes, and rebuilt when either body is recreated. Rapier's first body is the connected one, so angles read as this body's relative to it.
- **Editor:** joint gizmos draw anchors, links, hinge axes and limit arcs, slider axes, ropes and springs (`src/editor/jointGizmo.ts`).

## Alternatives considered

- **Unity's names and `ConfigurableJoint`.** One configurable joint is powerful but hard to use; the named joints cover the common cases and map one-to-one onto Rapier.
- **Multibody (reduced-coordinate) joints.** Stiffer chains, but Rapier's multibody API is more restrictive (no loops) and 2D/3D parity is weaker; impulse joints first.
- **Joints as child nodes between two bodies** (Godot's `Joint3D` with two node paths). Possible via ADR 0009's component nodes anyway; one body on the joint's own node is simpler to author.

## Consequences

**Positive**
- Doors, wheels, pendulums, ropes, chains and springs in 2D and 3D, authored in the editor with node references.

**Negative / costs**
- No breakable joints (Rapier's JS API doesn't report joint forces cheaply), no ball-joint cone limits or motors, no reading the current hinge angle or slider position yet.
- A world-anchored joint costs one hidden fixed body.
- Rebuilding a joint (say, after moving its anchor at runtime) resets its rest pose to the current one.

## Deprecates

Nothing.

## Open questions

- Breaking force/torque, ball-joint limits, `angle`/`position` readouts.
- Multibody joints for articulated chains.

## References

- `src/engine/physics/Joint.ts`, `Joint2D.ts`, backends (`pushJoint`, `createJoint`); tests `src/engine/tests/joints.test.ts`.
- Rapier joints: https://rapier.rs/docs/user_guides/javascript/joints
