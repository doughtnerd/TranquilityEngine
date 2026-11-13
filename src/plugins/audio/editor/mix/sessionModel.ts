// The Mixer panel's loudness session controls and target picker (ADR 0171 §6.6 and §7, record change 23, ADR 0172; task
// Mp1b): pure, no Preact.
//
//   - Reset: `reset(what)` resets every meter through the injected host (`"all"` by default) and clears the marks the
//     monitor and Compare models keep (`noteReset`), because the hub clears its own `tainted` flag on the same reset.
//   - Pause and resume: all meters, through the host. Paused time does not count towards `elapsed`.
//   - Elapsed: seconds since the last reset (`"all"` or `"integrated"`; `"maxPeak"` leaves it, as the meter does), read off
//     an **injected clock** (the audio clock in the panel), paused spans excluded. The meter's own `elapsed` (metered audio
//     only, shed and gap time excluded) stays on `BusLoudness`; this is the panel's wall-of-session readout.
//   - Reset on Play: `notePlay(resetOnPlay)` with the project's `loudnessResetOnPlay`. True resets everything, elapsed and
//     the models' marks (the hub's `play()` resets the meters themselves). False keeps all of it, rebasing the clock only,
//     because a new Play's Engine has a new clock.
//   - The target picker: lists `audio.loudnessTargets` (default `console` and `mobile`, the per-platform entries, plus the
//     project's own) and `pickTarget(name)` sets `Audio.loudnessTarget` through the host. The target is **not** a project
//     setting here (the table is; the one in force is session state, like `Audio.loudnessTarget = name`), so a pick is one
//     host call and never a commit. An unknown name does nothing.
import { loudnessTargetsOf } from "../../../../engine/audio/mixOps";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import type { AudioSettings, LoudnessTarget } from "../../../../engine/audio/settings";

/** What the model calls on the hub's meters: injected. */
export interface SessionHost {
  /** Reset every meter (`bus.loudness.reset(what)` for each metered bus and the master). */
  reset?(what: LoudnessResetWhat): void;
  pause?(): void;
  resume?(): void;
  /** `Audio.loudnessTarget = name` (`LoudnessHub.target`). */
  setTarget?(name: string): void;
}

/** The marks other models keep; `noteReset` and `notePlay` are `monitorModel`'s and `compareModel`'s. */
export interface SessionMarks {
  noteReset(what: LoudnessResetWhat, bus?: string): void;
  notePlay(resetOnPlay: boolean): void;
}

export interface SessionOptions {
  readonly host: SessionHost;
  /** Seconds, monotonic (the audio clock). Never the wall clock in tests. */
  readonly clock: () => number;
  /** Models whose taint marks a reset clears (monitor, Compare). */
  readonly marks?: readonly SessionMarks[];
  /** The project's `audio` section, for the target list; default the two default targets. */
  readonly audio?: Pick<AudioSettings, "loudnessTargets">;
}

/** One picker row. */
export interface TargetChoice extends LoudnessTarget {
  /** In force. */
  readonly selected: boolean;
  /** "-24 LUFS ±2 LU, -1 dBTP". */
  readonly label: string;
}

export interface SessionModel {
  reset(what?: LoudnessResetWhat): void;
  pause(): void;
  resume(): void;
  togglePause(): void;
  readonly paused: boolean;
  /** Seconds since the last reset, paused time excluded. */
  readonly elapsed: number;
  /** Play started with the project's `loudnessResetOnPlay`. */
  notePlay(resetOnPlay: boolean): void;
  /** The project's targets, in order, the one in force marked. */
  targets(): readonly TargetChoice[];
  /** The target in force (the first entry until a pick). */
  readonly target: string;
  /** Pick a target by name: one `host.setTarget`, nothing else. False (and no call) for an unknown name. */
  pickTarget(name: string): boolean;
  /** The project's targets changed (a live edit): the pick stays if its entry survives, else the first entry. */
  setAudio(audio: Pick<AudioSettings, "loudnessTargets">): void;
  /** The hub's target changed outside the picker (a script's `Audio.loudnessTarget = ...`): follow it; unknown names ignored. */
  syncTarget(name: string | null): void;
}

export const formatTarget = (t: LoudnessTarget): string => `${t.integrated} LUFS ±${t.tolerance} LU, ${t.truePeak} dBTP`;

export function createSessionModel(options: SessionOptions): SessionModel {
  const { host, clock } = options;
  const marks = options.marks ?? [];
  let list: LoudnessTarget[] = loudnessTargetsOf(options.audio ?? {});
  let current = list[0].name;
  let paused = false;
  let accumulated = 0;
  let since = clock();

  const read = () => (paused ? accumulated : accumulated + Math.max(0, clock() - since));
  const restart = () => { accumulated = 0; since = clock(); };

  const doReset = (what: LoudnessResetWhat) => {
    host.reset?.(what);
    for (const m of marks) m.noteReset(what);
    if (what !== "maxPeak") restart();
  };

  return {
    reset: (what = "all") => doReset(what),
    pause() {
      if (paused) return;
      accumulated = read();
      paused = true;
      host.pause?.();
    },
    resume() {
      if (!paused) return;
      paused = false;
      since = clock();
      host.resume?.();
    },
    togglePause() { if (paused) this.resume(); else this.pause(); },
    get paused() { return paused; },
    get elapsed() { return read(); },
    notePlay(resetOnPlay) {
      for (const m of marks) m.notePlay(resetOnPlay);
      if (resetOnPlay) restart();
      else { accumulated = read(); since = clock(); }
    },
    targets: () => list.map((t) => ({ ...t, selected: t.name === current, label: formatTarget(t) })),
    get target() { return current; },
    pickTarget(name) {
      if (!list.some((t) => t.name === name)) return false;
      current = name;
      host.setTarget?.(name);
      return true;
    },
    setAudio(audio) {
      list = loudnessTargetsOf(audio);
      if (!list.some((t) => t.name === current)) current = list[0].name;
    },
    syncTarget(name) {
      if (name === null) current = list[0].name;
      else if (list.some((t) => t.name === name)) current = name;
    },
  };
}
