# 0224. Music reads the core's frame map through the `AudioClock` capability

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0179)
- **Related:** 0158, 0166, 0179

## Context

ADR 0179 made the audio backend seam required members plus capability objects a caller reads once (`clipCache`, `clock`, `music`, `automation`, `mix`, `capture`), so callers no longer test for optional members or cast the backend. Two places in the interactive-music runtime still did. `music/segmentRun.ts` (`eventClock`) cast `audioBackend()` with `as unknown as { clockMap?: … }` to read the core's `ClockMap`, and `music/background.ts` (`contextRate`) cast the backend to `{ clockMap?: … }` to read its rate. Both want the same three facts: the context's sample rate (a rebuild may change it), the `timeOffset` that makes frame `f` heard at `f / sampleRate + timeOffset` after a context swap, and whether that offset is still unknown (`carryPending`). The casts reached into a public field of `CoreBackend` that no interface names, so a rename of `clockMap` would have compiled and silently fallen back to 48 kHz, and a test could only drive a rate change by assigning a `clockMap` property onto a fake.

## Decision

We will add one read to the `AudioClock` capability: `frameMap(): AudioFrameMap | null`, where `AudioFrameMap` is `{ sampleRate, timeOffset, carryPending }`, a snapshot read afresh each call.

- **The core** answers from its `ClockMap` (`CoreBackend.frameMap()`; the core's `clock` capability is the backend itself, ADR 0179).
- **The Babylon fallback** has no heard clock and so no `clock` capability; callers already take their no-clock path, and `backend.clock?.frameMap()` is undefined there. It gains nothing.
- **`FakeBackend`** returns `frameMapValue`, null by default (no frame map); a test sets it to drive a rate change or a pending carry through the same interface the music reads.
- **Music reads only `backend.clock`.** `eventClock` and `contextRate` use `clock?.frameMap()`; the `as unknown as` casts are gone. A null map means what an absent `clockMap` meant: 48 kHz and the event's own start frame.

`clockMap` stays a public field of `CoreBackend` for the loopback tests and the core's own parts; music no longer reads it.

## Alternatives considered

- **Expose `ClockMap` on the capability.** It would hand callers `rebase`, `reanchor` and the stamping methods music must not call, and the fake would need the whole class.
- **Pass the rate in every group event.** `routeGroupEvent` already takes an optional `sampleRate`, but `timeOffset` and `carryPending` belong to the clock, not to a backend event, and the background check has no event.

## Consequences

**Positive**
- The music runtime has no casts to the backend; the seam names what it reads.
- A rate change or a carry that has not settled is testable through the fake's interface.

**Negative / costs**
- `AudioClock` has one more member for every implementation (two: the core and the fake).
- Each call allocates a small snapshot object; music reads it once per group start and per recovery, not per frame.

## Deprecates

The `as unknown as { clockMap? }` reads in `music/segmentRun.ts` and `music/background.ts`: removed.

## Open questions

None.

## References

- ADR 0179 (the capability objects), ADR 0166 (the music seam and clock), ADR 0158.
- `src/plugins/audio/runtime/backend.ts` (`AudioClock`, `AudioFrameMap`), `music/segmentRun.ts`, `music/background.ts`, `music/anchors.test.ts`.
