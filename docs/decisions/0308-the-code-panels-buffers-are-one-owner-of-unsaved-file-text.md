# 0308. The Code panel's buffers are one owner of unsaved file text

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0030, 0125, 0247, 0302 (gets its second owner adapter)

## Context

A file open in the Code panel (ADR 0030) with unsaved edits was spread over six modules: the tab and dirty signals in
`code/codeState.ts` (which also repeated the scene/prefab rule in `codeFiles` and `codeFileText`, only one checking
`isTextAsset`); the unsaved text itself, held only in Monaco's models (`code/monaco.ts`, `syncModels` skipping dirty
models); `ui/CodePanel.tsx`, which reverted a closed tab's model and rebuilt the `file:///project/` URI by hand;
`assetOps.ts` (refused to move a dirty file; renamed tabs by hand); `assetDelete.ts` (closed a dirty script's tab
without the delete prompt saying so); `session.ts`; and `dialogs.ts`. Two bugs followed (both confirmed):

- **Unsaved script and JSON edits were discarded without asking** on Open project, Close project and window close:
  `confirmDiscard` and the close guard counted dirty scenes only.
- **A move or delete wrote a file on disk behind its dirty buffer.** `editProjectFiles` (ADR 0302) rewrote
  `data/level.json` on disk, the Code panel kept its unsaved text with the old reference, and the next Ctrl+S wrote
  it back, while the status had counted the file as updated.

Asset documents (ADR 0133) need nothing here: they write every edit themselves (a coalesced burst after its delay, and
a pending one when the project changes), so they hold no unsaved text for the guard to ask about.

## Decision

We will make one Code-buffers module, `src/editor/code/codeBuffers.ts`, the owner of the files open in the Code panel
and their unsaved text, with Monaco as an adapter of it and the Code panel as a view.

- **Interface.** Tabs (`openScripts`, `activeScript`, `openScript`, `showScript`, `closeScript`, `closeAllScripts`),
  unsaved text (`editBuffer` from the view as the user types; `bufferText`, the unsaved text or else the file's;
  `dirtyScripts`; `saveBuffer(path, write)`), what the panel can hold (`codeFiles`, `codeFileText`, `bufferTexts`, one
  rule: scripts and `isTextAsset` files, never scenes or prefabs), and the model URI scheme (`codeFileUri`,
  `codeFilePath`), written in one place. A buffer is unsaved exactly while its text differs from the file on disk.
- **Monaco is an adapter.** `monaco.ts` makes the models hold `bufferTexts` (unsaved text over the file's) and
  disposes the rest; the module bumps `bufferRewrites` when it changes a buffer's text itself (a rewrite, a revert, a
  move), and the panel's effect syncs then. Closing a tab drops its unsaved text; the model returns to the file.
- **The discard guard asks about it.** `confirmDiscard` and the beforeunload/Tauri close guard list dirty scenes and
  `dirtyScripts` together ("Discard unsaved changes to scenes/main.scene.json, data/level.json?").
- **It follows moves and deletes** like asset documents: `codeBuffersMoved` (tabs, the tab showing and unsaved text
  move with the file or folder, so moving a file with unsaved edits is no longer refused) and `codeBuffersDeleted`.
  The delete prompt names files whose unsaved text is lost (`unsavedWithin`) and asks even when "Don't ask again" was
  ticked, since that text exists nowhere else.
- **It is a file owner for the project file edit (ADR 0302).** `codeBufferOwner(project, path)` exists while the
  buffer has unsaved text. `editProjectFiles` lets the file's own owner write the disk as before, then hands the same
  change to the buffer, which **rewrites its unsaved text and stays unsaved** (`follow`), so a later save keeps the new
  reference and a discard returns to the rewritten file. The file is counted as updated when either changed. The
  rewritten buffer is JSON as `JSON.stringify(…, null, 2)` writes it, and Monaco's undo for it restarts (as an asset
  document's rewrite is no step, so Undo can't restore a dead path).
- **Unsaved text that isn't valid JSON can't be rewritten: the edit is refused with the reason.** A move checks
  first (`whyBuffersCantFollow`, in `whyNotMovable`, which Rename, Cut and drag use): "data/level.json has unsaved changes
  in the Code panel that aren't valid JSON, so its references can't be updated; fix, save or close it first". Other
  project file edits (a delete's cleanup of `project.json`, a settings name rename, ADR 0262) leave such a file alone,
  on disk and in the buffer, as they leave a broken file on disk.

## Alternatives considered

- **Refuse every move or delete that touches a dirty buffer** — simplest, but makes the user save before a rename the
  editor can do for them; kept only for text that doesn't parse.
- **Rewrite only the buffer and leave the disk to the next save** — a discard would then bring back the old reference
  on disk.
- **Keep the unsaved text in Monaco's models only** — the guard, moves and the file edit would all need Monaco loaded,
  and nothing could be tested without it.

## Consequences

**Positive**
- Unsaved Code panel edits are asked about before Open/Close project and window close.
- A move keeps an unsaved JSON buffer's references right, on disk and in the buffer; the status's count is true.
- The buffers are tested through their own interface without Monaco (`code/codeBuffers.test.ts`,
  `codeBufferEdits.test.ts`).

**Negative / costs**
- The module keeps a copy of each unsaved buffer's text, updated as the user types (one string per keystroke, which
  the dirty check already compared).
- A rewritten buffer loses its own layout and Monaco undo history.

## Deprecates

`codeState.ts`'s tab and dirty signals, `setDirty`, `codeFiles`/`codeFileText` there (moved), CodePanel's own model
revert and URIs, `assetOps.ts`'s refusal to move a file with unsaved edits and its hand-written tab rename. `codeState.ts`
keeps loading Monaco and the warm-up.

## Open questions

- Monaco's own undo could keep the rewrite as an edit (`pushEditOperations`) if a later record wants Undo there.

## References

- `src/editor/code/codeBuffers.ts`, `src/editor/code/monaco.ts`, `src/editor/ui/CodePanel.tsx`, `src/editor/dialogs.ts`,
  `src/editor/projectFileEdits.ts`, `src/editor/assetOps.ts`, `src/editor/assetDelete.ts`
