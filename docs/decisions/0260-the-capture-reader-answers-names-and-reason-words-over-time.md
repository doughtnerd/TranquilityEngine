# 0260. The capture reader answers names and reason words over time

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0171 (§17, the session slot table and its tombstones), 0172, 0227 (amended by this record), 0230

## Context

ADR 0227 made the capture reader answer typed events, so the Profiler stopped reading the EVENT arg layout. Two things stayed behind.

- **Names.** Five editor modules named things their own way: `nameLookup` (`editor/mix/voiceTableModel.ts`), `eventNames` (`tracks/events.ts`), `busName` in `tracks/buses.ts` (META's names, then the project section by slot for a tombstone), a private `busName` in `tracks/loudness.ts` (the only one that called the output slot "Master"), and `busParents` (`profilerTablesModel.ts`, which mapped names back to slots itself). The same unnamed bus read `bus 3` in one track and `Bus 3` in another. `TrackContext.names` was built once when the panel attached a capture (`ProfilerPanel.tsx`), so a live capture's later names never reached the tracks.
- **Bus names froze at the take's start.** META's `buses` table (slot to name) is built from the slot table when the take starts (`capture.ts`'s `buildMeta`), and the saver then overwrote it with the names seeded when the ring started. Nothing recorded a bus added, recycled or renamed during the take: a new bus read `bus 3`, and a renamed one kept its old name. `capture/events.ts`'s header said the reader applies rename MIXOPs. It doesn't: MIXOP records are decoded, `decodeMixOp` (`src/engine/audio/mixOpCodec.ts`) has no production caller, and no production code writes a MIXOP at all.
- **Reasons.** `CaptureEvent.reason` was §5.6's raw code. The reader worded `loudnessControl` and `ladder`, but the voice table re-typed the voice reason tables (`reasonText`, `stopReasonText`, mirroring `VIRTUAL_REASON` and the rest in `events.ts`), as 0227 had removed for event args.

ADR 0227's Deprecates note says a private `NO_NAME` copy remains in `profilerTablesModel.ts` for the keyframe music row. It is already gone: the music row's pending transition is typed (`m.pending === null`), so nothing is left to remove there.

## Decision

**A name interface over time** (`runtime/capture/names.ts`, re-exported by `reader.ts`). The reader keeps every name it reads as `[id, name, seconds]`: META's at `-Infinity`, then each NAMES record at its axis time (`CaptureContents.nameLog`). `CaptureOpenSummary.names` is that log (it stays structured-cloneable, and a live view's grows with each appended segment). `captureNames(summary)` returns a `CaptureNames`, built once per summary, which answers:

- `name(table, id, t)` and the shorthands `clip`, `bus`, `event`, `parameter`, `snapshot`: the last name at or before `t` (the latest when `t` is left out). Before an id's first record it reads as that first name.
- the one fallback text: the table's word and the id (`clip 3`, `bus 3`, `event 3`), and `Master` for the output slot (`LOUD_OUTPUT_TAP`) when no bus is named there;
- `find` (no fallback), `slotOf(name, t)` and `busSlots(t)`, for the bus table's parents and the Worker's loudness controls.

**The capture records each slot's name as it changes.** `EventSink.busName(slot, name)` writes a NAMES record in the `buses` table, keyed by slot as META's is, when the slot doesn't already hold that name. `capture.ts` calls it for every named slot of `Audio.debug().mix.slots` after each op the live mix sends (`onMixOpSent`) and before each keyframe (which catches a deferred add that found its slot). The saver merges the sink's names into META only where META has none, so META keeps the slot table at the take's start. The file format does not change: NAMES records in the `buses` table were always allowed (§5.3), and an older reader takes the last one.

**Reasons are words.** `runtime/capture/reasons.ts` holds the code tables by the sink's words (moved from `events.ts`), turns codes back into words, and owns `reasonText(word)`, the one text of each word ("bus max voices"; "demoted by the cap"). Each `CaptureEvent` kind with §5.6 reasons carries `reason` as its word (`ProfileStopReason | null` and so on; null for a code this build doesn't know), and kinds without reasons carry none. A KEYFRAME voice row's `reason` is read by its state into the same words (`readCaptureKeyframe`).

