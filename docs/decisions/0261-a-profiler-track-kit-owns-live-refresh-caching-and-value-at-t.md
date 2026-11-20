# 0261. A profiler track kit owns live refresh, caching and the value at t

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0171, 0172 (the `TrackModule` contract in `editor/mix/tracks/types.ts`), 0227 (no per-track series in the reader), 0260

## Context

The Profiler's track modules (`editor/mix/tracks/`) each decided how to read the capture, how to cache it and how to find "the sample in force at t":

- **Reading.** `cpu.ts` read only the samples after its newest one. `voices.ts` and `counters.ts` re-read the whole capture's STATUS columns on every live update, and `counters.ts` asked for `VOICE_COLUMNS` again although `voices.ts` had just read them. `events.ts`'s `EventLog` re-read every STATUS time on each refresh to sample its spans on. With the panel refreshing every module on each live update (`ProfilerPanel.tsx`), a one-second segment cost three whole-capture `range` requests.
- **Single flight.** Five schemes: `cpu.ts`'s and `loudness.ts`'s `inflight`, `counters.ts`'s closure, `EventLog`'s `running`, and `buses.ts`'s promise chain (which queued instead of joining). The joining ones dropped a refresh that arrived after the source grew mid-read.
- **Value at t.** `indexAtOrBefore` was written twice with the same body and exported from both `cpu.ts` and `voices.ts` (`counters.ts` imported `cpu.ts`'s); `loudness.ts`, `buses.ts` and `runtime/mix/loudnessTrackModel.ts` had their own; `tracks/events.ts`, `cursorModel.ts` and `timelineModel.ts` each kept a `lowerBound`/`upperBound` pair; `reader.ts` exported `lastAtOrBefore`/`firstAtOrAfter` with the count before the time.

## Decision

**A track kit** (`editor/mix/tracks/kit.ts`), one per open capture (`TrackKit.of(source)`), that track factories declare against:

- **`status(columns)`** declares the STATUS columns a track reads and returns the shared `StatusFeed` (`times`, `column(name)`, `columns()` as a range answer, `at(t)`). **`events()`** declares that a track reads the EVENTs and returns the shared `EventLog` (moved from `tracks/events.ts`).
- **`refresh()`** reads what the source gained: one `range` for the union of the declared columns from the newest sample held (a sample at that time already held is not added twice), and one `events` page from the record cursor. Calls during a read join it; a call after the source's summary changed (a live segment arrived) runs one more read when it ends (`singleFlight`, exported for the reads the kit doesn't make).
- **`track(spec)`** makes a `TrackModule` from the row, a `build` that returns the drawn data and the tooltip, and an optional `read` for a track that reads more than columns and events (the bus tracks' grid of seeks, the loudness series from the Worker). A module that reads only the shared feed and log rebuilds when its data or tooltip is asked for after the kit read something new, so refreshing one module of a family refreshes them all; a module with its own `read` rebuilds after it.
- **The value at t** is one library module, `src/engine/core/sortedSearch.ts` (`lastAtOrBefore`, `firstAtOrAfter`, `firstAfter`, each with an optional count), used by the kit (`StatusFeed.at`), every track, `cursorModel.ts`, `timelineModel.ts`, `reader.ts` and `loudnessTrackModel.ts`.

The CPU, voices, counters, event, music and marker tracks build through `kit.track`; the bus tracks pass their sampler's refresh as `read`; the loudness track keeps its client and uses `singleFlight`. The `TrackModule` contract (`types.ts`) is unchanged, so the panel and the canvas are untouched. The kit is editor code: the reader still answers columns and events, not per-track series (ADR 0227).

## Alternatives considered

- **A shared cache in `ProfileSource`.** It would put track concerns (which columns, when to rebuild) into the Worker client that the tables and the cursor also use.
- **Per-track series in the reader** (one request per track). ADR 0227 rejected it; it moves view logic into the Worker.
- **Only deduplicate `indexAtOrBefore`.** It fixes the copies but leaves three whole-capture reads per live update and five single-flight schemes.

## Consequences

**Positive**
- One place sets the refresh cost: a live update reads only the new samples, once, for every track.
- A new track declares columns and a build function; the kit does the rest. Track tests drive real captures through the kit, and `kit.test.ts` tests the reading rules alone over a source made of arrays.
- One binary search for the whole Profiler, the reader included.

**Negative / costs**
- The kit holds every declared column for the whole capture (as `counters.ts` already did for its own), so its memory grows with a long live capture: 8 bytes per column per STATUS sample: 22 columns and the times, about 11.5 KB per second at 62.5 STATUS blocks per second (48 kHz).
- Builds still derive the counter and voice series from every held sample per growth (CPU work, not a Worker read).

## Deprecates

`indexAtOrBefore` in `tracks/cpu.ts` and `tracks/voices.ts`; `lowerBound`, `upperBound`, `eventLogFor`, `hoverModule`, `EventLog`'s own STATUS read and the hover types in `tracks/events.ts` (the types move to `kit.ts`); `loudness.ts`'s and `buses.ts`'s bisects and single-flight; the private bisects of `cursorModel.ts`, `timelineModel.ts` and `loudnessTrackModel.ts`; `reader.ts`'s exported `lastAtOrBefore`/`firstAtOrAfter`. All removed.

## Open questions

- Evicting the oldest held samples for a very long live view (the kit could keep a window and re-read on a zoom out).

## References

- `src/plugins/audio/editor/mix/tracks/kit.ts`, `kit.test.ts`; `src/engine/core/sortedSearch.ts`, `sortedSearch.test.ts`.
- `src/plugins/audio/editor/mix/tracks/{cpu,voices,counters,events,music,markers,buses,loudness}.ts`.
