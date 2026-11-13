// The Mixer panel's controller (ADR 0171 change 22, ADR 0172; api-and-models §6 and §7; task Mp2b): pure, no Preact. It ties
// the merged models into one panel: `mixerModel` (strips, the drag), `meterModel` (hold and clip latch), `monitorModel`
// (monitor mute and solo), `compareModel` (Compare with Play start), `sessionModel` (Reset, Pause, elapsed, the target), and
// the banners. Everything outside it (the section's draft and edits, the play Engine's mixer, the loudness hub, the capture,
// the audio clock, the op log) is an injected function, so a test needs no editor and no audio.
//
// Rules the panel keeps:
//   - Reading never writes: `sample()` (every 50 ms while playing) and `view()` build strips from the draft and the live
//     readings; no section edit, no `recordMixOps`, so a script's `bus.volume = 0.5` moves a strip without dirtying the project.
//   - Only a gesture commits: a fader drag is one section edit on release (the mixer model's), a key press on the fader or a
//     mute click is one each. Monitor solo, Compare, snapshots, the target, Reset and Pause never commit (session state).
//   - Compare never commits and never writes an undo step: its ops go through `apply` (the mixer has no origin argument, so
//     `compare` is dropped there) and each switch drops a capture marker. While it is on the faders and mute are locked.
//   - Play state is read, not told: the first `sample()` that sees Play running starts the Compare snapshot, applies
//     `loudnessResetOnPlay` and clears the monitor controls; the first that sees it stopped ends Compare.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import type { SettingsDraft } from "../../../../editor/sdk";
import { createCompareModel, type CompareModel, type CompareSwap } from "./compareModel";
import { createMeter, resetClip, tickMeter, type MeterState } from "./meterModel";
import { createMixerModel, type BusReading, type MixerModel, type Strip } from "./mixerModel";
import { createMonitorModel, type MonitorModel } from "./monitorModel";
import type { OpLogEntry } from "./opLog";
import { createSessionModel, type SessionModel, type TargetChoice } from "./sessionModel";
import type { StripModel } from "./MixerStrip";

// ---- banners (pure) ---------------------------------------------------------------------------------------------------

export type MixerBannerId = "problem" | "restart" | "monitor" | "compare";

export interface MixerBanner {
  readonly id: MixerBannerId;
  readonly severity: "info" | "warn";
  readonly text: string;
}

/** The banner texts (the design gives the behaviour; the words are these, and the tests assert them). */
export const MIXER_BANNER_TEXT = {
  monitor: "Monitor controls are on: the loudness target check is suspended and the meters are marked. They are never saved.",
  compare: "Compare: you are hearing the saved mix from Play start. The faders are locked and nothing is saved.",
  restart: (what: string): string => `Applies at the next Play: ${what}. The edit is saved.`,
} as const;

export interface MixerBannerInput {
  readonly monitorActive: boolean;
  readonly compareActive: boolean;
  /** What the mixer answered `restartRequired` (each message once), and the section keys with no live path. */
  readonly restart: readonly string[];
  /** The audio section's problems (`parseAudioSettings`). */
  readonly problems: readonly string[];
}

/** Every banner that applies: problems first, then what waits for the next Play, then the monitor and Compare. */
export function mixerBanners(input: MixerBannerInput): MixerBanner[] {
  const out: MixerBanner[] = [];
  for (const text of input.problems) out.push({ id: "problem", severity: "warn", text });
  for (const what of input.restart) out.push({ id: "restart", severity: "info", text: MIXER_BANNER_TEXT.restart(what) });
  if (input.monitorActive) out.push({ id: "monitor", severity: "info", text: MIXER_BANNER_TEXT.monitor });
  if (input.compareActive) out.push({ id: "compare", severity: "warn", text: MIXER_BANNER_TEXT.compare });
  return out;
}

