# 0070. Runtime navigation cost volumes change path costs inside a box without rebaking

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0065, 0066

## Context

Navigation (0065) costs come from areas. `NavModifierVolume` sets an area on geometry only when it's baked, and the guide says games "don't bake at run time". At runtime, `Navigation.setAreaCost` changes an area's cost across the whole World, and an agent's `areaCosts` change it for that agent. `NavGate` opens or closes baked gate polygons. None of these can make one spot of the map, chosen during play, cost more: a fog cloud a player drops, a fire, a danger zone.

The query filter (`native/nav/crates/nav-query/src/filter.rs`) already carries per-search, per-polygon state that is rebuilt at runtime: `closed_gates`, `switched_off` and `congestion`. A cost multiplier per polygon fits the same pattern.

## Decision

- **Component** `NavCostVolume` (`src/engine/nav/components.ts`): an oriented box (`center`, `size`, the node's transform). `cost` is a multiplier ≥ 0, default 4. `excluded: boolean` makes the box impassable instead. `agents` lists the agent types it applies to (empty means all). `domain` is `ground | air | both`. Volumes take effect while the component is enabled, with no bake.
- **Runtime.** When a volume is added, removed, moved or changed (checked once per navigation step), the World's runtime recomputes a per-polygon cost table for each loaded navmesh chunk, per agent type the change affects. A polygon is inside a volume when its centre is inside the box. Overlapping volumes multiply, and excluded wins. Flight volumes get the same treatment per leaf.
- **Searches.** `NavMeshQueryFilter` gains `poly_costs: Option<&[f32]>`. Path, route, flow-field and hybrid searches multiply the cost of travel through a polygon by it. The A* heuristic is unchanged: it only uses the cheapest cost, and multipliers below 1 lower `min_area_cost` for that search. Excluded polygons are skipped like closed gates.
- **Agents re-plan.** Agents whose current corridor crosses a polygon whose cost changed re-plan on the next step, as they do when a gate closes. Static queries (`Navigation.findPath`) use the volumes in force when they run.
- **Multiplayer.** Volumes are scene nodes, so a server spawns them as ghosts and both ends see them. Navigation normally runs on the server only.
- **Debug:** `Navigation.debug.costs` tints polygons by their runtime multiplier.

## Alternatives considered

- **Re-bake the tiles under the volume at runtime.** That would give exact shapes, but the bake runs in a worker and takes tens to hundreds of milliseconds per tile. Nav data is also an asset that games load, not build.
- **A World-wide area cost** (`setAreaCost`). It exists, but it isn't local.
- **Avoidance obstacles.** They steer agents away locally, but paths still go through. Fog should make planners route around, not make agents bump along its edge.

## Consequences

**Positive**
- Danger zones, fog, fire and traffic can be shaped at runtime without a rebake.
- It reuses the pattern of the filter's existing per-polygon runtime state.

**Negative / costs**
- A Rust and WASM change: the committed `src/engine/nav/wasm/` must be rebuilt.
- Accuracy is per polygon. Big polygons on open ground (a whole ocean) give coarse edges. Tile and maximum-polygon-size settings control that.
- Each change recomputes the table for every chunk and agent type it touches. That's cheap for a handful of volumes, but hundreds of moving volumes would cost frame time.

## Deprecates

- Nothing.

## Open questions

- Shapes other than boxes (spheres, cylinders).
- Soft edges (a cost falling off with distance).

## References

- `native/nav/crates/nav-query/src/filter.rs`, `pathfinding.rs`; `native/nav/crates/nav-crowd/src/filters.rs`, `routes.rs`, `flow_agents.rs`
- `src/engine/nav/components.ts`, `NavigationWorld.ts`, `runtime.ts`; `docs/guide/navigation.md`
