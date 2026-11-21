# 0302. Project-wide reference edits go through asset documents and asset kinds

- **Status:** Accepted, amended by 0308 (the Code panel's buffers are a second file owner: a file with unsaved Code panel text has it rewritten too)
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** 0148 in part (its JSON-only edit loop and its text rule for users)
- **Related:** 0027, 0133, 0134, 0148, 0262, 0299

## Context

Renaming, moving or deleting an asset, and renaming a settings name (ADR 0262), edit every file that names it. The
loop in `src/editor/projectFileEdits.ts` wrote every non-scene JSON file itself with `JSON.stringify`, around the
file's asset document (`assetDocuments.ts`, ADR 0133) and its kind's `format`:

- **Undo brought back a dead path (confirmed).** An open asset document learnt of the write in `reread`, which calls
  `TextHistory.amend`: the current state took the new text, every other state kept its own. Rename a clip while its
  audio event is open, press Undo, and the event names a file that no longer exists.
- **A rename during a burst was lost (suspected, confirmed by test).** `reread` returns early while a coalesced edit
  is pending or a write is in flight; the burst then wrote its value, with the old path, over the rename.
- **Users and dependencies disagreed.** `assetUsers` matched a regex over quoted paths in `*.json` files and scripts;
  `assetDependencies` used each kind's own reader (`.obj`, `.mtl`, `.gltf`, audio events). Deleting a texture an
  `.mtl` names listed no users, and moving it reported nothing left behind.

## Decision

We will make the project-file edit ask each file's owner to apply the change, and answer "who uses this" with the
same readers that answer "what does this depend on".

- **Owners.** `editProjectFiles` (`projectFileEdits.ts`) finds the JSON files an edit changes and asks:
  - scenes and prefabs: the scene format, as before (`writeSceneFile`, instances in the open scene rebuilt); the open
    scene: its document, one `ReplaceDocument` undo step (save to keep it), as before;
  - asset files of a kind with a `format`: `assetFileOwner(project, path)` in `assetDocuments.ts`;
  - `project.json` and JSON files of kinds without a format: written as JSON, as before (the shell is their owner).
- **An open asset document takes the change in its whole history.** `assetFileOwner` hands the change to the document:
  a pending burst becomes its step first, then `TextHistory.rewrite` maps every state's text (patches rebuilt between
  the mapped texts, tree, labels and current state kept), and the new value is written in order with the document's
  own writes. The change is **not a step of its own**: the move or rename that caused it isn't undoable either, and a
  step would be the one thing Undo must never do (put back a path that no longer exists). So Undo after a rename
  undoes the user's last edit with the new path, in that file and every other. Deciding against "one labelled step":
  undoing it, or any step before it, would restore the dead path in that file only.
- **A closed asset file is written by its kind's format,** in the format's layout, when the format keeps everything:
  the changed JSON reads without problems and the format's text parses back to the same JSON (`deepEqual`). Otherwise
  (hand-written fields the parser ignores, values it would default) the changed JSON is written as it is, so a
  reference edit never drops data. The edit itself still runs on the file's JSON (`withMovedAssets`, a settings
  list's `assets` rename), as ADR 0299 wants.
- **One rule for the references a file holds** (`referencesIn` in `assetReferences.ts`): its kind's `references`
  reader if it has one, else every reference string in a JSON file (path and slice). `assetDependencies` keeps the
  project files among them; `assetUsers` lists the files one of them names (the file, a slice, something inside a
  folder). Scripts have no reader and keep the quoted-path rule; the open scene's unsaved text is read as JSON.
  `assetUsers` becomes async: files served as bytes whose kind reads their format (`.obj`, `.mtl`, `.gltf`) are read
  from the project's URL for them, as the thumbnail service does. It takes one path or several.
- **Files no owner can rewrite are reported, not edited.** No kind writes a non-JSON format, so `.obj`, `.mtl` and
  `.gltf` users of a moved file are listed with scripts: `rewriteReferences` returns `{ updated, notRewritten }`
  (was `scriptUsers`), the Assets panel says "Files that name the old path weren't changed", and the delete dialog and
  status list them as still referring to it.

## Alternatives considered

- **One labelled document step for the rewrite** (the review's first sketch) — visible in History, but Undo of it, or
  of anything before it, restores a path that is gone; coherent only by also rewriting earlier states, which leaves
  the step empty.
- **Keep writing JSON on disk and make `reread` rewrite the whole history** — the document would still guess, from a
  diff, what changed; the burst race stays.
- **Writing closed files always through the format** — canonical, but a hand-written field the parser ignores would be
  lost by a rename the user never looked at.
- **Let kinds contribute a `rewrite` beside `read`** (an `.mtl` writer) — a public SDK change for files the editor
  doesn't otherwise edit; left open.

## Consequences

**Positive**
- Undo after a rename or settings rename keeps the new name in an open asset document; a rename during a slider drag
  isn't overwritten.
- Users and dependencies come from one walk; the delete dialog lists an `.mtl` that names a texture.
- Files the editor writes keep the format's layout after a rename.

**Negative / costs**
- `assetUsers` is async and parses each JSON file that holds the target's name (a substring pre-filter skips the rest).
- The rewrite is invisible in the document's History; the Assets panel's status names the updated files.
- A closed file's saved edit history (ADR 0133) no longer matches the rewritten file and is set aside when it opens,
  as for any outside change.

## Deprecates

ADR 0148's JSON-only rewrite of asset files around their documents and its regex rule for `assetUsers` (kept for
scripts and the `mentioned` pre-filter); `scriptUsers` (folded into `notRewritten`).

## Open questions

- A kind `rewrite` for formats it reads (`.mtl` maps, `.obj` `mtllib`, `.gltf` URIs).
- Rewriting a closed file's saved history with it, so its undo tree survives a rename of something it names.

## References

- `src/editor/projectFileEdits.ts`, `src/editor/assetDocuments.ts` (`assetFileOwner`), `src/editor/document/TextHistory.ts` (`rewrite`)
- `src/editor/assetReferences.ts` (`referencesIn`, `assetUsers`, `rewriteReferences`), `src/editor/assetDelete.ts`, `src/editor/assetOps.ts`
- Tests: `src/editor/assetReferences.test.ts` (ADR 0302 block), `src/editor/document/TextHistory.test.ts`
