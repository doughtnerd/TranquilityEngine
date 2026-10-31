# 0005. Physics backend: Rapier now, PhysX for 3D later, behind an engine interface

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0010, 0011, 0014, 0016

## Context

The legacy engine has homemade physics: `RigidBody.js` (forces, gravity, impulses), `BoxCollider.js`, a sweep-and-prune broadphase (`physics/SAP.js`, `Endpoint.js`, `Collider.js`), all stepped on a separate `setInterval`. It is limited to boxes and has a known leak (`// TODO: USING COLLISION LAYER LIKE THIS SEEMS TO HAVE CREATED A MEMORY LEAK` in `scene1.js`).

The unmerged `CannonIntegration` branch (March 2021) tried a physics library. On review (2026-10-31):
- It imports the original `cannon` package (abandoned around 2016), not `cannon-es`, and the package isn't in the branch's `package.json`.
- About 200 lines: `physics/RigidBody.ts`, `physics/BoxCollider.ts`, a stub `PhysicsEngine.js`. Collision/trigger events were never connected.
- The sync logic overwrites the body position from the Transform every `update()` (cancelling the simulation), round-trips rotation through Euler angles, and turns `useGravity: false` into `mass: 0` (making the body static).
- **The component API is good**: `RigidBody { isKinematic, useGravity, mass, drag, angularDrag, constraints.freezePosition/freezeRotation per axis, addForce(force, "force" | "impulse") }` and `BoxCollider { size, center, isTrigger, material }`. It is Unity-shaped and backend-independent.

Requirements: 2D and 3D physics (0014); free for commercial use; runs in all Tauri webviews (0003); usable TypeScript API; active maintenance. Nice to have: determinism, snapshots, Unity-matching semantics (the scripting API is Unity-like, and Unity's 3D physics is PhysX).

Candidates as of 2026-10-31:

| | Rapier | PhysX (`physx-js-webidl`) | Havok (`@babylonjs/havok`) | Jolt (`jolt-physics`) | cannon-es |
| --- | --- | --- | --- | --- | --- |
| License | Apache-2.0 | PhysX BSD-3, bindings MIT | MIT | MIT | MIT |
| 2D | Yes (`rapier2d`) | No | No | No | No |
| 3D | Yes | Yes (PhysX 5.12) | Yes | Yes | Yes |
| Unity semantic match | Close | **Exact** (Unity 3D uses PhysX) | Close | Close | Loose |
| Features | Joints, CCD, character controller, snapshots | Most complete: all joints, articulations, vehicles, character controller, serialization | Strong core | Strong core, vehicles | Basic |
| JS API | Typed, documented, handles | Generated types; mirrors C++ API; **manual memory management** (`PhysX.destroy`) | Flat `HP_*` functions, thin docs | Emscripten bindings, manual memory | Typed JS |
| Package size | Few MB | ~10 MB unpacked | Few MB | Few MB | Small |
| Maintenance | Active, team | Active, single maintainer | Active (Babylon team) | Active | Low |

## Decision

1. Physics sits behind an **engine physics interface** (`PhysicsBackend`): world create/step/destroy, body and collider CRUD, joints, queries (raycast, shape cast, overlap), collision/trigger event drain, snapshots. Engine components and `Physics.*` queries talk only to this interface.
2. **The interface follows PhysX/Unity semantics** (damping, axis constraints, collision detection modes, interpolation, sensors as triggers), so that the 3D backend can change without changing the component API.
3. **Rapier is the backend for v1**: `@dimforge/rapier2d-compat` and `@dimforge/rapier3d-compat` (the `-compat` builds embed the WASM file).
4. **PhysX is the planned 3D upgrade** (via `physx-js-webidl`), adopted when a game needs its 3D features (articulations, vehicles) or Unity-exact behavior. Rapier2D stays the 2D backend, mirroring Unity's PhysX + Box2D split. Havok and Jolt remain alternatives but aren't planned.
5. **Component API comes from the `CannonIntegration` branch**, with the sync rewritten to the rules in 0010/0011:
   - `RigidBody`: `bodyType` (`dynamic | kinematic | static`, replacing the `isKinematic` + mass-0 overloading), `mass`, `useGravity` (gravity scale, not mass), `drag`, `angularDrag`, `constraints.freezePosition/freezeRotation`, `interpolate`, `collisionDetection`, `addForce(force, mode)`, `addTorque`, `velocity`, `angularVelocity`.
   - Colliders: `BoxCollider`, `SphereCollider`, `CapsuleCollider`, `MeshCollider` (3D) and `*2D` variants; `size`/`radius`/…, `center`, `isTrigger`, `material` (friction, bounciness), `layer`.
6. **Collision layers are project-wide named layers with a collision matrix** (Unity-style), configured in project settings and mapped to backend collision groups. Colliders pick a layer by name.
7. **`CharacterController` is an engine-level component** with a Unity-like API (`move(delta)`, `isGrounded`, `slopeLimit`, `stepOffset`, `skinWidth`), implemented on each backend's native controller (Rapier's `KinematicCharacterController` now, PhysX's later).
8. Each World runs at most one 2D and one 3D physics world. Scenes declare which dimension they use (0014, 0016).

## Alternatives considered

- **PhysX 3D + Rapier 2D from day one.** Best 3D parity immediately, but two integrations and PhysX's manual memory management up front. Deferred, not rejected.
- **Havok.** License-free, fast, but 3D only, with a thin low-level API. PhysX covers more features and matches Unity, so it takes the "future 3D backend" role.
- **cannon-es (port of the branch).** The most code would carry over, but it's 3D only, the slowest option and lightly maintained. Only the branch's component API is kept.
- **Keep the homemade physics.** Not viable beyond boxes.
- **No interface layer.** Locks the engine to one library and blocks the planned PhysX move.

## Consequences

**Positive**
- One library covers 2D and 3D for v1.
- Unity users get familiar component fields now and exact 3D behavior once PhysX lands.
- Determinism and snapshots available from Rapier if needed.

**Negative / costs**
- WASM init is async; engine startup awaits backend creation.
- The interface must be designed with two very different backends in mind (Rapier's handles vs PhysX's manually freed objects). A PhysX backend must own every allocation to avoid leaks.
- Backend-specific features go through an explicit escape hatch.

## Deprecates

- `src/engine/RigidBody.js`, `BoxCollider.js`, `PhysicsEngine.js`, `Physics.js`, `src/engine/physics/*` (SAP broadphase, Endpoint, Collider).
- The separate physics `setInterval` in `Engine.js` (replaced by the fixed-step accumulator, 0011).
- The `collisionLayer` bitmask in scene data (replaced by named layers).
- Branch `origin/CannonIntegration`: not merged. Its component API is carried into the new components; its cannon integration and sync code are discarded.
- The `uuid` dependency's only use (collider ids in `SAP.js`) goes with it; stable node ids (0013) may reuse it or `crypto.randomUUID()`.

## Open questions

- ~~Default physics units and gravity.~~ Resolved in [0014](0014-unified-2d-and-3d.md): 1 unit = 1 m, gravity −9.81 m/s².

## References

- https://rapier.rs/docs/user_guides/javascript/getting_started_js
- https://github.com/fabmax/physx-js-webidl
- https://www.npmjs.com/package/@babylonjs/havok
- Unity physics overview: https://docs.unity3d.com/Manual/PhysicsOverview.html