/** The distinct `restartRequired` messages and no-live-path keys of the op log's entries newer than `afterSeq`, plus `own`. */
export function restartMessages(entries: readonly OpLogEntry[], afterSeq: number, own: Iterable<string> = []): string[] {
  const seen = new Set<string>(own);
  for (const e of entries) {
    if (e.seq <= afterSeq) continue;
    for (const r of e.results) if (r.restartRequired !== undefined) seen.add(r.restartRequired);
    for (const k of e.restartRequired) seen.add(k);
  }
  return [...seen];
}

/** Seconds as "m:ss" ("h:mm:ss" from an hour on). */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ---- the controller ---------------------------------------------------------------------------------------------------

/** What the controller calls on the loudness hub (the real ones are `loudnessHub`'s and every bus's `loudness`); all optional. */
export interface MixerHub {
  /** Reset every meter. */
  reset?(what: LoudnessResetWhat): void;
  pause?(): void;
  resume?(): void;
  noteMonitorMute?(bus: string): void;
  noteMonitorSolo?(): void;
  setMonitorActive?(on: boolean): void;
  setCompare?(on: boolean): void;
}

/** Everything the panel needs from outside. */
export interface MixerPanelDeps {
  /** The audio section's current draft; null with no project open. */
  draft(): SettingsDraft | null;
  /** One undo step named `label` (the section's `edit`). */
  commit(label: string, next: SettingsDraft): void | Promise<void>;
  /** The editor is in Play. */
  playing(): boolean;
  /** `mixer.apply`. */
  apply(op: MixOp): ApplyResult;
  /** The backend's `flushNow`, when it has one. */
  flushNow?(): void;
  /** A live bus's readings (`Bus` getters), null when none is up. Monitor flags are the controller's. */
  readBus(name: string): BusReading | null;
  /** `mixer.setMonitor`. */
  setMonitor(bus: string, controls: { mute?: boolean; solo?: boolean }): void;
  hub?: MixerHub;
  /** `Audio.loudnessTarget` (get and set). */
  target(): string | null;
  setTarget(name: string): void;
  /** `mixer.snapshot(name)` or, with null, `mixer.clearSnapshot()`; and the one in force. */
  snapshot(name: string | null): void;
  currentSnapshot(): string | null;
  /** `Audio.capture.mark` (a no-op while not recording). */
  mark?(text: string): void;
  /** The audio clock, seconds (`Audio.time`). */
  clock(): number;
  /** The op log's entries (the answers to the edits made in Play). */
  entries?(): readonly OpLogEntry[];
}

/** What the view renders from. */
export interface MixerView {
  readonly playing: boolean;
  readonly strips: readonly Strip[];
  /** Names of the buses a level-ducking rule targets (their gain-reduction meter always shows). */
  readonly ducked: ReadonlySet<string>;
  readonly banners: readonly MixerBanner[];
  readonly snapshots: readonly { readonly name: string; readonly active: boolean }[];
  readonly targets: readonly TargetChoice[];
  readonly paused: boolean;
  readonly elapsed: string;
  readonly compare: { readonly available: boolean; readonly active: boolean; readonly differs: boolean };
  readonly monitorActive: boolean;
  /** The panel-level note when nothing is live, else null. */
  readonly empty: string | null;
}

export const NOT_PLAYING = "Not playing: the strips show the saved mix. Levels, loudness and the monitor controls start with Play.";

export class MixerPanelController {
  readonly mixer: MixerModel;
  readonly monitor: MonitorModel;
  readonly compare: CompareModel;
  readonly session: SessionModel;
  /** The gestures a strip drives: the mixer model's, with the faders locked while Compare is on and solo routed to the monitor. */
  readonly stripModel: StripModel;
  /** How many times `sample` ran (the render-count tests read it). */
  samples = 0;
  private meters = new Map<string, MeterState>();
  private wasPlaying = false;
  private busKey = "";
  private baseSeq = 0;
  private own = new Set<string>();

