# 0316. One history persistence module for scene stacks and text histories

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0027, 0116, 0141, 0174, 0267, 0317

## Context

Keeping an edit history on disk (ADR 0027, 0141) was built twice. `historyPersistence.ts` (`slotsFor`,
`attachHistory`) did scenes: its own write loop with coalescing, failure streak, load-then-write and relocate.
`assetHistory.ts` did asset documents: its own slot spaces, a global queue, another failure streak, another
relocate, a global effect following the location setting, and an "edits made while it loaded" guard. The scene tabs
had a third piece, `relocateHistories`, driven by an effect in `session.ts`. Saved layouts (ADR 0174) borrowed
`defaultHistoryPlatform` as "the editor's per-user storage" and chose the project's file system with a different
rule (`project.fileSystem ?? fs`, no write check) from histories (`fileSystem?.canWrite ? fileSystem : fs`).

The scene path had a race (confirmed by test): a tab was editable before its history loaded, so an edit made then
left the stack's current hash matching no saved state; `CommandStack.load` returned null, the status bar said the
scene "changed outside the editor", and the first write replaced the saved history, unsaved changes it offered back
included.

## Decision

We will keep edit history on disk through one module, `src/editor/historyPersistence.ts`, for both history tree
adapters.

- **Interface.** `persistHistory({ project, kind, tree, path, saveFailed, location?, platform?, pruneDays? })`
  returns `{ loaded, save, relocate, written, stop }`. `tree` is a `PersistedTree` (`empty`, `load`, `toFile`): an
  asset document's `TextHistory` as it is, a scene's `CommandStack` through `sceneHistory(stack, path)`. `kind`
  (`"scene"` | `"asset"`) picks where it's kept and whether it follows its file.
- **What hosts hear.** `loaded` resolves with the outcome: `adopted` (with `ahead`, the state it was at when
  written if past the file's), `set aside` (`why`: `changed` outside the editor, or `edited` before it loaded), or
  `new`; and `saveFailed` once per failure streak. Nothing else.
- **Load or set aside.** The saved history is adopted only when the tree is still empty when it arrives (the
  edits-started rule: edits made meanwhile win and their history replaces it, reported as `edited`, never as
  `changed`). Then the tree is written once, so a history file exists from the start.
- **Scene tabs open after the load.** `sceneTabs.open` reads the scene and waits for `loaded` before the tab
  enters, so no edit can race the load; the restore offer and migrations stay in the background. Opening a scene
  that is still loading returns the same promise (one tab); `closeAll` meanwhile opens nothing.
- **One disk queue per project.** Loads, saves (coalesced: changes in a row are one write), relocations, and asset
  moves and deletes run in order on the project's queue.
- **Location.** Each open history follows the location setting (a signal; the editor preference by default) and
  writes its whole tree to the new place; `session.ts`'s `relocateHistories` effect is gone. Where "the project
  folder" is comes from `projectFolder(project, platform)` in `src/editor/projectPlace.ts`, which saved layouts use
  too: `write` is the project's own file system when it can write, else the platform's, and only for a project
  that can save; `read` is the project's own, else the platform's. `editorPlatform()` there gives the file system
  and the editor's per-user storage (ADR 0317's editor scope).
- **Asset-only moves and deletes.** `moveAssetHistories` / `deleteAssetHistories` move or remove an asset's (or a
  folder's) history in both places; scene histories don't follow their file (unchanged from 0027).
- Per-user keys and folder layouts are unchanged (`history-…`, `asset-history-…`, `.myco/history`,
  `.myco/asset-history`), so existing histories load.

## Alternatives considered

- **Keep both, share helpers.** The two loops already drifted (the race guard existed for one only).
- **Graft edits made during the load onto the adopted history.** Needs a tree operation `HistoryTree` doesn't have;
  for scenes, opening after the load removes the case, and asset documents keep the simple rule.
- **Block asset documents until their history loads.** The document opens synchronously and is read by many
  panels; the edits-started rule covers the few milliseconds.

## Consequences

**Positive**
- One place for the queue, coalescing, failure streak, location and the load rule; the scene race is gone.
- Saved layouts and histories agree on which file system writes a project's folder.

**Negative / costs**
- Opening a scene tab now waits for its history read (two small files or storage keys).
- A load or platform failure is reported through `saveFailed` ("Couldn't save the edit history"), not a separate
  "couldn't load" message.

## Deprecates

- `assetHistory.ts` (removed; `AssetHistoryPersistence` folded in), `attachHistory`, `slotsFor`, `userSlots`
  (`historyStore.ts` keeps `HistoryStore` and `projectSlots`), `SceneTabs.relocateHistories`, `LayoutPlatform`.

## Open questions

- None.

## References

- [0027](0027-persistent-undo-tree.md), [0141](0141-asset-documents-keep-a-persistent-text-patch-history-tree-that-follows-their-file.md), [0267](0267-one-history-tree-module-under-the-scene-stack-and-text-histories.md), [0317](0317-player-storage-owns-its-scope-and-value-encoding.md)
