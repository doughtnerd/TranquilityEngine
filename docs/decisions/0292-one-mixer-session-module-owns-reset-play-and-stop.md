# 0292. One mixer session module owns Reset, Play and Stop

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0171, 0172, 0175

## Context

The Mixer panel's controller (`editor/mix/mixerPanelModel.ts`) composed five models, each with that one caller: `mixerModel` (strips, the drag), `meterModel` (hold and clip latch), `monitorModel` (monitor mute and solo, taint marks), `compareModel` (Compare with Play start) and `sessionModel` (Reset, Pause, elapsed, the target). What a Reset, a Play or a Stop clears was split between them:

- `sessionModel` reached across to the monitor and Compare through a `SessionMarks` interface (`noteReset`, `notePlay`) so a Reset or a resetting Play cleared their taint marks;
- the controller kept the meters' map, cleared the clip latches after a Reset itself, and on Play began Compare, turned the monitor controls off and cleared the meters; on Stop it ended Compare, turned the monitor off and cleared the meters again, a second copy of the same rules;
- `sessionModel.test.ts` already tested three models together to check the reset rule.

`monitorModel` and `compareModel` each had a `notePlay(resetOnPlay)` that did exactly what `noteReset("all")` did when the flag was true.

## Decision

We will put the session rules in one module, `editor/mix/mixerSession.ts` (`createMixerSession`), which replaces `sessionModel.ts`:

- **It owns the session state.** The meters' map (each `MeterState`, folded by `tickMeters` and read by `meter(bus)`), the monitor model and the Compare model (it creates both), and the loudness controls (Pause, elapsed on the injected audio clock, the target picker).
- **Reset** (`reset(what)`): the hub's meters through the host, the monitor's and Compare's taint marks for `what`, the elapsed time (not for `"maxPeak"`) and, for `"all"`, every clip latch. `resetClip(bus)` clears one latch.
- **Play** (`playStarted(audio)`): Compare keeps its snapshot of the saved mix (a Compare in force ends without applying anything), the monitor controls go off, and with `loudnessResetOnPlay` (default true) the taint marks, the meters and the elapsed time start over; false rebases the elapsed clock only.
- **Stop** (`playStopped()`): Compare ends and drops its snapshot, the monitor controls go off, the meters are forgotten.
- **The tree** (`setAudio(audio)`): the monitor's bus tree (only when the names change), the meters of vanished buses, and the target list.
- **Lifecycle is the session's alone.** The controller reaches the monitor and Compare through narrowed views (`SessionMonitor`, `SessionCompare`: gestures and reads, without `setBuses`, `clearAll`, `begin`, `end`, `noteReset`). `notePlay` is removed from both models; the session sends `noteReset("all")` for a resetting Play.
- **What stays apart.** The fader maths (`mixerModel`, `faderModel`) and the meter maths (`meterModel`'s `tickMeter`, `resetClip`) are unchanged. The controller keeps the op-log baseline, the banners, the snapshot buttons, following Play from `sample()`, and cancelling a drag when Stop ends a Compare.
- **Tests.** `mixerSession.test.ts` (from `sessionModel.test.ts`) tests the controls, the taint marks through the real hub, and what Reset, Play and Stop clear, on the one module. The panel tests that restated those rules through the controller ("Reset clears the clip latches and the monitor's taint marks", "Stop clears the monitor controls") moved there; the per-model Play rows in `monitorModel.test.ts` and `compareModel.test.ts` went with `notePlay`.

Behaviour is unchanged.

## Alternatives considered

- **Keep `SessionMarks` and move only the meters into `sessionModel`.** Play and Stop would still be split between the controller and the model, and the monitor and Compare lifecycle would still be callable from both.
- **Fold everything, the faders included, into the controller.** One bigger shallow module; the fader and meter maths have their own tests and no lifecycle.

## Consequences

**Positive**
- One place says what a Reset, a Play and a Stop clear; the controller's Play and Stop are one call each.
- The rules are tested on one module instead of three together.

**Negative / costs**
- The session's host is wider (hub, monitor lane, Compare's apply, flush and marker); the controller adapts its deps to it once.

## Deprecates

`editor/mix/sessionModel.ts` (`createSessionModel`, `SessionHost`, `SessionMarks`, `SessionOptions`, `SessionModel`), `MonitorModel.notePlay`, `CompareModel.notePlay`, and the controller's meters map and bus-key memo. Removed. `TargetChoice` moved to `mixerSession.ts`.

## Open questions

None.

## References

`src/plugins/audio/editor/mix/mixerSession.ts`, `mixerPanelModel.ts`, `monitorModel.ts`, `compareModel.ts`; tests `mixerSession.test.ts`, `mixerPanel.test.ts`, `monitorModel.test.ts`, `compareModel.test.ts`.
