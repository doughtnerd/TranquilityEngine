# 0141. Asset documents keep 0027's persistent history tree as text patches, stored apart from scenes' and following their file

- **Status:** Proposed (built; the owner reviews at QA)
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0027, 0077, 0116, 0133, 0134

## Context

ADR 0133 gives every asset document (Sky, materials, shader and particle graphs, formations, tilesets) 0027's persistent, tree-shaped history. ADR 0134 built the documents with a linear, in-memory undo stack (200 values) and noted that persisting it "changes no caller". Building it showed four places where 0027, written for scenes, doesn't fit an asset as it stands:

- **Patches.** 0027 stores node-level diffs of a scene file. Assets have no common shape; each format turns its value into text (`format(value)`).
- **Keys.** A scene's history is keyed by its path and isn't moved on a rename; a deleted scene's history stays until its path's hash stops matching. 0133 requires asset history to follow a rename and go with a delete, so that a new file at an old path (which may have identical content, e.g. a fresh default sky) doesn't inherit it.
- **Saving.** Asset documents write every edit straight away; there is no unsaved state for the scene's "Restore unsaved changes?" dialog to offer, except when the last write didn't land.
- **View changes.** Some edits are written but are no undo step (`edit(v, { history: false })`, a collapsed frame in the particle graph). With a stored tree, the file would then match no state and the history would be set aside on the next open.

## Decision

- **Same tree, text patches.** `TextHistory` (`src/editor/document/TextHistory.ts`) is 0027's tree over one text value: the same `HistoryState` / `HistoryFile` (`myco.history@1`) shapes, navigation (undo to parent, redo to last-visited child, jump, creation-order back/forward), 1000-state limit and pruning. Each step's change is one `FilePatch` in `files[0]` (ADR 0077's text patch: the differing middle of the formatted file), and each state's `hash` is `hashText` of its text. `HistoryFile.scene` holds the asset's path.
- **Same store and rules.** Saved through `HistoryStore` (two checksummed, generation-numbered slots) after every step, undo, redo, jump and successful write; the same History location setting (project folder, or per-user storage, which read-only projects would use; read-only documents can't be edited, so they keep none); pruned by age (0116). On open, the state matching the file is taken (the saved state first); if none matches, the history is set aside with a status-bar note and a new one starts.
- **Stored apart, following the file.** Project folder: `.myco/asset-history/<asset path>.history.<a|b>.json` (scenes keep `.myco/history/`, so folder moves never touch a scene's history). Per-user storage: keys `asset-history-<hash of project>-<encoded path>.<a|b>`, so a folder's histories can be found. `moveAssets` and `deleteAssets` (through `assetDocumentsMoved` / `assetDocumentsDeleted`) move or remove the stored history in both places, whether the document is open or not. Anything already at a move's target is removed first. All of this runs on one queue (`assetHistory.ts`) with the documents' saves, in order.
- **Recovery without a dialog.** If the history was last past the file's state (a write that didn't land), the document opens at the file's state with a status-bar note; redo (which leads there) or the History panel brings the edits back. No modal, since documents open as panels render.
- **View and outside changes amend the current state.** `history: false` edits, and changes made to the file elsewhere while it's open, rewrite the current state's text (its incoming and outgoing patches and its hash) without a new step. Undo behaves as before (to the previous step), and the tree keeps matching the file across restarts.
- **Interface.** `AssetDocument` keeps `value`, `edit`, `undo`, `redo`, `canUndo`/`canRedo` and `flush`, and gains `history` (`version`, `states`, `current`, `saved`, `jumpTo`) for the History panel, plus an optional `label` edit option (default "Edit"). The History panel shows the tree of `focusedAssetDocument`: the document whose editor (root marked `data-asset-document`) was last focused or clicked, until something outside the editor and the History panel is.

## Alternatives considered

- **Full snapshots per state.** Simplest, but grows with asset size times edits; graphs run to tens of KB. Text patches of a formatted file are usually a few bytes.
- **Generalise `CommandStack` for any document.** One tree implementation, but rewrites the scene history's core while other work depends on it. `TextHistory` duplicates about 150 lines of tree logic instead; merging them can follow.
- **Key by a stable id with an index file.** Rename and delete become index edits, but the index needs its own crash safety. Moving slot files is enough.
- **Share `.myco/history/` with scenes.** A folder move would then have to tell scene histories (which don't follow renames) from asset ones.
- **Ask, like the scene, before restoring unwritten edits.** A modal raised from a panel's render, for a rare case (a failed or interrupted write).

## Consequences

**Positive**
- Asset edit history survives restarts and crashes, keeps undone branches, and is visible and navigable in the History panel.
- Renames keep history; deletes don't leak it to a new file at the same path.

**Negative / costs**
- Two tree implementations (`CommandStack`, `TextHistory`) to keep in step.
- An edit made before the stored history finishes loading (normally a few ms) starts a new history over it.
- Text patches depend on the format's output staying stable; a format change makes old histories set aside, as an outside edit would.
- Undo on a history pruned by count still works, but a damaged history's patch that doesn't fit is refused (nothing changes) rather than repaired.

## Deprecates

The in-memory linear undo stack in `assetDocuments.ts` (removed).

## Open questions

- Ctrl/Cmd+Alt+Z (step by time) for asset documents: editors route their own Ctrl+Z, so it isn't wired yet.
- Whether to merge `TextHistory` and `CommandStack` into one generic tree.

## References

- `src/editor/document/TextHistory.ts`, `src/editor/assetHistory.ts`, `src/editor/assetDocuments.ts`, `src/editor/ui/HistoryPanel.tsx`
- Tests: `src/editor/document/TextHistory.test.ts`, `src/editor/assetDocuments.test.ts`