  constructor(
    private readonly deps: MixerPanelDeps,
    private readonly onChange: () => void = () => {},
  ) {
    const hub = deps.hub ?? {};
    this.monitor = createMonitorModel({
      host: {
        setMonitor: (b, c) => deps.setMonitor(b, c),
        noteMonitorMute: (b) => hub.noteMonitorMute?.(b),
        noteMonitorSolo: () => hub.noteMonitorSolo?.(),
        setMonitorActive: (on) => hub.setMonitorActive?.(on),
      },
    });
    this.compare = createCompareModel({
      host: {
        // The mixer has no origin argument: Compare's ops reach it as any live op does.
        apply: (op) => this.apply(op),
        flushNow: () => deps.flushNow?.(),
        marker: (text) => deps.mark?.(text),
        setCompare: (on) => hub.setCompare?.(on),
      },
      current: () => this.audio(),
    });
    this.session = createSessionModel({
      host: {
        reset: (what) => hub.reset?.(what),
        pause: () => hub.pause?.(),
        resume: () => hub.resume?.(),
        setTarget: (name) => deps.setTarget(name),
      },
      clock: deps.clock,
      marks: [this.monitor, this.compare],
      audio: this.audio(),
    });
    this.session.syncTarget(deps.target());
    this.mixer = createMixerModel({
      draft: () => deps.draft() ?? ({} as SettingsDraft),
      apply: (op) => this.apply(op),
      flushNow: () => deps.flushNow?.(),
      commit: (label, next) => deps.commit(label, next),
    });
    const m = this.mixer;
    const locked = (): boolean => this.compare.locked;
    this.stripModel = {
      get dragging() { return m.dragging; },
      beginDrag: (bus) => !locked() && m.beginDrag(bus),
      drag: (v) => m.drag(v),
      endDrag: () => m.endDrag(),
      cancelDrag: () => m.cancelDrag(),
      setVolume: (bus, v) => !locked() && m.setVolume(bus, v),
      toggleMute: (bus) => !locked() && m.toggleMute(bus),
      // Solo is a monitor control: only while a play Engine is up, and never a commit.
      toggleSolo: (bus) => { if (deps.playing()) this.monitor.toggleSolo(bus); },
    };
  }

  /** The project's audio section as the engine parses it. */
  private audio(): AudioSettings {
    return parseAudioSettings(this.deps.draft()?.audio).settings;
  }

  /** `deps.apply`, remembering what only the next Play can serve. */
  private apply(op: MixOp): ApplyResult {
    const r = this.deps.apply(op);
    if (r.restartRequired !== undefined) this.own.add(r.restartRequired);
    return r;
  }

  // ---- play state and the 50 ms sample ----

  private playStarted(): void {
    const audio = this.audio();
    this.baseSeq = this.deps.entries?.().at(-1)?.seq ?? 0;
    this.own.clear();
    this.compare.begin(audio);
    this.monitor.clearAll();
    const resetOnPlay = audio.loudnessResetOnPlay ?? true;
    this.session.notePlay(resetOnPlay);
    if (resetOnPlay) this.meters.clear();
  }

  private playStopped(): void {
    if (this.compare.active) { if (this.stripModel.dragging) this.mixer.cancelDrag(); }
    this.compare.end();
    this.monitor.clearAll();
    this.meters.clear();
  }

  /**
   * One poll (the panel calls it every 50 ms while playing, once on a gesture otherwise): follows Play starting and stopping,
   * folds each bus's peak into its hold and clip latch at the audio clock, and follows the hub's target. Writes nothing.
   */
  sample(): void {
    this.samples++;
    const playing = this.deps.playing();
    if (playing && !this.wasPlaying) this.playStarted();
    else if (!playing && this.wasPlaying) this.playStopped();
    this.wasPlaying = playing;
    const audio = this.audio();
    const names = audio.buses.map((b) => b.name);
    const key = names.join("\n");
    if (key !== this.busKey) {
      this.busKey = key;
      this.monitor.setBuses(audio.buses.map((b) => ({ name: b.name, parent: b.parent ?? null })), audio.buses.flatMap((b, i) => (i === 0 || b.meter !== undefined ? [b.name] : [])));
      for (const n of [...this.meters.keys()]) if (!names.includes(n)) this.meters.delete(n);
    }
    this.session.setAudio(audio);
    this.session.syncTarget(this.deps.target());
    if (!playing) return;
    const nowMs = this.deps.clock() * 1000;
    for (const name of names) {
      const r = this.deps.readBus(name);
      this.meters.set(name, tickMeter(this.meters.get(name) ?? createMeter(), r?.peak ?? 0, nowMs));
    }
  }

