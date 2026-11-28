# 0270. The audio frame order is written once, and the test rigs run it

- **Status:** Accepted, amended by 0446 (the frame step takes in `mixer.update` and the playlist runtime: `stepAudioFrame`)
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0179 (`AudioBackend.update` becomes optional; the core has none), 0221 (the loopback's `step` runs the production frame, and the rigs gain `tick`)
- **Related:** 0162 (K4, "the whole M3 order in one place"), 0166 (step 9, the music plan), 0221, 0234, 0264 (`SpatialPassHost.zones`, `velocityOf`)

## Context

ADR 0162 (K4) split the core backend's frame at main's passes (`StagedFrameHost`, `core/spatial.ts`) so the audio system
could run the M3 order in one place. It did, in `audioSystem.ts` `runFrame`: attenuate → collect → Doppler → zones →
occlusion → select → panner pick → fx → listener → music plan → commit, with a shorter path for the Babylon fallback
(passes, music plan, `update`) and plain backends (music plan, `update`).

But the order was written three more times:

- `CoreBackend.update(dt)`, a required `AudioBackend` member (ADR 0179), ran a second order: no `collectSpatialVoices`,
  no Doppler, zones or occlusion, no music plan, and LISTENER staged from a frame that was never set. Production never
  called it (the audio system takes the staged branch); only test rigs did: `loopbackAudio().step`,
  `recordingAudio().frame`, `hrtfLoopbackRig.ts` and about 70 direct `backend.update(dt)` calls in core tests.
- `core/zonesWalk.test.ts` and `editor/audioDebugMonitor.loopback.test.ts` copied the stage calls by hand (zonesWalk
  without Doppler and occlusion, the monitor test without Doppler).
- `musicRecoveryLoopback.test.ts` and `rhythmModeLoopback.test.ts` ran the music plan before the mixer and the
  backend's frame, the reverse of production.

So core loopback tests ran a frame no game runs, and a new stage meant editing four places. Only
`music/testing/loopbackClock.ts` ran the real thing (it steps `AUDIO_SYSTEMS`).

## Decision

**One frame-step module.** `runtime/audioFrame.ts` exports `runAudioFrame(backend, frame, dt, settings)`: one backend
frame in the production order, for every kind of backend:

- the core (`StagedFrameHost`): `frameAttenuate`, `collectSpatialVoices`, Doppler, zones, occlusion, `frameSelect`,
  `framePickPanners`, `frameStageFx`, `frameStageListener(frame)`, `musicPlanStep`, `frameCommit`;
- the Babylon fallback (`SpatialPassHost` only): `collectSpatialVoices`, Doppler, zones (inert), occlusion,
  `musicPlanStep`, then its `update(dt)`;
- a plain backend (the pending backend, fakes): `musicPlanStep`, then `update?.(dt)`.

`frame` is the caller's `ListenerFrame`, already `set` for this frame; `settings` are those of the mixer that configured
the backend. It allocates nothing.

**Its callers.** `audioSystem.ts` (`engine.Audio`) calls it with its listener frame and the page mixer's settings; the
listener resolution, `mixer.update`, occlusion source binding, events and source sync stay in the system around it.
`testing.ts` adds `audioFrameDriver(backend, mixer)`: a driver with its own listener frame (no World, no listener, so
the listener-bound passes are inert, as in a World without a listener) that runs `runAudioFrame` with that mixer's
settings. `loopbackAudio()` and `recordingAudio()` gain `tick(dt)` (that driver); `step` and `frame` use it. Tests that
build their own host (`recovery`, `contextRebuild`, `rhythmModeLoopback`, `musicRecoveryLoopback`) call
`audioFrameDriver`; the two tests that need a World in the frame (`zonesWalk`, `audioDebugMonitor.loopback`) call
`runAudioFrame` with their own frame.

**The stage methods are the module's contract with the core.** `StagedFrameHost` stays `@internal`; `runAudioFrame`
is the only caller of its stages. (`BackgroundController`'s hidden-tab tick still calls `frameCommit` alone to flush
what the STATUS-driven music tick staged: that is a different event, not a frame.)

**`CoreBackend.update` is removed, and `AudioBackend.update` becomes optional.** It is the backend's own part of the
frame, run last by the frame step; the Babylon fallback and the pending backend keep theirs, test fakes may have one,
and the core has none (its frame is the stages). Nobody drives a frame by calling `update` directly; the Babylon unit
tests still call `BabylonBackend.update` as that class's own member (they test the adapter, not the frame).

## Alternatives considered

- **Keep `CoreBackend.update` and make it call the frame step.** One more entry point into the same order, a core that
  depends on the music system through the frame module, and a listener frame the core would have to own. No.
- **Keep `update` required, and give the core an empty one.** A member that does nothing on the main backend is the
  shallow seam this record removes; optional says what it is.
- **Make the frame step a method of the audio system.** It would need a World; the rigs have none. A module of its
  own is the seam both use.

## Consequences

**Positive**
- Every loopback and recording test runs the frame a game runs: collection, the passes, the music plan and LISTENER
  staging included. One place to add or reorder a stage.
- `AudioBackend` is smaller: the core no longer carries a second frame for tests.

**Negative / costs**
- About 70 test call sites moved from `backend.update(dt)` to the rig's `tick(dt)`.
- The rigs' listener frame has no World, so tests of listener-bound behaviour (Doppler of the listener, LISTENER
  staging, occlusion rays) still set a frame of their own; `zonesWalk` and the debug monitor test do.

## Deprecates

`CoreBackend.update`, its `idleFrame`, and `audioSystem.ts` `runFrame` (removed); the hand-copied stage orders in
`zonesWalk.test.ts`, `audioDebugMonitor.loopback.test.ts`, `musicRecoveryLoopback.test.ts` and
`rhythmModeLoopback.test.ts` (replaced).

## Open questions

None.

## References

- `src/plugins/audio/runtime/audioFrame.ts`, `audioSystem.ts`, `backend.ts` (`AudioBackend.update`), `core/spatial.ts`
  (`StagedFrameHost`), `core/coreBackend.ts`, `testing.ts` (`audioFrameDriver`, `tick`)
- `music/testing/loopbackClock.ts` (steps `AUDIO_SYSTEMS`, unchanged)
