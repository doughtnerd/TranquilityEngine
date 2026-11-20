# 0264. Every audio voice takes every member; a weak backend decides how, per adapter

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158, 0162, 0166, 0179, 0248

## Context

ADR 0179 grouped the audio backend's optional members into capability objects and rejected "one capability per member"
as "the old interface with a new name". It left `AudioVoice` (`runtime/backend.ts`) with eight optional members:
`seek?`, `setLoop?`, `setVelocity?`, `setOcclusion?`, `setDopplerRate?`, `setSpatialOptions?`, `fadeShaped?`,
`paramsShaped?`. What a voice had depended on how it was made, not on the adapter:

| Member | Core | Babylon | Pending | Fake |
|---|---|---|---|---|
| `seek` | yes | — | — (the offset was lost) | — |
| `setLoop` | — (through the automation sink) | yes | records | yes |
| `setVelocity`, `setOcclusion`, `setDopplerRate` | yes | yes | records | yes |
| `setSpatialOptions` | yes | — | records | yes |
| `fadeShaped`, `paramsShaped` | yes | music voices only | — | `paramsShaped` behind a switch that deleted it |

About twelve call sites probed one member at a time and each invented its own weak-backend fallback:
`stop(seconds)` (segmentRun, stingers, loopTail), a deferred list (reload), an `unstamped` map applied at the frame
after a leg's time (transition), `fade(to, s)` with quantised levels committed a frame late (stems, eventRuntime), a
stop/fade/shaped split (Babylon's own `stampGroup`), `sink ? sink.setLoop : voice.setLoop?.` (segmentRun, loopTail,
`TsAutomation`). An event played while the core loaded lost its `startOffset` (`voice.seek?.()` on a `PendingVoice`),
and so did `AudioSource.seek`. Two more reads reached past the seam with casts: `AudioSource.velocity` cast the backend
to find `_velocityOf`, and the audio system cast it to find Babylon's `noteReverbZones`.

## Decision

We will make every member of `AudioVoice` required on every adapter, grouped by what the members do, and let each
adapter decide how a weak backend does a member. Callers state one intent.

- **Groups (documented on `AudioVoice`):** plain controls (unchanged); **playback position** `seek`, `setLoop`;
  **main's spatial results and options** `setVelocity`, `setOcclusion`, `setDopplerRate`, `setSpatialOptions`;
  **stamped ramps** `fadeShaped(ShapedFade)`, `paramsShaped(ShapedParams)` (the params type is now named). Only reads
  stay optional (`alive`, `panner`, `occlusion`), answered by defaults.
- **Core voice:** `setLoop` goes through its own automation sink (`CoreAutomation.setLoop`, SET_LOOP stamped behind
  the PLAY), so music and `TsAutomation` call the voice, never the sink.
- **Babylon voice:** stamped ramps on every voice (timer steps, the law and the late-timer phase join it had for music),
  `seek` (before the start: the start offset; after: `currentTime`, wrapping a loop, clamping otherwise),
  `setSpatialOptions` (keeps the `occlusion` switch and `dopplerLevel` its passes read; no sends or rotation exist).
  `stampGroup` stamps each member's fade with `fadeShaped`.
- **Pending voice:** records the latest `seek`, `fadeShaped` and `paramsShaped` like `setLoop`, and forwards them at
  the hand-over (the real voice stamps a late ramp at once). An event's `startOffset` and `AudioSource.seek` during the
  core's load now hold.
- **Fake voice:** records `fadeShaped`, `paramsShaped` and `seek` as events. The `stampedRamps` switch that deleted
  `paramsShaped` is removed: no adapter lacks ramps, so there is no capability to choose. Whether ramps are
  sample-exact stays `MusicBackendCaps.stampedFades`, the fake's music caps, which a test may set.
- **Callers:** segmentRun, stingers, loopTail, reload, transition, stems, eventRuntime and AudioSource call the member;
  the `unstamped` map, reload's deferred list, stems' unstamped commit and the `stop`/`fade` fallbacks are deleted.
- **Named backend reads:** `SpatialPassHost` (the backend-side capability the audio system runs main's passes on) gains
  `velocityOf(id, out)` (was `_velocityOf`, reached by a cast) and `zones: ZonePass` (the core's `ZoneManager`; the
  fallback's `InertZones`, which warns once for an enabled reverb zone, replacing the cast to `noteReverbZones`). The audio
  system runs `zones` on both backends.
- **0248 is unchanged:** nothing here crosses the music seam; music still only reads `MusicFrame` and reports up through
  `onLifecycle`.

## Alternatives considered

- **Voice capability objects (`voice.ramps?.fadeShaped`, `voice.spatial?`).** 0179's shape, but every adapter has every
  group once Babylon and the pending voice do their part, so each object would always be present; an optional group
  nobody lacks is a probe with extra steps.
- **Keep the members optional and share one fallback helper.** It would centralise the twelve branches but keep the
  pending voice losing seeks and the Babylon voice treating music and other voices differently, and the fallback timing
  (a frame late) would still be the caller's guess at what a backend does.
- **Keep the fake's switch as an option that removes ramps.** It modelled a backend that no longer exists.

## Consequences

**Positive**
- Weak-backend behaviour lives in each adapter; about twelve caller branches and three private fallback structures go.
- Events and `AudioSource.seek` keep their start offset while the core loads; the Babylon fallback seeks, and every
  Babylon voice fades with the music laws.
- The fake records what callers asked for, so music tests read the ramps they stamp.

**Negative / costs**
- On the Babylon fallback a ramp now starts on the voice's own timer at its stamp, where the transition's old fallback
  started a linear `stop(seconds)` on the first frame after; both are best effort there.
- A recorded pending ramp is forwarded once, even when its time passed during the load (it then runs at once).

## Deprecates

`FakeBackend.stampedRamps`; `BabylonBackend.noteReverbZones` and `_velocityOf` on both backends (now `zones` and
`velocityOf`); transition's `unstamped` map and `applyUnstamped`; reload's `Retiring.deferred`/`fadeAt`; stems'
`StemGain.next.stamped`; `TsAutomation`'s "can't loop part of a clip" warning. Removed.

## Open questions

- Babylon's `seek` on a streamed sound restarts HTML5 audio at the offset; no browser spec covers it yet.

## References

- `src/plugins/audio/runtime/backend.ts` (`AudioVoice`, `ShapedParams`), `pendingBackend.ts`, `babylonBackend.ts`,
  `core/coreBackend.ts` (`Voice`), `core/spatial.ts` (`SpatialPassHost`, `ZonePass`), `testing.ts`
- ADR 0179's rejected alternative "one capability per member"
- Architecture review 2026-11-20, candidate 3 and small fix 1
