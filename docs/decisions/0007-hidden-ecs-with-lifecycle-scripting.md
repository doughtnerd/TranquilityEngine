# 0007. Hidden ECS core, lifecycle-method scripting

- **Status:** Accepted, amended by [0017](0017-user-systems-and-data-components.md) (user systems ship in v1; no engine event system)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0008, 0009, 0011, 0012, 0017, 0018

## Context

The engine's audience is developers who think in Unity's MonoBehaviour model: attach a script to an object, implement `awake`/`start`/`update`, call `getComponent`. That model is easy to learn but, implemented naively (as in the legacy code: arrays of objects, each with a `Map` of behaviors, iterated every frame), it scales poorly and makes engine-wide passes (transforms, physics sync, rendering) awkward.

ECS (entities as ids, components as data, systems as loops over component sets) gives the engine clean, fast, testable internal passes and makes serialization and queries straightforward. But ECS is unfamiliar to many game developers and changes how game code is written.

The legacy `GameBehavior` already defines a Unity-like hook set (`awake`, `onEnable`, `start`, `fixedUpdate`, `update`, `lateUpdate`, `onDisable`, `onDestroy`, trigger hooks, and a list of rendering hooks that are never called).

## Decision

- The engine core is an **ECS**. Entities are ids; components live in engine-managed storage (0012); systems run in a fixed order (0011).
- **ECS is hidden from game code.** Game developers write `GameBehavior` subclasses with lifecycle methods. Each `GameBehavior` instance is a component on an entity.
- A built-in **lifecycle system** finds behaviors that implement each hook and calls them at the right point in the frame. Behaviors that don't implement a hook cost nothing for that hook (the system indexes by implemented hooks, rather than calling empty methods).
- Built-in engine features (Transform, RigidBody, Collider, renderers, audio) are implemented as **internal data components + systems**, not as GameBehaviors. Game code accesses them through the same `getBehavior`/`getComponent` API, which returns a typed facade.
- **Lifecycle contract** (Unity-aligned):

  | Hook | When |
  | --- | --- |
  | `awake()` | Once, when the behavior is created and its node is in a loaded scene, even if disabled. |
  | `onEnable()` | Whenever the behavior becomes active in the hierarchy. |
  | `start()` | Once, before the first `update` after the first enable. |
  | `fixedUpdate()` | Every fixed step, before the physics step. |
  | `update()` | Every frame. |
  | `lateUpdate()` | Every frame after all `update`s. |
  | `onCollisionEnter/Stay/Exit`, `onTriggerEnter/Stay/Exit` | After the physics step that produced the event. |
  | `onDisable()` | Whenever the behavior stops being active in the hierarchy, and before destroy. |
  | `onDestroy()` | Once, at end of frame when the behavior or its node is destroyed. |

- Within one hook, call order follows the node graph order (depth-first) unless a behavior declares an explicit `executionOrder`.
- Structural changes (create/destroy nodes, add/remove components) made during a hook are **deferred** to safe points so systems never iterate over changing storage.
- Rendering hooks that the engine can't implement meaningfully with three.js (`onPreCull`, `onRenderImage`, `onGUI`, …) are removed. Hooks are added back only when there is a real implementation.

## Alternatives considered

- **Classic object model (legacy approach).** Simple, but every engine pass walks object graphs and maps; no clean separation between data and behavior; hard to serialize.
- **Expose ECS directly (bitECS-style systems in game code).** Fastest, but abandons the core goal of approachable Unity-like scripting.
- **Both models side by side as equals.** Doubles the API surface and documentation. An opt-in advanced "custom systems" API may still come later ([open questions](../architecture/open-questions.md)).

## Consequences

**Positive**
- Familiar scripting for users; clean, fast internal passes for the engine.
- Serialization, queries (`findObjectsOfType`) and tooling work off component storage.

**Negative / costs**
- User scripts are still objects with methods, so per-script `update` calls don't get ECS's cache-friendly speed. Hot engine paths stay fast; heavy user logic is the user's cost, as in Unity.
- A facade layer to maintain between handles and storage.
- Deferred structural changes must be documented clearly (e.g. a destroyed node is still readable until the end of the frame).

## Deprecates

- `Scene.update/lateUpdate/start/awake` loops over `gameObjects` and `getBehaviors()`: replaced by the lifecycle system.
- Unimplemented rendering hooks in `GameBehavior.js`.
- `GameBehavior.init(properties)` attribute assignment: replaced by typed, registry-driven component initialization from scene data (0013).

## Open questions

- ~~Opt-in API for user-defined systems.~~ Resolved by [0017](0017-user-systems-and-data-components.md): yes, in v1.
- ~~Coroutines / async hooks.~~ Resolved by [0018](0018-promise-based-waits.md): promise-based waits.

## References

- Unity execution order: https://docs.unity3d.com/Manual/ExecutionOrder.html
