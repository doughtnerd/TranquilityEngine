# 0278. One tree view draws the Hierarchy, the live Hierarchy and the asset folders

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0077, 0124, 0174, 0219, 0258

## Context

The editor had three tree widgets, each with its own caret, collapse, selection, drag and rename, and the differences showed:

| | scene nodes | UI elements | live World | folders |
|---|---|---|---|---|
| Rename / F2 | no | yes | yes | (tiles only) |
| drag | pointer (`nodeDrag.ts`) | pointer, its own loop (`uiElementDrag.ts`) | HTML5 `draggable` | – |
| `aria-level` | no | no | yes | no |
| arrow keys | no | no | no | no |

- `ui/Hierarchy.tsx` drew scene rows (`Row`, `TreeNode`, `InstanceNode`, `InnerTreeNode`) and UI element rows (`UIElementTreeRow`) separately; `ui/RuntimeHierarchy.tsx` drew live rows inline with HTML5 drag events; `ui/Assets.tsx` drew folders as nested buttons (`FolderItem`) that couldn't collapse.
- Three near-copies of the rename field (`UIElementRename`, `LiveRename`, the tiles' `RenameInput`) each implemented "commit once on Enter or blur, cancel on Escape".
- Scene nodes, the main case, could be renamed only in the Inspector; the Hierarchy menu had no Rename.
- ADR 0174 rules out dragging between windows, so nothing needed HTML5 drag's cross-window reach; it made the live tree the one tree without a drop indicator ghost and with a different feel.

## Decision

We will draw every tree with one tree view, `src/editor/ui/TreeView.tsx`, and let adapters supply each item set's rows and edits.

- **Interface.** `<TreeView tree label rows multiselectable? indent? />` over `TreeRow`s: key, label, children (needed only while open), `expandable`, `open`, `selected`, classes, row attributes (`data-key`, `data-entity`, `data-ui-key`, `data-drop-folder`, which drags and drops find rows by), icon, trailing content, the drop indicator (`drop`: into/before/after) and `dragging`; and the row's edits: `setOpen`, `select(how)` (toggle, range, the visible keys), `menu(x, y)`, `activate` (double-click), `rename` (`{ value, label, commit }` or null), `remove` (Delete), `drag(e)`. `renameRow(tree, key)` starts a rename from outside (a menu's Rename, a new live node).
- **The tree view owns** the DOM (`ul.tree[role=tree] > li[role=treeitem] > .row + ul[role=group]`, kept so existing selectors hold), carets (drawn with CSS, so a row's text is its name), collapse, the keys (Up/Down/Home/End move and select; Right opens or steps in; Left closes or steps out; F2 renames; Delete and Backspace remove; each handled key stops there instead of reaching the editor's shortcuts), renaming in place, the drop indicator classes, and ARIA: `aria-level`, `aria-expanded`, `aria-selected`, `aria-multiselectable`, one tab stop that roves to the row last focused.
- **One rename field.** `ui/RenameField.tsx` (focus with the name or its first `selectTo` characters selected; Enter or blur commits once; Escape cancels; uncontrolled so a refreshing tree doesn't reset typing). The tree view and the asset tiles use it.
- **Adapters.**
  - *Scene document* (`Hierarchy.tsx`: `sceneRows`, `innerNodeRow`, `nodeRow`): scene nodes, prefab instances and their inner nodes. Rename is `renameNode` (`nodeEdits.ts`), the Inspector's undoable document edit: `RenameNode` on a scene node, a `name` override inside an instance; an empty name changes nothing. The Hierarchy menu gains **Rename** (F2). Delete is `deleteSelected`.
  - *UI elements* (`uiElementRow`): keys `ui:<ref key>` so they mix with scene rows; rename edits the element's id in its markup.
  - *Live World* (`RuntimeHierarchy.tsx`): built nested from `liveRows`; edits are live edits (ADR 0124).
  - *Asset folders* (`Assets.tsx`: `folderRow`): folders now collapse (a folder holding the one showing stays open); F2 renames through `renameAsset`, Delete runs the Assets Delete command.
- **One drag gesture.** `src/editor/pointerDrag.ts` (`startPointerDrag(e, { move, end })`: threshold, the press's own window per ADR 0174, Escape, cancel) under the node drag, the UI element drag and a new live drag. The live tree drops by pointer onto a row (reparent) or the World header (top level), with the same ghost label as the other drags. Drop geometry stays the Hierarchy drop module's (ADR 0258).

## Alternatives considered

- **A generic `TreeAdapter<T>` interface with one adapter object per tree** — a tree mixes item sets (a node's UI elements sit under its children), so rows carry their own edits instead; the adapters are the functions that build them.
- **Keep HTML5 drag for the live tree** — its only advantage, crossing windows, is ruled out by ADR 0174; it lacked a ghost and couldn't share the threshold and Escape rules.
- **A third-party tree component** — the editor uses one UI library (Preact); the tree's hard parts (drop geometry, prefab inner rows, live refresh) are ours either way.

## Consequences

**Positive**
- Scene nodes rename in place (F2, double-click is left to the badge, the menu's Rename) and every tree has arrow keys and the same ARIA.
- One fix fixes every tree; one set of story tests (`TreeView.stories.tsx`, `Hierarchy.stories.tsx`).
- The live tree's drag behaves like the others (threshold, Escape, a ghost saying what releasing will do).

**Negative / costs**
- Focus now lands on the tree item a click selects, so Delete in the Hierarchy reaches the tree's handler first (it runs the same `deleteSelected`).
- The live tree loses `draggable` attributes; a test that read them now checks the drag's result.

## Deprecates

Removed: `Hierarchy.tsx`' `Row`, `TreeNode`, `InstanceNode`, `InnerTreeNode`, `UIDocumentElements`, `UIElementTreeRow`, `UIElementRename`, `clickRow`, `rowMenu`; `RuntimeHierarchy.tsx`' `LiveRename`, the HTML5 drag handlers and the `renaming`/`dropOn` signals; `Assets.tsx`' `FolderItem` and its own rename field body; `uiElementDrag.ts`' `renamingUIElement`; the pointer loops in `nodeDrag.ts` and `uiElementDrag.ts` (now `pointerDrag.ts`).

## Open questions

- Shift+Up/Down to extend a selection, and type-ahead to jump to a row, aren't built.

## References

- `src/editor/ui/TreeView.tsx`, `ui/RenameField.tsx`, `ui/tree.css`, `src/editor/pointerDrag.ts`, `ui/Hierarchy.tsx`, `ui/HierarchyMenu.tsx`, `ui/RuntimeHierarchy.tsx`, `ui/Assets.tsx`
- Stories: `src/editor/ui/TreeView.stories.tsx`, `ui/Hierarchy.stories.tsx`; e2e: `hierarchy.spec.ts`, `playdebug.spec.ts`, `assetbrowser.spec.ts`, `dragdrop.spec.ts`
