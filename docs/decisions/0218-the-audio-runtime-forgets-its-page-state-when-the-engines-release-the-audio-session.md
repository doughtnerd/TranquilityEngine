# 0218. The audio runtime forgets its page state when the Engines release the audio session

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157, 0158, 0166, 0171, 0172

## Context

Several audio runtime modules keep state for the life of the page: the event runtime (`events()`: live instances, group
ids, curve ids, avoid-repeat history, parameter globals, the seed), the music players, the files' loop points
(`loopPoints.ts`), the warn-once keys (`core/handle.ts` `warnOnce`), and the core fallback's warning and reason
(`backend.ts`). Nothing in production ever cleared them. Tests did, through reset functions that existed only for them
(`events()._reset()`, `_resetMusicPlayers`, `_resetHandleWarningsForTests`, `resetCoreFallbackState`,
`resetFileLoopPoints`), which CLAUDE.md's testing rule forbids.

Production has a real moment when that state is stale: the editor closes or switches a project (its Engine is disposed),
or an exported game exits (its Engine is disposed with no editor Engine alive). The audio capture already frees its ring
and take at exactly that moment (ADR 0171 amended by 0172, record change 33). The other modules carried the old
project's curves, parameters, loop points of files that may now differ under the same paths, and spent warn-once keys
into the next project.

## Decision

We will treat that moment as the **release of the audio session** for the whole runtime, not only the capture.

- `runtime/audioSession.ts` holds the one copy of the rule (moved from `capture.ts`): an `editor` Engine disposed, or a
  `runtime` Engine disposed while no `editor` Engine is alive, releases the session. The editor's per-Play runtime Engine
  going is a Play stop and releases nothing. `onAudioSessionReleased(listener)` (internal) runs listeners in the order
  they were added; one that throws is logged and the rest still run.
- Listeners: the capture (`releaseCapture`, unchanged behaviour); the event runtime (`EventSystem.release()`: stop every
  instance, then forget the music players and everything a new page would not have); the warn-once keys; the core
  fallback's warning and reason (the next project's service load probes again); the files' loop points (waiters stay).
- The music modules' own resets that no production path needed (`_resetSegmentRuns`, `_resetStingers`,
  `_resetMusicBackground`) are removed outright: their state is per player or emptied as players stop.
- Tests end the session the way production does: they dispose the Engine they made, or call `endAudioSession()` in
  `runtime/testing.ts`, which creates and disposes a headless Engine.

## Alternatives considered

- **Keep the reset functions for tests** — forbidden by CLAUDE.md's testing rule; nothing in production called them.
- **`vi.resetModules()` and a fresh import in every test** — workable for a few files (the calibration tests do it), but
  about 80 files import these modules statically, and it would leave production carrying one project's state into the
  next.
- **Own the state per backend** — the event runtime and the music players must survive a backend hand-over (the pending
  backend to the core, F-35), so the backend is the wrong owner.

## Consequences

**Positive**
- A project switch in the editor no longer carries the previous project's event state, parameters, loop points or spent
  warnings.
- No audio runtime module keeps a reset that only tests call.

**Negative / costs**
- A game that disposes its only Engine and makes another loses its playing event instances and music (they would have
  been orphaned on a disposed Engine anyway).
- Tests that end a session pay one headless `Engine.create` per test.

## Deprecates

`EventSystem._reset`, `_resetMusicPlayers` (now the internal `forgetMusicPlayers`, called by the release),
`_resetSegmentRuns`, `_resetStingers`, `_resetMusicBackground`, `_resetHandleWarningsForTests`, `resetCoreFallbackState`
and `resetFileLoopPoints`: removed.

## Open questions

None.

## References

- `src/plugins/audio/runtime/audioSession.ts`
- ADR 0171 amended by 0172 (the capture's Released state)
