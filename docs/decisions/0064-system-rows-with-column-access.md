# 0064. System rows give typed-array columns as well as per-row views

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0011, 0012, 0017, 0033

## Context

A system's `run(rows, ctx)` iterates rows (ADR 0017). Each row carries `node`, `transform` and one view per data component, and every field read or write on a view goes through a getter or setter. The 0012 benchmarks (`bench/ecs.bench.ts`) measured the cost at 50k agents:

| | ms per step |
|---|---|
| A seek system using views | 21.6 |
| The same maths over plain `Float32Array`s | 0.76 |

That's about 27× slower. In a profile, most of the gap is the view accessors. Next is the query: a generator that copies the smallest store's dense list on every run, and looks up `node` and `transform` for every row even when the system never reads them.

Data components are already stored as typed arrays indexed by entity (0012), one per field. Systems simply have no way to reach those arrays. Heavy systems need that access: navigation, crowds and particles on the CPU. So do engine modules that sync with WASM, such as physics today and a nav runtime later. Unity's equivalent is chunk iteration over component arrays.

## Decision

We will keep rows as they are and give the `rows` object column access:

```ts
defineSystem({
  name: "game.Seek",
  phase: "fixedUpdate",
  query: [Agent, Target],
  run(rows, ctx) {
    const a = rows.column(Agent);   // { x: Float32Array, …, speed: Float32Array }
    const t = rows.column(Target);
    for (const i of rows.indices) { // the matching rows' indices into the columns
      const dx = t.x[i] - a.x[i];
      // …
      a.x[i] += a.vx[i] * ctx.dt;
    }
  },
});
```

- **`rows` is a `Rows` object.** It is still iterable as before (`for (const row of rows)`), with the same filtering. `Rows` adds:
  - **`indices: Int32Array`**: the rows matched at the start of the run, as indices into the columns. Each index is the node's slot in the World. It's only meaningful with this run's columns. It isn't an identity to keep: slots are reused after a node is destroyed.
  - **`count`**: the number of rows.
  - **`column(def)`**: the data component's fields, as the typed arrays that store them, indexed by `indices`. Writes change the components directly. `def` must be one of the query's terms.
  - **`node(i)` and `transform(i)`**: the GameObject and Transform for an index, when you need them.
- **Columns are valid during this `run` only.** Adding the component to more nodes, or creating nodes, can grow and replace the arrays, so fetch columns again after doing either. Storage stays sparse by entity slot (0012), so reads follow the order of `indices` and aren't contiguous. Making them contiguous would be a storage change (dense packing or archetypes) that no measurement asks for yet.
- **Iterating rows gets cheaper as well, with no change to how it's written:**
  - `row.node` and `row.transform` are looked up only when read.
  - The matched rows are collected once per run into a reused buffer, instead of copying an array and checking each entity again inside a generator.
  - Views are unchanged.
- **Predicted systems (0033):** their filter (the ghosts this client predicts) applies when the rows are collected, so `indices` and iteration both see only those rows.
- **Column types:** `f32` fields come back as `Float32Array`, `i32` as `Int32Array`, `u8` as `Uint8Array`. A `bool` field is a `Uint8Array` of 0 and 1.

The same benchmarks found other costs, fixed without API change:
- **`world.activeScene`** copied and filtered the World root's children on every `GameObject.create` without a parent, which made creating nodes at the root quadratic. It now walks the root's children from the last.
- **World matrices** use an affine multiply. Transforms are always translation, rotation and scale, so the matrix's bottom row is fixed.

## Alternatives considered

- **Faster views only** (generated classes, field indices instead of names). They still cost a call per field, and they'd need `new Function`, which a strict content-security policy forbids. They'd narrow the gap, not close it.
- **Archetype/chunk storage with dense columns.** This is what Unity does. It would also make reads contiguous. But it rewrites storage, adding and removing components becomes more expensive, and nothing measured needs it yet. It can come later behind the same `column()` API.
- **Expose `world._dataStore(def).arrays` to user code.** It would work today, but it's an internal: no filtering, no rules on when arrays may be replaced, and it breaks if storage changes.

## Consequences

**Positive**
- Hot systems can run near plain typed-array speed.
- WASM modules can sync column data in bulk.
- Existing systems keep working and get somewhat faster.

**Negative / costs**
- **Two ways to write a system.** The docs have to say when columns are worth it: thousands of rows, or per-frame maths.
- **Raw slot indices are visible.** They're valid within a run only, and code that keeps them across frames will break.
- **Columns aren't change-tracked**, any more than views are. Replication reads current values each tick (0033), so that's unaffected.

## Deprecates

Nothing.

## Open questions

- Transform columns (position, rotation, scale), which need to mark world matrices dirty.
- `without` and optional query terms.
- Dense or archetype storage if contiguous reads become the bottleneck.

## References

- `bench/ecs.bench.ts`, docs/architecture/implementation-status.md (0012 row)
- Unity Entities `IJobChunk`/`ArchetypeChunk.GetNativeArray`; bitECS's typed-array component stores.
