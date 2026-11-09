# 0157. The Assets panel's commands are one module, shared by its menu, its keys and the menu bar, and an asset entry has one encoding

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0040, 0146, 0148, 0149 (amends: the Assets panel's half of Edit's clipboard items, and where `addAssets`' node builders live)

## Context

The Assets panel's commands (Open, Rename, Duplicate, Copy, Cut, Paste, Delete, New Folder) were each written twice in `ui/Assets.tsx`: once in the context menu (`menuItems`) and once in the keyboard handler (`AssetItems.onKeyDown`), with their own enable rules and the same `.then((made) => made.length > 0 && select(made))` follow-up six times. The rules had drifted:

- The menu disabled Delete through `whyNotEditable`; the Delete key skipped it and relied on `deleteAssets` refusing.
- `whyNotEditable` checked only the active tab's scene (`openScene.value?.path`), while `deleteAssets` and `moveAssets` check every open tab (`openScenePaths()`), so the menu could show Delete or Cut enabled for a scene open in a background tab and the operation then refused. Rename and Cut didn't see `moveAssets`' unsaved-script rule either.
- The Paste and Duplicate keys checked only `project.canSave`; Paste of a cut into the folder it came from was enabled and then refused.
- The menu bar's Edit items sent a synthetic key press into the panel when it had the focus, so they were always enabled there whatever the panel would do.

The enable rules and the Shift+arrow range logic lived in the component, testable only end to end. And an Assets panel entry — a file `images/a.png`, a folder `images/`, a slice `images/sheet.png#walk_0` — was decoded by helpers spread over `assetBrowser.ts` (`sliceEntry`, `isSliceEntry`, `splitSliceEntry`), `assetDelete.ts` (`isFolderEntry`, `entryPath`), `Assets.tsx` (`kindOf`, `nameOf`, `fileEntries`), `assetSelection.ts` and `addAssets.ts` (each with its own `endsWith("/")`). `assetBrowser.ts` also still held the scene-node builders `addAssets` (ADR 0149) uses, and `addAsset`, which only tests called, bypassing `addAssets`.

## Decision

We will put the panel's commands in one module, `src/editor/assetActions.ts`, modelled on `hierarchyActions.ts`, and let the context menu, the keys and the menu bar only map gestures onto it.

- **Commands.** `AssetCommandId` is `open | rename | duplicate | copy | cut | paste | delete`. A command acts on an `AssetTarget` `{ project, entries }` (the entries right-clicked, or the panel's listed selection, `panelTarget()`).
  - `whyNotAsset(id, target)` is the one rule: the reason it can't run, or null. It uses the same checks the operation does: Delete `whyNotDeletable` (exported from `assetDelete.ts`, the check `deleteAssets` makes), Rename and Cut `whyNotMovable` (exported from `assetOps.ts`, the check `moveAssets` makes, open tabs and unsaved scripts included), Paste `whyNotPaste` (new in `assetOps.ts`, now also checked by `pasteAssets`: read-only, nothing copied, and for a cut `whyNotMoveTarget` plus `whyNotMovable`; for a copy, a folder into itself).
  - `runAsset(id, target)` checks the rule (a refusal goes to the status bar as `Can't <verb>: <reason>.`), runs, and selects what it made.
  - `assetCommandLabel(id, target)` names it (Open, or Sprite Editor… for an image or slices) and `assetShortcut(id)` gives its key; `assetKeyCommand(event)` maps a key press to a command, so the menu's shortcut labels and the keys agree by construction (tested).
  - `assetCreateItems(target)`: New Folder, each kind's `create` (ADR 0149) and New Script…, with the read-only rule and selection of the result. `assetPluginItems(target)`: the plugin asset actions (ADR 0146), unchanged in contract, after Open.
  - Slices are listed but aren't files: Open and plugin actions take them; the file commands act on the selection's files and are unavailable for slices alone.
- **The Assets panel** builds its context menu from these (layout and separators stay in `Assets.tsx`), its keyboard handler maps keys with `assetKeyCommand` and calls `runAsset` (a mapped key is always consumed in the panel, so a refused Delete no longer falls through to the editor's delete-node shortcut), and the Delete button uses `whyNotAsset("delete", …)`. Shift+arrow selection is `arrowSelection` in `assetSelection.ts`, pure and unit-tested. What the panel lists (`listedEntries`, the expanded images) moves to `assetActions.ts`, since `panelTarget()` needs it.
- **The menu bar** (`menuBar.ts`): with the panel focused, `MenuState.assets` carries `whyNotAsset` for Cut, Copy, Paste, Duplicate and Delete, so Edit's items show the same reasons; `MenuBar.tsx` runs them with `runAsset` instead of synthesising key presses.
- **One entry encoding.** `src/editor/assetEntry.ts` is the only place that knows the encoding: `folderEntry`, `sliceEntry`, `isFolderEntry`, `isSliceEntry`, `splitSliceEntry`, `entryPath`, `entryName`, `entryKind`, `entryFolder`, `fileEntries`. Every editor caller imports from it (`assetSelection.ts`, `addAssets.ts`, `assetOps.ts`, `assetDelete.ts`, `assetDrag.ts`, `assetImport.ts`).
- **Node builders beside `addAssets`.** `parentForAdd`, `prefabInstanceEntry`, `spriteNodeEntry`, `audioNodeEntry`, `idBase`, `uniqueId`, `prepareAssets`, `whyNotAddable`, `nodeForAsset`, `addAssetEntries` move from `assetBrowser.ts` to `src/editor/assetNodes.ts`. `addAsset` is deleted; tests add through `addAssets`. `assetBrowser.ts` keeps the folder tree, search and path helpers.

## Alternatives considered

- **Keep the two definitions and share only the predicates** — removes the drift for now, but the next command added still needs two edits and the follow-ups stay duplicated.
- **Commands as a registry the panel iterates** (labels, separators and all) — the menu's layout differs by selection (background, slices, folder, file) and isn't a list of commands; the layout stays in the component, the behaviour moves.
- **Leave the menu bar sending key presses** — it works, but its items can't show why they're unavailable, and the keyboard event is a hidden contract.

## Consequences

**Positive**
- One rule per command, the operation's own, so the menu, the keys, the Delete button and the menu bar can't disagree; fixes Delete/Cut/Rename enabled for a scene in a background tab, Paste enabled for a cut into its own folder, and a refused Delete key deleting the scene's selected node.
- The rules, key mapping and range selection are tested headlessly against the in-memory project.
- One place decodes entries.

**Negative / costs**
- Pasting a copied folder into itself is now refused up front ("Can't paste here: … can't go inside itself.") instead of failing part-way as an error.
- Keys that do nothing in the panel now say why in the status bar (Ctrl+V with nothing copied: "Can't paste: nothing copied."), where before they were silent.
- `assetActions.ts` reads editor signals (selection, clipboard, open scenes), like `hierarchyActions.ts`; its tests set them.

## Deprecates

`whyNotEditable`, `pasteFolder`, `actionItems`, `kindOf`, `nameOf`, `fileEntries` in `Assets.tsx`; the entry helpers in `assetBrowser.ts` and `assetDelete.ts`; the node builders in `assetBrowser.ts`; `addAsset`; `MenuBar.tsx`'s synthetic key presses into the panel.

## Open questions

- Should the panel's selection drop entries a search hides? Commands act on the listed selection, as before.

## References

- `src/editor/assetActions.ts`, `src/editor/assetEntry.ts`, `src/editor/assetNodes.ts`, `src/editor/ui/Assets.tsx`, `src/editor/menuBar.ts`, `src/editor/ui/MenuBar.tsx`
- `src/editor/hierarchyActions.ts` (the model)
