# 0179. The audio backend seam is required members plus capability objects

- **Status:** Accepted, amended by 0224 (`AudioClock` gains the frame map), 0264 (every voice member is required, grouped; `SpatialPassHost` gains `velocityOf` and `zones`), 0270 (`update` becomes optional; the core has none), 0434 (another capability, `worldViews`); partly superseded by 0249 (keyframe music and the event rows are composed above the seam for every backend)
- **Date:** 2026-11-15
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0098, 0157, 0171, 0175, 0176, 0178

## Context

`AudioBackend` (`src/plugins/audio/runtime/backend.ts`, ADR 0098) is a real seam with four adapters: the core (`core/coreBackend.ts`), the Babylon fallback (`babylonBackend.ts`), the pending backend used while the core loads, and `makeFakeBackend` (`runtime/testing.ts`, about 50 test files). Since 0098 it grew one optional member at a time: 0157 and 0158 added clips, horizon and automation, 0166 the music seam and clock, 0171 the mix and capture members. By 1d0a7ab it had 12 required and 24 optional members in a 1,129-line file, about 400 lines of which were `Audio.debug()` types.

A review found four problems:

- **Test hooks in the interface.** `rampLane`, `writeSlot`, `writeDucking` and `writeLoudnessConfig` had no caller through the seam. Only `CoreBackend`'s own forwarding and the fake implemented them, and the tests drove the core modules (`laneWriter.ts`, `liveMix.ts`, `presence.ts`) directly. `cpu()` and `duckGain()` were the same: `debug()` and the mixer's duck source read them inside the core.
- **Probing one member at a time.** Callers checked `horizon?.()`, `timeAt?.()`, `latency?.()`, `beginFrame?.()`, `clipFacts?.()`, `holdSpan`, `setProfileSink?.()`, `keyframe` and `flushNow?.()` separately, though in production they come in fixed groups (the core has all of them; the fallback has none of the clock members). `capture.ts` decided whether a capture records STATUS by testing `"recorderTap" in backend`.
- **The file did not read as the seam.** The debug shape and the pending adapter took most of it.
- **Logic repeated in the two real adapters.** The hidden-tab policy (`audio.background`) and the keyframe's bus-lane encoding were written twice.

## Decision

We will keep the required members required and group what only some backends can do into capability objects. A backend has a whole capability or none of it.

**Required (13).** `name`, `play`, `setListener`, `applyMix`, `configureBuses`, `masterVolume`, `muted`, `status`, `time`, `debug`, `setBackground`, `update`, and `dispose` (now required; every adapter already had one).

**Capabilities (6).** The grouping follows what the adapters actually have, not how the members were added:

| Capability | Members | Core | Babylon | Pending | Fake |
|---|---|---|---|---|---|
| `clipCache: AudioClipCache` | `clipDuration`, `clipFacts`, `invalidateClip`, `holdSpan` (null: no span clips) | yes | durations only | — | yes |
| `clock: AudioClock` | `beginFrame`, `horizon` (null: unknown), `frameInterval` (null: unknown), `timeAt`, `latency` | yes | — | — | yes |
| `music: MusicBackend` | unchanged (0166 §4.6) | yes | yes | — | yes |
| `automation: AutomationSink` | unchanged (0158) | yes | — | — | — |
| `mix: AudioLiveMix` | `mixCaps`, `mixOpTarget`, `flushNow` | yes | yes | — | yes |
| `capture: AudioCaptureSource` | `recorderTap`, `setProfileSink`, `keyframe` | yes | yes (tap never called) | — | yes |

