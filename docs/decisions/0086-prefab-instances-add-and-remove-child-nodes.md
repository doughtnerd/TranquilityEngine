# 0086. Prefab instances can add and remove child nodes as overrides

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0022, 0026

## Context

0013 promises overrides for added and removed child nodes, but only fields, components, name, active, tags, worlds and order exist. Deleting or creating a node inside an instance was refused.

## Decision

We will add two override forms. `addNodes: NodeEntry[]` is a flat subtree in the scene file's node shape; entries with no `parent` become children of the node `target` names (the instance root when empty). `removeNode: true` with a non-empty `target` removes that node and its subtree. Added ids are registered in the id scope of the instance (or nested instance) the target is in, so later overrides can target them (`target: ["<added id>"]`), and must not repeat a prefab id (reported as a problem). The editor adds them with `addInnerNode` and `removeInnerNode` (`prefabs.ts`): removing a node the instance added edits its `addNodes` override (and drops overrides aimed at it); removing a prefab node adds a `removeNode`, dropping overrides aimed at it. Apply writes them into the prefab file (added nodes become children of the target; removed nodes are deleted; inside a nested instance they stay overrides there).

## Alternatives considered

- **Hide removed nodes instead of destroying** — leaves them in physics and queries.
- **Nested `children` inside the override** — differs from the file's flat shape.

## Consequences

**Positive**
- Instances can differ structurally without breaking the link to the prefab.

**Negative / costs**
- `$node` references from an added node resolve within the added nodes and to top-level scene nodes only, not to prefab-internal nodes.
- The Hierarchy's delete/create commands for rows inside an instance are not yet routed to these helpers (API and loader are done).

## Deprecates

Nothing.

## Open questions

- Reordering added nodes among the prefab's children.

## References

`src/engine/scene/SceneLoader.ts` (`addNodes`), `src/editor/prefabs.ts`.
