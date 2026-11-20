# 0269. One music-tree module addresses a node by id or path

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0166 (music format, editor tools, hot reload), 0263 (segment grids), 0158 (§7 Event editor), 0268

## Context

A music node has two addresses: its id (unique in an event, library segments included) and its path from the root
(`[1, "lib0"]`, the Event editor's). The descent over a node's `children` and `library` was written at least seven
times, each with its own edit around it, and nothing mapped one address to the other:
`segmentViewModel.ts` `findSegment`/`replaceSegment`, `RulesTable.tsx` `findContainer` (private, in a view),
`rulesModel.ts` `replaceContainer`, `eventTreeModel.ts` `getMusicNode`/`musicNodePaths`/`setMusicNode`/`mapMusic` (by
path), `ruleLint.ts` `leafSegments`, `runtime/music/reload.ts` `findNode` and `transition.ts` `containerById`. The engine
had only one-level helpers (`musicChildrenOf`, `musicChildById` in `musicFormat.ts`).

## Decision

We will address the music tree in **one engine module beside the format**, `src/engine/audio/musicTree.ts`, and every
editor and runtime caller uses it.

- **Addresses:** `MusicStep` (a child index, or `MusicLibraryStep` `"lib<n>"`), `MusicPath`; `isLibraryStep`,
  `libraryIndexOf`, `libraryStep`, `isLibraryPath`.
- **One level:** `musicChildrenOf`, `musicChildById` (moved from `musicFormat.ts`), `musicStepsOf`, `musicChildAt`.
- **Walk:** `musicEntries(root, { library? })` (every node with its path, children then library, depth first),
  `musicLeaves(node, { library? })` (segments; default the children only, what a container plays in turn),
  `musicNodeCount`.
- **Find:** `musicNodeAt(root, path)`, `musicPathOf(root, id)` (id → path), `findMusicNode`, `findMusicSegment`,
  `findMusicContainer` (library included).
- **Replace with structural sharing:** `replaceMusicNodeAt(root, path, node)` (throws `RangeError` for a path that leads
  nowhere or a container in a library slot), `replaceMusicNode(root, id, next)` (the root itself when the id isn't
  there), `mapMusicTree(root, fn)` (bottom up; what `fn` leaves alone is shared).

Path lookups accept any step list, so the Event editor's `NodePath` (which also has sustain slots for event trees) is
passed as is; a non-music step leads nowhere. The Event editor keeps its edits (add, remove, reorder, duplicate,
rename) in `eventTreeModel.ts`, built on this module. Specialised runtime indexes that walk children only and cache by
root (`transitionRules.ts` parents, `musicSwitch.ts` holders, `editorHooks.ts` playlist chains) stay where they are.

## Alternatives considered

- **Put the walk in `musicFormat.ts`** — the format module is the parser and writer; addressing is a separate concern
  its callers (editor and runtime) share, and a second file keeps both readable.
- **One addressing scheme only (ids)** — the Event editor's selection must address a node whose id is being edited or
  duplicated; paths stay, and the module maps between the two.

## Consequences

**Positive**
- One tested descent (`musicTree.test.ts`); a new child or library rule lands in one place.
- Editors and runtime reload find and replace the same way, with the same sharing.

**Negative / costs**
- `musicFormat.ts` no longer exports `musicChildrenOf`/`musicChildById`; callers import them from `musicTree.ts`.

## Deprecates

Removed: `findSegment`, `replaceSegment` (`segmentViewModel.ts`), `findContainer` (`RulesTable.tsx`), `replaceContainer`
(`rulesModel.ts`), `leafSegments` (`ruleLint.ts`), `getMusicNode`, `musicNodePaths`, `setMusicNode`, `isLibraryPath`
and the private `musicChild`/`musicSteps`/`countMusic`/`mapMusic` (`eventTreeModel.ts`), `findNode` (`reload.ts`),
`containerById` (`transition.ts`).

## Open questions

None.

## References

`src/engine/audio/musicTree.ts`, `src/engine/audio/musicTree.test.ts`; ADR 0166, 0263.
