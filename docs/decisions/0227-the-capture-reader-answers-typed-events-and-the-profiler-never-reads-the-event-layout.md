# 0227. The capture reader answers typed events, and the Profiler never reads the EVENT layout

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0171, 0172, 0177, 0219

## Context

The capture file (ADR 0171, corrected by 0172) stores each `ProfileSink` tap as an EVENT record: a `kind` byte, a `reason` byte, a list of `u32` args and, for four kinds, an `f32` tail. What each arg means is written down once, in `runtime/capture/events.ts`, the sink that writes them. The reader (`capture/reader.ts`) decoded an EVENT only as far as `{ kind, reason, args, f32 }`, and its Worker sent that shape to the editor in every `seek` answer.

So every view that used events learned the layout again. `voiceTableModel.ts`, `profilerTablesModel.ts`, `tracks/events.ts`, `tracks/music.ts` and the Worker's own loudness walk switched on `EventKind` from `format.ts` and read `args[0]`, `args[2] & 0xff` (a `busRef`'s slot), `args[1] === 0xffffffff` (three private copies of `NO_NAME`), and a parameter's value by reinterpreting `args[2]`'s bits as an `f32`. Changing an arg layout meant finding these readers by hand, and the compiler could not help, because every arg was a `number` in an array.

The event tracks also had no way to ask for "the events". `seek(t)` answers the records of one keyframe interval, so `EventLog` covered the capture with seeks: it galloped and bisected over the STATUS times to find each keyframe boundary (a record written before a keyframe but stamped after the previous one can only be reached by a seek made before that keyframe). That was about seven seeks per captured second, each one decoding a keyframe, all to list records the Worker could have walked in one pass. The log kept a `seeks` counter that only its test read.

A review asked whether the reader should give each track its own typed series. Most tracks already depend only on the reader's answers: CPU and the counters read `range` columns, loudness has its own Worker series, markers come from the summary, and the cursor uses `seek` and `range`. Per-track series for those would only pass the same data through. Events were the exception, plus one header flag (`CAPTURE_FLAG_MAIN_SIDE_ONLY`) that the CPU track and the panel tested by its bit.

## Decision

We will decode EVENTs into named, typed values in the capture module, and the Profiler will receive only those values.

