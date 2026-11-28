# 0464. One layer table maps physics layers to collision groups

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0005, 0162

## Context

ADR 0005 maps the project's named physics layers and collision matrix to backend collision groups (membership in the
high 16 bits, filter in the low 16). That mapping lived in four places: `physics/layers.ts` `layerGroups` (name →
groups), `worldServices.ts` `rayGroupsFor` (a ray query's groups), `PhysicsCore` `groupsFor`/`queryGroups` (colliders
and queries), and the audio occlusion pass, which called `rayGroupsFor` one layer at a time and repacked the bits by
hand. They disagreed:

- An unknown layer in a query: `PhysicsCore.queryGroups` warned and used layer 0, so `Physics2D.raycast(…, ["Nope"])`
  hit every collider on the first layer; `rayGroupsFor` threw (the occlusion pass caught it per layer, the editor's
  occlusion overlay caught it and cast at every layer).
- Repeated layer names (the settings keep them and report them, `settings.ts`): the matrix used `indexOf` (the first
  layer of the name) for bits, but the name → groups `Map` kept the last, so with `["Default", "Enemy", "Enemy"]` and a
  matrix, "Enemy" got the second Enemy's bit and filter 0 and collided with nothing.
- `layers.ts` hard-coded 16 where settings has `MAX_PHYSICS_LAYERS`.

No ADR said what a query naming an unknown layer does.

## Decision

We will map physics layers through one table, `src/engine/physics/layers.ts`:

```ts
layerTable(physics: { layers; collisionMatrix? }, warn?: (key, message) => void): LayerTable
interface LayerTable {
  names: readonly string[];
  indexOf(layer): number;                      // the first layer of that name; -1 when unknown
  groupsOf(layer): number;                     // a collider's groups; unknown: warn, use the first layer
  queryGroups(layers?: readonly string[] | null): number | undefined; // none: undefined (every layer)
}
filterOf(groups): number                       // the low 16 bits
```

- **Name → index is the first layer of that name**, for the bit and for the matrix.
- **A query's unknown layer warns once and matches nothing.** It adds no bit; a query naming only unknown layers hits no
  collider. A query is a filter the caller narrowed on purpose, so widening it to layer 0 (or to every layer) returns
  colliders the caller excluded. A collider on an unknown layer still falls back to the first layer with a warning (a
  collider must exist on some layer), unchanged.
- `MAX_PHYSICS_LAYERS` bounds the table; a matrix naming an unknown layer still throws (the settings parse reports it).
- Every caller uses the table: `PhysicsCore` (colliders, character controllers, raycast, castShape, overlap,
  overlapPoint) with its `warnOnce`; the occlusion pass through its environment's `physicsLayers(world)`; the editor's
  occlusion overlay. `rayGroupsFor` is removed.

## Alternatives considered

- **Throw on an unknown query layer** (as `rayGroupsFor` did) — a typo in a script's raycast would stop the frame; the
  physics API elsewhere warns and carries on.
- **Fall back to layer 0** (as `PhysicsCore` did) — silently returns hits on a layer the caller never asked for.

## Consequences

**Positive**
- One rule for unknown layers and repeated names; the occlusion pass and its overlay now cast the same groups.

**Negative / costs**
- Behaviour change: `Physics.raycast`/`castShape`/`overlap`/`overlapPoint` (2D and 3D) naming only unknown layers now
  return no hit instead of layer-0 hits; the warning now says the layer matches no collider.
- Behaviour change: a repeated layer name's colliders get the first layer's bit and the matrix's filter (they collided
  with nothing before).
- The editor's occlusion overlay leaves out unknown layers, as the pass does, instead of casting at every layer.

## Deprecates

`layerGroups` (replaced by `layerTable`), `rayGroupsFor` (callers use `layerTable(world.settings.physics).queryGroups`),
`PhysicsCore.queryGroups`, the occlusion pass's hand repacking and `OcclusionEnvironment.rayGroupsFor` (now
`physicsLayers`). All removed.

## As built

`src/engine/physics/layers.ts`; tests in `src/engine/tests/physicsLayers.test.ts` (the table),
`src/engine/tests/physics.test.ts` (`Physics2D.raycast` with an unknown layer; a repeated name meeting the matrix),
`src/engine/tests/raycastInto.test.ts` (the occlusion ray query) and `src/plugins/audio/runtime/core/occlusion.test.ts`.
