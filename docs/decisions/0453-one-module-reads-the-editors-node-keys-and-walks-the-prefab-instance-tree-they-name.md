# 0453. One module reads the editor's node keys and walks the prefab instance tree they name

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0086, 0122, 0242, 0258

## Context

The selection, Hierarchy rows, drops and tab views name a node of the open scene by a key: its document path joined
with "/" (`pathKey`), `id` for a scene node and `instanceId/innerId…` for a node inside a prefab instance. Reading a
key back was spread over the editor:

- `key.split("/")` in a dozen places (`state.ts`, `deleteSelection.ts`, `inspectorTarget.ts`, `nodeInsertion.ts`,
  `assetDrag.ts`, `selectionModel.ts`, `ui/Hierarchy.tsx`, `ui/HierarchyMenu.tsx`).
- "Is this key inside an instance" three times (`hierarchyDrop.ts`, `hierarchyEdit.ts`'s exported `isInsidePrefab`,
  inline in `assetDrag.ts`).
- "Is the node still there" two ways: the full check (the instance, then the inner node in it) in
  `inspectorTarget.ts` and `runtimeInspect.ts`, and a root-only check (`doc.has(key.split("/")[0])`) in
  `deleteSelection.ts`, `sceneTabs.ts`, `prefabTabs.ts`, `ui/HierarchyMenu.tsx` and `state.ts`.
- The instance's inner tree walked three ways: `prefabs.findInner`, `hierarchyDrop`'s `innerRow` and
  `selectionModel`'s `innerChain`.

The root-only check let a stale inner key through. A selected inner node can go while its instance stays (an undo
of an `addNodes` override, a `removeNode` written another way, the prefab edited in another tab), and its key stays
in `selectedKeys`. `deleteSelected` then took every selected key as inside a prefab and wrote a `removeNode`
override for each, so a node that wasn't there got a second, dangling `removeNode`.

## Decision

We will read node keys only through `src/editor/nodeKey.ts`, which also owns the inner tree they name:

- `parseKey(key): NodePath`, `rootOf(key)` (the scene node a key starts at), `isInnerKey(key)`.
- `innerAt(doc, key)`: the inner node a key names with its inner ancestors' keys and its parent row's key (its
  inner parent, or the instance), or null.
- `keyExists(doc, key)`: the scene node, or the inner node inside its instance, is in the document.
- `liveKeys(doc, keys)`: the keys still in the document, in order.
- `InnerNode`, `instanceInnerNodes(doc, id)` and `findInner(doc, path)` move here from `prefabs.ts`; one private
  walk (`innerTrail`) answers `findInner`, `innerAt` and `ancestorKeys`.

Every "still there" check uses `keyExists`/`liveKeys`: `deleteSelected` deletes only live keys (and does nothing when
none is left), restoring a tab's selection and Open Prefab's selection keep only live keys. Building a key stays
`pathKey` in the document module. The selection stays a list of keys in its own signal: 0242 rejected merging the
selections into one tagged signal, and this record only owns how keys are read.

## Alternatives considered

- **Put the helpers in `selectionModel.ts`** — keys are read by drops, tabs, visibility and the runtime inspector
  as well as the selection rules, and `state.ts` needs `parseKey`; `selectionModel` would drag the rules in.
- **Leave the inner tree in `prefabs.ts`** — `state.ts` reads keys, and `prefabs.ts` imports the node insertion and
  the edit gate, which import `state.ts`: a cycle. The inner tree depends only on the document, so it moves.

## Consequences

**Positive**
- A stale inner key can't reach an edit; deleting with one selected no longer writes a dangling override.
- One walk of the inner tree; `hierarchyDrop`, `selectionModel` and `prefabs` share it.

**Negative / costs**
- `prefabs.ts` importers of `findInner`/`instanceInnerNodes` now import them from `nodeKey.ts`.

## Deprecates

`hierarchyEdit.isInsidePrefab` (use `isInnerKey`), `hierarchyDrop`'s `innerRow`, `selectionModel`'s `innerChain`,
and `prefabs.ts`'s `findIn`; all removed.

## As built

`src/editor/nodeKey.ts`; tests in `selection.test.ts` ("leaves selected inner nodes alone once they're gone from the
instance" fails without the `liveKeys` filter in `deleteSelected`: it returned true and added a second `removeNode`;
"tells live keys from stale ones"). `nodeEdits.ts` keeps its `isInner(path)` on paths, not keys. Navigation code is
untouched.
