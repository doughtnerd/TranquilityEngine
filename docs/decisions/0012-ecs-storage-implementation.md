# 0012. ECS storage implementation

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0008, 0010, 0017, 0019

## Context

0007 makes the core an ECS but hides it from game code. That changes what the ECS needs to be good at:

- **Built-in data components** (Transform, Hierarchy, RigidBody state, render-sync handles) are touched by engine systems every frame and benefit from compact storage, ideally typed arrays.
- **User GameBehaviors** are class instances with methods and arbitrary fields. They can't live in typed arrays; the ECS only needs to store references and index them by type and by implemented hook.
- Queries the engine needs: "all entities with Transform + Renderer", "all behaviors implementing `update`", "components of type T on entity E", "children of E".
- Structural changes are deferred to end of frame (0011), so the store doesn't need to support adding/removing during iteration.

Existing libraries take different trade-offs: bitECS (typed-array, function-based API, very fast), koota (pmndrs, trait-based), miniplex (object-based, simple, plays well with React/three), becsy (multithreading-oriented). None is built around "MonoBehaviour objects as components" plus "typed-array built-ins".

## Decision

- The engine defines its own small **`World` interface** that core systems and the scripting facade use: entity create/destroy, add/remove/get component, queries with cached results, deferred command buffer, and a stable-id ↔ entity map. A stable subset of it is public for user systems (0017).
- **Before building it, a benchmark spike** compares a minimal in-house sparse-set store against bitECS on the engine's hot paths (transform propagation and render sync for 10k nodes, add/remove churn). The in-house design goes ahead unless the spike shows a large gap.
- The first implementation is **in-house, using sparse sets**:
  - One sparse set per component type (entity → dense index).
  - **Built-in hot components** use struct-of-arrays storage on typed arrays (`Float32Array` for positions, rotations, scales, world matrices). The public `Transform` is a facade that reads and writes those arrays.
  - **User data components** (0017) use the same struct-of-arrays storage for numeric fields.
  - **GameBehavior components** use a dense array of object references per class.
  - Per-hook registries (`update`, `fixedUpdate`, …) list behaviors that implement that hook, kept in node order (0007).
- Entity ids are generational (index + generation) so stale handles are detected. `GameObject` handles check the generation on access and throw a clear error on a destroyed node.
- Swapping in a library later (bitECS or koota for built-ins) stays possible because only the `World` implementation changes.

## Alternatives considered

- **Adopt bitECS (or koota) directly.** Fast built-ins for free. But GameBehavior objects, hook registries, hierarchy order and the deferred command buffer would still be engine code on top, and the library's API would leak into core. Worth benchmarking before the decision is accepted.
- **miniplex / plain object storage for everything.** Simplest, close to the legacy design, but loses the typed-array benefit for transforms and physics sync, which are the engine's hottest paths.
- **Archetype-based storage.** Fastest iteration for many component combinations, but costly add/remove and more complex. Sparse sets suit a node graph where components change often.

## Consequences

**Positive**
- Storage fits the engine's two kinds of components exactly.
- No third-party ECS API leaks into the engine core.

**Negative / costs**
- Engine-owned code to write, test and optimize.
- Facades over typed arrays add indirection on every script access to `transform.position`. Mitigation: cached live vector views that write through (0019).

## Deprecates

- `GameObject.behaviors: Map` and `Scene.gameObjects: GameObject[]` as the storage model.
- `Scene.findObjectOfType` / `findObjectsOfType` linear scans; replaced by per-type storage lookups.

## Open questions

- ~~In-house vs bitECS/koota.~~ Resolved: in-house, benchmark spike first (above).
- ~~Live view or copy for `transform.position`.~~ Resolved: live view ([0019](0019-public-api-conventions.md)).

## References

- Sparse sets in EnTT: https://skypjack.github.io/2019-03-07-ecs-baf-part-2/
