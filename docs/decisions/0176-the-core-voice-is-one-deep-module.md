# 0176. The core voice is one deep module

- **Status:** Accepted
- **Date:** 2026-11-15
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157, 0162

## Context

ADR 0157 put the audio core's per-voice intent in a typed-array voice table (`core/voiceTable.ts`) that main writes and the audio thread never reads, and gave each voice a handle (`AudioVoice`). The core backend (`core/coreBackend.ts`, 2,368 lines) grew around it: about 900 of its lines were per-voice logic (start, launch, the setters, what is sent, the music stem re-sends of F-9b and F-12), with about 55 direct `table.x[i] = …` writes, while musicOps, streams, coreAutomation, selection, voiceFx and busIndex wrote the same public arrays. The `Voice` handle forwarded about 20 methods to `backend._setX`, each repeating "slot of id, table write, refresh gain, `writer.setParams`".

The dry gain the core gets was re-derived in about seven places: `dryGain()` (gain × occGain × stemDry), inline `gain × occGain` in the stem re-sends and `musicOps.paramsShaped`, the rebuild's replay (`gain × occGain`, without the stem level), and line-for-line copies of the reported gain in `debug.ts` and `keyframeSource.ts`. The replay's copy had drifted: a stem voice whose stem-level log entry had been pruned replayed at the gain without its stem level (fixed before this record, with a test; production stems are music group members, which the replay hands to `musicOps.reopenGroups`, so only a non-member voice given `paramsShaped` reached it). Bugs in this area (F-9b, F-12, G9b) came from exactly this: one concern spread over many writers.

## Decision

We will keep a core voice's state and changes in one module, `core/voices.ts` (`CoreVoices`):

- **What it owns.** A voice's start (allocation, the table fill, the ambisonic cap), launch / wait for the clip / fail (and the "stream instead" restart), stream failure, the stream reopen after a rebuild, every setter (volume, pitch, priority, attenuation, position with F-24's flat refusal, bus, pause, seek, occlusion, Doppler, velocity, spatial options, a stem's level), what goes to the core for it (PLAY, the dry gain and direction to a mixed voice, the pitch with Doppler, SET_MIXED on a promote or demote, the score, a steal), the listener pose for distance gains, the spatial move pass, F-9b's lookahead and F-12's stale stem re-sends, the voice's free, and §5.6's refusal reports. It is the only writer of the voice table's columns for those concerns; `coreBackend.ts` has no direct table writes left.
- **Its interface.** By voice id, each call does nothing for a stale id; slot-level calls (`setOcclusionAt`, `setDopplerRateAt`, `refreshGain`, `onFree`) are for the backend's own passes. Only a mixed voice gets SET_PARAMS gain and direction; pitch, pause and bus go to any voice on the core; nothing goes before the voice's PLAY. The frame calls `moveSpatial`, `select` and, at commit, `resendStaleStems`; the lifecycle calls `beginRecovery`, `recoveryFailed`, `dispose` and `busesReset` (so a later lifecycle registry can register it as one participant).
- **Effective views.** The module exports the one definition of each derived quantity, as functions over the table: `effectiveDryGain` (what PLAY, SET_PARAMS and SET_MIXED carry), `dryGainBeforeStem` (what a stem ramp multiplies), `effectivePitch` (pitch × Doppler, clamped), `reportedGain` and `reportedPitch` (what `Audio.debug()` and the capture keyframes show). The replay, `debug.ts`, `keyframeSource.ts` and `musicOps.paramsShaped` read them. Selection's audibility (`audibility0 × occGain`, with the fade, automation, stem audible level, bus gain and priority) is a different quantity and stays selection's.
- **The handle is an adapter.** `coreBackend.ts`'s `Voice` maps `AudioVoice` onto `CoreVoices` by id and holds one reference, so a voice start allocates what it did. The backend's `_setX` methods are gone (`_velocityOf` stays: `AudioSource` reads it by duck typing).
- **Other writers.** busIndex's per-voice dip moves voices through `CoreVoices.moveBus` (the same table, mixer and presence update a `setBus` makes); musicOps sets a stem's level through `CoreVoices.setStemLevel`. Separate concerns keep their own writes: selection's mixed/virtual state and reason, coreAutomation's `autoGain`/`autoPitch` estimate, voiceFx's composed `lpHz`, musicOps' group membership and `fadeGain` (the fade ramp's mirror, as `AudioHandle.fade` writes it), and streams' data-wait reason.
- **Constraints kept.** The hot paths allocate nothing more (eventBench's core start+stop heap, keyframe FU5); wire output is byte-identical for every existing scenario (the goldens pass unchanged).

## Alternatives considered

- **Make the voice table's arrays private behind accessors.** Moves no logic: every caller would still re-derive the dry gain, and accessors on the hot loops (selection's 4,096-voice pass) cost time.
- **Keep the logic in `coreBackend.ts` and only share `dryGain`.** Fixes the drift once but keeps the shallow handle and the 900 lines of per-voice code in the coordinator file every task edits.
- **One `Voice` object per voice holding its own state.** Breaks the typed-array table ADR 0157 chose for allocation-free frames and the core's mirror.

## Consequences

**Positive**
- One place to read and change what a voice sends; the drift class of bug (replay vs. `dryGain`) is gone.
- `coreBackend.ts` is down from 2,368 to 1,558 lines and is orchestration (frames, lifecycle, buses, loudness, music seam).
- Tests drive the module by voice id with a recording writer (`voices.test.ts`) instead of reading `backend.table.*` or calling `backend._setX`.

**Negative / costs**
- `CoreVoicesHost` is a wide dependency list (the parts a voice touches); it is explicit, but it is long.
- The backend constructs `CoreVoices` after the parts it depends on, and closures made earlier (streams, playheads, the spatial view, bus index) reach it lazily.

## Deprecates

`CoreBackend._setVolume`, `_setPitch`, `_setOcclusion`, `_setDopplerRate`, `_setVelocity`, `_setSpatialOptions`, `_setPriority`, `_setAttenuation`, `_setPosition`, `_setBus`, `_setPaused`, `_seek`, `_pannerOf` and `_occlusionOf` are removed (tests call `backend.voices.*`). `CoreBackend.owners` and `lockedQueue` remain as read-only views of the module's.

## Open questions

- The replay's playhead rate (`replay.ts` `PlayheadTracker`: pitch × autoPitch × Doppler × clip rate, unclamped) is a heard-rate estimate, not the sent pitch; whether it should clamp like `effectivePitch` is left open.

## References

- `src/plugins/audio/runtime/core/voices.ts`, `voices.test.ts`
- The stem-replay test: `coreBackend.test.ts` "a stem voice across a hard rebuild (F-9b)"
- ADR 0157 (the voice table and handles), ADR 0162 C20 (occlusion in audibility)
