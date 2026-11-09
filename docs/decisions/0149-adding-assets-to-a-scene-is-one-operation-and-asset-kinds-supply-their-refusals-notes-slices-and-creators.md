# 0149. Adding assets to a scene is one operation; asset kinds supply their refusals, notes, slicing and New… entries

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** — (completes 0143 and 0146 for the Assets panel)
- **Related:** 0022, 0040, 0044, 0077, 0109, 0118, 0133, 0134, 0140, 0143, 0146, 0147

## Context

**Adding assets.** Two features add assets to the open scene: a drop on the scene view or the Hierarchy (`assetDrag.ts`) and a tile's + in the Assets panel (`ui/Assets.tsx`). Each had to remember the same order itself (`prepareAssets` to load a model's meshes, then `addAsset` per file, an undo group, the status message), and they had drifted:

- `Assets.tsx`'s `addToScene` read `openScene.value` again *after* `await prepareAssets`, so switching scene tabs while a model loaded added it to the other tab. `assetDrag.ts` captured the scene and checked `openScene.value !== scene`, but then gave no message.
- "A scene is open and in edit mode" was checked by the UI (`canAdd`) and by the drag's `problemFor`, not by `addAsset`. The drag said "Added X", the + said "Added X to main.scene.json".
- `assetBrowser.ts` knew kinds by name: `whyNotAddable` named `"scene"` and `"prefab"` for self-nesting, and `addAsset` logged the note about a model's turned-off cameras (`disabledModelCameras`, ADR 0118), which is the Meshes plugin's knowledge.

**The shell still named kinds and plugins** (0143, 0146 left over):

- The New… menu hard-coded New Scene, New UI Document and New Render Texture beside the registry's `create` entries. The `uidocument` kind is the UI plugin's (0140), but its creator (`createUIDocument`) lived in `uiDocumentEdits.ts`, so with the UI plugin disabled New UI Document was still offered. No core kind used `create`.
- `Assets.tsx` compared kinds with the literal `"image"` four times for slice behaviour (listing slices, Sprite Editor…, the self-thumbnail), while `assetKindLookup.ts` had its own `SLICED_KIND = "image"`.

## Decision

We will add assets through one operation, and let asset kinds say what the shell used to know about them.

- **One operation.** New `src/editor/addAssets.ts`: `addAssets(paths, target): Promise<{ ids, message }>`. A target is `{ kind: "point", position }` (scene-view drop: top level, prefab and scene instances placed there), `{ kind: "slot", parent, index? }` (Hierarchy drop; several assets take consecutive indices) or `{ kind: "selection", selected, position }` (the +: under the selection via `parentForAdd`, instances keep their own position). It captures the open scene, checks the preconditions, `await`s `prepareAssets`, refuses if the open scene changed (`<scene> is no longer the open scene`) or play started meanwhile, adds every asset in one undo group (`Add <name>`), logs each kind's note and returns the new root ids and the status message (`Added <name> to <scene file>`, or `Couldn't add <name>: <reason>`). It never rejects. Callers only select the ids and show the message.
- **One precondition check.** `whyNotAddAssets(paths, scene?)`: no scene open, not in edit mode, folders, then each file's `whyNotAddable`. The drag's ghost label and the tile's + (its `disabled` and tooltip, which now says why) use it, and `addAssets` runs it before and after preparing.
- **Kinds supply refusals and notes.** `AssetSceneNodes` gains `whyNot?(doc, path)` and `note?(path, entries)`. The core `scene` and `prefab` kinds' `whyNot` refuses self-nesting (`wouldNest`); the Meshes plugin's `model` kind's `note` is the turned-off-cameras message (`disabledCamerasNote` in `plugins/meshes/editor/modelNodes.ts`). `whyNotAddable` asks the kind; `assetBrowser.ts` names no kind. `addAsset` stays as the bare, synchronous one-command add (tests, `addAssets` itself) beside a new `addAssetEntries` that returns every entry; `addAssetToScene` and `disabledModelCameras` go.
- **Core kinds declare `create`.** `scene` (New Scene, opening it) and `rendertexture` (New Render Texture) declare `create` in `assetKinds.builtin.ts`, loaded on first use. The New… menu's file entries are exactly `kindCreators()` (`assetKindLookup.ts`): every registered kind's `create` in registration order, the core kinds first. New Folder and New Script… stay shell entries (a folder is no asset kind, 0143; a script is the Code panel's).
- **UI documents are the UI plugin's.** `createUIDocument` and `newUIDocumentTexts` move to `src/plugins/ui/editor/uiDocumentAssets.ts`, written against the editor surface (0147), and become the `uidocument` kind's `create`. The Hierarchy's Create > UI Document (still a built-in node kind, 0146) writes its document through `registeredKind("uidocument")?.create`, so with the plugin disabled it makes the node without a document.
- **Slicing is a capability.** `AssetKindContribution` gains `slices?: boolean`: the kind's files are images that can be cut into slices (0040). A `#slice` entry of such a file is a `sprite` that adds and opens as its own file does (`sceneNodesAt(path)` asks the slice's file's kind), the Assets panel lists the slices, shows the file itself as its thumbnail, and calls Open "Sprite Editor…". The core `image` kind sets it. `hasSlices(kind)` replaces the `"image"` comparisons in `Assets.tsx` and `searchEntries`; `SLICED_KIND` goes. (The panorama field rule still names `image`; it is about PNG and JPEG images, not slices.)

