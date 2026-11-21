# 0293. One clip resolver turns a clip path into a play request

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040 (import settings), 0158 (events), 0162 §2.4 (ambisonic clips), 0166 P6 and §2.6 (segment stems, the stream-or-decode rule), 0179 (backend capabilities), 0286 (the fake backend's clip facts)

## Context

How a clip path becomes a play (its URL, the import volume with the FuMa gain, stream or decode, the ambisonic flag, the
bus) was written four times:

- `AudioSource.ts` `startClip` and `clipVolume`, used by `AudioSource` and `Audio.playOneShot` (`Audio.ts`);
- the event runtime's `playClip` (`events/eventRuntime.ts`), through a `ClipStarter` that `AudioSource.ts` installed
  with `_setEventClipStarter`; its default played nothing (`play: () => null`);
- segment runs (`music/segmentRun.ts`), through a `SegmentClipSource` installed with `setSegmentClipSource`; its default
  used the path as the URL, streamed everything and knew no facts.

The two setters existed only to avoid an import cycle (`AudioSource.ts` imports the event runtime), and their defaults
failed silently. The copies had drifted: the event runtime said it built "the request `startClip` builds", but never set
`ambisonic: true` nor the ambisonic stream rule. The core gates the ambisonic voice cap and the FuMa gain on that flag
(`core/voices.ts` `start`), so an ambisonic clip in an audio event played as a plain voice. Two dozen music test files
injected clip facts, URLs and buses through `setSegmentClipSource` instead of the backend the code really reads.

## Decision

We will resolve clips in one module, `runtime/clipResolver.ts`, which depends only on `Assets` (URLs, import
settings), the mixer (bus names), the clip registry (an ambisonic clip's FuMa gain and whether it is long) and the
active backend's clip facts (`AudioBackend.clipCache.clipFacts`, G-1). It imports neither `AudioSource.ts` nor the event
runtime, so every caller imports it directly. Its interface:

- **`clipRequest(path, loop, output, use = "sound")`:** the base `PlayRequest`: `url` (throws for a missing asset),
  `loop`, `stream`, `bus` (`mixer.resolveOutput`: empty or unknown is Master), `volume` = import volume × FuMa gain, and
  `ambisonic: true` for an ambisonic sound. A fresh object: the caller scales `volume` by its own level and adds its
  fields.
- **`ClipUse`:** `"sound"` (sources, one-shots, event clips) streams by the import setting, or when the clip is
  ambisonic and the registry found it longer than 5 s (§2.4). `"music"` (segment stems) decodes up to 30 s and streams
  beyond once the clip's facts are known, else follows the import setting (§2.6); music is never ambisonic (the music
  lint refuses ambisonic stems, `musicValidate.ts`).
- **`clipStreams(path, use)`, `clipVolume(path)`, `clipFacts(path)`, `isAmbisonicClip(path)`:** the parts callers
  need on their own (a run decides stream or decode at creation; `AudioSource` re-applies the volume; anchors, loop
  tails, the planner and segment grids read the facts).

`AudioSource`, `Audio.playOneShot`, the event runtime's `playClip` and `segmentRun.groupRequest` /
`createSegmentRun` all start from it. `_setEventClipStarter`, `ClipStarter`, `setSegmentClipSource`,
`segmentClipSource`, `SegmentClipSource` and `startClip` are deleted. An event clip now carries the ambisonic flag and
the ambisonic stream rule, as a source's does.

**Tests** go through the backend the code reads. Music tests serve their clips as project assets and give their facts
to the fake backend's clip cache (`music/testing/clips.ts` `serveMusicClips`: a record into the fake's `facts` map, or
a function answering `clipFacts`; ADR 0286), and configure the page mixer's buses when they assert a bus name
(`projectBuses`). The loopback tests' facts are the core's own once a clip is decoded. `clipResolver.test.ts` drives the
module's interface; `audioApiM3.test.ts` checks the ambisonic flag from a source, a one-shot, a clip played as an
event and an event's clip node.

## Alternatives considered

- **Keep the setters, add the flag to the event starter.** Fixes the bug, keeps four copies and two silent defaults; the
  next rule (a codec, a span) would drift again.
- **Move `startClip` into the event runtime and import it from `AudioSource.ts`.** No cycle, but the event runtime would
  own sources' and music's clip rules; segment runs would still need it from a module that has nothing to do with them.
- **A resolver object injected into each caller.** The resolver's dependencies are already process-wide singletons
  (`Assets`, the mixer, the active backend); injection would add a seam with one adapter.

## Consequences

**Positive**
- Locality: the stream, ambisonic and volume rules live in one module; four callers get one request.
- An ambisonic clip in an event plays as an ambisonic voice (cap, gain, rotation).
- No silent defaults: a test that forgets to serve a clip fails at the URL, as production would.
- Music tests exercise the backend's clip cache, the path production uses.

**Negative / costs**
- The event runtime's per-voice request is built by the resolver and then filled field by field (one object, as before;
  the per-play allocation gate in `eventBench.test.ts` holds).
- Music unit tests now need their clips served as assets (one helper call).

## Deprecates

`startClip` and `clipVolume`/`isAmbisonicClip` in `AudioSource.ts` (moved), `_setEventClipStarter` and `ClipStarter`
(`eventRuntime.ts`), `setSegmentClipSource`, `segmentClipSource` and `SegmentClipSource` (`segmentRun.ts`). Removed.

## Open questions

None.

## References

`src/plugins/audio/runtime/clipResolver.ts`, `AudioSource.ts`, `Audio.ts`, `events/eventRuntime.ts`,
`music/segmentRun.ts`, `music/anchors.ts`, `music/loopTail.ts`, `music/planner.ts`, `music/segmentGrids.ts`; tests
`clipResolver.test.ts`, `audioApiM3.test.ts`, `music/testing/clips.ts`. Architecture review 8, card 1.
