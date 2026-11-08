# 0137. Physics is two plugins: a backend-neutral Physics plugin and a Rapier backend plugin

- **Status:** Proposed
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133 and 0135 (amends: how physics is split into plugins), 0005, 0010, 0032, 0039, 0045, 0091, 0092, 0093, 0104, 0136

## Context

ADR 0135 step 3 made `myco.physics2d` and `myco.physics3d` plugins. Each one holds everything for its dimension: the Components, the `Physics` queries, events, the Rapier world class (`Physics2DWorld`, 888 lines; `Physics3DWorld`, 924 lines) and its World service.

- **The two world classes are mostly copies.** They share 32 method names. `dispatchEvents`/`notify`, `pushBody`, interpolation, joint breaks and moving platforms match apart from how poses are packed. They have drifted: 3D interpolates rotations with `nlerp`, while 2D lerps the raw angle across Rapier's ±π wrap. (This was the 2026-11-08 review's candidate 4.)
- **Rapier is tied up with the API.** Switching to Box2D or Jolt would mean rewriting the Components' sync logic. ADR 0010 keeps Rapier out of the public API but not out of the Components' implementation.
- **Other features use physics:**
  - the core's script hooks (`onCollisionEnter`, `onTriggerEnter`; these now take plain core types such as `PhysicsCollision`);
  - tilemap colliders;
  - particle collisions (through the World service's `raycast`);
  - character control;
  - netcode prediction;
  - the editor's collider gizmos.
- **What it weighs today:** the lazily loaded Rapier chunks are 4.36 MB (1.66 MB gzipped) for 3D and 3.43 MB (1.30 MB gzipped) for 2D. The Components and queries are a few KB.
- **The owner's goals:** physics should be backend-neutral, and a game with no physics, such as a visual novel, should be able to switch it off completely.

## Decision

Physics becomes two first-party plugins. The second depends on the first.

### `myco.physics`: backend-neutral, covering both 2D and 3D

- **Runtime half:**
  - The Components: `RigidBody2D`, the 2D colliders, 2D joints, `RigidBody`, the 3D colliders, 3D joints, `CharacterController` and `Buoyancy`. Component ids don't change, so scene files are untouched.
  - The `Physics` queries (raycasts, shape casts, overlaps) and physics events.
  - Layers and collision groups (`physics/layers.ts`), shapes (`polygon.ts`, `shape3d.ts`).
  - **The shared sync core**, written once for both dimensions:
    - signature-based rebuilds, teleport versus kinematic moves;
    - pending velocity and one-step forces;
    - interpolation buffers, with angle wrap handled;
    - contact and stay bookkeeping, hook dispatch;
    - joint-break checks, moving platforms.
  - One World service per dimension (0135) that runs the shared core over a backend.
- **Editor half:** collider gizmos (`colliderGizmo.ts` and others), physics project settings (layers and the collision matrix), and physics inspector sections.
- **The backend contribution point:** `registerPhysicsBackend({ id, dimension: "2d" | "3d", load })`. `load()` returns a backend for that dimension, which:
  - creates and steps a world;
  - creates, updates and removes bodies, colliders and joints from neutral descriptions;
  - reads poses back;
  - drains contact and trigger events;
  - answers queries;
  - runs a character controller.

  The shared core is loaded in the same lazy chunk as the backend, so it costs nothing until physics starts. Neutral descriptions use engine types only (ADR 0010).
- **Choosing a backend:** the project settings `physics.backend2d` and `physics.backend3d` select one. When only one backend is registered for a dimension, it is used.
- **No backend:** the Components stay registered but inert, with one warning per World. Add Component labels them "no physics backend enabled".
- **Turning `myco.physics` off:** its Components load as missing, and their data is kept (0133). The core's hook types stay in the core as plain types, so nothing in the core breaks.

### `myco.physics-rapier`: Rapier only

- Depends on `myco.physics`.
- Registers a Rapier 2D backend and a Rapier 3D backend. Each loads its own WebAssembly lazily, as today.
- Holds only the Rapier calls, the conversion to and from Rapier types, and Rapier's character controller. Everything shared moves into the core above.

### Migration

1. Define the backend interface. Build the shared sync core in `myco.physics` and test it against a fake backend, with no Rapier: teleport versus kinematic moves, the stay-event lifecycle, 2D angle wrap and joint breaks.
2. Turn `Physics2DWorld` and `Physics3DWorld` into the two Rapier backends in `myco.physics-rapier`. The existing 2D/3D scenario tests (`physics.test.ts`, `physics3d.test.ts`, `physicsFeatures.test.ts`, `joints.test.ts`) must pass unchanged.
3. Merge `myco.physics2d` and `myco.physics3d` into `myco.physics`. Existing `project.json` `plugins.disabled` entries naming the old plugins map to the new ones. Public names stay importable from `"myco"`.
4. Move the physics editor half (gizmos, settings, sections) into `myco.physics`.

**`TilemapCollider2D` stays where it is** until ADR 0136 (the tile-layer interface) settles how other plugins read tile data. Then it joins whichever plugin that ADR's dependency rule points to.

**Navigation stays one plugin.** Nothing outside it uses its API much.

## Alternatives considered

- **The physics API in the engine core, with backends as plugins.** Core features could use physics without a dependency, and a visual novel would pay only a few KB. But physics could no longer be switched off, and the core would grow a feature the owner wants optional.
- **Keep one plugin per dimension, as built in 0135.** This keeps the duplicated sync code and its drift, and ties every physics API to Rapier.
- **Separate 2D and 3D backend-neutral plugins.** It splits the shared sync core across two plugins for no gain: backends already load lazily per dimension, so a 2D game never downloads 3D code.
- **A plugin per backend per dimension** (`rapier-2d`, `rapier-3d`). Allowed by the backend contribution point, but one Rapier plugin is simpler. Splitting it later changes nothing for users.

## Consequences

**Positive**
- **Locality:** sync, interpolation, events and joint logic live in one module. A fix lands in both dimensions, and the drift (angle wrap) goes away.
- **A real seam:** two adapters (Rapier 2D and Rapier 3D) from day one. Box2D or Jolt can be added without changing scenes or scripts.
- **A visual novel** turns `myco.physics` off and carries no physics at runtime.
- **The shared core is tested** against a fake backend, without WebAssembly.

**Negative / costs**
- **Rework:** the 0135 step 3 plugins are merged and split again.
- **The backend interface must cover two engines' features** (joint motors, character controllers, continuous collision). Some will be capability flags, not guarantees.
- **Old plugin names in `project.json` need a mapping.**

## Deprecates

- The `myco.physics2d` and `myco.physics3d` plugins. They are merged into `myco.physics`, and their names are mapped.
- `Physics2DWorld` and `Physics3DWorld` as owners of sync and event logic. They become Rapier backends.

## Open questions

- Which backend features are capability flags (for example continuous collision, joint motors).
- Where `TilemapCollider2D` lives once ADR 0136 is settled.
- Whether audio (Howler) gets the same split later.

## References

- 2026-11-08 architecture review, candidate 4; [0133](0133-features-are-plugins-over-an-engine-and-editor-sdk.md); [0135](0135-runtime-contribution-points-and-plugin-activation.md); `src/plugins/physics2d/`, `src/plugins/physics3d/`, `src/engine/physics/`; the player build's Rapier chunk sizes (above).
