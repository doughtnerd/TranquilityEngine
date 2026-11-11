# 0019. Public API conventions: names, angles, live vectors

- **Status:** Accepted, amended by 0163 (Euler angles use Unity's ZXY order; rotations are quaternions in data) and 0164 (the rotation API takes radians; component angle fields stay degrees)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0009, 0012, 0014

## Context

Several small API conventions affect every script and scene file and should be fixed early:

- **Naming**: the legacy engine uses `GameBehavior` and `getBehavior`; Unity users expect `getComponent`.
- **Angles**: Unity uses degrees; three.js and physics libraries use radians.
- **Vector semantics**: in Unity, `transform.position` returns a copy, so `transform.position.x = 5` silently does nothing, which is a classic beginner bug.

## Decision

- **Names**: `GameBehavior` and `getBehavior` / `getBehaviors` / `addBehavior` / `getBehaviorInChildren` / `getBehaviorInParent` / `getBehaviorInComponents` are the primary names. `getComponent`, `getComponents`, `addComponent`, `getComponentInChildren` and `getComponentInParent` are provided as **aliases** with identical behavior. Docs and examples use the primary names.
- **Angles are degrees** everywhere in the public API: Euler rotation accessors, `rotation2D`, joint limits, camera field of view, cone angles. Quaternions are available for precise work. The engine converts at the backend boundary.
- **Vectors from components are live views**: `transform.position` returns a vector bound to the transform's storage. `transform.position.x += 1` moves the node, and `transform.position = v` copies `v` in. Call `.clone()` to keep a snapshot. Live views are cached per component, so reading them doesn't allocate.
- Same rule for other component vectors (`rigidBody.velocity`, `collider.center`, …).

## Alternatives considered

- **Unity names only, or `GameBehavior` names only.** Aliases cost little and help Unity users.
- **Radians.** No conversion, but unfriendly in scene files and inspector fields.
- **Copy semantics (Unity).** Familiar, but a well-known source of bugs.

## Consequences

**Positive**
- Familiar for Unity users, with one of Unity's common pitfalls removed.

**Negative / costs**
- Holding a live view and later being surprised it changed (`const p = transform.position; …; p` is now different). Docs must stress `.clone()`.
- Alias surface to keep in sync.

## Deprecates

- Legacy `getBehavior(string)` lookups by class-name string (0009).

## Open questions

- None.

## References

- [0012](0012-ecs-storage-implementation.md) (storage behind live views)
