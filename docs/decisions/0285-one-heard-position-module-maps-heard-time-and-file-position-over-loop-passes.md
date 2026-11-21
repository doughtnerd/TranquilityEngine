# 0285. One heard-position module maps heard time and file position over loop passes

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0166 (P3 `advanceAnchor`, R1 `PlayingGrid`/`exitTime`)
- **Related:** 0166 (P3 grid anchors, R1 `exitTime`, R4a/R4b loop regions), 0229 (`PlayingPosition`, promotion), 0263 (segment grids and loops), 0222 (the GLOSSARY's other "anchor")

## Context

Music asks "when is this heard?" in many places: the handle's `nextGrid`, stinger quantisation, quantised stem
automation, the planner's default points, a transition's exit point, a playlist's natural exit, a recovery's restart
bar, the beat clock, the debug rows. `music/anchors.ts` (ADR 0166 P3) answered it two ways side by side:

- **pass-aware readers** (`ticksAt`, `predictWrap`, `nextWrapOf`) that walk loop passes from the grid anchor;
- **linear readers** (`playingGridOf`, `heardTimeOf`, R1's `PlayingGrid` with `heardTimeAt`/`ticksAtHeard`) that apply
  heard = `anchor.time` + file − file(`anchor.ticks`), right only inside the anchor's own pass, unless the caller first
  called `advanceAnchor` (only transition planning and reload did).

Stingers, stems and the planner summed the anchor by hand. Nothing moves the anchor while a loop plays with no transition
planned, so they named points the loop never plays. The handle's `nextGrid` had the same bug and was fixed once
(646b2480) by copying loop-region knowledge into the handle. Failing tests written first through the music modules'
interfaces (`handle.trigger` via `triggerOn`, `quantizedRamp`; `music/loopPasses.test.ts`) confirmed it on a forever
region of a bar and a half: a bar stinger in pass 2 stamped at 4 s instead of 5 s; a cue stinger in pass 3 was dropped
(the linear reading put the cue behind it); quantised stem ramps landed a bar early in passes 2 and 4.

## Decision

We will make `music/anchors.ts` the **heard position**: the only module that maps between heard time and file position
on a playing segment. Every query walks the loop passes from the anchor itself (a forever loop in closed form), so the
anchor never needs moving to "the pass heard now", and it answers whole questions:

- **`ticksAt(anchor, T)`**: the position heard at T (unchanged).
- **`nextHeard(position, T, next, strict?)`**: the heard time (and file seconds) of the first file position a
  `NextPoint` names at or after the position heard at T, in the pass it is heard in. A point the loop wraps before, or
  within half a clip frame of the wrap (the worker wraps on the clip's frame grid), is asked again from the region's
  start one pass later; when no pass of the region holds one the walk goes on past its last wrap; a forever region that
  never plays it gives NaN. `nextGridHeard(position, T, spec, strict?)` is the grid-spec case. The search starts no
  earlier than the anchor.
- **`predictWrap`, `nextWrapOf`**: the next wrap after T (unchanged meaning, now on the same walk).

`position` is a `PlayingPosition` (a player: its run's anchor and its region release) or a bare `GridAnchor` (a
successor's, a bridge's: its release through `bindRelease`). Callers describe *what* point they want as a pure function
of file seconds; the module decides *when* it is heard:

- R1's `exitTime(match, PlayingGrid, notBefore, natural)` becomes **`exitPoint(match, grid, file, natural)`** in file
  seconds; `transition.ts` asks `nextHeard` with it (the leg-1 exit, the bridge's exit cue, `ringsOn`). `PlayingGrid`,
  `heardTimeAt` and `ticksAtHeard` are deleted.
- `stingers.ts` (grid, next grid, cue), `stems.ts` (`quantizedRamp`), `planner.ts` (`defaultPoint`), `playlist.ts`
  (natural exit), `background.ts` (recovery's restart bar), `beatClock.ts` (its line walk, strict after the cursor) and
  `handle.ts` (`nextGrid`) each make one query. `audioRows.ts` and `background.ts` read the grid from `segmentGrid`.
- `advanceAnchor`, `playingGridOf` and `heardTimeOf` are no longer exported (deleted). The anchor moves only by its named
  corrections: promotion, slips (`applySlip`) and a released region's end (`anchorPastRegion`).

## Alternatives considered

- **Call `advanceAnchor` every frame before the plan step** — keeps the linear readers right at `now`, but not at other
  times (a stinger's next point, a planner point two passes ahead, the beat clock's look-ahead), and leaves the rule in
  every caller's head.
- **Fix stingers and stems as the handle was fixed** — two more copies of loop-region knowledge outside the module; the
  next caller makes a third.

## Consequences

**Positive**
- Locality: the loop-pass rule (count, forever, a `while` region's release, the half-frame wrap line, the exit) is in
  one module instead of nine callers.
- Fixes the stinger (grid and cue) and stem quantisation bugs on loop passes ≥ 2; recovery's restart bar and the
  bridge's exit cue are now right across wraps too.
- Pass 3, the wrap and a released region are tested once on this interface (`anchors.test.ts`, `anchors.loop.test.ts`,
  `regions.test.ts`); caller tests stop knowing about passes.

**Negative / costs**
- A query is a walk from the anchor each time (closed form per region, so a few region steps), not a constant-time sum.
- The player's `anchor.pass` now stays at the anchor's pass; the debug row's `pass` shows the anchored pass, not the
  pass heard now (unchanged in practice: only planning moved it before).

## Deprecates

`advanceAnchor`, `playingGridOf`, `heardTimeOf` (anchors.ts), `PlayingGrid`, `heardTimeAt`, `ticksAtHeard`, `exitTime`
(transitionRules.ts), `transition.ts`'s `passAfter` pass loop, `playlist.ts`'s wrap loop (`MAX_WRAPS`, `WRAP_PROBE`), and
the hand-summed anchors in `stingers.ts`, `stems.ts`, `planner.ts`, `handle.ts`: removed.

## Open questions

None.

## References

- `src/plugins/audio/runtime/music/anchors.ts`, `transitionRules.ts`, `transition.ts`, `stingers.ts`, `stems.ts`,
  `planner.ts`, `playlist.ts`, `background.ts`, `beatClock.ts`, `handle.ts`, `reload.ts`, `../audioRows.ts`
- `music/loopPasses.test.ts` (the bugs, written first), commit 646b2480 (the handle's earlier fix)
