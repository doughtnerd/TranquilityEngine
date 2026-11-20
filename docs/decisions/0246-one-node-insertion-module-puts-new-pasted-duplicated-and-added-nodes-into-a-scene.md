# 0246. One node insertion module puts new, pasted, duplicated and added nodes into a scene

- **Status:** Accepted, amended by 0258 (Hierarchy drops on rows inside an instance insert `addNodes` overrides; drop geometry has its own module)
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0086, 0146, 0147, 0149, 0226, 0241 (amends 0146: what a Hierarchy create entry is used for; amends 0147: `editor.scene.uniqueId` and `idBase` go; amends 0149: `AssetSceneNodes.nodes` returns node templates and `addAssets` inserts through this module)

## Context

Four modules put nodes into the scene document, and each decided the id, the name, the place and the refusal itself:

- `nodeCreate.ts` (`newNodeEntry`, `uniqueNodeName`, `whyNotCreatable`, `createNode`) for the Create menus;
- `nodeClipboard.ts` (`freshId`, `entriesForPaste`, `whyNotPlaceable`, `pasteTarget`, `addCopies`, `duplicateNodes`) for paste and duplicate;
- `assetNodes.ts` (`uniqueId`, `parentForAdd`, `spriteNodeEntry`, `audioNodeEntry`, `prefabInstanceEntry`, `addAssetEntries`) for adding assets (ADR 0149);
- `prefabs.ts` (`addInnerNode`, `freeInnerId`, and Create Prefab from several nodes with its own `fresh` id).

The rules had drifted:

- **Two id schemes.** `uniqueId` kept the base and appended `-2` (`bird-2` taken → `bird-2-2`); `freshId` stripped a `-N` suffix first even when the id was free (a copy of `walk-0` became `walk`). `freeInnerId` and Create Prefab had a third and fourth copy of the loop.
- **Names.** Created and pasted roots got sibling-unique names (`Node (1)`), added assets did not. `charAt(0).toUpperCase() + slice(1)` was copied four times (two in `assetNodes.ts`, Particles' `particleNodeEntry`, Meshes' `modelNodeEntries`).
- **Three placement rules.** `pasteTarget` (after the selection), `parentForAdd` (under the selection, beside a prefab instance) and `besideRow` in `ui/HierarchyMenu.tsx`, a copy of `pasteTarget`'s body.
- **Prefab interiors.** Create under a node inside an instance made an `addNodes` override (ADR 0086), paste refused ("nodes inside a prefab get children in the prefab"), and the Assets panel's + went beside the instance.
- **Plugins minted ids.** `editor.scene.uniqueId` and `idBase` (ADR 0147) existed so asset kinds' `addToScene.nodes(doc, path, position)` could build whole `NodeEntry`s. Particles described its node twice (the Hierarchy create entry's `components` and `particleNodeEntry`).
- **A kind by name.** `hierarchyActions.ts`' `createNodeIn` special-cased `"ui-document"` to write the document first.
- The play-mode refusal was worded in six places.

## Decision

We will put every insertion in one module, `src/editor/nodeInsertion.ts`. It takes **a source** and **a place**, inserts as one undo step, and returns the new keys or one reason.

