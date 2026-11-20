# 0248. The music seam is one-way: backends report lifecycle events and music decides what to re-plan

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0166, 0176, 0178, 0179, 0224, 0229

## Context

ADR 0166 §4.6 made `MusicBackend` the seam between the music runtime (`runtime/music/`) and the two backends that play it (the core's `core/musicOps.ts`, the fallback's `BabylonMusic`). Group events already went up it through `onGroupEvent`. Recovery, abandon and the hidden-tab tick did not; the core called down into `music/` instead:

- `core/musicOps.ts` imported `recoverGroups`, `recoverAbandoned` and `groupAbandoned` from `music/background.ts` and `liveRun` from `music/segmentRun.ts`, and built `this.view = {…} as unknown as AudioBackend` (still carrying `clockMap`, which 0224 says music no longer reads) only to pass it to them.
- `core/background.ts` imported `noteHidden` and `tickHidden` and passed itself `as AudioBackend`; `tickHidden` then probed `frameCommit`.
- `music/background.ts` probed `(backend as { isRecovering? }).isRecovering` each frame for the rhythm-mode beat holds.
- `MusicFrame.backend` was the whole `AudioBackend`, though music reads only `time`, `clock`, `clipCache`, `automation` and `play`; `music/planner.ts` and `musicSystem.ts` started their frames from `null as unknown as` backends.

