// The Mixer panel's session (ADR 0292; ADR 0171 §6.6 and §7, ADR 0172; tasks Mp1b, Mp2b): pure, no Preact. One module
// owns what a Reset, a Play and a Stop do to the session state the panel keeps: the meters' hold and clip latch, the monitor
// controls and their taint marks, Compare with Play start, and the loudness controls (Pause, elapsed, the target). The
// fader maths (`mixerModel`, `faderModel`) and the meter maths (`meterModel`) stay apart; the controller drives the session
// and draws from it.
//
//   - Reset: `reset(what)` resets every meter through the injected host (`"all"` by default), clears the monitor's and
//     Compare's taint marks for it (the hub clears its own `tainted` flag on the same reset), restarts the elapsed time
//     (not for `"maxPeak"`, as the meter does) and, for `"all"`, clears every clip latch.
//   - Play: `playStarted(audio)` keeps Compare's snapshot of the saved mix (a Compare in force ends without applying
//     anything: the new Engine plays the edited mix) and turns the monitor controls off (they belong to the old Engine).
//     With the project's `loudnessResetOnPlay` (default true) the hub's `play()` resets the meters themselves, so the
//     session clears the taint marks, the meters' hold and latch and the elapsed time; false keeps all of it and rebases
//     the elapsed clock only, because a new Play's Engine has a new clock.
//   - Stop: `playStopped()` ends Compare and drops its snapshot, turns the monitor controls off and forgets the meters.
//   - Pause and resume: all meters, through the host. Paused time does not count towards `elapsed`.
//   - Elapsed: seconds since the last reset, read off an **injected clock** (the audio clock in the panel), paused spans
//     excluded. The meter's own `elapsed` (metered audio only) stays on `BusLoudness`; this is the panel's readout.
//   - The target picker: lists `audio.loudnessTargets` (default `console` and `mobile`, plus the project's own) and
//     `pickTarget(name)` sets `Audio.loudnessTarget` through the host. The target in force is session state, like
//     `Audio.loudnessTarget = name`, so a pick is one host call and never a commit. An unknown name does nothing.
//   - The tree: `setAudio(audio)` follows a live edit of the section: the monitor's bus tree (controls on vanished buses
//     drop), the meters of vanished buses, and the target list.
//
// The monitor and Compare models are reached through narrowed views: the controller drives their gestures (a solo, a
// monitor mute, a Compare toggle) and reads them, and only this module runs their lifecycle (`clearAll`, `begin`, `end`,
// `noteReset`, `setBuses`).
import { loudnessTargetsOf, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import type { AudioSettings, LoudnessTarget } from "../../../../engine/audio/settings";
import { createCompareModel, type CompareModel } from "./compareModel";
import { createMeter, resetClip, tickMeter, type MeterState } from "./meterModel";
import { createMonitorModel, type MonitorModel } from "./monitorModel";

/** What the session calls on the loudness hub, the play Engine's mixer and the capture: injected, all optional but `apply`. */
export interface MixerSessionHost {
  /** Reset every meter (`bus.loudness.reset(what)` for each metered bus and the master). */
  reset?(what: LoudnessResetWhat): void;
  pause?(): void;
  resume?(): void;
  /** `Audio.loudnessTarget = name` (`LoudnessHub.target`). */
  setTarget?(name: string): void;
  /** `mixer.setMonitor(bus, controls)`: the monitor lane; never saved. */
  setMonitor?(bus: string, controls: { mute?: boolean; solo?: boolean }): void;
  noteMonitorMute?(bus: string): void;
  noteMonitorSolo?(): void;
  setMonitorActive?(on: boolean): void;
  /** `LoudnessHub.setCompare(on)`. */
  setCompare?(on: boolean): void;
  /** `mixer.apply(op)`: Compare's swaps (never an undo step, never saved). */
  apply(op: MixOp): ApplyResult;
  /** The mixer's asap post, once after a Compare swap. */
  flushNow?(): void;
  /** The capture's MARKER, one per Compare swap. */
  marker?(text: string): void;
}

export interface MixerSessionOptions {
  readonly host: MixerSessionHost;
  /** Seconds, monotonic (the audio clock). Never the wall clock in tests. */
  readonly clock: () => number;
  /** The project's current (edited) `audio` section: the target list at start, and what Compare swaps back to. */
  readonly current: () => AudioSettings;
}

/** One picker row. */
export interface TargetChoice extends LoudnessTarget {
  /** In force. */
  readonly selected: boolean;
  /** "-24 LUFS ±2 LU, -1 dBTP". */
  readonly label: string;
}

/** The monitor model as the controller drives it: gestures and reads; its lifecycle is the session's. */
export type SessionMonitor = Omit<MonitorModel, "setBuses" | "clearAll" | "noteReset">;
/** The Compare model as the controller drives it: the toggle and reads; its lifecycle is the session's. */
export type SessionCompare = Omit<CompareModel, "begin" | "end" | "noteReset">;

export interface MixerSession {
  readonly monitor: SessionMonitor;
  readonly compare: SessionCompare;
  /** Play started with the project's `audio` section (see the header). */
  playStarted(audio: AudioSettings): void;
  /** Play stopped (see the header). */
  playStopped(): void;
  /** The section changed: the monitor's tree, the meters of vanished buses, the target list. */
  setAudio(audio: AudioSettings): void;
  /** Folds each bus's live peak (linear, `Bus.peak`) into its hold and clip latch at `nowMs`. */
  tickMeters(buses: readonly string[], peakOf: (bus: string) => number, nowMs: number): void;
  /** A bus's meter state, undefined before its first tick in this Play. */
  meter(bus: string): MeterState | undefined;
  /** Clear one bus's clip latch (a click on its lamp or meter). */
  resetClip(bus: string): void;
  reset(what?: LoudnessResetWhat): void;
  pause(): void;
  resume(): void;
  togglePause(): void;
  readonly paused: boolean;
  /** Seconds since the last reset, paused time excluded. */
  readonly elapsed: number;
  /** The project's targets, in order, the one in force marked. */
  targets(): readonly TargetChoice[];
  /** The target in force (the first entry until a pick). */
  readonly target: string;
  /** Pick a target by name: one `host.setTarget`, nothing else. False (and no call) for an unknown name. */
  pickTarget(name: string): boolean;
  /** The hub's target changed outside the picker (a script's `Audio.loudnessTarget = ...`): follow it; unknown names ignored. */
  syncTarget(name: string | null): void;
}

const formatTarget = (t: LoudnessTarget): string => `${t.integrated} LUFS ±${t.tolerance} LU, ${t.truePeak} dBTP`;

export function createMixerSession(options: MixerSessionOptions): MixerSession {
  const { host, clock } = options;
  const monitor = createMonitorModel({
    host: {
      setMonitor: (b, c) => host.setMonitor?.(b, c),
      noteMonitorMute: (b) => host.noteMonitorMute?.(b),
      noteMonitorSolo: () => host.noteMonitorSolo?.(),
      setMonitorActive: (on) => host.setMonitorActive?.(on),
    },
  });
  const compare = createCompareModel({
    host: {
      // The mixer has no origin argument: Compare's ops reach it as any live op does.
      apply: (op) => host.apply(op),
      flushNow: () => host.flushNow?.(),
      marker: (text) => host.marker?.(text),
      setCompare: (on) => host.setCompare?.(on),
    },
    current: options.current,
  });
  const meters = new Map<string, MeterState>();
  let busKey = "";
  let list: LoudnessTarget[] = loudnessTargetsOf(options.current());
  let current = list[0].name;
  let paused = false;
  let accumulated = 0;
  let since = clock();

  const read = () => (paused ? accumulated : accumulated + Math.max(0, clock() - since));
  const restart = () => {
    accumulated = 0;
    since = clock();
  };
  /** The meters were reset by `what`: the models' taint marks follow the meters' rule. */
  const clearMarks = (what: LoudnessResetWhat) => {
    monitor.noteReset(what);
    compare.noteReset(what);
  };

  return {
    monitor,
    compare,
    playStarted(audio) {
      compare.begin(audio);
      monitor.clearAll();
      if (audio.loudnessResetOnPlay ?? true) {
        // The hub's `play()` resets the meters themselves.
        clearMarks("all");
        meters.clear();
        restart();
      } else {
        accumulated = read();
        since = clock();
      }
    },
    playStopped() {
      compare.end();
      monitor.clearAll();
      meters.clear();
    },
    setAudio(audio) {
      const names = audio.buses.map((b) => b.name);
      const key = names.join("\n");
      if (key !== busKey) {
        busKey = key;
        monitor.setBuses(audio.buses.map((b) => ({ name: b.name, parent: b.parent ?? null })), audio.buses.flatMap((b, i) => (i === 0 || b.meter !== undefined ? [b.name] : [])));
        for (const n of [...meters.keys()]) if (!names.includes(n)) meters.delete(n);
      }
      list = loudnessTargetsOf(audio);
      if (!list.some((t) => t.name === current)) current = list[0].name;
    },
    tickMeters(buses, peakOf, nowMs) {
      for (const name of buses) meters.set(name, tickMeter(meters.get(name) ?? createMeter(), peakOf(name), nowMs));
    },
    meter: (bus) => meters.get(bus),
    resetClip(bus) {
      const m = meters.get(bus);
      if (m) meters.set(bus, resetClip(m));
    },
    reset(what = "all") {
      host.reset?.(what);
      clearMarks(what);
      if (what !== "maxPeak") restart();
      if (what === "all") for (const [n, m] of meters) meters.set(n, resetClip(m));
    },
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
    togglePause() {
      if (paused) this.resume();
      else this.pause();
    },
    get paused() {
      return paused;
    },
    get elapsed() {
      return read();
    },
    targets: () => list.map((t) => ({ ...t, selected: t.name === current, label: formatTarget(t) })),
    get target() {
      return current;
    },
    pickTarget(name) {
      if (!list.some((t) => t.name === name)) return false;
      current = name;
      host.setTarget?.(name);
      return true;
    },
    syncTarget(name) {
      if (name === null) current = list[0].name;
      else if (list.some((t) => t.name === name)) current = name;
    },
  };
}