- **Interface.** `insertNodes(scene, source, place)` → `{ ok: true, keys, entries } | { ok: false, reason }`; `whyNotInsert(scene, source, place)` is the same check without the edit, for menus and drags. `keys` are the new roots' selection keys (`instance/id` inside an instance); `entries` are what each root's subtree became (for asset kinds' `note`). Duplicate has no place argument: each copy goes right after its original.
- **Sources.** `{ kind: "new", node, position?, asset? }` (a built-in or contributed node kind); `{ kind: "copies", clipboard }` (paste); `{ kind: "duplicate", keys }`; `{ kind: "assets", paths, position?, placeInstances? }` (each kind's `addToScene.nodes`); `{ kind: "template", nodes, label }` (the shell's own: Create Prefab's group instance). Every source resolves to subtrees of node templates or clipboard entries; nothing outside the module writes an id.
- **Places.** `{ kind: "into", key, index? }` (null key: the top level), `{ kind: "after", key }` (right after the row; a row inside an instance means after its instance; null: the end of the scene), `{ kind: "near", key }` (into the node, or after it when it is a prefab instance or inside one: the Assets panel's +). **Into a node inside an instance** makes an `addNodes` override (ADR 0086) for every source, create, paste and assets alike; references from the inserted nodes to nodes outside them become None there, since an override's nodes resolve inside the instance. An override has no order, so `index` is ignored inside an instance.
- **Ids: one scheme.** The `DASHED` numbering of `engine/core/uniqueName.ts`: the base if free, else the base less any `-N` with the first free number from 2 (`bird` → `bird-2`, `bird-2` → `bird-3`, a free `walk-0` stays). Taken means used in the document, or inside the instance (its prefab files' ids and its other added nodes) for an override. A template root's base comes from its name, or from the asset's file name for an asset; a template descendant's from its root's id and its own name (`robot-wheel`); a copy's from its old id.
- **Names.** Every inserted root without `prefab` gets a name unique among its new siblings (`BRACKETED`: `Name (1)`), assets included; an asset root's name is the file name less its kind's extension (or the slice name), capitalised once, here. Instance roots keep the prefab's name.
- **References.** Parents and `{"$node"}` references inside the inserted nodes are re-pointed at the new ids; other references are kept only when pasting into the scene they came from (ADR 0022), else None.
- **Refusals,** each worded once: no scene, play mode, a gone node, nothing copied, a node kind no plugin registers, folders, an asset kind's `addToScene.whyNot`, a prefab that would end up inside itself, a pasted instance of a prefab the project lacks (ADR 0226; not for duplicate, whose scene already has it), and `whyNotCopyable` for duplicate.
- **Node templates.** `NodeTemplate` (in `myco/editor`) is a node entry with no id whose `parent` is the index of an earlier template. `AssetSceneNodes.nodes(path, position)` returns templates and no longer takes the document; Particles' and Meshes' kinds return templates and stop naming roots. A Hierarchy create entry (ADR 0146) still supplies `name` and `components(position, asset)`; Particles' asset kind reuses the same components function. The built-in UI Document kind and contributed kinds declare "write an asset first" the same way (`nodeKinds.ts`' `kindAssetCreator`), so `createNodeIn` names no kind.
- **What stays.** `nodeKinds.ts` (renamed from `nodeCreate.ts`) is the catalogue of kinds and their templates. `nodeClipboard.ts` keeps copy, cut and the clipboard text. `addAssets.ts` keeps preparing, the stale-scene guard, notes and the message, then inserts. `prefabs.ts`' Create Prefab of one node replaces it in place with the same id (a conversion, not an insertion) and keeps its two commands. Hierarchy drop geometry (`assetDrag.ts`' `hierarchyDrop`, shared with node moves) still refuses drops on rows inside an instance.

## Alternatives considered

- **Keep the four paths and share helpers** (one id function, one place function) — the callers would still each decide which rules apply; the drift came from exactly that.
- **Keep `uniqueId`'s scheme** (`bird-2` → `bird-2-2`) — duplicating a duplicate grows ids; `freshId` existed to avoid it. Keeping `freshId`'s instead renames a free `level-1` to `level`.
- **Give plugins `editor.scene.insert`** — no plugin inserts nodes itself today; contributions describe nodes and the shell places them. Left for when a plugin needs it.

## Consequences

**Positive**
- One rule per insertion question; menus, shortcuts, drops and plugins can't disagree.
- Plugins describe nodes (components, templates) and never mint ids or names.
- Paste into a prefab interior works like create there.
- One test surface, `nodeInsertion.test.ts`, for every path.

**Negative / costs**
- Public editor SDK change: `editor.scene.uniqueId`/`idBase` removed, `AssetSceneNodes.nodes` has a new signature. Only first-party plugins used them.
- Small visible changes: added assets get sibling-unique names; a particle effect's node id drops `-particles` (`smoke-puff`); the + beside an instance goes right after it rather than last; a copied `bird-2` pastes as `bird-3`, not `bird`.

## Deprecates

Removed: `createNode`, `whyNotCreatable`, `uniqueNodeName`, `newNodeEntry` (`nodeCreate.ts`, renamed `nodeKinds.ts`); `freshId`, `entriesForPaste`, `whyNotPlaceable`, `whyNotPastable`, `pasteTarget`, `PasteTarget`, `addCopies`, `pasteNodes`, `duplicateNodes` (`nodeClipboard.ts`); `assetNodes.ts` entirely (`idBase`, `uniqueId`, `parentForAdd`, `prefabInstanceEntry`, `spriteNodeEntry`, `audioNodeEntry`, `addAssetEntries`, `whyNotAddable`, `prepareAssets` moves into `addAssets.ts`); `addInnerNode` and `freeInnerId` (`prefabs.ts`); `besideRow` (`ui/HierarchyMenu.tsx`); `particleNodeEntry`; `editor.scene.uniqueId`/`idBase`.

## Open questions

- ~~Should Hierarchy drops on rows inside an instance become overrides too? That needs drop geometry for inner rows, shared with node moves, which stay refused there.~~ Yes (ADR 0258): `hierarchyDrop.ts` owns the geometry; the middle of an inner row inserts into it, its edges into its parent; moving scene nodes there is refused with one reason.

## References

- `src/editor/nodeInsertion.ts`, `src/editor/nodeKinds.ts`, `src/editor/nodeInsertion.test.ts`
- ADR 0086 (`addNodes` overrides), 0149 (adding assets), 0226 (clipboard text)
