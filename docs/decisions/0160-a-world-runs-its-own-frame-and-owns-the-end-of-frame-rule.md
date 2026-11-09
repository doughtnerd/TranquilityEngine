# 0160. A World runs its own frame and owns the "now, or at the end of the frame" rule

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0011, 0032, 0034, 0093, 0124, 0153, 0159

## Context

ADR 0011 fixes the order of a frame; ADR 0032 gave each World its own loop and clock. But the frame lived in
`Engine.stepWorld`, which drove about ten World internals in order: `_runPendingStarts`, `_accumulator`,
`_resolveWaits`, `scheduler.run`, `_propagateTransforms`, `_flushDestroyed`, `_clearBuffers`, `_sceneOps` and
`_inFrame`. Around it:

- `Engine._redraw` repeated steps 7–9 (propagate, sync, render).
- The rule "inside a frame, wait for its end; outside, do it now" was written out by `SceneManager.load`
  (`_inFrame ? _sceneOps.push(op) : _runIn(op)`), `Engine._destroyWorld`, `UIDocument`'s `destroyNode`
  (`!_inFrame && _flushDestroyed()`), and the editor's `destroyNow`/`applyDestroys`, which flushed even inside a
  frame and so were documented "only call between frames". `ui/components.ts` read `_inFrame` to pick an event's
  frame.
- `ThumbnailRenderer.settle` (0153) moved particles by writing `world.time.deltaTime` by hand around
  `renderer.sync` and setting it back.
- A World couldn't be stepped without an Engine: `isolation.test.ts` copied part of the frame (setting
  `_inFrame`, calling `_flushDestroyed`) to run one.

## Decision

**`World.step(dt, { surface?, timings? })`** runs one frame of the World in ADR 0011's order, with it current, and
restores the previous current World afterwards: the clock (step 1), `start()` (3), fixed steps at its own rate with
the accumulator and sub-step cap (4), interpolation when it has a surface (0093), update and lateUpdate (5–6),
transform propagation (7), sync and render to `surface` (8–9), then, even if a phase threw, deferred destroys,
buffers and the queued end-of-frame work (10). `timings` gets the fixed, update and render durations (play mode's
Stats). The input snapshot (2) stays the Engine's: one per Engine frame, shared by its Worlds.

**`World.redraw(surface)`** is steps 7–9 alone, with the World current (the editor's redraw while paused).

**`World.advanceClock(dt)`** is step 1 alone; `step` calls it first. `ThumbnailRenderer.settle` uses it (a
thumbnail's World is drawn, never stepped), then `advanceClock(0)`.

**One end-of-frame rule.** `World.atFrameEnd(op)`: inside the World's frame, `op` runs at step 10 after deferred
destroys; otherwise now, with the World current. `World.applyDestroys()` is the same rule for deferred destroys
(outside a frame, now; inside, step 10 already applies them, so nothing is queued). `World.inFrame` is a read-only
getter; the flag and the queue are private. Users: `SceneManager.load`, `Engine._destroyWorld`, `UIDocument`, the
editor's `destroyNow`/`applyDestroys` (now safe inside a frame), and `ui/components.ts` (`inFrame`).

**Engine** keeps the scheduling: which Worlds step (unpaused, alive, in creation order), the input snapshot, the
surface each draws to (`views.surfaceOf`, 0159), the default World current afterwards, and timings. `stepWorld` is
one call to `world.step`, `_redraw` one call to `world.redraw` per drawn World.

The frame's order and behaviour are unchanged; only its owner moves. `_runPendingStarts`, `_resolveWaits`,
`_propagateTransforms`, `_flushDestroyed`, `_clearBuffers` and `_accumulator` stay `@internal` World members (tests
and the net session's tick estimate read some of them).

## Alternatives considered

- **A separate `FrameRunner` over a World** — a second module that still needs every one of those internals; the
  World is the thing whose frame it is.
- **One `atFrameEnd` for destroys too** (`atFrameEnd(() => _flushDestroyed())`) — inside a frame it queues a
  closure per destroy (a UI document rebuild destroys many nodes per frame) for work step 10 does anyway.
- **Keep `_inFrame` public and writable** — tests and callers could again run half a frame by hand.

## Consequences

**Positive**
- A World steps without an Engine (`isolation.test.ts` and `worldFrame.test.ts` call `world.step`), and the frame
  order is tested on a bare World.
- The end-of-frame rule is in one place; the editor's destroy helpers no longer break if called mid-frame.
- `Engine.ts` loses its 70-line `stepWorld` and the `_redraw` copy.

**Negative / costs**
- `World.ts` grows by about 130 lines (with comments); `Engine.ts` goes from 542 to 473.
- `World.step` restores the previous current World instead of leaving itself current; the Engine sets the
  default World afterwards anyway, so nothing observable changes there.
- `settle` now also advances `time`, `frameCount` and `realtimeSinceStartup` while it moves particles, as a real
  frame would; nothing in a thumbnail reads them.

## Deprecates

`World._inFrame` and `World._sceneOps` (now private, behind `inFrame` and `atFrameEnd`); `Engine.stepWorld`'s frame
body and `_redraw`'s steps; the hand-written time in `ThumbnailRenderer.settle`; `isolation.test.ts`'s copy of the
frame.

## Open questions

- `SceneLoader` flushes destroys during `removeNode` overrides even inside a frame; it's left as is (instantiation
  needs the node gone at once).

## References

- `src/engine/core/World.ts` (the frame section), `Engine.ts` (`step`, `stepWorld`, `_redraw`, `_destroyWorld`)
- `src/engine/scene/SceneManager.ts`, `ui/UIDocument.ts`, `ui/components.ts`, `editor/index.ts`,
  `render/babylon/previews/ThumbnailRenderer.ts` (`settle`)
- Tests: `src/engine/tests/worldFrame.test.ts` (new), `isolation.test.ts`
