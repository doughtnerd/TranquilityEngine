# 0286. The fake audio backend has one clock, and music tests step the real plan step

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0270 (the frame order written once, the rigs run it), 0224 (the frame map), 0264 (fake voices record stamped ramps), 0158 (`clock.horizon()`), 0285

## Context

`makeFakeBackend()` (`runtime/testing.ts`) is the fake tier's adapter of `AudioBackend`. Production derives `Audio.time`,
the horizon, `timeAt` and the frame map from one `ClockMap`; the fake had six separate settings (`time`, `horizonTime`,
`rafTime`, `frameIntervalSeconds`, `frameMapValue`, `latencyValue`) that a test set one by one and that could disagree.
`time` is read-only on `AudioBackend`, so 28 writes in 18 files went through `(b as { time: number }).time =`; nine music
test files carried the same `at(now)` helper (set `time`, set `horizonTime = now + L`, return a hand-built frame cast
`as unknown as MusicFrame`) and called single steps (`tickTransition`, `planTick`, `tickPlayer`) directly, skipping the
tick order. `fakeHostClock` (the recording and loopback tiers' clock) already works as one clock moved by one call.

## Decision

We will give the fake backend **one clock**, moved by one call, and derive the rest from it:

- `advance(seconds)` (and `advanceTo(time)`, which may go back when a test sharing the fake starts over) moves `time`
  and the rAF time together; `time` and `rafTime` are read-only getters, so `timeAt(p) = time + (p − rafTime) / 1000`
  stays consistent.
- `lookahead: number | null` replaces `horizonTime`: `clock.horizon()` is `time + lookahead` (null: no horizon, the
  Babylon fallback's path).
- `startContext(rate)` replaces `frameMapValue`: a context whose frame 0 is heard now; `clock.frameMap()` reports
  `{ sampleRate: rate, timeOffset: <time then> }` from there on (null before, as a backend without one).
- `frameIntervalSeconds` and `latencyValue` stay settings (they are configuration, not the clock's time).

Music unit tests drive the fake through the real frame where the test is about the tick order:

- `musicFrameStep(backend, now, dt)` moves the clock and runs one music frame as the audio systems do: step 0
  (`musicEarlyStep`) then step 9 (`musicPlanStep`, every player's `tickPlayer`). The transition, precedence, refusal,
  seek, reload and playlist tests and `audioApiM4.test.ts` step it instead of calling `tickTransition` + `planTick` or
  `tickPlayer`. A call between two steps is one from outside the frame, as in production (F-25).
- `musicFrameAt(backend, now?, dt?)` gives the frame the plan step hands a player, at the clock moved to `now`, for a
  test of one module's own step (the planner's `planTick`/`requestStart`, a stinger's `tickStingers`, `quantizedRamp`).
  No hand-built or cast `MusicFrame` remains in a fake-tier music test.

Both live in `runtime/testing.ts` beside the fake: it stays an adapter of the real interface, and no production module
gains a member for tests.

Two stale test details go with it: `music/reload.test.ts` no longer patches `voice.fadeShaped` (the fake's voices record
stamped ramps since ADR 0264; the test reads them from `events`), and `music/seek.loopback.test.ts` and
`core/streamRegionLoopback.test.ts` read the lookahead and the stamped frame from the public `clock.horizon()` and
`clock.frameMap()` instead of the core backend's private `clockMap`.

## Alternatives considered

- **A shared `at(now)` in `testing.ts` that sets each field** — one copy instead of nine, but the fields still disagree
  as soon as a test sets one by hand, and the tick order is still skipped.
- **Run music unit tests on the loopback (ADR 0270's frame driver)** — the real core is slower and the fake tier exists
  for what the core can't show quickly (refusals, primes on demand); the fake keeps its place with the same frame order.

## Consequences

**Positive**
- Locality: the clock rule is in the fake adapter; `time`, horizon, `timeAt` and frame map cannot disagree.
- The transition, reload and seek tests run the real tick order (switch, playlist, regions, transition, planner, loop
  tails, stingers, stems), so ordering bugs show at unit speed.
- No `(b as { time: number }).time` cast and no `as unknown as MusicFrame` in fake-tier tests.

**Negative / costs**
- A test that wants the horizon at a fixed heard time while it moves the clock sets `lookahead` relative to the frame's
  time (a comment says where the horizon lands).
- `musicFrameStep` also runs the early step (the beat dispatch, `beginFrame`), which a test of the plan step alone did
  not before.

## Deprecates

`FakeBackend.horizonTime`, `frameMapValue` and a writable `rafTime`/`time`; the nine `at(now)` helpers and the
hand-built frames in fake-tier music tests: removed.

## Open questions

None.

## References

- `src/plugins/audio/runtime/testing.ts` (`makeFakeBackend`, `musicFrameAt`, `musicFrameStep`)
- `src/plugins/audio/runtime/music/*.test.ts`, `audioApiM4.test.ts`, `events/*.test.ts`, `mix/soundLabMixer.test.ts`,
  `src/engine/tests/{flappyMusic,soundLabRhythm,soundLabTouch,soundLabSpatialSample}.test.ts`