- **A capability is the backend itself on the core and the fallback.** The getter returns `this`, so the members keep their names (`backend.mix.mixCaps`, `backend.capture.recorderTap`). A capability costs no object and no allocation, and code that holds a concrete `CoreBackend` (tests, the browser specs' `page.evaluate`) is unchanged. On the fake each capability is a plain property set to the fake. A test sets one to `undefined` to stand in for a backend without it.
- **Callers read a capability once.** `audioBackend().clock?.horizon() ?? fallback`, `f.backend.clipCache?.holdSpan(...)`, `backend.capture?.setProfileSink(...)`. The fallbacks are the ones each member used to name. `horizon()` and `frameInterval()` may answer null ("not known"), which callers already treated as "no clock". That lets the fake keep its Babylon-like stamping default with a clock present.
- **What a capture records** is `mix.mixCaps.capture` ("full" or "mainSideOnly"). With no `capture` capability (the pending backend), `Audio.capture` refuses as before. The `"recorderTap" in backend` probe is gone.
- **Off the seam.** `rampLane`, `writeSlot`, `writeDucking` and `writeLoudnessConfig` are removed from the interface and from `CoreBackend`. Tests already reach `LaneWriter.rampLane`, `LiveMix.writeSlot` / `writeLoudnessConfig` and `Presence.writeDucking`. Their input types (`MixLane`, `BusLaneRamp`; `BusSlotWrite`, `LoudnessConfigWrite`) move into `core/laneWriter.ts` and `core/liveMix.ts`. `cpu()` and `duckGain()` leave the interface but stay on `CoreBackend`, where `debug()` and the mixer's duck source use them.
- **File layout.** `backend.ts` holds the seam (voice, request, music, capability and backend types) and the selector. The `Audio.debug()` types move to `debugTypes.ts`, and `PendingVoice` / `PendingCoreBackend` move to `pendingBackend.ts`. `backend.ts` re-exports every debug type, so none of the 169 importers changed.
- **What the two adapters share.**
  - The hidden-tab policy is `hiddenTab.ts` (`HiddenTabPolicy`): it reads the mode at the hide and remembers it; `mute` mutes; `pause` mutes, then suspends after `PAUSE_SUSPEND_DELAY_MS` if the page is still hidden under `pause`; a show cancels a waiting suspend and returns the mode. Each backend supplies `mute` and `suspend`.
  - The keyframe bus row's lanes are `mix/keyframeBus.ts` (`writeKeyframeBusLanes`): five lanes' value and target, the duck and automation values, and the gate bits, from the mixer.
  - The zero base of `AudioDebugInfo.counters` is `zeroCounters()`, used by the fallback, the pending backend and the fake.
- **What stays apart by design.**
  - The show side of the hidden-tab policy. The core waits for the context's resume and re-anchors its clock map before restoring MASTER with a 50 ms ramp, frees ended voices from STATUS and ticks the music while hidden. The fallback sets its engine volume at once and suspends only a context it made.
  - Keyframe voices, meters, music, the mix section's meter and target fields, and pooling. The core reads its voice table, loudness hub and music players into pooled rows. The fallback has no meters and no table and builds fresh rows once a second.
  - `debug()`. The core reads STATUS (peaks, counters, beds, zones, memory, health). The fallback reports zeros and the mixer's resolved gains. The M5 sections already share `mix/mixDebug.ts`.
- **The audition label.** `editor/event/auditionHost.ts` still tells backends apart by name. It reads `Audio.debug().core.backend` for the label it shows ("Audio core", "Babylon fallback", "Audio core loading"), and that needs the name whatever else is known. Deriving "skips event filters and aux sends" from a capability would add a field to the public `Audio.debug().mixCaps` for one reader, so we left it.

**What this changes in 0098, 0157 and 0171.** 0098's interface is now 13 required members plus the six capabilities above. The members 0157/0158 (clips, horizon, automation), 0166 (music, clock) and 0171 (mix, capture, lane and slot writers) added as optional members become capability members, or leave the seam (the four writers, `cpu`, `duckGain`).

## Alternatives considered

- **Leave the optional members and document them.** Each caller would still probe one member at a time, and the fake would keep implementing hooks nothing calls.
- **One capability per member (a `Partial<>` of everything).** That is the old interface with a new name. The real co-presence across adapters is a few groups, and the groups are what callers check.
- **Capability objects distinct from the backend, with shorter member names (`mix.caps`, `mix.opTarget`).** The core would need a forwarding object per capability or a rename of public `CoreBackend` members that the browser specs read by name from `page.evaluate`. Returning the backend keeps names, allocation and the specs unchanged, at the cost of `mix.mixCaps` repeating itself.
- **Fold the clock into `music`.** `horizon` and `clipDuration` are used by the event runtime without music, and `latency` by `Audio.latency` and the capture's EPOCH.
- **Share the whole background controller with the fallback.** Its device-change, stall and rebuild handling, STATUS heartbeat and hidden music tick need a core host. The fallback has none of these.

## Consequences

**Positive**
- A caller asks for one capability and gets everything in it. A new backend implements whole capabilities or none, and the table above says what each adapter has.
- The fake lost the four writer recorders, `duckGains`, `cpuValue` and its conditional `horizon` / `frameInterval` properties, and gained `dispose`, `invalidateClip`, `holdSpan`, `keyframe` and the four capability properties: `makeFakeBackend` went from 101 to 97 lines (`testing.ts` 671 to 673 with the comments).
- `backend.ts` went from 1,129 to 627 lines (the debug types are 294 lines in `debugTypes.ts`, the pending adapter 221 in `pendingBackend.ts`) and reads as the seam.
- The hidden-tab mode-and-suspend policy and the keyframe bus lanes each exist once.

**Negative / costs**
- `backend.mix.mixCaps` and `backend.clipCache.clipDuration` repeat themselves (the price of keeping member names).
- On the fallback, `pause` now always arms the 40 ms suspend timer, and whether the backend made its context is read when the timer fires rather than at the hide. The suspend hook does nothing on a context it didn't make, so nothing audible changes; a context the fallback makes inside those 40 ms is now suspended too.
- `AudioClock.horizon()` and `frameInterval()` can now answer null. The core never does.

## Deprecates

`AudioBackend.rampLane`, `writeSlot`, `writeDucking`, `writeLoudnessConfig` and the matching `CoreBackend` forwarding methods (removed). `AudioBackend.cpu` and `duckGain` (off the interface, kept on `CoreBackend`). The optional members `clipDuration`, `clipFacts`, `invalidateClip`, `holdSpan`, `horizon`, `frameInterval`, `beginFrame`, `timeAt`, `latency`, `mixCaps`, `mixOpTarget`, `flushNow`, `recorderTap`, `setProfileSink` and `keyframe` on `AudioBackend` (they move into capabilities). The fake's `laneRamps`, `slotWrites`, `duckingWrites`, `loudnessConfigs`, `duckGains` and `cpuValue` (removed: no test read them). `CoreBackend`'s private `clock` field is renamed `hostClock` (the name is now the capability).

## Open questions

- If a third real backend appears, revisit whether `clipCache` should split (durations and facts against spans and invalidation).

## References

- `src/plugins/audio/runtime/backend.ts`, `debugTypes.ts`, `pendingBackend.ts`, `hiddenTab.ts`, `mix/keyframeBus.ts`, `testing.ts`.
- ADR 0098 (the interface), 0157 (the core and the fallback), 0171 (the M5 members), 0175 (`MixOpTarget`), 0176, 0178 (the core's deep modules).
