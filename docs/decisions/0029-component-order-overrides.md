# 0029. Prefab overrides can reorder a node's components

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0013, 0028

## Context

The Inspector reorders components by dragging. A node's component order isn't cosmetic: within one node, hooks run in the order the components were created (0007; the World breaks ties between behaviors on the same node by creation sequence). A plain node's order is its file order. A prefab instance's components come from the prefab, so the editor can't move them without an override, and the override kinds (0013, 0028) can't express order. Unity refuses to reorder components on prefab instances for the same reason.

Data components (0017) are stored apart from behaviors in the ECS, so their position in a file has no runtime meaning.

## Decision

We will add one optional key to override entries: `order`, a list of component ids. With a `target` (or none, for the instance root), it gives the order of that node's components. A type appears once per component of that type.

```json
{ "target": ["top"], "order": ["engine.BoxCollider2D", "engine.SpriteRenderer"] }
```

- **Loading:** the loader applies it in override order. Listed components come first in the listed order; components not listed follow in their existing order; listed types that aren't there are skipped. It reorders the node's component list and swaps the components' creation sequence numbers to match (`World._reorderComponents`), so hook order follows.
- **Editing:** the editor writes one `order` override per node, replacing any earlier one. It lists only scripts and engine components; Transform stays first, and an instance's data components stay where the prefab has them. When the new order matches the prefab's own order (worked out from the prefab file plus the instance's add and remove overrides), it removes the override instead. Removing a component takes its entry out of the order.
- **Apply:** on a plain prefab node, Apply rewrites the node's component list in that order, with Transform and data components keeping their places. On a nested instance it stays an override.
- **Plain nodes:** the Inspector shows a plain node's components in file order, and data components can be dragged among the rest there. That changes only the file layout.

The format version stays `tranquility.scene@1`. Like 0028, the key is additive: older files load unchanged, and an older engine can't load files that use it.

## Alternatives considered

- **Refuse to reorder on instances**, like Unity. Simplest, but it leaves no way to change hook order on one instance short of editing the prefab.
- **A "move" override** (`{ moveComponent: { type, index, to } }`). Several moves compose badly, and an index can mean a different component after other overrides run. A whole order is idempotent and easy to read.

## Consequences

**Positive**
- Dragging works the same on plain nodes and instances.
- The instance shows as modified only while its order really differs from the prefab's.

**Negative / costs**
- One more override kind, and a loader step that renumbers creation sequences.
- When the prefab's own order can't be worked out from files (a node inside a nested instance that has overrides of its own), returning to the original order keeps a redundant `order` override.

## Deprecates

Nothing.

## Open questions

None.

## References

- `src/engine/core/World.ts` (`_reorderComponents`), `src/engine/scene/SceneLoader.ts` (`OverrideEntry.order`), `src/editor/componentEdits.ts`, `src/editor/prefabs.ts` (Apply)
