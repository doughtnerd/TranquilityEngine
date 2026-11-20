# 0267. One history-tree module under the scene's undo stack and the asset documents' text history; each supplies a step adapter

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0027 (persistent undo tree; amended), 0141 (asset documents' text-patch tree; amended), 0116 (pruning by age), 0145 (the active history sees only `UndoHistory`), 0077 (text files in the scene's history), 0037 (the former `tranquility.*` names)

## Context

ADR 0141 gave asset documents 0027's tree by copying it: `TextHistory` repeated `CommandStack`'s tree code line for
line (redo-child choice, `back` / `forward`, `pathToRoot`, the common-ancestor walk, count pruning, `load`, the
getters), and the record listed merging them as an open question. The copies had drifted:

| rule | `CommandStack` (scene) | `TextHistory` (asset documents) |
| --- | --- | --- |
| next seq after `load` | trusted `file.nextSeq` | `max(file.nextSeq, highest seq + 1)` |
| root exists on `load` | not checked | checked |
| former `tranquility.history@1` | read | refused |
| a step that doesn't fit | never refused (a missing patch threw) | refused, nothing changes |

A damaged scene history (a `nextSeq` that is too small) made the next edit reuse a seq and overwrite a state. The
text-patch apply rule was written twice (`applyText` in `TextHistory`, inline in `CommandStack.replayFiles`), and
`historyPrune.ts` walked the same parent links a third time to prune by age (0116).

## Decision

We will have one module own the tree, apart from what is edited, and make the scene and text histories adapters of it.

- **`HistoryTree`** (`src/editor/document/HistoryTree.ts`) owns the states, root, current and saved state and
  numbering; the target of a move (`targetOf`: `"undo"`, `"redo"` to the child last visited, `"back"` / `"forward"`
  in creation order, or a seq) and its label (`labelOf`); the path between two states through their common
  ancestor (`path`); `add` (a child of the current state, then count pruning, 0027); the `myco.history@1` file
  (`toFile`) and adopting one (`load`). `HistoryState`, `HistoryFile`, `HISTORY_LIMIT` and `cleanPruneDays` live here.
- **Step adapter.** `go(move, value, adapter)` walks the path and hands each state to a `StepAdapter<V>`, whose
  `step(value, state, "undo" | "redo")` returns the moved value or null to refuse. A refusal abandons the whole move
  and changes nothing, so a step must not have side effects before the move succeeds.
- **Load guards, once.** `load(file, hash, { pruneDays, now, accepts })` reads both format names, refuses a damaged
  file (malformed or repeated states, no root, a state that doesn't lead to the root: a missing parent, a second
  root, a cycle) and any state `accepts` rejects, prunes by age, matches by `hash` (the saved state if it matches,
  else the newest), and continues numbering past the highest seq whatever `nextSeq` says.
- **Pruning by age (0116) is the tree's.** `toFile(scene, { pruneDays })` leaves out old states nothing kept needs
  (the tree keeps them) and `load` drops them on the way in. `historyPrune.ts` is deleted.
- **The scene adapter** (`CommandStack`): each state's document patch, refused when missing or naming a node that
  isn't there; the text files the steps wrote are replayed after the move succeeds. `CommandStack` keeps groups,
  listeners and dirtiness (`dirty` reads `tree.path`).
- **The text-patch adapter** (`TextHistory`): `files[0]` applied with `applyFilePatch`; `accepts` refuses a scene's
  history. `TextHistory` keeps `amend`. `FilePatch`, `diffText` and `applyFilePatch` move to
  `src/editor/document/textPatch.ts`, the one text-patch rule both use.
- **Outward interfaces stay.** `CommandStack` and `TextHistory` keep their members (plus an optional `AgeOptions` on
  `toFile` / `load`), and the active history (0145) still sees only `UndoHistory`. `historyPersistence.ts` and
  `assetHistory.ts` pass `pruneDays` to `load` / `toFile` instead of calling `pruneHistoryByAge`.
- **Saved layouts stay apart.** `layout/saved.ts` (0174) keeps its own version tree: each version is a whole layout,
  not a step, so it drops interior versions and re-parents their children, which a tree of diffs can't; its root
  hangs from 0, it has no undo, redo or saved state, and its operations are pure functions over the file.

## Alternatives considered

- **Generalise `CommandStack` over a document type** — puts groups, listeners and the scene's dirtiness rule in front
  of every history; the text history needs none of them.
- **Share only helper functions (path, prune)** — the state lives in two classes still, so load guards and
  numbering could drift again.
- **Fold saved layouts in** — see above; the shapes and pruning rule differ, and nothing would get simpler.

## Consequences

**Positive**
- The scene history tolerates damaged files like the asset histories do; asset histories read the former format.
- Tree rules are tested once through `HistoryTree` (`HistoryTree.test.ts`); the adapter tests cover only their
  payloads (`history.test.ts`, `TextHistory.test.ts`).
- A scene step that doesn't fit now refuses instead of throwing halfway through a move.

**Negative / costs**
- A scene move builds an adapter object per call (negligible next to `toJSON`).

## Deprecates

`src/editor/historyPrune.ts` (`pruneHistoryByAge`; `cleanPruneDays` moves to `HistoryTree.ts`) and its test, removed.
The copies of the tree in `CommandStack` and `TextHistory`, removed. `diffText` / `FilePatch` move from
`CommandStack.ts` to `textPatch.ts` (still exported from `src/editor/document`).

## Open questions

None.

## References

- `src/editor/document/HistoryTree.ts`, `textPatch.ts`, `CommandStack.ts`, `TextHistory.ts`
- `src/editor/historyPersistence.ts`, `src/editor/assetHistory.ts`
- Architecture review 2026-11-20, candidate 1