## Alternatives considered

- **Fix the stale-scene read in `Assets.tsx` alone.** One line, but the next caller (a paste, a menu command) would copy the order again; the drift was the problem, not the line.
- **Make `addAsset` itself async and check the scene.** Tests and the bare add would pay for preparing and signals; keeping the bare add and wrapping it keeps the low-level path simple and the policy in one place.
- **A `refuses` list of kind ids** (scene/prefab) in the shell. Still names kinds; the model note proved kinds need their own hook anyway.
- **Keep New UI Document in the shell behind an `isPluginEnabled("ui")` check.** Names a plugin in the shell, which 0146 forbids.
- **Slicing by `importSettings` presence** (kinds with import settings have slices). Audio and models have import settings and no slices.

## Consequences

**Positive**
- Switching tabs while a model loads no longer adds it to the other tab; both features refuse with a message instead.
- The drag and the + give the same messages and the same undo step label; the + tooltip says why it is disabled.
- Disabling the UI plugin removes New UI Document; a third-party kind can have slices, refuse adds and leave a note.
- `assetBrowser.ts`, `ui/Assets.tsx` and the New… menu name no asset kind.

**Negative / costs**
- Two more optional `AssetSceneNodes` members and one more `AssetKindContribution` member in the experimental SDK (0133).
- The drag's success message changes from "Added X" to "Added X to <scene file>"; a stale drop that used to do nothing silently now says so.
- New UI Document moves after the core entries, among plugin entries in activation order.
- The tile's + computes `whyNotAddAssets` while rendering, which for scene and prefab tiles walks their nested prefabs (`wouldNest`), as the drag's ghost label already did on every pointer move.

## Deprecates

- `addAssetToScene`, `disabledModelCameras` (`assetBrowser.ts`): removed; `addAssets` and the model kind's `note` replace them.
- `createUIDocument`, `newUIDocumentTexts` in `src/editor/uiDocumentEdits.ts`: moved to the UI plugin, no re-export.
- `SLICED_KIND` (`assetKindLookup.ts`) and the hard-coded New Scene, New UI Document and New Render Texture menu items: removed.

## Open questions

- Should Create > UI Document become the UI plugin's Hierarchy create entry (0146's open question), so the shell stops naming `uidocument` too?
- Plugins' editor halves still compare `kindOf(f) === "image"` when listing textures (Materials, Sky, Particles); a `referencedAs` query ("files satisfying `texture`") would serve them better.

## References

- `src/editor/addAssets.ts` (+ `addAssets.test.ts`), `src/editor/assetBrowser.ts`, `src/editor/assetDrag.ts`, `src/editor/ui/Assets.tsx`, `src/editor/assetKindLookup.ts`, `src/editor/assetKinds.builtin.ts`, `src/editor/sdk/contributions.ts`, `src/editor/hierarchyActions.ts`
- `src/plugins/ui/editor/uiDocumentAssets.ts`, `src/plugins/ui/editor/index.ts`, `src/plugins/meshes/editor/modelNodes.ts`, `src/plugins/kindCreatesAndSlices.test.ts`
- Architecture review, 2026-11-09.
