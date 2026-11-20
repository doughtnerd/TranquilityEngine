# 0263. One module owns the grid of a segment node now, with one length rule

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0166, 0224, 0229, 0248

## Context

The music runtime (`src/plugins/audio/runtime/music/`) reads a segment's grid (`compileSegmentGrid` in
`engine/audio/musicGrid.ts`, G1 of 0166) in 13 places. Nine kept a private `WeakMap` cache (planner, transition,
handle, playlist, loopTail, beatClock, stems, stingers, anchors) and three compiled on every call (seek,
startPosition, reload). The copies disagreed:

- **Which clip gives the length:** `tracks[0].clip` (planner, handle, playlist) or the first track with a clip (anchors,
  transition, stingers, seek, startPosition, reload); loopTail, beatClock and stems passed no end at all.
- **Decoded length:** only the anchors fell back to the backend's decoded length (`clipCache.clipDuration`), so on the
  Babylon fallback (no clip facts) an `"end"` exit resolved in the anchors and nowhere else.
- **Refresh:** clip facts arrive after a run is admitted (`SegmentClipSource.facts`). Only anchors, transition and
  stingers recompiled once they did; planner, handle and playlist cached the first grid forever, with `exitTicks = NaN`
  and an `"end"` cue without a time.
- **Malformed nodes:** `cues` required (planner, handle, playlist, which returned no grid) or `cues ?? []` (the rest;
  beatClock compiled a second fallback grid for exactly that case).

## Decision

We will have one module, `runtime/music/segmentGrids.ts`, answer "the grid of this segment node now". Callers keep no
grid caches and no length rules.

- **Interface:** `segmentGrid(node)` (the grid, null for a node that isn't a segment or has no tempo list),
  `segmentLength(node)` (`{ seconds, frames, rate }`, frames and rate only when the clip's facts are known; undefined while
  unknown), `segmentLoops(node, rate?, openEnd?)` (the grid with the usable loop regions on the frame grid of `rate`
  and the exit in file seconds, what the anchors' pass walk reads), and `FALLBACK_CLIP_RATE` (48 kHz).
- **Length rule:** a segment's file is its **first track that names a clip**; its length is that clip's facts (frames at
  its own rate), else the backend's decoded length in seconds, else unknown. The rule was the majority already, and a
  first track without a clip (a silent placeholder) no longer hides the file.
- **Refresh:** every read looks the length up (two map lookups) and recompiles when it differs from the one the cached
  grid has, so the first read after the facts arrive gets the full grid. The cache is per node object, private.
- **Open end:** `segmentLoops(…, openEnd = true)` keeps F-23's rule: with the length unknown, a region to `"end"` ends far
  past any file and the answer isn't kept.
- **Tolerance:** a segment without a `cues` list compiles with none (one rule instead of two).
- Callers narrow on the `MusicNode` `type` discriminant instead of casting to `Partial<SegmentNode>` where they read a
  segment's fields.

## Alternatives considered

- **Keep the caches, align their rules (the review's small fix).** Nine copies of the same rule drift again; it was the
  stopgap only until this record.
- **Cache the grid on the node object.** Nodes are parsed data shared with the editor; writing derived state onto them
  breaks 0229's split between authored data and the player's state.
- **Compile on every read, no cache.** `compileSegmentGrid` allocates typed arrays; the anchors read the grid several
  times a frame.

## Consequences

**Positive**
- An `"end"` exit resolves the same in the planner, transitions, playlist, handle, anchors and beat clock, including on
  the Babylon fallback through the decoded length.
- Locality: one "is the end known yet" rule, one test of late facts (`segmentGrids.test.ts`) through the module's own
  interface.
- Nine caches and 13 compile sites go.

**Negative / costs**
- Every grid read now does the length lookup (the anchors did already).
- `segmentGrids.ts` sits in the existing import cycle with `segmentRun.ts` and `anchors.ts`; importers must read
  `FALLBACK_CLIP_RATE` inside functions, not at module load.

## Deprecates

The private grid caches and `gridOf`/`segmentGrid` helpers in `planner.ts`, `transition.ts` (with its `rateOf` and
`fileSecondsOf` loops), `handle.ts` (whose exported `segmentGrid` other modules imported), `playlist.ts`,
`loopTail.ts`, `beatClock.ts` (and its fallback cache), `stems.ts`, `stingers.ts`; the anchors' `factsOf`/`compile`;
the uncached compiles in `seek.ts`, `startPosition.ts` and `reload.ts`. Removed.

## Open questions

- A run's own rate (`anchors.ts`/`loopTail.ts` `runRate`, `stems.ts`) still reads the run's picked stems, which can be
  alternatives of other clips; that is about the run's voices, not the node's grid, and is left as is.

## References

- `src/plugins/audio/runtime/music/segmentGrids.ts`, `segmentGrids.test.ts`
- `src/engine/audio/musicGrid.ts` (`compileSegmentGrid`)
- Architecture review 2026-11-20, candidate 2
