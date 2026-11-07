# 0017. User systems and data components in v1; no engine event system

- **Status:** Accepted, amended by 0032 (several Worlds, each with its own loop, clock and tick rate)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0007)
- **Related:** 0007, 0011, 0012

## Context

0007 hides the ECS behind lifecycle scripts and leaves an opt-in system API for later. Two owner decisions change that:

1. **User-defined systems ship in v1** as an advanced, opt-in API.
2. **No engine event system.** Behaviors that need to communicate should, in data-oriented fashion, write to a buffer or a component that something else reads, or call methods directly. A signal/event bus is added only if it becomes truly necessary.

Together these mean user code needs a data-oriented way to communicate: data components and buffers that both systems and behaviors can read and write.

## Decision

- **Data components**: plain-data components declared with a schema. Numeric fields are stored in typed arrays (0012); other field types are stored as references.

  ```ts
  export const Velocity = defineComponent("game.Velocity", { x: f32, y: f32, z: f32 });
  export const Health   = defineComponent("game.Health",   { current: f32, max: f32 });
  ```

- **Buffers**: per-frame, append-only queues of plain records, for "something happened" data. Each buffer has a defined clear point (default: end of frame after all readers ran).

  ```ts
  export const DamageEvents = defineBuffer<{ target: GameObject; amount: number }>("game.Damage");
  ```

- **Systems**: user functions registered into the frame phases of 0011, with ordering constraints.

  ```ts
  defineSystem({
    name: "game.ApplyVelocity",
    phase: "fixedUpdate",            // fixedUpdate | update | lateUpdate
    after: ["engine.PhysicsWriteBack"],
    query: [Transform, Velocity],
    run(rows, ctx) {
      for (const r of rows) r.transform.position.addScaled(r.velocity, ctx.time.fixedDeltaTime);
    },
  });
  ```

- **Behaviors can use the same data**: `this.node.addData(Health, { current: 10, max: 10 })`, `this.node.getData(Health)`, `DamageEvents.push({ … })`, `for (const e of DamageEvents.read()) …`.
- **Communication between behaviors**: method calls (`other.getBehavior(Health).damage(5)`) or data (components/buffers). The engine provides **no** signal or event bus.
- **Engine-originated notifications stay as lifecycle hooks** (`onCollisionEnter`, `onTriggerEnter`, …, 0007) for scripts, and are **also** exposed as engine buffers (`CollisionEvents`, `TriggerEvents`) for systems.
- Scene loading progress, previously an `EventEmitter` event, becomes a promise with a progress callback: `await SceneManager.load(path, { onProgress })`.
- The user-facing system/query API is a **stable public subset** of the internal `World` interface (0012). Internal-only operations stay private.

## Alternatives considered

- **User systems later (0007's original stance).** Rejected by owner: data-oriented users should have systems in v1.
- **Typed signals (Godot).** Familiar and traceable, but adds an event model next to the data model. Not needed if data and method calls suffice.
- **Global event bus.** Easy, hard to trace, and not data-oriented.
- **Systems that query behavior objects.** Simpler but not data-oriented, and couples systems to script classes.

## Consequences

**Positive**
- Data-oriented users get real ECS tools; script-only users never need to see them.
- One communication model (data), plus plain method calls.
- Collision data is available to both scripts and systems.

**Negative / costs**
- The `World` query API becomes a public contract in v1 and must be designed for stability.
- Two ways to hold state (behavior fields vs data components) to document; guidance: data components for state that systems process, behavior fields for script-private state.
- Buffer clear points must be clear to avoid "event read twice / missed" bugs.

## Deprecates

- The `events` (Node `EventEmitter`) dependency and its uses in `SceneManager.ts`, `AudioPlayer.js` and `Damageable.js`.
- 0007's statement that a user system API comes later.

## Open questions

- Whether buffers may be read in the frame after they are written (double-buffering) for systems that run before the writer.
- Schema field types beyond numbers (strings, node references, enums) and how they serialize (0013).

## References

- [0007](0007-hidden-ecs-with-lifecycle-scripting.md), [0012](0012-ecs-storage-implementation.md)
