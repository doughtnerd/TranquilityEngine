# 0249. Event and music rows are built once, above the audio backend seam

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** 0179 in part (the "what stays apart by design" bullet that keeps keyframe music fallback-specific)
- **Related:** 0166, 0171, 0179, 0215, 0220, 0227, 0230, 0248

## Context

`Audio.debug()` and the capture's KEYFRAME each have sections that don't depend on the backend: the event instances (the event runtime's registry, `events()`) and the music instances (the players, `musicPlayers()`). They were built inside the core adapter:

- `core/debug.ts` built `Audio.debug().music` and `musicTotals` from `musicPlayers()`, the anchors and `musicOps.debugView()`, importing `music/`.
- `core/keyframeSource.ts` built the keyframe's event rows (through `events().debugRows`) and music rows, importing `events/` and `music/`.
- The Babylon fallback's `keyframe()` wrote `music: []` and placeholder event rows (asset `NO_NAME`, state 0, `paramsHash` 0), and its `debug()` had no music at all, although `BabylonMusic` plays music: the fallback's profiler and debug panel showed none.
- `Audio.ts` already composed `events` and `eventTotals` above the seam for `Audio.debug()`.

ADR 0179 listed keyframe music among the things that "stay apart by design", because the fallback has no voice table and no meters. That reason holds for voices and meters; it doesn't for music or events, whose rows come from page-wide registries every backend shares.

## Decision

We will build the event and music rows once, above the seam, in one row composer (`runtime/audioRows.ts`), for both `Audio.debug()` and the keyframe. Backends report only what they own: voices, buses, meters and the mix section.

- **Debug** (`debugRows(info, backend)`): `events` (with E3.9's rule: an instance's row stays while the backend still lists one of its voices) and `eventTotals`; on a backend with `music`, the `music` rows (segment, position, the pending change and its rule, groups, stems, counters, Ê) and `musicTotals`. `Audio.debug()` is `{ ...backend.debug(), ...debugRows(info, backend), recorder }`. A backend without music (the pending stand-in) gets no music section, as before.
- **Keyframe** (`KeyframeRows`): wraps a backend's `AudioCaptureSource` and adds the `events` and `music` sections. `capture.ts` hands the recorder `() => rows.read(nameId, NO_NAME)`. The pooled-row rule stays (FU5): every row is a pooled object rewritten in place, the arrays are reused, nothing is constructed per keyframe; `audioRows.test.ts` counts it as `keyframeSourceAlloc.test.ts` does for the backend's part.
- **What a backend reports.** `AudioCaptureSource.keyframe` returns a `BackendKeyframe`: the keyframe's voices, buses, metered and mix sections plus `eventVoices` (event id to the number of its voices the keyframe lists, stolen ones left out; a pooled `Map` on the core). `MusicBackend.debugView()` returns a `MusicBackendDebug`: the ring pool, the live groups and the backend's own group counters (the core's STATUS header: `streamStartsLate`, `groupsLate`, `groupsHeld`, `groupsAbandoned`, `maxSlipFrames`, `splitQuanta`, `voiceSplits`, `curvePoolFull`; zeros on the fallback). `musicTotals` is that view plus main's session sums (ADR 0220).
- **Neither backend imports `events/` or `music/` for rows.** `core/debug.ts` and `core/keyframeSource.ts` lose their music and event code; the fallback loses its placeholder rows. `AudioDebugInfo.music` and `musicTotals` stay in the type, documented as added by `Audio.debug()` (as `events` already was).
- **Capture format.** Unchanged: the same six sections in the same layout (ADR 0230). Captures from the fallback now carry real event rows (asset, parameters hash) and music rows instead of placeholders and an empty music section; readers already decode both. No version bump.

## Alternatives considered

- **Keep the rows in the core and add them to the fallback too.** Two copies of the same registry walk, which 0179 already counted as a cost when it shared the keyframe bus lanes.
- **Have the backend pass event groups in each keyframe voice row.** It would change the wire's voice row for a fact only the composer needs; `eventVoices` carries it beside the rows.
- **Compose the rows in `capture.ts` and `Audio.ts` separately.** The music row logic (state mapping, position, pending change) would exist twice again.

## Consequences

**Positive**
- The rows exist in one module, not three; the fallback's debug panel and profiler show music, and its keyframe events carry real assets and parameter hashes.
- Tests of the rows run on any backend, the fake included (`audioRows.test.ts`, `audioDebugMusic.test.ts`).
- `core/` imports `music/` and `events/` for nothing but the automation sink's constants and types (`events/automation.ts`).

**Negative / costs**
- `MusicBackend` gains `debugView()` (the fallback and the fake implement it), and `AudioCaptureSource.keyframe` returns a narrower type: callers that want a full payload go through `KeyframeRows`.
- The keyframe's music position is read at the backend's `time` (the heard clock), where the core's source read the mixer's clock, which follows it each frame.

## Deprecates

`core/debug.ts` `musicRows`, `musicTotals`, `musicRow`, `musicState`, `musicView` and `DebugSource.musicOps.debugView`/`primeEmaMs`; `core/keyframeSource.ts` `readEvents`, `readMusic`, `paramsHash`, `musicStateOf` and their pools; the fallback's placeholder event rows and `music: []`; `MusicOpsDebugView` (now `MusicBackendDebug` in `debugTypes.ts`). The 0179 bullet "Keyframe … music … stay apart by design" for music (voices and meters stay apart).

## Open questions

None.

## References

- `src/plugins/audio/runtime/audioRows.ts`, `Audio.ts` (`debug`), `capture/capture.ts` (`wireKeyframes`), `backend.ts` (`BackendKeyframe`, `MusicBackend.debugView`), `debugTypes.ts` (`MusicBackendDebug`), `core/keyframeSource.ts`, `core/debug.ts`, `babylonBackend.ts`.
- ADR 0179 (the seam and what stays apart), 0220 (totals from cumulative counters), 0230 (the keyframe layout), 0248 (the one-way music seam).