- **`CaptureEvent`** (`capture/events.ts`) is a union keyed by `type`, which is the `EventKind` name (`"voiceStart"`, `"parameter"`, `"musicTransition"`, …), with named fields. `NO_NAME` becomes `null`, a `busRef` becomes `slot` and `busGen`, the parameter's `f32` bits become `value`, the monitor mask becomes `mutes` and `solos`, and `loudnessControl` and `ladder` carry the sink's own words (`control`, `shed`). Every event keeps the numeric `reason` (§5.6's code, which keyframe rows share) and `perfMs`. `readCaptureEvent(payload)` inverts the sink's writes and sits in the same file as them, so the arg layouts are known in that one module. A record with fewer args than its kind's layout returns `null` and is not read. (The open accepts any arg count.) Extra args are ignored, so a writer may add to the end of a layout.
- **`seek`** answers each EVENT as `{ kind: "event", seq, seconds, event: CaptureEvent }`. MIXOP records are unchanged.
- **`eventsCapture(contents, from, types?)`** is a new reader function, and **`events`** is the Worker request that wraps it. It answers every typed EVENT after a record cursor, optionally only the given `types`, with axis seconds, plus the `next` cursor. `ProfileSource.events(from, types)` exposes it. It reads every EVENT exactly once, whatever order the stamps are in. A live view continues from `next` and reads only what was appended.
- **`CaptureOpenSummary.mainSideOnly`** replaces testing `header.flags` against `CAPTURE_FLAG_MAIN_SIDE_ONLY`.
- **The reader is the Profiler's vocabulary.** `reader.ts` re-exports the decoded types the views use: `CaptureError`, `CaptureErrorInfo`, the keyframe row types, the loudness answer types, `CaptureEvent` and `CaptureEventType`. It also exports `CAPTURE_OUTPUT_SLOT` for the final-output meter. The Profiler's tracks, cursor, voice table, tables, panel and source import from the reader and the Worker types, never from `format.ts` or `wire.generated.ts`.

`EventLog` drops its seek sweep. A refresh reads the STATUS times, does one seek at the first STATUS for the instances the first keyframe already counted, and makes one `events` call from its cursor.

## Alternatives considered

- **Typed series per track in the reader (CPU, counters, loudness, markers, voices, events).** Only events needed it. The other tracks already consume `range`, the loudness requests, the summary's markers and `seek`, and they contain view logic, not layout logic. Per-track series would only pass the same data through, and the reader would have to know about tracks.
- **Type the events on the editor side (a helper beside the views).** The views would stop repeating the layout, but it would then be written in two places, the sink and the helper. Putting the inverse in the sink's own module keeps one place, and lets the Worker's loudness walk use it too.
- **An "events in [t0, t1]" time window instead of a record cursor.** The disorder bound (§5.3) means a window has to overlap the previous one by `CAPTURE_DISORDER_SECONDS` and remove duplicates by `seq`, which leaks a reader constant into the views. The tracks want every event of the capture anyway. A cursor reads each record once and continues naturally on a live view.
- **Leave it.** The review rated it speculative. Reading the code showed real duplication: four readers of the arg layout, three `NO_NAME` copies, a bit-cast in a view, and a ~60-line seek sweep that exists only because there was no events request.

## Consequences

**Positive**
- A change to an EVENT arg layout touches `capture/events.ts` (write and read side by side) and nothing in the editor. The compiler checks every field a view reads.
- The event and music tracks read a capture in one Worker pass instead of about seven seeks per captured second, and a live view reads only the new records.
- `EventLog.seeks`, a member only its test read, is gone. The track test now checks what it should: every event read once, typed, at its recorded time.
- `voiceTableModel`, `profilerTablesModel` and the tracks read like the design (`e.voice`, `e.thief`, `e.instance`, `e.from === null`).

**Negative / costs**
- `seek` answers carry the typed object instead of the raw payload. The few tests that built seek records by hand now build `event` objects.
- One more Worker request type, and `ProfileSource` gains a member, so a fake source must provide it if a track calls it.
- Keyframe rows still carry their raw encodings (`KeyframeBus.flags` bits read in `busFactorsModel.ts`, a voice's `u4.12` pitch and `u0.16` audibility, the music row's `NO_NAME` pending transition). They are imported through the reader now, but typing them in the same way is left for later.

## Deprecates

- Reading `EventPayload.args` or `EventKind` in `editor/mix/` (removed). The private `NO_NAME` copies in `tracks/events.ts` and `worker.ts` (removed). The private copy in `profilerTablesModel.ts` remains, for the keyframe music row.
- `EventLog`'s gallop-and-bisect seek sweep and its `seeks` counter (removed).
- Testing `summary.header.flags & CAPTURE_FLAG_MAIN_SIDE_ONLY` in views (replaced by `summary.mainSideOnly`).

## Open questions

- Should keyframe rows get the same treatment (named bus mute flags, pitch and audibility as numbers, `null` for no pending transition)? That would let `busFactorsModel.ts` drop its flag bits.
- `liveFollow.ts`, `openCapture.ts` and `openSaveFlow.ts` still import `format.ts`, for the live-ring protocol, the header-size pre-check and the refusal codes. That is capture plumbing, not view logic, so this record leaves them as they are.

## References

- `src/plugins/audio/runtime/capture/events.ts` (`CaptureEvent`, `readCaptureEvent`), `reader.ts` (`eventsCapture`, `CaptureSeekRecord`, `CaptureOpenSummary.mainSideOnly`), `worker.ts` (`events` request).
- `src/plugins/audio/editor/mix/profilerSource.ts` (`ProfileSource.events`), `tracks/events.ts` (`EventLog`).
- Tests: `runtime/capture/events.test.ts` ("reading EVENTs back by name"), `editor/mix/tracks/events.test.ts`.