Three smaller places repeated themselves across the seam: the fade-law curves (`babylonBackend.ts` `lawWeight`, `core/musicOps.ts` `lawWeight` and `LAW_CODE`, `music/transition.ts`'s curve choice), the event runtime's refresh after a live `setAutomation` (the fallback called `events().getGlobal("")` for its side effect, the core `events().syncSettings()` from `core/liveMix.ts`), and the `Audio.calibration` hookup (`initCalibration` and `calibrationDeviceChanged` called from inside both backends).

## Decision

We will make the seam one-way: a backend reports what happened, and the music side alone decides what to re-plan. No module under `core/` imports `music/`, and the fallback imports `music/` for nothing.

**Lifecycle events.** `MusicBackend` gains a second sink, `onLifecycle: ((e: MusicLifecycleEvent) => void) | null`, beside `onGroupEvent`:

| Event | Who reports it | What music does |
|---|---|---|
| `{ kind: "rebuild", active }` | the core's session (`beginRecovery` true; `endRecovery`, `recoveryFailed` false; musicOps joins those phases) | rhythm-mode beat holds (Rh1); replaces the `isRecovering` probe |
| `{ kind: "recover", cause }` (`rebuild`, `crash`, `rate`) | `musicOps.reopen` after it forgot the dead groups | re-plan every player at the heard position |
| `{ kind: "hidden", hidden }` | the core's background controller under `play` and `mute` | gates the hidden tick and `frame.hidden` |
| `{ kind: "hiddenTick" }` | the controller, per STATUS block while hidden; it flushes the batch (`frameCommit`) after the call | tick every player |

An abandon stays an ordinary group event (`kind: "abandon"`). The music side looks up the player before the router releases the run, routes it, and recovers the player at once, where musicOps used to recover after the frame's whole batch; nothing later in a batch can name the re-planned group, since its id is new.

**Binding.** `music/background.ts` `bindMusicBackend(backend)` sets both sinks (idempotent per music backend; a new binding starts visible and not rebuilding). It runs for every backend the selector installs (the attach hook below) and from the early step for a backend a rig sets some other way, also before the first player, so a hide or a rebuild reported before any music is not lost. `recoverGroups`, `recoverAbandoned`, `groupAbandoned`, `noteHidden` and `tickHidden` become private to `music/background.ts`; tests drive them through the fake's sinks (`FakeMusicBackend.report`, `emit`).

**What music reads.** `MusicFrame.backend` is `MusicHost = Pick<AudioBackend, "time" | "clock" | "clipCache" | "automation" | "play">`. Frames start from a real idle host (`{ time: 0, play: () => null }`), not a cast. `isPendingCoreBackend` takes any object, so the planner's F-35 check still sees the stand-in.

**The fallback.** `BabylonMusic` has `onLifecycle` and never calls it: it has no rebuild, crash, abandon or STATUS-driven hidden tick (rAF stops and nothing ticks hidden music there, as before).

**Above the seam, once for every backend** (`runtime/backend.ts`):
- `onAudioBackendAttached(fn)` runs `fn` on every backend the selector installs (`audioBackend()`, `setAudioBackend`; never the pending stand-in), and at once on the installed one. The music side binds its sinks with it and `music/calibration.ts` follows the output device with it; both register on import, as `onAudioSessionReleased` listeners do.
- `onMixOpSent(fn)` runs after the installed backend's live mix sent an op: the selector hands the mixer a thin target around `mix.mixOpTarget`. The event runtime binds bus automation again after a `setAutomation` there (`events().syncSettings()`). The fallback's `getGlobal("")` call and `core/liveMix.ts`'s `refreshEventAutomation` (and its unused `automationChanged` host hook) are removed.
- **Output device.** `AudioBackend.device?: AudioOutputDevice` (`outputSink`: the context's sink or null before there is one; `onOutputDevice(sink, "opened" | "changed")`, set from above). The core answers from the host's snapshot and reports the background controller's device events; the fallback reports when its lazily made context opens and on `sinkchange` / `devicechange`. `initCalibration` and `calibrationDeviceChanged` become private to `music/calibration.ts`.

**One fade-law module.** `runtime/fadeLaw.ts` holds `fadeLawWeight(law, p)`, the wire code both ways (`fadeLawCode`, `fadeLawOfCode`) and a transition curve's laws (`fadeInLaw`, `fadeOutLaw`). The core's music ops, the fallback and `music/transition.ts` import it. The Rust core keeps its own laws, and `golden/seamReference.ts` keeps an independent copy on purpose: it is the offline reference the seam goldens are checked against, written "with no knowledge of the runtime". `fadeLaw.test.ts` checks the module against it.

## Alternatives considered

- **Lifecycle kinds on `onGroupEvent`.** One sink, but the router (`routeGroupEvent`) would have to skip kinds that name no group, and the event union would mix per-group reports with backend-wide ones.
- **`recovering` as a readonly field on `MusicBackend`.** Smaller, but it is still a probe each frame, and the begin and end of a rebuild are moments the music side wants to act on (marking the players that had a run), not a level to poll.
- **Bind in the early step only (as before).** A backend reporting a hide before the first frame with a player would talk to nothing; binding at install time closes that gap.
- **Import `events/` and `music/calibration` into `backend.ts`.** It makes the seam module depend on its callers and risks import cycles; the hooks keep `backend.ts` free of them.
- **Merge the golden reference into `fadeLaw.ts`.** It would stop being an independent check of the runtime's laws.

## Consequences

**Positive**
- `core/` has no `music/` import (`calibration.ts` included); the backend fakes are gone (musicOps's `as unknown as AudioBackend` view, the frames' `null as unknown as` backends, `core/background.ts`'s `as AudioBackend`). The music recovery and hidden-tab policy are one module, driven in tests through the same sinks the core reports to.
- The fallback gets the same semantics by reporting the same events where it has the moment (none today; a future fallback rebuild only has to report `rebuild`/`recover`).
- The after-`setAutomation` refresh and the calibration hookup run once, for every backend, above the seam.

**Negative / costs**
- `MusicBackend` gains `onLifecycle` (and `AudioBackend` the optional `device` capability): every adapter implements one more member.
- An abandon now recovers as its event is handled rather than after the frame's batch.
- The mixer's live-op target is a thin wrapper object per installed backend, not the backend's own `mixOpTarget`.

## Deprecates

`music/background.ts` exports `noteHidden`, `tickHidden`, `recoverGroups`, `recoverAbandoned`, `groupAbandoned` (now private, reached through `onLifecycle` and `onGroupEvent`); `CoreMusicOps`'s `view`; the `isRecovering` and `frameCommit` probes in `music/background.ts`; `babylonBackend.ts` and `core/musicOps.ts` `lawWeight` / `LAW_CODE` and `music/transition.ts` `lawIn` / `lawOut` (moved to `fadeLaw.ts`); `LiveMixHost.automationChanged` and `refreshEventAutomation`; the backends' calls of `initCalibration` and `calibrationDeviceChanged` (now private to `music/calibration.ts`).

## Open questions

None.

## References

- `src/plugins/audio/runtime/backend.ts` (`MusicLifecycleEvent`, `MusicBackend.onLifecycle`, `AudioOutputDevice`, `onAudioBackendAttached`, `onMixOpSent`), `music/background.ts`, `music/musicSystem.ts` (`MusicHost`), `core/musicOps.ts`, `core/background.ts`, `core/session.ts`, `fadeLaw.ts`, `music/calibration.ts`.
- ADR 0166 §4.6 (the music seam), 0178 (the session's phases), 0179 (capabilities), 0224 (music reads only `clock`).
