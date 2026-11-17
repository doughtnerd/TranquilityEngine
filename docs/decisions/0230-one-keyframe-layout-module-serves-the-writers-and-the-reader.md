# 0230. One keyframe layout module serves the capture's writers and its reader

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0227 and 0171)
- **Related:** 0171, 0172, 0179, 0223, 0227

## Context

A capture KEYFRAME (ADR 0171, api-and-models §5.5) is written by three pieces of runtime code: the core's keyframe source (`core/keyframeSource.ts`), the bus lanes both backends share (`mix/keyframeBus.ts`, ADR 0179) and the Babylon fallback's `keyframe()`. One function reads it back by name: `readCaptureKeyframe` in `capture/format.ts` (ADR 0227's follow-up). The row layout (section caps, voice and music state codes, bus and metered flag bits, `NO_NAME`, pitch as u4.12 and audibility as u0.16) was defined in `format.ts`, but the writers did not import it:

- `keyframeSource.ts` kept its own caps, state codes, flag bits and the literal 4096. Its header said this kept the lazy recorder chunk out of the core and that "a test holds them equal". No such test existed.
- The Babylon fallback wrote 4096, `0xffffffff` and the caps 8192, 32 and 1024 as literals.
- `mix/loudnessTrackModel.ts` kept a private copy of the metered flag bits and decoded `flags` itself. The Worker passed it the raw `KeyframeMetered` rows.
- The core tests checked rows with bit masks (`flags & 32`) and recomputed the quantising (`Math.round(pitch * 4096)`).
- `mix/keyframeBus.ts` value-imported `KeyframeBusFlag` from `format.ts`. That was the one import the header warned against: the player build put all of `format.ts`, every capture codec, into the main `myco` chunk. The e2e specs only checked that the `recorder-*.js` chunk wasn't requested, so nothing caught it.

ADR 0227 left typing the keyframe rows for later. Its follow-up typed them for the Profiler, but the writers and the loudness model still kept their own copies.

## Decision

We will define the KEYFRAME row layout once, in `capture/keyframeLayout.ts`. That module imports nothing. Every writer value-imports it, and `format.ts` imports and re-exports it.

- **`keyframeLayout.ts`** holds the section caps (`KEYFRAME_MAX_*`) and `KEYFRAME_BUS_LANES`, plus `NO_NAME`. It holds the state names (`KEYFRAME_VOICE_STATES`, `KEYFRAME_MUSIC_STATES`) and the code maps derived from them (`KeyframeVoiceState`, `KeyframeMusicState`). It holds the flag bits (`KeyframeBusFlag`, `KeyframeMeteredFlag`) and the masks of known bits that the decoder checks. It also holds the quantising: `KEYFRAME_PITCH_ONE` and `KEYFRAME_AUDIBILITY_ONE`, with `keyframeU16`, `keyframePitch(rate)` and `keyframeAudibility(a)`.
- **Writers** use only that module for values. `keyframeSource.ts` loses its copies, the Babylon fallback loses its literals, and both quantise through the same functions. `keyframeBus.ts` imports its bits from the layout module, which takes `format.ts` out of the main chunk (`myco-*.js` shrinks by about 12.7 kB). The capture service (`capture/capture.ts`) passes `NO_NAME` directly instead of waiting for the events chunk to provide it.
- **Readers** decode only through `readCaptureKeyframe`. The loudness model takes `CaptureKeyframeMetered` (named booleans), so its flag copy is gone. A new `readKeyframeMetered(row)` is the per-row reader that `readCaptureKeyframe` uses for its metered section. The Worker's loudness lane calls it so that it doesn't name every voice row once per keyframe.
- **Tests** check rows through the typed reader (`state: "playing"`, `pitch: 2`, `metered: true`, `snapshot: null`) instead of masks and recomputed quantising. A test that writes raw rows on purpose (the encoder vectors, scene fixtures) still uses wire values.

**Follow-up of ADR 0223 (no test-only members):** `MusicGroups.membersOf` was used only by its test, so it is deleted. The test now checks what the decoder shows from outside: the `closeMember` calls, the `cache.release` calls, a second `cancelGroup` that posts nothing, and a re-prime that opens the same stream ids from scratch.

## Alternatives considered

- **Keep the copies and add the test the header promised.** That would check that the values are equal, but the quantising would still be duplicated and the loudness model would still decode bits. It also would not have found the chunk leak.
- **Move `readCaptureKeyframe` into the layout module too.** The reader names whole payloads and belongs with the codec in the lazy chunk. Only the layout has to be in every game.
- **Have the loudness model call `readCaptureKeyframe(payload).metered`.** That names every voice row (up to 8,192) once per keyframe only to read at most nine metered rows. The per-row reader gives the same answer.

## Consequences

**Positive**
- A change to the row layout touches `keyframeLayout.ts`, and the compiler finds every writer and the reader. Nothing in the code repeats it.
- `format.ts` is a lazy chunk again (`format-*.js`, loaded with the recorder, events and save chunks). The layout module is a 672 B chunk shared by the core and the recorder.
- Readers of the loudness model and of the core tests see named values.

**Negative / costs**
- `format.ts` re-exports names it no longer defines. Its existing importers keep working, but a reader has to look in two files.
- The e2e specs still check only for `recorder-*.js` by name. A new value import of `format.ts` from runtime code would leak it into the main chunk again without failing a test. A comment in `keyframeBus.ts` and in the layout module's header says why it must not.

## Deprecates

- The private caps, codes and flag bits in `core/keyframeSource.ts` (removed, including its exported `KF_BUS_TOMBSTONE` and `KfMusicState`, which nothing else used). The `KF_METERED_*` exports of `mix/loudnessTrackModel.ts` (removed). The Babylon fallback's literal caps and quantising (replaced). `CaptureService.noName` (removed).
- `MusicGroups.membersOf` (removed, ADR 0223's rule).

## Open questions

- Should an e2e or build check walk the player entry's static imports and refuse any capture codec chunk, not only `recorder-*.js`? `audio-mix-d.spec.ts` already walks that closure. Extending its pattern to `format-*.js` would close the gap, but the chunk's name depends on Rollup's naming.

## References

- `src/plugins/audio/runtime/capture/keyframeLayout.ts`, `capture/format.ts` (`readCaptureKeyframe`, `readKeyframeMetered`), `core/keyframeSource.ts`, `mix/keyframeBus.ts`, `babylonBackend.ts` (`keyframe`), `mix/loudnessTrackModel.ts`, `capture/worker.ts`, `capture/capture.ts`.
- Tests: `core/keyframeSourceLoopback.test.ts`, `core/keyframeSourceAlloc.test.ts`, `babylonBackendM5a.test.ts`, `mix/loudnessTrackModel.test.ts`, `editor/mix/keyframeCoreRoundTrip.test.ts`, `decoder/musicGroups.test.ts`.
- e2e: `export.spec.ts` ("loads no recorder chunk"), `audio-mix-smoke.spec.ts` (M5a), `audio-mix-d.spec.ts` (static closure).
