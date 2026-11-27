# 0433. The Studio has one asset library module for every file action

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0341 (one app owns each file), 0342 (samples are assets, the trash), 0343 (playlists), 0348 (takes and captures), 0408 (one recording for both Run screens), 0417, 0362

## Context

ADR 0341 says a Studio move or rename of an asset that scenes or prefabs name must not rewrite those files while the
editor holds the project: the moves go to `.myco/locks/pending-moves.json` for the editor. `moveStudioAssets`
(`boot/studioAssetMoves.ts`) does that, but only the Takes and Captures trees (`profiler/runFileActions.ts`) called it.
Playlists (`playlistsScreen.ts`: rename, move, the folder delete's moves and their Undo, tree drops), Samples
(`SamplesPanel.tsx`: rename, move, folder delete) and Spatial (`spatialScreen.ts`: rename) called the editor's
`assetOps` (`renameAsset`, `moveAssets`, `moveAssetsTo`) directly, which never checks the lock: with the editor open,
the Studio rewrote the editor's scenes under it.

The rest of the file actions were written once per screen and had drifted:

- **"Delete folder, contents move up"** twice: playlists' `folderContentsUp` (sidecar-aware, collision numbering before
  the asset kind's extension, scripts counted, the engine's deletability check, Undo on the toast) and samples'
  `moveUpPlan` (used by takes and captures too: a different collision rule, every sidecar skipped, no check, no Undo).
- **The trash** twice: `samples/sampleTrash.ts` and `profiler/runFileTrash.ts`, the same code, one adding a sample's
  session steps.
- **Renames:** the typed name's extension handled per screen (the run tree appending it, samples' `keepExt`, playlists'
  and Spatial's suffix stripping), folder names cleaned in two screens only.
- **Take and Profiler** wired the same nine tree callbacks line for line around a shallow `RunFileKind`, and imported
  each other (`captureTree`, `RunFileTree`, `RunRuler`, `runFileActions`, `runFileDurations` from Profiler; `takeScreen`,
  `takeFiles`, `ReplayTransport` from Take).

## Decision

We will give the Studio one **asset library** module, `src/studio/library/studioLibrary.ts`, that owns every file action
a screen offers, and route every Studio move through `moveStudioAssets`.

