# 0145. Undo and Redo act on one active history, resolved by focus

- **Status:** Proposed — built in the same change
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0026, 0027, 0038, 0046, 0060, 0115, 0133, 0134, 0141

## Context

The editor has five edit-history models, and the commands that drive them are wired separately:

- **Scene:** `document/CommandStack.ts`, 0027's tree. The Edit menu (`menuBar.ts`, `ui/MenuBar.tsx`) and the global shortcuts (`shortcuts.ts`: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y, Ctrl/Cmd+Alt(+Shift)+Z) only ever drive this one.
- **Asset documents:** `document/TextHistory.ts` (0141) behind `AssetDocument`. Each editor (Sky, Material, Shader Graph, Particle Graph, Formation, Tileset) had its own `onKeyDown` for Z/Y, with three different guards for text fields. Sky and Material didn't stop the event, so the window's shortcut also undid the scene; `shortcuts.ts` skipped `.shader-graph` altogether for that reason. Edit > Undo always undid the scene, even with an asset editor focused.
- **Sprite Editor:** `spriteHistory.ts`, immutable snapshots (0115), its own keys in the modal.
- **Project Settings and Worlds:** `EditHistory` in `worldsConfig.ts`, a linear labelled list, keys in each panel.
- **Graph snapshots:** `graph/history.ts` (`createGraphHistory`), unused since 0134 moved the graphs onto asset documents.

`focusedAssetDocument` (0141) already tracked which asset editor had the focus, but only the History panel read it. 0141 left Ctrl/Cmd+Alt+Z for asset documents open because "editors route their own Ctrl+Z".

## Decision

We will route every Undo and Redo through one module, `src/editor/activeHistory.ts`, which resolves the **active history** by focus.

- **The interface.** A history is seen only as `UndoHistory`: `canUndo`, `canRedo`, optional `undoLabel` / `redoLabel`, `undo()`, `redo()`, optional `back()` / `forward()` (creation-order steps, Vim's g- / g+), optional `tree` (`states`, `current`, `saved`, `jumpTo`, `version`) for the History panel, and an optional `name`. Getters may read signals, so the Edit menu and History panel follow changes. The histories keep their own implementations; `sceneHistory(stack)` and `assetDocumentHistory(doc)` adapt the two trees, and the panels adapt `spriteHistory` and `EditHistory` in a few lines each.
- **Resolution,** in order: (1) a **panel-local history**, while the focus or last click is inside the root element a panel registered it on; (2) the **focused asset document**, an editor root marked `data-asset-document` (0141's tracking), while that editor is still on the page; (3) the open scene's `CommandStack`; else none. Clicks and focus in the History panel and the menu bar (`KEEPS_HISTORY_FOCUS`) keep the current choice, so Edit > Undo acts on the editor that was focused before the menu opened.
- **The module** exports `activeHistory` (a computed signal: `{ kind: "panel" | "asset" | "scene", history, path? }` or null), `undo()`, `redo()`, `stepBack()`, `stepForward()`, `providePanelHistory(root, history)` (returns the unregister) and `usePanelHistory(ref, history)` (the Preact hook; a new `history` object re-registers, for histories kept in component state).
- **Callers.** `shortcuts.ts` sends Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y and Ctrl/Cmd+Alt(+Shift)+Z to the module, after the existing `isEditable` check, so text fields and Monaco keep native text undo; the `.shader-graph` exclusion lets these four through. Edit > Undo / Redo take their label and enabled state from `activeHistory` (`MenuState.history`) and call `undo()` / `redo()`. The History panel draws `activeHistory`'s tree, or says the focused editor keeps a linear list.
- **Panels.** The per-panel Z/Y `keydown` handlers are removed from Sky, Material, Shader Graph, Particle Graph, Formation, Tileset, Project Settings, Worlds and the Sprite Editor. Asset editors need nothing more than their existing `data-asset-document` root. The Particle Graph registers a panel history wrapping its document, so undo keeps the frames' collapsed state as its buttons did. The Sprite Editor lets Ctrl+Z/Y bubble out of its modal (it still stops its other keys) and registers its snapshots. Project Settings and Worlds register their `EditHistory`. Undo / Redo buttons stay and call the same history object the route resolves to.
- **SDK.** `myco/editor` exports `activeHistory`, `providePanelHistory`, `usePanelHistory` and the `UndoHistory`, `HistoryTree` and `ActiveHistory` types. A plugin's asset editor marks its root `data-asset-document={doc.path}`; a panel with its own history registers it.
- **Asset documents** gain `undoLabel` / `redoLabel` signals (from `TextHistory.undoLabel` / `redoLabel`, or the pending coalesced edit's label) and `history.back()` / `forward()`, which answers 0141's open question: Ctrl/Cmd+Alt+Z steps an asset's tree by time.
- **`graph/history.ts` is deleted.**

## Alternatives considered

- **Keep per-panel handlers and only fix propagation.** Smallest change, but leaves Edit > Undo and the History panel scene-only and nine guards to keep in step.
- **Merge the histories into one implementation** (generic tree for scenes, assets and panels). The real duplication, but rewrites `CommandStack` and `spriteHistory` while other work depends on them (0141 already declined it); the seam lets it happen later behind the same interface.
- **Resolve from `document.activeElement` at key time** instead of tracking focus. Simpler, but a click on non-focusable panel content leaves the focus on `body`, the menu takes the focus, and an editor's popup that closes takes its focused element with it. Tracking focus and clicks, as 0141 does, covers all three.
- **A focus-scope registry keyed by panel id** (the docking layout) rather than DOM roots. Modals (the Sprite Editor) and inspectors (Material, Formation, Tileset) aren't layout panels.

## Consequences

**Positive**
- One place decides what Undo means; the Edit menu, the shortcuts and the History panel agree, and the menu names the step ("Undo Edit", "Undo Add World").
- Pressing Ctrl+Z in the Sky or Material editor no longer also undoes the scene.
- Asset editors get Ctrl/Cmd+Alt+Z; plugins get undo routing by marking their root or registering a history.

**Negative / costs**
- Focus is tracked by two capture listeners (asset documents' and panel roots'); they share `KEEPS_HISTORY_FOCUS` and must stay in step.
- An asset editor stays the active history after its panel loses the focus without a click elsewhere (e.g. the inspector swaps while focus is on `body`) unless its root has left the page; resolving checks for the root at key time.
- Panel histories that aren't trees show only a note in the History panel.

## Deprecates

- `src/editor/graph/history.ts` (`createGraphHistory`): removed.
- The Z/Y `keydown` handlers in `SkyPanel.tsx`, `MaterialInspector.tsx`, `ShaderGraphPanel.tsx`, `GraphEditor.tsx`, `FormationInspector.tsx`, `TilesetInspector.tsx`, `ProjectSettingsPanel.tsx`, `WorldsPanel.tsx` and `SpriteEditor.tsx`: removed.
- `MenuState.scene`'s undo fields: replaced by `MenuState.history`.

## Open questions

- Merging `CommandStack`, `TextHistory`, `spriteHistory` and `EditHistory` into one implementation behind `UndoHistory`.
- Whether the Code panel's Monaco undo should join the route (today it keeps its own keys, as before).

## References

- `src/editor/activeHistory.ts`, `src/editor/shortcuts.ts`, `src/editor/menuBar.ts`, `src/editor/ui/MenuBar.tsx`, `src/editor/ui/HistoryPanel.tsx`, `src/editor/assetDocuments.ts`, `src/editor/sdk/index.ts`
- Tests: `src/editor/activeHistory.test.ts`, `src/editor/menuBar.test.ts`, `src/editor/assetDocuments.test.ts`