  // ---- gestures ----

  /** Clear one bus's clip latch (a click on its lamp or meter). */
  resetClip(bus: string): void {
    const m = this.meters.get(bus);
    if (m) this.meters.set(bus, resetClip(m));
    this.onChange();
  }

  /** Reset every meter (and the models' marks and the elapsed time; `"all"` also clears the clip latches). */
  reset(what: LoudnessResetWhat = "all"): void {
    this.session.reset(what);
    if (what === "all") for (const [n, m] of this.meters) this.meters.set(n, resetClip(m));
    this.onChange();
  }

  togglePause(): void {
    this.session.togglePause();
    this.onChange();
  }

  pickTarget(name: string): boolean {
    const ok = this.session.pickTarget(name);
    this.onChange();
    return ok;
  }

  /** Snapshot buttons, one at a time: a button fades to its snapshot; the one in force fades back to the plain mix. */
  pickSnapshot(name: string): void {
    if (!this.deps.playing()) return;
    if (!this.audio().snapshots.some((s) => s.name === name)) return;
    this.deps.snapshot(this.deps.currentSnapshot() === name ? null : name);
    this.onChange();
  }

  /** Compare on or off; null (nothing happens) outside Play. */
  toggleCompare(): CompareSwap | null {
    if (!this.deps.playing() || !this.compare.available) return null;
    if (this.mixer.dragging) this.mixer.cancelDrag();
    const swap = this.compare.toggle();
    this.onChange();
    return swap;
  }

  /** A monitor mute of `bus` (the panel's strips carry no button for it; the model and its taint rules are tested). */
  toggleMonitorMute(bus: string): boolean {
    if (!this.deps.playing()) return false;
    const ok = this.monitor.toggleMute(bus);
    this.onChange();
    return ok;
  }

  // ---- the view ----

  view(): MixerView {
    const playing = this.deps.playing();
    const audio = this.audio();
    const read = (name: string): BusReading | null => {
      if (!playing) return null;
      const r = this.deps.readBus(name);
      return r ? { ...r, monitorMute: this.monitor.isMuted(name), monitorSolo: this.monitor.isSoloed(name) } : null;
    };
    const meterOf = (name: string) => {
      const s = this.meters.get(name);
      const r = playing ? this.deps.readBus(name) : null;
      return s && r ? { peak: r.peak, hold: s.hold, clipLatched: s.clipped } : undefined;
    };
    const restart = restartMessages(this.deps.entries?.() ?? [], this.baseSeq, this.own);
    return {
      playing,
      strips: this.mixer.strips(read, meterOf),
      ducked: new Set(audio.ducking.filter((d) => d.mode === "level").map((d) => d.target)),
      banners: mixerBanners({
        monitorActive: this.monitor.active,
        compareActive: this.compare.active,
        restart: playing ? restart : [],
        problems: parseAudioSettings(this.deps.draft()?.audio).problems,
      }),
      snapshots: audio.snapshots.map((s) => ({ name: s.name, active: playing && this.deps.currentSnapshot() === s.name })),
      targets: this.session.targets(),
      paused: this.session.paused,
      elapsed: formatElapsed(this.session.elapsed),
      compare: { available: playing && this.compare.available, active: this.compare.active, differs: this.compare.differs() },
      monitorActive: this.monitor.active,
      empty: playing ? null : NOT_PLAYING,
    };
  }
}