- **A kind in, actions out.** A screen describes its files once as a `LibraryKind`: the noun, the extension a typed name
  keeps, the companions that go with a file (a take's notes), the files it has open, and how the screen opens, follows
  and closes one; optional steps around a move (`afterMove`) and a delete (`beforeDelete`, `afterDelete`, `deletedText`);
  and, for kinds that import, the import folder and the file check. `studioLibrary(kind)` returns the actions:
  `move`, `renameFile`, `renameFolder`, `newFolder`, `duplicate`, `deleteFile`, `folderDeletePlan`, `deleteFolder`,
  `importFiles`, and `treeActions`, the same actions as a file tree's callbacks (`FileTreeActions`).
- **One rule per action.**
  - Rename: the typed name keeps the file's extension; folder names turn `/` into `-`; both are checked by the engine's
    `whyNotValidName`; companions take the new name.
  - Move: a file takes its companions, a folder goes whole, an item inside another moved folder goes with it, nothing
    moves into where it is or into itself; a toast says where (`name → folder`).
  - Duplicate: the engine's copy, companions copied to the copy's name; a single copy opens.
  - Delete a file: into the project's trash (`library/trash.ts`, one module), with its companions and sidecars; Undo on
    the toast; the open file closes and Undo reopens it.
  - Delete a folder: playlists' rule, the better-behaved one. What's directly in it moves up to its parent (a taken name
    gets " 2", " 3"… before the asset kind's extension; a sidecar travels with its file; scripts count as taken names),
    refused where the engine's delete rule refuses it (read-only, play, gone), then the empty folder goes; Undo on the
    toast puts the folder back and moves everything in again. Whether to ask first stays the screen's (Playlists and
    Samples ask, using `folderDeletePlan`; Takes and Captures don't, since nothing is lost).
- **One route for moves (ADR 0341).** Every move and rename the library makes, a folder delete's moves and their Undo
  included, goes through `moveStudioAssets`, now `library/studioAssetMoves.ts` (the library is its only caller).
  Copies, new folders and deletes into the trash rewrite no references, so they don't need the lock: the editor sees
  them through its watch like any outside change.
- **Screens migrated:** Takes (`takeLibrary`) and Captures (`captureLibrary`) pass `treeActions` to the run-file tree;
  Playlists (`playlistFiles`), Samples (`sampleFiles`, `samples/sampleFiles.ts`) and Spatial scenes (`sceneFiles`) call
  the actions. What is a screen's own stays there: a playlist file's delete (its links and children plan), a sample's
  Duplicate (a derived sample, not a file copy), a test scene's delete (documents written back), confirmations.
- **No import cycle between Take and Profiler.** What both Run screens use moves to `screens/run/` (the capture tree, the
  run-file tree, the ruler, file durations). The Profiler takes what it needs of the Take screen (open a recording there
  too; the replay transport) as a `ProfilerTakeLink` given by the screens' composition (`screens/index.tsx`,
  `profilerPanels(link)`); the Take screen still uses the Profiler's store.

## Alternatives considered

- **Make `assetOps` check the lock** — the editor's own module would learn about the Studio's lock file and its pending
  moves, and every screen would still carry its own rename, trash and folder-delete code.
- **Route only the moves, leave the rest per screen** — fixes the bug but keeps two folder-delete rules, two trashes and
  four rename variants that had already drifted.
- **A shared helper per action** (a `deleteFolderKeepingContents(kind, …)` beside `renameFile(kind, …)`, as
  `runFileActions.ts` was) — a shallow interface: each screen still wires every action and passes the kind each time.

## Consequences

**Positive**
- With the editor open, no Studio screen rewrites its scenes, prefabs or project.json any more; every move is left for it.
- One place for each rule: every screen's folder delete checks deletability and has Undo; every rename checks names and
  keeps the extension; one trash.
- A screen's file actions are a kind of a few lines; the run screens' panels pass one `treeActions`.
- Take and Profiler no longer import each other.

**Negative / costs**
- Small behaviour changes from the shared rules: Playlists and Spatial moves and Samples' Move to top level now show the
  move toast; a playlist folder name with `/` becomes `-` instead of being refused; Takes, Captures and Samples folder
  deletes are refused while playing or read-only and get Undo; Takes and Captures folder deletes name collisions by the
  asset kind's extension and move stray sidecars.
- The library reads the page's `currentProject` and toast queue, so its tests set them, as the other Studio tests do.

## Deprecates

- `profiler/runFileActions.ts` (`RunFileKind`, `moveItems`, `renameFile`, `renameFolder`, `newRunFolder`, `importInto`,
  `duplicateFile`, `deleteFile`, `deleteFolder`, `moveIntoPlan`, `movedTo`): removed.
- `profiler/runFileTrash.ts` and `samples/sampleTrash.ts` (`trashSample`, `restoreSample`, `TRASH_FOLDER`): replaced by
  `library/trash.ts`.
- `samples/sampleLibrary.ts` `moveUpPlan`, `cleanFolderName`; `playlists/structureEdits.ts` `folderContentsUp`; the
  Playlists screen's `restoreFolder`: removed.
- `boot/studioAssetMoves.ts` moved to `library/`; `renameStudioAsset` removed (the library renames).
- `take/takeFiles.ts` `takeMoves` (used only by its test): removed.
- `PROFILER_PANELS` became `profilerPanels(link)`.

## Open questions

- Spatial test scenes' delete writes documents back on Undo rather than using the trash; moving it onto the library's
  delete would make Undo exact but changes its multi-scene toast.

## References

- `src/studio/library/studioLibrary.ts`, `trash.ts`, `studioAssetMoves.ts`, `studioLibrary.test.ts`.
- ADR 0341 "One app owns each file; both watch".

## As built

- **Module:** `src/studio/library/studioLibrary.ts` (`studioLibrary`, `LibraryKind`, `StudioLibrary`, `FileTreeActions`,
  `AssetMove`); `library/trash.ts` (`trashFiles`, `restoreFiles`, `whyNotTrashable`, `withSidecars`; `.myco/trash/<n>/`,
  newest 20 kept); `library/studioAssetMoves.ts` (`moveStudioAssets`).
- **Kinds:** `take/takeScreen.ts` `takeLibrary` (notes as companions, `.sporesample` kept, the replay follows),
  `profiler/profilerScreen.ts` `captureLibrary`, `playlists/playlistsScreen.ts` `playlistFiles` (every file the open path
  names follows), `samples/sampleFiles.ts` `sampleFiles` (source versions and folder colours follow a move; the pending
  edit is written and the decoded audio dropped before a delete, the session after; the toast counts uses),
  `spatial/spatialScreen.ts` `sceneFiles`. `run/captureTree.ts` gained `recordingExtension`.
- **Run screens:** `screens/run/` holds `captureTree.ts`, `RunFileTree.tsx` (+ css; its props extend `FileTreeActions`),
  `RunRuler.tsx`, `runRulerModel.ts` (+ css), `runFileDurations.ts`, `runFiles.test.ts`. `profiler/index.tsx` exports
  `ProfilerTakeLink` and `profilerPanels`; `screens/index.tsx` links it to `takeScreen().openPath` and `ReplayTransport`.
  The one Profiler import of Take left is a test fixture (`reviewLink.test.ts` uses `take/takeFixture.ts`).
- **Tests:** `library/studioLibrary.test.ts` (18 cases: lock held and not held for moves, renames and a folder delete's
  moves, refusals leaving no pending moves, extension kept, folder names cleaned, companions, nested items, `afterMove`,
  duplicate with companions, new folder numbering, trash with companions and sidecars, Undo and Undo refused, the kind's
  delete steps, contents up with numbering and sidecars and references following, folder Undo, refusal, import);
  `samples/sampleFiles.test.ts` replaces `sampleTrash.test.ts` (a pending edit written before the delete, the open
  sample following and closing). The moves cases left `boot/studioBoot.test.ts`; `profiler/runFiles.test.ts`'s moves and
  trash cases and `playlistDeletes.test.ts`'s folder move-up cases moved to the library suite.
