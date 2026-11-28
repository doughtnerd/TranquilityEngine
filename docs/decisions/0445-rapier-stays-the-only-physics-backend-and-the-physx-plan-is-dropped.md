# 0445. Rapier stays the only physics backend, and the PhysX plan is dropped

- **Status:** Accepted
- **Date:** 2026-11-26 (accepted 2026-11-28)
- **Deciders:** Chris Carlson
- **Supersedes:** 0005, in part (point 4: "PhysX is the planned 3D upgrade")
- **Related:** 0005, 0010, 0045, 0091, 0092, 0093, 0104, 0137, 0375

## Context

ADR 0005 put physics behind an engine interface, chose Rapier 2D and 3D for v1, and planned PhysX
(`physx-js-webidl`) as the 3D upgrade "when a game needs its 3D features (articulations, vehicles) or Unity-exact
behaviour". Later records kept that plan open:
- 0045 built 3D on Rapier and said the component API could let PhysX replace it later.
- 0375 says a later PhysX backend must offer the same joint and ragdoll features.

What exists today:
- **The interface:** it exists since ADR 0137. `myco.physics` holds the backend-neutral Components, queries and
  shared 2D/3D sync core, plus a backend contribution point (`registerPhysicsBackend`, project settings
  `physics.backend2d` / `physics.backend3d`). `myco.physics-rapier` is the only backend
  (`@dimforge/rapier2d-compat` and `@dimforge/rapier3d-compat` 0.21).
- **What's built on Rapier:** character controllers (0091), joints (0092), shape casts, overlaps, `Stay` events and
  interpolation (0093), tile colliders and one-way platforms (0105), and ball-joint limits, drives and ragdolls (0375).
  None of the games or samples needs articulations or vehicles.
- **The status row:** `implementation-status.md` lists PhysX as missing, noting that "the owner prefers to stay on
  Rapier; 0005's PhysX plan is unrevisited". Audits of missing features keep reporting it as a gap.

The owner decided on 2026-11-26 to stay on Rapier for the foreseeable future.

## Decision

We will keep Rapier as the engine's only physics backend, for both 2D and 3D, and drop the planned PhysX backend.

- **No PhysX work is scheduled.** PhysX is no longer a gap: the status row and future audits don't list it as
  missing.
- **The rest of 0005 stays in force.** That covers the engine physics interface, the Unity-shaped component API and
  semantics (damping, axis constraints, collision detection modes, interpolation, triggers), named layers with a
  collision matrix, and the engine-level `CharacterController`. Unity-shaped semantics remain the target because the
  scripting API is Unity-like, not because a PhysX backend is coming.
- **The backend seam stays (0137).** `registerPhysicsBackend` and the per-dimension project settings are kept. They
  cost nothing at run time and leave a door open: a third-party plugin could add a backend, or a later record could
  revisit PhysX, Jolt or Havok if a game needs something Rapier can't do. Such a record would supersede this one.
- **Rapier-only features are allowed behind the interface.** A record no longer has to show that a feature could be
  served by PhysX (as 0375 did). It still goes through the neutral interface, and no Rapier type reaches the public
  API (0010, open question O13). So a later backend would have to match Rapier's feature set, not the reverse.
- **Gaps are filled on Rapier.** Missing physics features are built on the Rapier backend: snapshots (Rapier has
  world snapshots), articulations through Rapier's multibody joints, and vehicles through Rapier's
  `DynamicRayCastVehicleController`.

## Alternatives considered

- **Keep the plan open, unscheduled (status quo).** Costs nothing in code, but every record has to write for a
  backend that may never come (0375's PhysX clause), and audits keep listing it as a missing feature.
- **Build the PhysX 3D backend now.** It's the only way to get Unity-exact 3D behaviour, along with PhysX's full
  articulation and vehicle set. But it means a second integration with manual memory management (`PhysX.destroy`), a
  download of about 10 MB unpacked, and a bindings package with a single maintainer, all for features no project needs
  today.
- **Remove the backend seam and call Rapier directly.** Saves an indirection, but undoes 0137's plugin split for
  nothing. It would also break the rule that no Rapier types appear in the public API, and close the door this record
  leaves open.

## Consequences

**Positive**
- One physics library to know, test and update, for both dimensions.
- Records and features can rely on Rapier's own capabilities (multibody joints, the vehicle controller, snapshots,
  determinism) without designing for a hypothetical second backend.
- Audits and the status doc stop carrying PhysX as a gap.

**Negative / costs**
- 3D behaviour is close to Unity's, not identical. A Unity user porting PhysX-tuned content (friction combining,
  joint drives, contact offsets, vehicle handling) may need to retune it.
- If a game later needs a PhysX-only feature, that work starts from scratch. A new backend would also have to match
  whatever Rapier-only features have been built by then.
- Engine physics moves at Rapier's pace: its release cadence, its wasm size and its `-compat` builds.

## Deprecates

- **0005 point 4** (PhysX as the planned 3D upgrade, Rapier 2D beside it in a PhysX + Box2D-style split). 0005's
  status becomes "Accepted; partly superseded by 0445 (the PhysX plan)".
- **The PhysX clauses in 0045 and 0375** are now moot: "PhysX can replace Rapier 3D later" and "a later PhysX backend
  must offer the same features". Those records aren't rewritten; this one says the clauses no longer bind.
- **The "(PhysX 3D later)" note** in the layer diagram of `docs/architecture/overview.md` is removed.
- No code: nothing was ever built for PhysX.

## Open questions

- Which Rapier-only physics features come first (snapshots, multibody articulations, the vehicle controller) is left
  to the records that build them.

## References

- [0005](0005-physics-backend.md) (the candidate table: Rapier, PhysX, Havok, Jolt, cannon-es), [0137](0137-physics-is-a-backend-neutral-plugin-plus-a-rapier-backend-plugin.md) (the backend seam).
- `src/plugins/physics/runtime/backend.ts`, `src/plugins/physics-rapier/runtime/`.
- Rapier JavaScript user guide: https://rapier.rs/docs/user_guides/javascript/getting_started_js (multibody joints,
  character and vehicle controllers, snapshots).
