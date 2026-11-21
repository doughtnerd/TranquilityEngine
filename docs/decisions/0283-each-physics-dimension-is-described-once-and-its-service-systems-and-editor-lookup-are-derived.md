# 0283. Each physics dimension is described once; its World service, systems and editor lookup are derived

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0011, 0032, 0045, 0072, 0093, 0135, 0137

## Context

The Physics plugin runs 2D and 3D physics as two World services over one shared sync core (ADR 0137). Which Components belong to which dimension was written in three places, and the fixed-step systems twice:

- **Component ids** in `runtime/systems2d.ts` and `systems3d.ts` (`PHYSICS_2D_COMPONENTS`, the service's `neededBy`), **classes** in `runtime/index.ts` (two `registerComponents` lists), and the **editor** guessed with a regex on the type name (`/2D$/` in `editor/physicsEditorModel.ts`). The guess called `engine.Buoyancy` 3D, so Add Component marked it "(no physics backend)" without a 3D backend, though its kinematic mode needs none (`Buoyancy.ts`).
- **Five systems** (restore interpolated, push, step, write back, events) were written out once per dimension, the 3D push joined to `engine.PhysicsEvents` by hand.
- **RigidBody and RigidBody2D** each copied the handling of commands given before their backend body exists (pending velocity, pending angular velocity, force, torque), and both turned an early `addTorque(…, "impulse")` into a one-step torque: a step too weak, unlike `addForce`'s impulse, which becomes a pending velocity.

## Decision

**One description per dimension.** `runtime/dimensions.ts` holds a `PhysicsDimensionDescription` for 2D and for 3D: its dimension, World service id, the Component classes that work in it and need its backend, its systems' name stem (`engine.Physics`, `engine.Physics3D`) and how its physics world is made (plus 3D's raycasts). `PHYSICS_DIMENSIONS` lists them in step order (ADR 0011).

**Everything else is derived** (`runtime/services.ts`):

- `physicsWorldService(description)` builds the World service; its `neededBy` (scene setting, Component ids, the other settings that exclude it) comes from the description.
- `physicsSystems(dimensions)` builds the five fixed-step systems per dimension, each dimension pushing after the one before it has dispatched its events. Names are unchanged (`engine.PhysicsPush`, `engine.Physics3DStep`…), so World settings and other systems' ordering keep working.
- The plugin registers each description's Components; Buoyancy is registered on its own and belongs to neither dimension.
- `physicsDimensionOf(type)` answers the editor's "(no physics backend)" note: a Component in no dimension (Buoyancy) is never noted. The regex is gone.

`systems2d.ts` and `systems3d.ts` keep only the event buffers, the service ids and `physics2DOf`/`physics3DOf`.

**One command buffer for both rigid bodies.** `runtime/bodyCommands.ts` (`BodyCommands`) takes velocity, angular velocity, force, torque and impulse commands in number arrays: with a body it applies them, before one it keeps them, and the sync core takes them at the body's push (`take()`, replacing the two `takePending` overrides). The RigidBody classes convert their vectors and pass their mass and frozen rotation axes. An early angular impulse now changes the pending angular velocity by impulse / inertia, none around a frozen axis, as the body would. `bodyMass` and `bodyInertia` are the one copy of the "mass at least 1e-4, inertia mass / 6" rule the core's body settings and joint-force estimate already used.

## Alternatives considered

- **Keep string ids in the description** and look the classes up — registration needs the classes anyway, and ids follow from them through the registry.
- **A `dimension` option on each Component's `@component`** — spreads the description over twelve files per dimension again and puts a physics concept in the core registry.
- **Queue the early angular impulse and apply it with `applyTorqueImpulse` at body creation** — more exact with a backend's own inertia, but `angularVelocity` read before the body exists would not show it; the pending-velocity rule matches `addForce` and the core's own inertia.

## Consequences

**Positive**
- Adding a physics Component touches one list; the service, the scene scan, registration and the editor note follow.
- Buoyancy is no longer marked "(no physics backend)".
- The five systems and their ordering are written once; one test table covers which Component is in which dimension.
- An early angular impulse spins a body as a later one does.

**Negative / costs**
- Systems' names come from a stem, so a search for `engine.PhysicsStep` finds the tests and settings, not the definition.
- Component ids are read from the registry when `dimensions.ts` loads, so a class there must be decorated with `@component` (it throws otherwise).

## Deprecates

`PHYSICS_2D_COMPONENTS`, `PHYSICS_2D_SYSTEMS`, `PHYSICS_3D_SYSTEMS` and the service definitions in `systems2d.ts`/`systems3d.ts` (moved to `dimensions.ts`), the `/2D$/` guess in `physicsEditorModel.ts`, the RigidBodies' `_pendingVelocity`/`_pendingAngularVelocity`/`_force`/`_torque` fields and the cores' `takePending` (removed).

## Open questions

None.

## References

`src/plugins/physics/runtime/dimensions.ts`, `services.ts`, `bodyCommands.ts`, `RigidBody.ts`, `RigidBody2D.ts`, `core/PhysicsCore.ts`, `editor/physicsEditorModel.ts`; tests `physics.test.ts`, `core.test.ts`, `editor/physicsEditor.test.ts`.
