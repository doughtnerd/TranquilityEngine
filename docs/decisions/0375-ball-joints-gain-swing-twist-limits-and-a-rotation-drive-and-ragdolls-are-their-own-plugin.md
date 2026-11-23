# 0375. Ball joints gain swing and twist limits and a target-rotation drive; ragdolls are their own plugin

- **Status:** Accepted, amended by 0378 (`Ragdoll.getUp()`, `body()` and further fields)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0305 (joint classes describe the new fields)
- **Related:** 0010, 0133, 0370, 0372, 0373, 0374

## Context

Ragdolls and powered ragdolls (PuppetMaster-style; 0372) need two things the physics plugin lacks:
- joints that turn freely within a cone and a twist range;
- motors that drive a joint toward a target **rotation**.

**Today:**
- `src/engine/physics/types.ts`: motors (`JointMotor`: target velocity and force) and springs (`JointSpring`: target position, stiffness, damping) exist only on hinges and sliders (`AxisJoint`).
- `BallJoint` already has `useLimits`, `twistLimits` (`{ min, max }` about its `axis`) and a scalar `swingLimit` (a circular cone), mapped to Rapier's per-axis limits (`PhysicsWorld3D.ts`, `rapier3d.ts`). It has no drive. *(Corrected 2026-11-22: the first version of this record said ball joints had no limits.)*
- Only the physics backend (`src/plugins/physics-rapier/`) talks to Rapier (0010), and a later PhysX backend must offer the same features.

The owner asked whether ragdolls could be a separate plugin rather than living in physics.

## Decision

**The joint features belong to the physics plugin.** They are general joint capabilities, also used for robot arms, vehicles and hanging props, and only the backend can implement them:

- **`BallJoint` gains:**
  - **elliptical swing:** `swingLimit` becomes `swing: { y, z }` (cone half-angles in degrees, elliptical when they differ). A saved `swingLimit: s` migrates to `{ y: s, z: s }` through the component's field migration, so existing scenes keep their behaviour. `twistLimits` stays as it is;
  - `useDrive` with `drive: { targetRotation (quaternion), stiffness, damping, maxForce }`.
  
  All are plain fields, animatable (0371), and described by the class (0305).
- **`HingeJoint` and `SliderJoint`** keep `motor` and `spring`. Their spring's `targetPosition` becomes animatable.
- **The backend interface** gains the limit and drive fields on ball joints. `physics-rapier` maps them onto Rapier's joint limits and motors per angular axis. If the JS binding lacks per-axis motors on spherical joints, the backend uses Rapier's generic joint with the same axes, and the physics wave confirms which.
- **Editor:** the joint gizmo (0305's `_worldAnchors`) draws the swing cone and twist arc.

**Ragdolls are a separate first-party plugin, `myco.ragdoll`,** depending on `myco.physics` and `myco.animation`:

- **Runtime half** (`src/plugins/ragdoll/runtime/`):
  - the `Ragdoll` component (per bone: body shape, mass and joint settings; `mode`: `off`, `ragdoll` or `powered`; `blend`; pinning strength);
  - built-in systems in the fixed step:
    - create bodies and ball joints from the skeleton;
    - each fixed step, read `anim-physics` drive targets (0370) from the animation plugin and write `drive.targetRotation` and strengths;
    - after the step, write the simulated pose back as the animation graph's physical-pose input (0372);
  - get-up: a pose snapshot plus a get-up state chosen by the pelvis facing.
- **Editor half:** the ragdoll builder (0373): generate bodies and limits from bone lengths and the skeleton profile's joint ranges, edit them with gizmos, test drop.
- **What the animation plugin keeps:** the drive-target computation, the pose snapshot source and the physical-pose graph input. Animation works without physics, and physics without animation.

## Alternatives considered

- **Ragdolls inside the physics plugin.** Physics would depend on animation (skeletons, poses), the wrong way round.
- **Ragdolls inside the animation plugin.** Every animated project would need physics, or animation would need an optional physics path throughout.
- **Joint features in the ragdoll plugin.** Impossible without reaching past the physics interface to Rapier (0010), and a PhysX backend couldn't serve them.

## Consequences

**Positive**
- General-purpose ball-joint limits and drives for every physics user.
- Each plugin stays usable alone.

**Negative / costs**
- A third plugin for users to enable for ragdolls (the Plugins category explains it).
- Rapier's spherical-joint motor support in its JS binding must be confirmed early in the physics wave.

## Deprecates

Nothing.

## Open questions

None.

## References

`src/engine/physics/types.ts`, `src/plugins/physics/runtime/Joint.ts`, `src/plugins/physics-rapier/runtime/rapier3d.ts`; Unity ConfigurableJoint, PuppetMaster; Rapier joint limits and motors.
