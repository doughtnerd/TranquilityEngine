# 0434. The main-thread audio frame is one step, and World views are a backend capability

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0270 (the frame step takes in `mixer.update` and the playlist runtime; the audio system keeps only listener resolution, source binding and sync), 0179 (another capability, `worldViews`)
- **Related:** 0162 (K4), 0221, 0234, 0343 (the playlist runtime's frame)

## Context

ADR 0270 wrote the backend frame once (`runAudioFrame`) and had the test rigs run it. It deliberately left the rest of
the main-thread audio frame in the audio system: `mixer.update` before the backend frame, and the event runtime (now the
playlist runtime, `playlistHost().update`, ADR 0343) after it. 0270's own context records the cost of that order being
written in more than one place: two music tests ran the music plan before the mixer and the backend frame, the reverse
of production.

The same bug class survived 0270, one level up. The order `mixer.update` → backend frame → playlists was hand-written in
`audioSystem.ts` and again in every rig that runs a main-thread frame:

- `loopbackAudio().step` (`testing.ts`), the fader gate harness (`mix/faderGateHarness.ts`), the soak support
  (`capture/soakSupport.ts`) and the real-core bench (`capture/realCore.bench.ts`), each `mixer.update` then `tick`
  (and the playlists, in two of them);
- `recovery.test.ts`, `contextRebuild.test.ts` and `zonesWalk.test.ts`, the same two or three calls;
- 24 loopback test files. Seven playlist and localisation tests (nine loops) ran `playlistHost().update` **before** `mixer.update` and
  the backend frame (the order 0270 removed from the music tests), and three ran the playlists with no `mixer.update`
  at all.

So a playlist loopback test ran a frame no game runs, and a new step in the frame meant editing every rig.

Separately, `audioSystem.ts` duck-typed `setWorldAudible` on the backend (`typeof b.setWorldAudible === "function"`) to
tell the core which Worlds have the view (architecture §3.9, A3.4b): a probe of a single optional member outside 0179's
declared capabilities, the pattern 0179 removed.

## Decision

**One step for the main-thread audio frame.** `runtime/audioFrame.ts` exports `stepAudioFrame(parts, dt)`, where `parts`
(`AudioFrameParts`) are the mixer, the playlist runtime (`PlaylistFrame`, or null), the backend and the caller's listener
frame (already `set`). It runs `mixer.update(dt)`, then `runAudioFrame(backend, frame, dt, mixer.audioSettings)`
(0270's backend frame, unchanged), then `playlists.update(dt)`. The caller keeps one `parts` object and updates it, so a
frame allocates nothing. Adding or moving a step of the frame is an edit there and nowhere else.

**The audio system keeps listener resolution and sources.** `engine.Audio` reports the World views, resolves the listener
into the backend and its `ListenerFrame`, binds the occlusion pass's sources, calls `stepAudioFrame`, then notes the
listener's velocity and syncs the sources. The source binding now runs before `mixer.update` rather than after it: it
reads each `AudioSource`'s voice id, which the mixer's update doesn't touch, and it must only precede the backend frame.

**Every rig calls the same step.**

- `audioFrameDriver(backend, mixer, playlists = null)` (`testing.ts`) returns the step over a listener frame of its own
  (no World, no listener) for tests that build their own host; `recovery` and `contextRebuild` use it.
- `loopbackAudio()` gains `mainFrame(dt?)`: the step, with the page's playlist runtime when the rig is on the page mixer
  and none on its own mixer (as `step` did). `step` is `mainFrame` then the render. The fader gate harness, the soak
  support, the bench and the hand-written loops of the loopback tests call `mainFrame`.
- `zonesWalk.test.ts`, which needs a World in its frame, calls `stepAudioFrame` with its own frame.
- `tick` stays on both rigs as the backend frame alone (`runAudioFrame`), for the tests that drive the mixer themselves
  (most core tests advance the mixer only where they mean to).

**World views are a capability.** `AudioBackend` gains `worldViews?: AudioWorldViews` (`setWorldAudible(key, audible)`),
declared as 0179's capabilities are: the core's getter returns the backend itself; the Babylon fallback, the pending
backend and the fake don't have it (every World is heard there). The audio system reads it once
(`audioBackend().worldViews`) instead of probing the member.

## Alternatives considered

- **Fold `mixer.update` and the playlists into `runAudioFrame`.** `tick`'s callers (about 60 core tests) drive the mixer
  themselves and expect the backend frame alone; changing what `tick` means would change those tests' frames silently.
  Two named entries, one calling the other, keep both readings honest.
- **Let the step resolve the listener too.** It would need a World and the scene's components; the rigs have neither.
  0270 rejected the same for the backend frame.
- **Make `recordingAudio().frame` run the full step.** It advances the fake clock and runs the backend frame, and its
  tests drive the mixer themselves; left as it was (no hand-written order to remove there).
- **Keep the duck-typed `setWorldAudible` and document it.** A single probed member is exactly what 0179's capabilities
  replace; one more capability costs a getter.

## Consequences

**Positive**
- Every loopback test that runs a main-thread frame runs the game's order: the seven playlist and localisation tests no
  longer run the playlists before the mixer, and the three that skipped `mixer.update` now run it.
- `audioSystem.ts` reads as listener and sources around one call.
- The seam declares everything the audio system asks of a backend.

**Negative / costs**
- The soak support, on the page mixer, now runs the (empty) playlist runtime each frame, as a game does.
- `tick` and `mainFrame` sit side by side on the loopback rig; a test must pick the right one (the docs on each say which).

## Deprecates

The hand-written `mixer.update` / `tick` / `playlistHost().update` sequences in `audioSystem.ts`, `testing.ts` (`step`),
the three harnesses and the loopback tests (replaced by the step); `audioFrameDriver`'s backend-only meaning (it now runs
the full step); `audioSystem.ts`'s `WorldAudibleSink` and `hasWorldAudible` probe (replaced by `worldViews`).

## Open questions

None.

## References

- `src/plugins/audio/runtime/audioFrame.ts` (`stepAudioFrame`, `AudioFrameParts`, `PlaylistFrame`), `audioFrame.test.ts`
- `audioSystem.ts`, `backend.ts` (`AudioWorldViews`), `core/coreBackend.ts` (`worldViews`)
- `testing.ts` (`audioFrameDriver`, `mainFrame`), `mix/faderGateHarness.ts`, `capture/soakSupport.ts`, `capture/realCore.bench.ts`

## As built

- Built as decided. The order is pinned by `audioFrame.test.ts` through `stepAudioFrame` alone: the backend's frame sees
  the mixer's clock already moved, and the playlists run after it, frame after frame.
- Migrated loops: 24 loopback test files (each `mixer.update` + `tick`, optionally with `playlistHost().update`, became
  `mainFrame`). Tests on `recordingAudio` keep `tick`.
- `babylonBackend.ts` is untouched: the fallback has no World views.