**Callers ask at query time.** The voice, event, bus and music tables name rows at the seek's instant. The bus, loudness, event and music tracks name things at the sample's or event's instant through `captureNames(ctx.source.summary)`, so a live capture's new names reach them on the next refresh. `TrackContext` loses `names`. The rule that a tombstone is named from the project section by slot is dropped: the slot's own name at the instant is right, including after a recycle.

**MIXOPs are not applied.** A MIXOP `addBus` carries the bus's name and parent but not the slot it took (the slot table picks it, and may defer it), so applying MIXOPs cannot name a slot; the NAMES record can, exactly. No production code writes MIXOPs yet, so `decodeMixOp` keeps no production caller, and `events.ts`'s header now says how bus names are recorded.

## Alternatives considered

- **Apply `addBus`, `removeBus` and `renameBus` MIXOPs in the reader** (the review's sketch). It needs a MIXOP writer first, and even then `addBus` would leave the slot unknown unless the reader replayed the slot table's allocation and recycling, which depends on voices the capture doesn't record. A NAMES record per slot change is exact and already in the format.
- **Keep a latest-name map and refresh `TrackContext.names` on each live update.** That fixes the snapshot but still names a renamed bus by its new name before the rename, and keeps five fallbacks.
- **Word reasons in the editor from shared tables.** It keeps code tables on both sides of the Worker boundary; the reader already words `loudnessControl` and `ladder`.

## Consequences

**Positive**
- One lookup and one fallback: every view reads `bus 3` for an unnamed slot, and "Master" for the output.
- A bus added, recycled or renamed mid-take is named from that instant, in a saved file and in the live view alike (`capture.test.ts`).
- No view keeps a reason code table; a new reason is one entry in `reasons.ts`.

**Negative / costs**
- One `Audio.debug()` call per keyframe (once a second) while recording, to read the slot table.
- A truncated file whose early NAMES records were evicted names a slot added during the take by its latest name for its whole span (the merge fills META from the sink's latest names).
- A code this build doesn't know reads as no reason instead of `reason 9`.

## Deprecates

`nameLookup` and `NameLookup` (`voiceTableModel.ts`), `eventNames` and `EventNames` (`tracks/events.ts`), `busName` (`tracks/buses.ts`), loudness's private `busName`, `busParents`' own name-to-slot map, the Worker's `slotOfName` map, `reasonText` and `stopReasonText` in `voiceTableModel.ts`, `TrackContext.names`: removed. The reason tables leave `events.ts` for `reasons.ts`. ADR 0227's numeric `reason` on every event is replaced by the per-kind word.

## Open questions

- When the capture records MIXOPs (for an op log beside the timeline), their string ids need a table; `parameters` already holds the names that arrive as strings (`loudnessControl`'s bus).

## References

- `src/plugins/audio/runtime/capture/names.ts`, `reasons.ts`, `reader.ts` (`CaptureDecoder`, `summarizeCapture`), `events.ts` (`EventSink.busName`, `readCaptureEvent`), `capture.ts` (`writeBusNames`, `withInterned`), `worker.ts` (loudness controls).
- `src/plugins/audio/editor/mix/voiceTableModel.ts`, `profilerTablesModel.ts`, `profilerTables.tsx`, `tracks/{buses,loudness,events,music,types}.ts`, `ProfilerPanel.tsx`.
- Tests: `runtime/capture/names.test.ts`, `reasons.test.ts`, `capture.test.ts` ("ADR 0260"), `events.test.ts`, `editor/mix/tracks/buses.test.ts` (naming).
- `docs/design/0171-audio-mix/api-and-models.md` §5.3 (NAMES), §5.6 (reasons), §6.3 (the slot table).
