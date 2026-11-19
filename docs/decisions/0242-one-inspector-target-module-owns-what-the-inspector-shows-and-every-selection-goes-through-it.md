# 0242. One Inspector target module owns what the Inspector shows, and every selection goes through it

- **Status:** Proposed
- **Date:** 2026-11-09 (rebuilt on current master 2026-11-19)
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0025, 0040, 0077, 0124, 0147, 0174, 0235, 0241 (amends 0040's "the Inspector shows an asset when no node is selected": any selection of one inspectable asset now shows it)

## Context

> **Rebuilt on current master.** This record was written on an unmerged branch (as its ADR 0162) and rebuilt on the
> 2026-11-19 editor. The design is the branch's; what differs is listed under "Rebuilt on master" below.

The Inspector shows one thing: a live World's node while playing (0022, 0124), an asset (0040, 0133), a UI document element (0077), the selected nodes, or the open scene's settings. Those come from three selections kept apart by hand in four places:

- `state.select` cleared the UI element, and the Assets panel's selection when nodes were selected.
- `uiDocuments.selectUIElement` cleared the nodes and the assets.
- `ui/Hierarchy.tsx`'s `showSceneSettings` cleared the nodes and the assets.
- `assetImport.inspectSelectedAsset` cleared the nodes, but only when a caller remembered to call it after selecting assets. The panel's click and arrow keys did; `showAsset` did; New Folder, the kinds' create items, Paste, Duplicate, Rename and plugin actions (all `assetActions.ts`) didn't, so a material just made stayed behind the node still selected.
- `assetDrag.ts` set `selectedKeys` directly after a drop, skipping every rule: a UI element still selected kept the Inspector.

The priority (live, then asset, then UI element, then nodes, then scene settings) was hard-coded in `ui/Inspector.tsx`, and "which asset the Inspector shows" (`inspectedAsset`, `showsAssetInspector`) lived in `assetImport.ts`, the sidecar module.

## Decision

We will add `src/editor/inspectorTarget.ts`, which owns the rule between the selections and answers what the Inspector shows. It sits above `state.ts`, `assetSelection.ts`, `uiDocuments.ts` and `runtimeInspect.ts`, which keep the selections' signals as storage.

**What it shows.** `inspectorTarget` is a computed tagged value:

```ts
type InspectorTarget =
  | { kind: "live"; world: string; node: GameObject | null } // playing, a live World picked (0022, 0124)
  | { kind: "asset"; path: string }                          // the file; a selected slice shows its image
  | { kind: "uiElement"; ref: UIElementRef }                 // 0077
  | { kind: "nodes"; scene: OpenScene; paths: readonly NodePath[] } // those that still exist, active last
  | { kind: "sceneSettings"; scene: OpenScene }
  | { kind: "nothing" };                                     // no scene open
```

`ui/Inspector.tsx` switches over it. `AssetInspector` takes the path as a prop.

**Selecting goes through it.** Every selection source calls one of its functions, which applies the rule; no caller makes a follow-up call:

- `select(keys, active?)`: nodes (the Hierarchy, the viewport, commands, the editor SDK's `selection.set`, an asset drop). Clears the UI element; non-empty, also clears the Assets panel's selection.
- `selectAssets(entries, focus?, anchor?)`: the Assets panel (clicks, the press that may start a drag, arrow keys, a box when let go, every command that selects what it made). `previewAssets(entries)` shows a box's entries while it is dragged, touching nothing else. If the result is one entry the Inspector can show (`inspectableAsset`), the nodes and the UI element are cleared; otherwise they stay (two materials, a scene file or a script don't take the Inspector from the node).
- `selectUIElement(ref)`: clears the nodes and the assets.
- `showSceneSettings()`: clears all three (the Hierarchy's scene row).
- `showAsset(path)`: opens its folder and selects it alone (the SDK's `editor.project.reveal`, Select Asset buttons).

The live World stays an overlay rather than a selection: `runtimeInspect.ts` keeps `inspectWorld`, `liveInspecting` and `endLiveInspection` (`session.ts` calls it on Stop, unchanged); while a live World is picked it wins, and the scene's selection is there again when it isn't.

**Moves.** `select` leaves `state.ts` and `selectUIElement` leaves `uiDocuments.ts` for this module. `state.selection` becomes read-only (`value`, `peek()`); writers call `select`. `assetSelection.ts`'s setter is renamed `setPanelSelection` and documented as this module's (the panel uses it only to clear, which needs no rule); `select` there is gone. `inspectableAsset` moves here (private); `inspectedAsset`, `showsAssetInspector` and `inspectSelectedAsset` are deleted. `assetImport.ts` keeps the sidecar read/write (`readImportSettings`, `writeImportSettings`, `sameSettings`) and the Sprite Editor's open image (`spriteEditorImage`, `openSpriteEditor`), since the Sprite Editor edits a sidecar's slices; `spriteSlicing.ts` stays pure.

**The SDK.** `editor.scene.selection` (0147) keeps its contract: `set` calls `select`, the readers are unchanged.

### Rebuilt on master

- **Nothing exported for tests.** The branch exported `inspectableAsset` and an `assetDrag.ts` `dropAssets` only so its
  tests could call them. Here `inspectableAsset` stays private to `inspectorTarget.ts` (master had made it private in
  `assetImport.ts`), and tests ask which assets the Inspector shows through `selectAssets` and `inspectorTarget`. The
  asset drop calls `select` on the nodes it added inside `startAssetDrag`, with no new export; that it goes through the
  rule is covered by `select`'s tests, and the drop itself by the `assetbrowser` and `dragdrop` e2e specs.
- **Box selection previews.** A box dragged in the Assets panel shows its entries with `previewAssets` (the panel's
  selection only) and selects through `selectAssets` when let go, so Escape never deselects the scene's nodes (the
  branch's review fix).
- **Which nodes still exist** is this module's: master's `nodeEdits.existingPaths`, which only the Inspector used, moves
  into `inspectorTarget` (importing `nodeEdits.ts` from here would have pulled the plugins into the SDK's imports).
- **Per-panel browsing (ADR 0174).** `showAsset` opens the asset's folder in the last-used Assets panel copy.
- **Import settings.** `assetImport.ts` keeps `readImportSettings`, `writeImportSettings`, `sameSettings` and the
  Sprite Editor's image; `hasImportSettings` is gone (the rule reads the kind's `importSettings` itself).
- **The story harness (ADR 0235)** clears the selections with `showSceneSettings` between stories.

## Alternatives considered

- **Keep the setters where they are and have each call a shared `claim(source)`.** `state.ts` would import the module that imports `state.ts` (a cycle), and `assetSelection.select` would still be callable without it.
- **One signal holding a tagged selection** (`{ kind: "nodes", keys } | { kind: "assets", entries } …`). The rule that an uninspectable asset selection leaves the nodes alone needs both kept at once, and `selectedKeys` has some sixty readers.
- **An effect that clears the others when one changes.** Order-dependent and invisible at the call site.

## Consequences

**Positive**
- One place says which selection wins and one switch renders it; every source follows the rule by construction, so assets made, pasted, duplicated or renamed show in the Inspector, and an asset drop clears a selected UI element.
- `inspectorTarget.test.ts` covers every source through the module headlessly.
- `assetImport.ts` is about sidecars only.

**Negative / costs**
- About twenty files change an import (`select` from `inspectorTarget`), and tests that set `selection.value` call `select` instead.
- Creating or pasting one asset now replaces the node in the Inspector, which is what Unity does but is a visible change. So does pressing an asset to drag it (before, only the click that followed did); a drop into the scene then selects the new node anyway.

## Deprecates

`inspectedAsset`, `showsAssetInspector`, `inspectSelectedAsset` (deleted); `state.select`, `uiDocuments.selectUIElement`, `Hierarchy.tsx`'s `showSceneSettings`, `assetImport.showAsset` and `nodeEdits.existingPaths` (moved); `selection`'s setter (removed); `inspectorSelection.test.ts` (merged into `inspectorTarget.test.ts`).

## Open questions

- None.

## References

- `src/editor/inspectorTarget.ts`, `src/editor/inspectorTarget.test.ts`, `src/editor/ui/Inspector.tsx`, `src/editor/assetImport.ts`, `src/editor/state.ts`, `src/editor/runtimeInspect.ts`
