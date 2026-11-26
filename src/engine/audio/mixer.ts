/**
 * The mixer's model (ADR 0097, amended by 0171, 0172 and 0344): a bus tree with returns and VCAs, volume, mute and
 * solo, blending snapshots and ducking. It is pure state plus per-frame maths; a backend (ADR 0098) turns the resolved
 * state into sound (Babylon audio buses, or the core's mix graph). Game code reaches it through `Audio.bus(name)` and
 * `Audio.snapshot(name)`.
 *
 * **The model (ADR 0344).** The mixer runs the `AudioProject` mix (`audio.json`): the runtime settings carry it whole
 * under `mix` (`projectWithAudio`); settings without one (the old section shape) are migrated on the fly
 * (`fromLegacySection`). What the backends build their bus graph from is the project's backends' view
 * (`coreSectionOf`, `audioSettings`): the bus tree, each bus's fader, its effects the backends run and its post-fader
 * sends. **Returns are buses** there (ADR 0344, ABI 4.7): each holds a core slot after the buses, with the same lanes as
 * a bus (fader, script volume, snapshot, monitor, dip, duck, automation), fed by the sends into it. Everything else runs
 * here, on the main thread: VCAs (a gain lane), send muting, blending snapshots (`SnapshotPlayer`: start kinds, fades,
 * hold, priority, Override and Add, effect-parameter overrides) and the automation the core doesn't run (send levels,
 * effect parameters). Effect-parameter values the main thread moves (snapshot overrides, effect automation) reach the
 * backends as each bus's live effects (`ResolvedBus.effects`, `_busEffects`); the core writes a `BUS_SLOT` when they
 * change. Send levels (with their automation) and send mutes (a muted bus silences its sends, keeping their levels)
 * reach them as each bus's live sends (`_busSends`); the core writes a `BUS_SENDS` when they change.
 *
 * **Gain lanes (ADR 0172 §1.3, 0344; design `architecture.md` §4.5).** A bus's gain is the product of eight lanes:
 * `authored` (the fader x authored mute), `vca` (the VCAs on the bus, ADR 0344), `runtime` (the script `volume`, its
 * fade, x script mute), `snapshot` (the blend's offset), `monitor` (monitor mute x the solo gate), `dip` (the structural
 * dip), all written here on main, and `duck` and `automation`, owned by the core. The wire has no VCA lane: the core's
 * `authored` lane carries fader x VCA (`BusLanes.authored`). Main keeps one `Ramp` record per lane it writes and
 * evaluates them at the **heard clock** (`setClock`; without one, the mixer's own clock advances by `update`'s `dt`),
 * for the getters and the audibility estimate. A fade is one ramp record per segment, not one step per display frame: a
 * snapshot fade is linear in dB, so its lane is written as linear-gain segments of at most `SNAPSHOT_SEGMENT_MS`.
 *
 * Until the core backend writes lanes itself (task Mx2), backends read `resolve`/`resolveAll`: one composed gain per
 * bus, re-sent on every frame a ramp moves.
 */
import { evalCurve, type Curve, type CurveKey } from "../core/curve";
import { defaultAudioSettings, MASTER, type AudioSettings, type BusEffect, type BusSettings } from "./settings";
import { applyOpToSettings, diffOps, isProjectOp, opClass, opRefusal, type MixOp, type ApplyResult, type OpClass } from "./mixOps";
import { applyOpToProject, projectOpRefusal, type ProjectMixOp } from "./projectOps";

/** The blend's effect-parameter values: owner → effect id → param → { value, from }. */
type EffectOverrides = ResolvedMix["effects"];
import { liveRuleAnswer, unsupportedAnswer, type LiveCaps, type SentClass } from "./busCapability";
import { LoudnessView, EMPTY_BUS_LOUDNESS, type BusLoudness, type LoudnessSource } from "./loudnessTypes";
import { isLabelled, parameterDefault } from "./parameters";
import { evalCurveBy, secondValueOf } from "./curveBy";
import { engineSettingsOf, projectOfMix } from "./project/format";
import { dbToGain, levelDbOf, MIN_DB } from "./project/gain";
import { fromLegacySection, mergeLegacyIntoProject } from "./project/legacy";
import { isCarrier, param as effectParam, toBusEffect } from "./project/legacyEffects";
import { coreSectionOf, coreShown, sectionReturnsOf, sendLevelOf, vcaOffsetDb } from "./project/runtimeView";
import { SnapshotPlayer } from "./project/snapshotPlayer";
import { valueOf, type ResolvedMix } from "./project/snapshots";
import type { AudioProject, Bus as ProjectBus, Return } from "./project/types";

/** What a backend applies for one bus. */
export interface ResolvedBus {
  name: string;
  parent: string | null;
  /** This bus's own gain: the product of its main-side lanes, the duck and (Babylon) automation; 0 when muted or silenced by another bus's solo. */
  gain: number;
  /** `gain` times every ancestor's: the level a sound that can't go through the node graph is scaled by. */
  effectiveGain: number;
  /** The bus's effects as they run now: `audioSettings`' with the main thread's live values (snapshot overrides, effect automation). */
  effects: BusEffect[];
  /** Low-pass cutoff a snapshot is applying (Hz), or null. */
  snapshotLowpass: number | null;
}

/** Shortest ramp main asks of the core for a set, a toggle or a 0-second fade (the wire's `BUS_MIN_RAMP_MS`, §4.1). */
export const BUS_MIN_RAMP_MS = 5;

/**
 * A fader edit's ramp on the `authored` lane (ADR 0172 §1.4: drags ramp over 10 ms, asap, never stamped); the wire's
 * `DRAG_RAMP_MS` (repeated here so the engine imports no plugin; `liveMix.test.ts` checks they agree).
 */
export const DRAG_RAMP_MS = 10;

/** A live edit of an active snapshot's definition retargets its lane over this long (architecture §4.7). */
export const SNAPSHOT_EDIT_MS = 20;

/**
 * ADR 0344: how often the blend is re-planned while a snapshot fades: the gain lane is one ramp linear in dB to the
 * fade's next break (ABI 4.8's `Decibel` law), and the carrier low-pass and the effect overrides follow the blend in
 * steps of at most this long.
 */
export const SNAPSHOT_SEGMENT_MS = 50;
/** Seconds before a fade's break where the gain lane's ramp aims (the blend's value as the break is reached, not after it). */
const BREAK_EPSILON = 1e-9;
/** A presence duck this close to its goal (gain; about 1e-6 dB at full scale) is there. */
const DUCK_SETTLE = 1e-7;

/**
 * Lane ids: the wire's `LANE_*` constants (api-and-models §4.1), and `vca` (ADR 0344), a main-side lane the wire
 * carries inside `authored`.
 */
export const Lane = { authored: 0, runtime: 1, snapshot: 2, monitor: 3, dip: 4, duck: 5, automation: 6, vca: 7 } as const;
export type LaneId = (typeof Lane)[keyof typeof Lane];

/** How a ramp moves: linear in gain, or linear in dB (ADR 0344 snapshot fades; a ramp to or from 0 is linear). */
export type RampLaw = "linear" | "db";

/**
 * One lane's ramp on the heard clock: `from` at `start`, `to` at `start + seconds`, linear between (§3.1; in dB with law
 * `db`, when both ends are above 0). `seconds`
 * 0 is an asap write: main reads `to` at once and the lane writer ramps it over `BUS_MIN_RAMP_MS` (never an unramped
 * step). `seq` grows on every write, so a writer can tell which lanes moved since it last looked.
 */
export interface Ramp {
  from: number;
  to: number;
  /** Heard seconds (`Audio.time`'s base). */
  start: number;
  seconds: number;
  law: RampLaw;
  seq: number;
}

/** A ramp's value at heard time `now` (law `db` with both ends above 0: geometric, as the core's `Decibel` law). */
export function rampAt(r: Ramp, now: number): number {
  if (!(r.seconds > 0) || now >= r.start + r.seconds) return r.to;
  if (now <= r.start) return r.from;
  const u = (now - r.start) / r.seconds;
  if (r.law === "db" && r.from > 0 && r.to > 0) return r.from * Math.pow(r.to / r.from, u);
  return r.from + (r.to - r.from) * u;
}

/** Whether `r` changes value somewhere in (`a`, `b`]: a frame that spans any of it must re-send the mix. */
function rampMoves(r: Ramp, a: number, b: number): boolean {
  return r.from !== r.to && r.seconds > 0 && r.start < b && r.start + r.seconds > a;
}

/** The main-side lanes of one bus, for the lane writer (Mx2) and the editor's views. Read-only to them. */
export interface BusLanes {
  /** Core index (§6.3); the bus's list index until the slot table (Sm1) assigns it. */
  readonly slot: number;
  /** The wire's `authored` lane: the fader times the VCA lane (the wire has no VCA lane). */
  readonly authored: Readonly<Ramp>;
  readonly authoredMute: boolean;
  /** Script `volume` and its fade. */
  readonly runtime: Readonly<Ramp>;
  readonly runtimeMute: boolean;
  readonly runtimeSolo: boolean;
  readonly snapshot: Readonly<Ramp>;
  /** The snapshot's low-pass cutoff, Hz (`OFF_HZ`: none), ramped with it: an override of a low-pass carrier's cutoff (ADR 0344 migration). */
  readonly snapshotLowpass: Readonly<Ramp>;
  readonly monitorMute: boolean;
  readonly monitorSolo: boolean;
  readonly dip: Readonly<Ramp>;
  /** The duck lane's value: STATUS's `busDuck` on the core backend (the duck source), main's presence computation on the Babylon fallback. */
  readonly duck: number;
}

/**
 * @internal ADR 0344 (ABI 4.7): one post-fader send of a bus as it runs now (`Mixer._busSends`): into bus `to` (a return),
 * at linear `level` (the authored send and its automation, 0..`MAX_SEND_LEVEL`), `muted` while the sending bus is muted
 * (the project, a script or a monitor control): the send goes silent and keeps its level.
 */
export interface LiveBusSend {
  readonly to: string;
  readonly level: number;
  readonly muted: boolean;
}

const NO_SENDS: readonly LiveBusSend[] = Object.freeze([]);

interface BusState {
  /** The backends' view of the bus (`audioSettings`); a return's is a bus of the view too (its output as the parent). */
  settings: BusSettings;
  slot: number;
  /** ADR 0344: the fader alone (`authoredVolume`). */
  fader: Ramp;
  /** ADR 0344: the VCAs on the bus (gain). */
  vca: Ramp;
  /** The wire's `authored` lane: fader x VCA. */
  authored: Ramp;
  authoredMute: boolean;
  runtime: Ramp;
  mute: boolean;
  solo: boolean;
  snapshot: Ramp;
  lp: Ramp;
  monitorMute: boolean;
  monitorSolo: boolean;
  dip: Ramp;
  duck: number;
  voices: number;
  /** Newest peak (max of L and R, linear), from the backend's status (A2.3). */
  peak: number;
  /** ADR 0158: bus automation from the TypeScript evaluator (the Babylon fallback only); 1 and OFF_HZ otherwise. */
  autoGain: number;
  autoLp: number;
  /** ADR 0158 §3 (M2 F2): bus automation the audio core applies itself, kept only so `effectiveGain` reports it; never sent to a backend. */
  viewGain: number;
  /** The live effects (`ResolvedBus.effects`): `settings.effects` with the main thread's values in. */
  effects: BusEffect[];
  /** ADR 0344: the live sends (`_busSends`); an unchanged list keeps its object. */
  sends: readonly LiveBusSend[];
  /** §1.1: allocated once per bus, a view over the registered loudness source. */
  loudness: BusLoudness;
}

const OFF_HZ = 24000;
/** The core's highest lane gain (`MAX_LANE_GAIN`). */
const MAX_LANE_GAIN = 4;
const FREQUENCY_PARAMS = new Set(["cutoff", "frequency", "freq", "lowFreq", "highFreq", "midFreq"]);

/** The heard clock the mixer evaluates ramps on: seconds, `Audio.time`'s base. */
export type MixerClock = () => number;

/** ADR 0172 §1.1 (Dp1): where the duck lane is read from when the core computes it: a bus's gain (1 = not ducked). */
export type DuckSource = (bus: string) => number;

/** Monitor controls (§6.6): a mixer view's mute and solo (the Audio Studio's), never saved, never set through `apply`. */
export interface MonitorControls {
  mute?: boolean;
  solo?: boolean;
}

/**
 * @internal ADR 0171 (Rc3, api-and-models §5.6): the capture's taps on the mixer's setters, for the plugin's recorder (the
 * engine imports no plugin, so this is the engine's own shape). `busRamp`: a main-side lane moved (`seconds` is the ramp as
 * authored, 0 asap: the lane writer ramps it over `BUS_MIN_RAMP_MS`); `snapshot`: a script or the panel faded to a
 * snapshot (`null`: back to the plain mix); `monitor`: a monitor mute or solo changed (`muted` and `soloed` are bus-slot
 * bit masks). With no tap set (the default) each setter pays one null check.
 */
export interface MixerTap {
  busRamp(bus: string, lane: LaneId, seconds: number, target: number): void;
  snapshot(name: string | null, seconds: number): void;
  monitor(muted: number, soloed: number): void;
}

/**
 * What `mixer.apply` sends a checked op to (ADR 0175): the backend's live path (`AudioBackend.mix.mixOpTarget`, ADR 0179: the core's
 * `LiveMix`, the fallback's `sendOp`). The Mixer does the rest: the refusal, the class, a no-op, the bus capability
 * rules against `liveCaps`, and the answer for a feature the target doesn't run.
 */
export interface MixOpTarget {
  /** What the target runs (`busCapability.ts`: `CORE_LIVE_CAPS`, `FALLBACK_LIVE_CAPS`). */
  readonly liveCaps: LiveCaps;
  /**
   * Send one op the Mixer has checked against this mixer's settings: not refused, changing something, of class `cls`,
   * within the target's capability rules. The target changes the model (`_applyLive`) and sends what moved.
   */
  sendOp(op: MixOp, cls: SentClass): ApplyResult;
  /** An op the Mixer refused or kept for the next Play without sending it (the core's `liveRefused` counter). */
  notSent?(r: ApplyResult): void;
}

/** A bus, as game code sees it: `Audio.bus("Music").volume = 0.5`. A return is reached the same way. Unknown names give an inert bus. */
export class Bus {
  /** @internal */
  constructor(private mixer: Mixer, readonly name: string) {}
  private get s(): BusState | undefined { return this.mixer._state(this.name); }
  /** Whether the project has a bus (or a return) with this name. */
  get exists(): boolean { return this.s !== undefined; }
  /**
   * Runtime multiplier, linear 0..2, default 1, set by scripts. Acts on top of `authoredVolume`; never written to
   * audio.json. Authored 2 x runtime 2 = 4 is legal; the master limiter catches it. A fade in progress reads its
   * current value on the heard clock.
   */
  get volume(): number { const s = this.s; return s ? rampAt(s.runtime, this.mixer.time) : 0; }
  set volume(v: number) { this.mixer._setRuntime(this.name, v, 0); }
  /** The project's fader (`audio.json`'s `volumeDb`, as a gain), read-only to scripts; the editor changes it through `mixer.apply`. */
  get authoredVolume(): number { const s = this.s; return s ? rampAt(s.fader, this.mixer.time) : 0; }
  /** Runtime switch set by scripts, default false; effective mute = authored mute OR this OR a monitor control. Mute silences the bus and its sends. */
  get mute(): boolean { return this.s?.mute ?? false; }
  set mute(m: boolean) { const s = this.s; if (s && s.mute !== !!m) { s.mute = !!m; this.mixer._dirty(true); this.mixer._noteMute(this.name); } }
  /** While any bus is soloed, only soloed buses (and the buses they feed and pass through, and returns) are heard. Default false. */
  get solo(): boolean { return this.s?.solo ?? false; }
  set solo(m: boolean) { const s = this.s; if (s && s.solo !== !!m) { s.solo = !!m; this.mixer._dirty(true); } }
  /** The project's mute, read-only to scripts. */
  get authoredMute(): boolean { return this.s?.authoredMute ?? false; }
  /** Sounds playing on this bus right now. */
  get activeVoices(): number { return this.s?.voices ?? 0; }
  /** The newest peak level on this bus (max of L and R, linear, decayed for display); 0 while the audio is locked. Declared by A1.6 (K10); fed by the core backend from STATUS (0 on the Babylon backend). */
  get peak(): number { return this.s?.peak ?? 0; }
  /** Product of every gain up the tree, all lanes: the level reaching the speakers from this bus. */
  get effectiveGain(): number { return (this.mixer.resolve(this.name)?.effectiveGain ?? 0) * this.mixer._viewChain(this.name); }
  /** The duck lane's gain, 1 = not ducked, 0..1. On the core backend, STATUS's `busDuck` (a block old, ADR 0172 §1.1); on the Babylon fallback, main's presence-duck computation. */
  get duckGain(): number { const s = this.s; return s ? this.mixer._duckOf(this.name, s) : 1; }
  /** Ease `volume` to `v` over `seconds` (0 jumps over `BUS_MIN_RAMP_MS`, never an unramped step). One ramp record, not one per display frame. */
  fadeTo(v: number, seconds: number): void { this.mixer._setRuntime(this.name, v, seconds); }
  /** Loudness readings and controls; a stable object allocated once per bus, like `peak`. */
  get loudness(): BusLoudness { return this.s?.loudness ?? EMPTY_BUS_LOUDNESS; }
}

/** A curve's value at `x`, interpolated in log scale (frequency parameters, ADR 0344). */
function evalLogCurve(curve: Curve, x: number): number {
  if (curve.some((k) => !(k[1] > 0))) return evalCurve(curve, x);
  return Math.exp(evalCurve(curve.map((k) => [k[0], Math.log(k[1]), ...k.slice(2)] as unknown as CurveKey) as Curve, x));
}

export class Mixer {
  private buses = new Map<string, BusState>();
  private order: string[] = [];
  /** ADR 0344: the returns' names (buses of the view, fed by sends only; no sound plays on one). */
  private returnSet = new Set<string>();
  private settings: AudioSettings = defaultAudioSettings();
  /** ADR 0344: the mix model the mixer runs. */
  private project: AudioProject = fromLegacySection(this.settings);
  private readonly player = new SnapshotPlayer();
  /** The heard time the snapshot lanes' current segment ends (Infinity: settled). */
  private segmentEnd = Number.POSITIVE_INFINITY;
  /** Global parameter values the main thread's automation reads, by name (labels as their index). */
  private paramValues: Record<string, number> = {};
  /**
   * Main's estimate of the effect-parameter values the core's automation sets (ABI 4.8: the core runs every automation
   * target), owner → effect id → param → value: what a snapshot override blends from.
   */
  private autoFx = new Map<string, Map<string, Map<string, number>>>();
  /** The live effects and sends need recomputing (a snapshot segment, an automation value, a mute). */
  private effectsDirty = true;
  /** While a project op runs, the old ops it sends don't lift into the project again. */
  private lifting = true;
  private listeners = new Set<() => void>();
  private changed = true;
  private warned = new Set<string>();
  private clock: MixerClock | null = null;
  /**
   * Dp1 (Mx2's timing note): the heard time a stamped ramp written now starts at on the backend (the lane writer's stamp,
   * *F*_now + L, in heard seconds; NaN when unknown). Used only with `clock`.
   */
  private stampClock: MixerClock | null = null;
  /** Dp1: the core's duck lane (STATUS); null keeps main's presence computation (the Babylon fallback). */
  private duckSource: DuckSource | null = null;
  /** The mixer's own clock (no `setClock`): advanced by `update`'s `dt`. */
  private ownTime = 0;
  /** Heard time at the last `update`: ramps moving since then re-send the mix. */
  private lastUpdate = 0;
  private seq = 0;
  private loudnessSource: LoudnessSource | null = null;
  private opTarget: MixOpTarget | null = null;
  /** Rc3: the capture's taps on the setters; null while no recorder runs. */
  private tap: MixerTap | null = null;
  /** Ma1 (§6.3): old bus name -> new, after a live rename, so a held `Bus` keeps working (one warning per old name). */
  private readonly aliases = new Map<string, string>();
  /**
   * G7c (architecture §2.3, §3.3, §4.7): on the core path a removed bus leaves the model at once (`busNames`,
   * `resolveAll`, `has`, `Audio.buses`) like on the fallback, but its state object is held here, by its slot, while the
   * slot table keeps the slot as a tombstone: its dip lane (held at 0) is what a rebuild replays for that slot. Released
   * when the slot recycles (`_releaseTombstones`), a bus is added into the slot, or at the next configure.
   */
  private readonly tombstones = new Map<number, BusState>();

  constructor(settings: AudioSettings = defaultAudioSettings()) { this.configure(settings); }

  /**
   * Replace the mix (project load). Every script value (volume, fades, mute, solo, snapshots started) and every monitor
   * control resets; authored values come from `settings`: its `mix` (`audio.json`'s) when present, else its old mix keys,
   * migrated (`fromLegacySection`).
   * `base` snapshots and those whose conditions hold with the parameters' defaults are on at once.
   */
  configure(settings: AudioSettings): void {
    let project: AudioProject;
    if (settings.mix !== undefined) {
      project = projectOfMix(settings.mix, engineSettingsOf(settings));
      this.settings = { ...settings, ...coreSectionOf(project), mix: settings.mix };
    } else {
      project = fromLegacySection(settings);
      // The old keys as given. With a reverb send, the bus tree is the migrated model's view, as for `audio.json`'s (ADR
      // 0344: the send became a send into a "Reverb" return, a bus of the view), so a live op's bus edit is an edit of
      // `coreSectionOf(project)` (`mergeLegacyIntoProject`); without one the two trees are the same.
      this.settings = project.returns.length > 0 ? { ...settings, buses: coreSectionOf(project).buses } : settings;
    }
    this.project = project;
    this.buses.clear();
    this.returnSet = new Set(sectionReturnsOf(project).map((r) => r.name));
    this.order = this.settings.buses.map((b) => b.name);
    const now = this.time;
    this.lastUpdate = now;
    this.aliases.clear();
    this.tombstones.clear();
    this.settings.buses.forEach((b, i) => this.buses.set(b.name, this.newState(b, i, now)));
    this.paramValues = Object.fromEntries(project.parameters.map((p) => [p.name, parameterDefault(p)]));
    this.player.configure(project.snapshots, project.parameters, this.paramValues, now);
    this.segmentEnd = Number.POSITIVE_INFINITY;
    this.followVcas(0, false);
    this.evaluateAutomation();
    this.planSnapshots(now, 0, true);
    this.effectsDirty = true;
    this.refreshEffects();
    this._dirty();
  }

  /** A bus's state at its authored values, every script value and monitor control at rest. */
  private newState(b: BusSettings, slot: number, now: number): BusState {
    const st: BusState = {
      settings: b, slot,
      fader: this.ramp(b.volume, b.volume, now, 0), vca: this.ramp(1, 1, now, 0), authored: this.ramp(b.volume, b.volume, now, 0), authoredMute: b.mute,
      runtime: this.ramp(1, 1, now, 0), mute: false, solo: false,
      snapshot: this.ramp(1, 1, now, 0), lp: this.ramp(OFF_HZ, OFF_HZ, now, 0),
      monitorMute: false, monitorSolo: false,
      dip: this.ramp(1, 1, now, 0),
      duck: 1, voices: 0, peak: 0, autoGain: 1, autoLp: OFF_HZ, viewGain: 1, effects: b.effects, sends: NO_SENDS,
      // Read through the state's name, so a live rename keeps the object a script holds.
      loudness: new LoudnessView(() => this.loudnessSource?.busLoudness(st.settings.name) ?? null),
    };
    return st;
  }

  /** The backends' view of the mix (`coreSectionOf`), with the engine settings (the backend selector, K3, reads `backend` from it). */
  get audioSettings(): AudioSettings { return this.settings; }
  /** ADR 0344: the mix model the mixer runs (`audio.json`'s, with the live edits made since the last configure). */
  get audioProject(): AudioProject { return this.project; }
  get busNames(): readonly string[] { return this.order; }
  /** ADR 0344: the returns' names (buses of the view after the project's buses, so `busNames` lists them too; `Audio.bus(name)` reaches them). */
  get returnNames(): readonly string[] { return this.order.filter((n) => this.returnSet.has(n)); }
  /** @internal Any bus or return muted by the project (authored) or a script (runtime); allocation-free (the loudness target is suspended while one is). */
  anyMuted(): boolean {
    for (const s of this.buses.values()) if (s.authoredMute || s.mute) return true;
    return false;
  }
  /** The snapshot game code started last that is still on (`Audio.snapshot(name, fade)`'s), or null. */
  get currentSnapshot(): string | null { return this.player.latestCode(); }
  get snapshotNames(): string[] { return this.project.snapshots.map((s) => s.name); }
  /** Q21: the unknown parameter labels already warned about (`setParameter`), one warning each. */
  private readonly warnedLabels = new Set<string>();

  /** The heard clock ramps are evaluated on: the registered clock, else the mixer's own (`update`'s `dt` summed). */
  get time(): number {
    if (!this.clock) return this.ownTime;
    const t = this.clock();
    return Number.isFinite(t) ? t : this.ownTime;
  }
  /**
   * Evaluate ramps on `clock` (the backend's heard clock, `Audio.time`'s base), or on the mixer's own `dt` clock with
   * null. Ramps keep their records: a running fade continues from where it reads on the new clock. `stamp` (with a
   * clock) gives the heard time a ramp written now starts at on the backend: a ramp with a length starts there, so a
   * getter during a fade reads the value being heard (the core starts it at its stamp, not at the call).
   */
  setClock(clock: MixerClock | null, stamp: MixerClock | null = null): void {
    this.stampClock = clock ? stamp : null;
    const now = this.time;
    // Re-anchor every running ramp so it keeps its remaining length on the new clock.
    const next = clock ? clock() : this.ownTime;
    const at = Number.isFinite(next) ? next : now;
    for (const s of [...this.buses.values(), ...this.tombstones.values()]) for (const r of [s.fader, s.vca, s.authored, s.runtime, s.snapshot, s.lp, s.dip]) rebase(r, now, at);
    this.clock = clock;
    this.lastUpdate = at;
    if (!clock) this.ownTime = at;
    // The snapshot player's times move with the clock, keeping every fade's remaining length.
    if (at !== now) {
      this.player.shift(at - now);
      if (this.segmentEnd !== Number.POSITIVE_INFINITY) this.segmentEnd += at - now;
    }
  }

  /** Register (or with null, remove) where `Bus.loudness` reads from: the loudness hub (Ld4). */
  setLoudnessSource(source: LoudnessSource | null): void { this.loudnessSource = source; }

  /**
   * @internal Dp1 (ADR 0172 §1.1): the core computes presence ducks; `source` reads its duck lane per bus (STATUS's
   * `busDuck`). While set, main stops computing presence ducks and every duck read (`Bus.duckGain`, `resolve`, the lanes)
   * is the source's; null (the Babylon fallback) computes them on main again, from 1.
   */
  _setDuckSource(source: DuckSource | null): void {
    if (source === this.duckSource) return;
    this.duckSource = source;
    for (const s of this.buses.values()) s.duck = 1;
    this._dirty();
  }
  /** @internal The duck lane of bus `name` (state `s`): the source's, else main's. */
  _duckOf(name: string, s: BusState): number {
    if (!this.duckSource) return s.duck;
    const g = this.duckSource(name);
    return Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1;
  }

  /** @internal Register what `apply` delegates to: the backend (K0 wires it). */
  _setOpTarget(target: MixOpTarget | null): void { this.opTarget = target; }

  /** @internal Rc3: where the setters report a lane ramp, a snapshot and a monitor change (null: nowhere, the default). */
  _setTap(tap: MixerTap | null): void { this.tap = tap; }

  /**
   * Apply an edit while the project plays (§6): the editor's and the Studio's live path. Unlike `configure` it keeps
   * every script value. The pipeline (ADR 0175), in order: no target answers `noLiveBackend` (the edit is saved and
   * applies at the next Play); an op `opRefusal` (or, for the mix model's own ops, `projectOpRefusal`) refuses answers
   * `{ ok: false, class: "none" }`; one that changes nothing `{ ok: true, class: "none" }`; one past a capability rule
   * of the target (`liveRuleAnswer`) is kept for the next Play; anything else goes to the target's `sendOp`, which
   * changes this model through `_applyLive` (authored values, rules, snapshots; runtime state stays) and sends what
   * moved (Ma1, `core/liveMix.ts`). A sent op the target can't run (`unsupportedAnswer`: a level ducking rule on the
   * fallback) is kept in the model and answers its reason.
   *
   * ADR 0344: a project op (`projectOps.ts`: returns, VCAs, mute, sends, snapshot edits) changes the mix model here; what
   * it changes of the backends' view goes to the target as the old ops (`diffOps`), each through the steps above; what
   * runs on main (VCA and return lanes, snapshots, live effects) follows at once. It answers the first refusal or
   * next-Play answer of those ops, else `{ ok: true }` with the strongest class sent (`direct` when none was).
   */
  apply(op: MixOp): ApplyResult {
    const target = this.opTarget;
    if (!target) return { ok: false, class: "none", reason: "noLiveBackend" };
    if (isProjectOp(op)) return this.applyProject(target, op);
    return this.applyOld(target, op);
  }

  private applyOld(target: MixOpTarget, op: MixOp): ApplyResult {
    const before = this.settings;
    if (opRefusal(before, op) !== null) return this.notSent(target, { ok: false, class: "none" });
    // ADR 0344/0345: the old shared-reverb send effect is retired; a bus sends into a return (`setSend`).
    if (op.op === "addEffect" && op.effect?.type === "reverb") return this.notSent(target, { ok: false, class: "none" });
    const cls = opClass(op, before);
    if (cls === "none") return { ok: true, class: "none" };
    const later = liveRuleAnswer(before, op, target.liveCaps);
    if (later !== null) return this.notSent(target, { ok: false, class: cls, reason: later });
    const r = target.sendOp(op, cls);
    const unsupported = r.ok && r.class !== "none" ? unsupportedAnswer(op, target.liveCaps) : null;
    return unsupported === null ? r : { ok: false, class: r.class, reason: unsupported };
  }

  private applyProject(target: MixOpTarget, op: ProjectMixOp): ApplyResult {
    const before = this.project;
    if (projectOpRefusal(before, op) !== null) return this.notSent(target, { ok: false, class: "none" });
    const next = applyOpToProject(before, op);
    if (next === before) return { ok: true, class: "none" };
    if (op.op === "setOcclusionCurves") {
      // ADR 0362 item 6: an engine setting the occlusion pass reads from these settings every frame; nothing to send.
      this.project = next;
      const { curves: _drop, ...occ } = this.settings.occlusion;
      const curves = next.settings.occlusion.curves;
      this.settings = { ...this.settings, occlusion: curves ? { ...occ, curves } : occ };
      this._dirty();
      return { ok: true, class: "config" };
    }
    // A send past the core's sends a bus (`sendsPerBus`): kept for the next Play, as an effect past its chain's limit.
    const later = liveRuleAnswer(this.settings, op, target.liveCaps);
    if (later !== null) return this.notSent(target, { ok: false, class: "direct", reason: later });
    let answer: ApplyResult | null = null;
    let strongest: OpClass = "direct";
    const rank: Readonly<Record<OpClass, number>> = { none: 0, direct: 1, smoothed: 2, config: 3, dip: 4 };
    const send = (sub: MixOp) => {
      const r = this.applyOld(target, sub);
      if (!r.ok && answer === null) answer = r;
      if (r.class !== "none" && rank[r.class] > rank[strongest]) strongest = r.class;
    };
    this.lifting = false;
    try {
      // A renamed return keeps its slot and state (the old op `renameBus`), as a renamed bus does.
      if (op.op === "setReturn" && op.ret !== null && op.from !== undefined && op.from !== op.name && this.buses.has(op.from)) send({ op: "renameBus", from: op.from, to: op.name });
      const view = coreSectionOf(next);
      // The view lists the returns after the buses; a bus added live went to the end of this mixer's list. Compared in
      // this mixer's order (the slots don't care), so a bus added after a return isn't taken for a move (removed and
      // added again).
      const at = new Map(this.settings.buses.map((b, i) => [b.name, i]));
      const ordered = view.buses.map((b, i) => ({ b, k: i === 0 ? -1 : (at.get(b.name) ?? this.settings.buses.length + i) })).sort((x, y) => x.k - y.k).map((x) => x.b);
      for (const sub of diffOps(this.settings, { ...this.settings, ...view, buses: ordered, mix: this.settings.mix }).ops) send(sub);
    } finally {
      this.lifting = true;
    }
    this.setProject(next, op.op === "setSnapshotDef" && op.from !== undefined ? new Map([[op.from, op.name]]) : undefined);
    return answer ?? { ok: true, class: strongest };
  }

  private notSent(target: MixOpTarget, r: ApplyResult): ApplyResult {
    target.notSent?.(r);
    return r;
  }

  /**
   * @internal Ma1 (§6.2, architecture §4.7): the main-side half of a live op the backend accepted. The settings become
   * `applyOpToSettings`' result, except that an added bus goes to the end of the list, with `slot` (the slot the session
   * slot table gave it; the core path) or, with none (the Babylon fallback), the next slot past every one in use. A
   * bus's list index is not its slot once a bus is removed or added into a recycled slot: consumers read `BusLanes.slot`
   * or the slot table (§4.7). A removed bus and its descendants leave the model at once; with `keepTombstones` (the core
   * path's structural dip, §3.3) their state is held by slot until the slot recycles (`_tombstoneLanes`). Authored
   * volume ramps over `DRAG_RAMP_MS`, asap; authored mute toggles; an edit of an active snapshot retargets its lane
   * over `SNAPSHOT_EDIT_MS`; a rename keeps the bus's state and aliases the old name. Every runtime value (script volume, fades, mutes, solo, monitor controls, the snapshots in force) stays.
   * The mix model follows (ADR 0344): the op is written into it (`mergeLegacyIntoProject` over the backends' view).
   * Returns false when the op is refused or changes nothing.
   */
  _applyLive(op: MixOp, slot = -1, keepTombstones = false): boolean {
    const before = this.settings;
    const next = applyOpToSettings(before, op.op === "addBus" ? { op: "addBus", name: op.name, parent: op.parent } : op);
    if (next === before) return false;
    const now = this.time;
    if (op.op === "renameBus") this.renameState(op.from, op.to.trim());
    this.settings = next;
    for (const b of next.buses) {
      const s = this.buses.get(b.name);
      if (s) s.settings = b;
    }
    switch (op.op) {
      case "addBus": {
        const b = next.buses[next.buses.length - 1]!;
        // No slot given (the Babylon fallback has no slot table): the next one past every slot in use, so a bus added after a removal never shares one.
        let free = 0;
        for (const s of this.buses.values()) free = Math.max(free, s.slot + 1);
        for (const t of this.tombstones.keys()) free = Math.max(free, t + 1);
        const at = slot >= 0 ? slot : free;
        // A slot the table recycled: the tombstone held for it goes (the new bus is a new state, R9).
        this.tombstones.delete(at);
        this.buses.set(b.name, this.newState(b, at, now));
        this.order.push(b.name);
        this.aliases.delete(b.name);
        break;
      }
      case "removeBus": {
        // The bus and its descendants leave the model: `resolveAll`, `busNames` and `debug` stop listing them. Every other
        // bus keeps its state object, so script volumes, fades in flight, mutes, solo and voice counts carry on untouched.
        const kept = new Set(next.buses.map((b) => b.name));
        for (const name of this.order) {
          if (kept.has(name)) continue;
          const s = this.buses.get(name);
          if (keepTombstones && s) this.tombstones.set(s.slot, s);
          this.buses.delete(name);
        }
        this.order = this.order.filter((n) => kept.has(n));
        for (const [old, target] of this.aliases) if (!kept.has(target)) this.aliases.delete(old);
        break;
      }
      case "setBus": {
        const s = this.buses.get(op.bus);
        if (!s) break;
        if (op.key === "volume") this.setFader(op.bus, s, s.settings.volume, DRAG_RAMP_MS / 1000, false);
        else if (op.key === "mute") { s.authoredMute = s.settings.mute; this.effectsDirty = true; this.tap?.busRamp(op.bus, Lane.authored, 0, s.authoredMute ? 0 : s.authored.to); }
        break;
      }
      default:
        break;
    }
    if (this.lifting) this.setProject(this.lift(op, next), op.op === "renameSnapshot" ? this.snapshotRename(before, op.index, next) : undefined);
    else this.effectsDirty = true;
    this._dirty();
    return true;
  }

  /** The renamed snapshot of a `renameSnapshot` op (old → new). */
  private snapshotRename(before: AudioSettings, index: number, next: AudioSettings): Map<string, string> | undefined {
    const from = before.snapshots[index]?.name, to = next.snapshots[index]?.name;
    return from !== undefined && to !== undefined ? new Map([[from, to]]) : undefined;
  }

  /** ADR 0344: the mix model after an old op changed the backends' view to `next`. A fader or a mute is written directly; the rest merges the view back. */
  private lift(op: MixOp, next: AudioSettings): AudioProject {
    const p = this.project;
    if (op.op === "setBus" && (op.key === "volume" || op.key === "mute")) {
      const bus = next.buses.find((b) => b.name === op.bus);
      const value = bus && (op.key === "volume" ? { volumeDb: levelDbOf(bus.volume) } : { mute: bus.mute });
      // A return is a bus of the view (ADR 0344): its fader and mute are the return's.
      if (value && this.returnSet.has(op.bus)) return { ...p, returns: p.returns.map((r) => (r.name === op.bus ? { ...r, ...value } : r)) };
      if (value) return { ...p, buses: p.buses.map((b) => (b.name === op.bus ? { ...b, ...value } : b)) };
    }
    // A rename keeps the snapshot's trigger, fades and overrides (the old shape knows only its name and levels).
    if (op.op === "renameSnapshot") {
      const was = p.snapshots.find((x) => !next.snapshots.some((n) => n.name === x.name));
      const to = next.snapshots[op.index]?.name;
      if (was && to !== undefined) return applyOpToProject(p, { op: "setSnapshotDef", name: to, snapshot: { ...was, name: to }, from: was.name });
    }
    return { ...mergeLegacyIntoProject(p, next), settings: p.settings };
  }

  /**
   * ADR 0344: the mix model became `next` (a live op): the VCA lanes, authored mutes, the view's sends, snapshots and
   * the main thread's automation follow, keeping every runtime value (a return's level, output and inserts are its
   * bus's in the view, which the old ops moved). A changed snapshot definition retargets its lanes over `SNAPSHOT_EDIT_MS`.
   */
  private setProject(next: AudioProject, renames?: ReadonlyMap<string, string>): void {
    const now = this.time;
    this.project = next;
    this.returnSet = new Set(sectionReturnsOf(next).map((r) => r.name));
    for (const o of [...next.buses, ...next.returns]) {
      const s = this.buses.get(o.name);
      if (s && s.authoredMute !== o.mute) s.authoredMute = o.mute;
    }
    // The view's sends (`BusSettings.sends`): the old ops don't carry them (the project op `setSend` does).
    let buses: BusSettings[] | null = null;
    this.settings.buses.forEach((b, i) => {
      const pb = next.buses.find((x) => x.name === b.name);
      const sends = pb ? pb.sends.filter((x) => this.returnSet.has(x.to)).map((x) => ({ to: x.to, level: sendLevelOf(x.levelDb) })) : [];
      if (JSON.stringify(sends) === JSON.stringify(b.sends ?? [])) return;
      const { sends: _drop, ...rest } = b;
      const nb: BusSettings = sends.length > 0 ? { ...rest, sends } : rest;
      (buses ??= [...this.settings.buses])[i] = nb;
      const s = this.buses.get(b.name);
      if (s) s.settings = nb;
    });
    if (buses) this.settings = { ...this.settings, buses };
    this.followVcas(DRAG_RAMP_MS / 1000, false);
    this.player.setSnapshots(next.snapshots, next.parameters, now, renames);
    this.evaluateAutomation();
    this.planSnapshots(now, SNAPSHOT_EDIT_MS / 1000, true);
    this.effectsDirty = true;
    this.refreshEffects();
    this._dirty();
  }

  /** The fader lane of `name` to `to`; the wire's `authored` lane (fader x VCA) follows. */
  private setFader(name: string, s: BusState, to: number, seconds: number, stamped: boolean): void {
    if (this.retarget(s.fader, to, seconds, stamped)) this.followAuthored(name, s, seconds, stamped);
  }

  /** Every bus's VCA lane to its VCAs' sum (`vcaOffsetDb`); the wire's `authored` lane follows. */
  private followVcas(seconds: number, stamped: boolean): void {
    for (const [name, s] of this.buses) {
      const to = Math.min(MAX_LANE_GAIN, dbToGain(vcaOffsetDb(this.project, name)));
      if (this.retarget(s.vca, to, seconds, stamped)) this.followAuthored(name, s, seconds, stamped);
    }
  }

  /** The wire's `authored` lane: fader x VCA, ramped as the lane that moved. */
  private followAuthored(name: string, s: BusState, seconds: number, stamped: boolean): void {
    this.lane(name, Lane.authored, s.authored, Math.min(MAX_LANE_GAIN, s.fader.to * s.vca.to), seconds, stamped);
  }

  /** Ma1: a live rename moves the state (voices, ramps, script values, the loudness object) to the new name. */
  private renameState(from: string, to: string): void {
    const s = this.buses.get(from);
    if (!s || from === to) return;
    this.buses.delete(from);
    this.buses.set(to, s);
    this.order = this.order.map((n) => (n === from ? to : n));
    this.aliases.delete(to);
    for (const [old, target] of this.aliases) if (target === from) this.aliases.set(old, to);
    this.aliases.set(from, to);
  }

  /** @internal The name a bus is known by now: itself, or where a live rename took it (`aliases`; one warning per old name). */
  _currentName(name: string): string {
    if (this.buses.has(name)) return name;
    const to = this.aliases.get(name);
    if (to === undefined || !this.buses.has(to)) return name;
    if (!this.warned.has(`alias:${name}`)) {
      this.warned.add(`alias:${name}`);
      console.warn(`[myco] audio bus "${name}" was renamed to "${to}" while playing; "${name}" reaches it until the next Play.`);
    }
    return to;
  }

  /** §6.6: a mixer view's monitor mute and solo for `bus` (the `monitor` lane), never saved, never through `apply`. */
  setMonitor(bus: string, controls: MonitorControls): void {
    const s = this.buses.get(bus);
    if (!s) return;
    let moved = false;
    if (controls.mute !== undefined && s.monitorMute !== controls.mute) { s.monitorMute = controls.mute; moved = true; }
    if (controls.solo !== undefined && s.monitorSolo !== controls.solo) { s.monitorSolo = controls.solo; moved = true; }
    if (!moved) return;
    this._dirty(true);
    if (this.tap !== null) {
      // Slots 0..15 of each mask (a bus past slot 15 is not representable in one u32 carrying both).
      let muted = 0, soloed = 0;
      for (const b of this.buses.values()) {
        if (b.slot >= 16) continue;
        if (b.monitorMute) muted |= 1 << b.slot;
        if (b.monitorSolo) soloed |= 1 << b.slot;
      }
      this.tap.monitor(muted, soloed);
    }
  }
  /** @internal Rc3: a script mute toggled; the runtime lane's target is 0 (muted) or the script's volume. */
  _noteMute(name: string): void {
    const s = this.buses.get(name);
    if (s && this.tap !== null) this.tap.busRamp(name, Lane.runtime, 0, s.mute ? 0 : s.runtime.to);
  }
  /** Whether any monitor control is on (meters are tainted, targets suspended, §1.1). */
  get monitorActive(): boolean { for (const s of this.buses.values()) if (s.monitorMute || s.monitorSolo) return true; return false; }

  /** @internal A bus's or return's state, through a live rename's alias. */
  _state(name: string): BusState | undefined { return this.buses.get(name) ?? this.buses.get(this._currentName(name)); }
  /** @internal The main-side lanes of bus `name`, for the lane writer (Mx2). */
  _lanes(name: string): BusLanes | undefined {
    const s = this.buses.get(name);
    return s ? this.lanesOf(s, name) : undefined;
  }
  private lanesOf(s: BusState, name: string): BusLanes {
    return {
      slot: s.slot, authored: s.authored, authoredMute: s.authoredMute, runtime: s.runtime, runtimeMute: s.mute, runtimeSolo: s.solo,
      snapshot: s.snapshot, snapshotLowpass: s.lp, monitorMute: s.monitorMute, monitorSolo: s.monitorSolo, dip: s.dip, duck: this._duckOf(name, s),
    };
  }
  /** @internal One lane's gain for a bus or return at the heard clock (`automation`: main's Babylon-fallback estimate times the core's view). */
  laneGain(name: string, lane: LaneId): number {
    const s = this.buses.get(name);
    if (!s) return 0;
    const now = this.time;
    switch (lane) {
      case Lane.authored: return s.authoredMute ? 0 : rampAt(s.fader, now);
      case Lane.vca: return rampAt(s.vca, now);
      case Lane.runtime: return s.mute ? 0 : rampAt(s.runtime, now);
      case Lane.snapshot: return rampAt(s.snapshot, now);
      case Lane.monitor: return s.monitorMute || (this.anySolo() && !this.audibleUnderSolo(name)) ? 0 : 1;
      case Lane.dip: return rampAt(s.dip, now);
      case Lane.duck: return this._duckOf(name, s);
      default: return s.autoGain * s.viewGain;
    }
  }
  /**
   * @internal G7c: the lanes of each removed bus whose slot is still a tombstone (`_applyLive`'s `keepTombstones`), by
   * slot: the lane writer's replay sends their dip lane (§3.4: a dip at its end state).
   */
  _tombstoneLanes(): BusLanes[] {
    const out: BusLanes[] = [];
    for (const s of this.tombstones.values()) out.push(this.lanesOf(s, s.settings.name));
    return out.sort((a, b) => a.slot - b.slot);
  }
  /** @internal G7c (R9): the slot table freed `slots`; the tombstones held for them go. */
  _releaseTombstones(slots: readonly number[]): void {
    for (const s of slots) this.tombstones.delete(s);
  }
  /** @internal The structural dip (§6.5, the slot table's): ease `name`'s dip lane to `to` over `seconds`. */
  _setDip(name: string, to: number, seconds: number): void {
    const s = this.buses.get(name);
    if (s) this.lane(name, Lane.dip, s.dip, Math.min(1, Math.max(0, to)), seconds);
  }
  /** @internal `effects`: the live effects may have moved too (a mute, a solo, a return's lane). */
  _dirty(effects = false): void {
    this.changed = true;
    if (effects) this.effectsDirty = true;
  }
  /** @internal A2.3: the backend reports a bus's peak. */
  _setPeak(name: string, peak: number): void { const s = this.buses.get(name); if (s) s.peak = peak; }
  /**
   * @internal ADR 0158: bus automation computed on main, used only where the backend can't run it itself (the
   * TypeScript evaluator on the Babylon fallback). The core applies BUS_AUTOMATE in the audio thread and never calls this.
   */
  _setAutomation(name: string, gain: number, lowpass: number): void {
    const s = this.buses.get(name);
    if (!s || (s.autoGain === gain && s.autoLp === lowpass)) return;
    s.autoGain = gain;
    s.autoLp = lowpass;
    this._dirty();
  }
  /**
   * @internal ADR 0158 §3 (M2 F2): bus automation the core applies in the audio thread, as main estimates it. It only
   * shows in `Bus.effectiveGain` (multiplied with snapshots, ducking and parents); `resolve` leaves it out, since the
   * core applies it itself and a backend must not apply it twice. No change notification: nothing is re-applied.
   */
  _setAutomationView(name: string, gain: number): void {
    const s = this.buses.get(name);
    if (s) s.viewGain = gain;
  }
  /** @internal The view gains of `name` and its ancestors, multiplied. */
  _viewChain(name: string): number {
    let g = 1;
    for (const n of this.chain(name)) g *= this.stateOf(n)?.viewGain ?? 1;
    return g;
  }
  /** @internal A2.3: the core backend resets a bus's live-voice count to the core mirror's (after a bus remap, which reconfigures the mixer and zeroes counts). */
  _setVoiceCount(name: string, n: number): void { const s = this.buses.get(name); if (s) s.voices = Math.max(0, n | 0); }
  /** @internal ADR 0344: bus `name`'s live effects (`ResolvedBus.effects`), for the core's `BUS_SLOT`; undefined for an unknown bus. */
  _busEffects(name: string): readonly BusEffect[] | undefined {
    this.refreshEffects();
    return this.buses.get(name)?.effects;
  }
  /**
   * @internal ADR 0344 (ABI 4.7): bus `name`'s live sends, for the core's `BUS_SENDS`: each send into a return the view
   * holds, at its level plus its automation, muted while the bus is muted. An unchanged list keeps its object; empty for a
   * bus without sends, undefined for an unknown bus.
   */
  _busSends(name: string): readonly LiveBusSend[] | undefined {
    this.refreshEffects();
    return this.buses.get(name)?.sends;
  }

  bus(name: string = MASTER): Bus {
    if (!this.buses.has(name) && !this.buses.has(this._currentName(name)) && !this.warned.has(name)) {
      this.warned.add(name);
      console.warn(`[myco] unknown audio bus "${name}". Buses: ${this.order.join(", ")}.`);
    }
    return new Bus(this, name);
  }
  /** Whether the project has a bus with this name (a sound can play on it; a return can't: it is fed by sends only). */
  has(name: string): boolean { return this.buses.has(name) && !this.returnSet.has(name); }
  /** The bus a sound with this output plays on: itself, else the root (with a warning; a return, which plays no sounds, silently). */
  resolveOutput(name: string | undefined): string {
    if (!name) return this.order[0] ?? MASTER;
    if (this.returnSet.has(name)) return this.order[0] ?? MASTER;
    if (this.buses.has(name)) return name;
    const renamed = this._currentName(name);
    if (renamed !== name) return renamed;
    this.bus(name); // warns once
    return this.order[0] ?? MASTER;
  }

  /** @internal Backends call these as sounds start and end, which is what ducking listens to. */
  voiceStarted(name: string): void { const s = this.buses.get(name); if (s) s.voices++; }
  voiceEnded(name: string): void { this.voicesEnded++; const s = this.buses.get(name); if (s && s.voices > 0) s.voices--; }
  /** @internal Voices that have ended (or left a bus) since the page began, whichever backend counted them: the event runtime retires instances when this moves, instead of scanning every frame (ADR 0158 §6). */
  voicesEnded = 0;

  // --- snapshots (ADR 0344) ------------------------------------------------------------------------------------------

  private knownSnapshot(name: string): boolean {
    if (this.project.snapshots.some((s) => s.name === name)) return true;
    console.warn(`[myco] unknown audio snapshot "${name}". Snapshots: ${this.snapshotNames.join(", ") || "none"}.`);
    return false;
  }

  /**
   * The shorthand (`Audio.snapshot(name, fade)`): fade to snapshot `name` over `seconds` (0 = at once, over
   * `BUS_MIN_RAMP_MS` in the core), fading out the other snapshots game code started over the same time. `base` and
   * conditions snapshots stay as their rules say.
   */
  snapshot(name: string, seconds = 0.5): void {
    if (!this.knownSnapshot(name)) return;
    const now = this.time;
    this.player.stopCode(now, seconds, name);
    this.player.start(name, now, seconds, true);
    this.tap?.snapshot(name, seconds);
    this.planSnapshots(now, 0, true);
  }
  /** The shorthand (`Audio.clearSnapshot(fade)`): fade out every snapshot game code started, over `seconds`. */
  clearSnapshot(seconds = 0.5): void {
    const now = this.time;
    this.player.stopCode(now, seconds);
    this.tap?.snapshot(null, seconds);
    this.planSnapshots(now, 0, true);
  }
  /** `Audio.snapshot(name).start()`: start `name` over its own fade in (or `seconds`); others stay on. Returns whether it changed. */
  startSnapshot(name: string, seconds?: number): boolean {
    if (!this.knownSnapshot(name)) return false;
    const now = this.time;
    const changed = this.player.start(name, now, seconds, true);
    if (changed) {
      this.tap?.snapshot(name, seconds ?? (this.project.snapshots.find((s) => s.name === name)!.fadeInMs / 1000));
      this.planSnapshots(now, 0, true);
    }
    return changed;
  }
  /** `Audio.snapshot(name).stop()`: fade `name` out over its own fade out (or `seconds`), once its hold is over. A `base` snapshot can't stop. */
  stopSnapshot(name: string, seconds?: number): boolean {
    if (!this.knownSnapshot(name)) return false;
    const now = this.time;
    const changed = this.player.stop(name, now, seconds);
    if (changed) this.planSnapshots(now, 0, true);
    return changed;
  }
  /** Whether snapshot `name` is on now (fading in, on, held or fading out). */
  snapshotActive(name: string): boolean { return this.player.isActive(name, this.time); }

  /**
   * ADR 0344: a global parameter changed (`Audio.setParameter`; labels by name or index): the conditions snapshots that
   * read it start or stop, and the automation the main thread runs (send levels, effect parameters, a return's level)
   * follows.
   */
  setParameter(name: string, value: number | string): void {
    const def = this.project.parameters.find((p) => p.name === name);
    if (!def) return;
    const v = typeof value === "number" ? value : valueOf(def, value);
    if (typeof value === "string" && !Number.isFinite(v)) {
      // Q21 (ADR 0386): an unknown label is ignored, with one warning per parameter and label.
      const key = `${name}\u0000${value}`;
      if (!this.warnedLabels.has(key)) {
        this.warnedLabels.add(key);
        const labels = isLabelled(def) ? def.labels.map((l) => `"${l}"`).join(", ") : "none (it takes a number)";
        console.warn(`[myco] audio parameter "${name}" has no label "${value}"; ignored. Labels: ${labels}.`);
      }
      return;
    }
    if (!Number.isFinite(v)) return;
    const now = this.time;
    if (this.player.setParameter(name, value, now)) this.planSnapshots(now, 0, true);
    if (this.paramValues[name] !== v) {
      this.paramValues[name] = v;
      if (this.project.automation.some((a) => a.parameter === name || a.by?.input === name)) {
        this.evaluateAutomation();
        this.effectsDirty = true;
        this._dirty();
      }
    }
  }

  /**
   * The snapshot lanes from the blend: each bus's and return's lane heads for the blend's value at the end of the
   * current segment (the next break of a weight ramp, at most `SNAPSHOT_SEGMENT_MS` away), linear in gain over it, so
   * the fade is linear in dB to within a segment. `minSeconds` stretches a step (a definition edit's `SNAPSHOT_EDIT_MS`).
   * Carrier low-pass overrides ride the lane's low-pass (the migration's carriers, ADR 0344); other effect overrides go
   * to the live effects.
   */
  private planSnapshots(now: number, minSeconds: number, force: boolean, fromBlend = false): void {
    if (!force && now < this.segmentEnd) return;
    this.player.prune(now);
    const brk = this.player.nextBreak(now);
    const end = brk === Number.POSITIVE_INFINITY ? now : Math.min(brk, now + SNAPSHOT_SEGMENT_MS / 1000);
    this.segmentEnd = brk === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : end;
    const seconds = Math.max(end - now, minSeconds);
    const base = (owner: string, id: string, p: string) => this.baseParam(owner, id, p);
    const mix = this.player.resolveAt(end, base);
    // A segment that ended between two frames: main's estimate of the next one starts from the blend now, not from
    // where the last segment stopped (the core ramps from wherever its lane is; only main's getters read `from`).
    const at = fromBlend && seconds > 0 ? this.player.resolveAt(now, base) : null;
    const gainOf = (db: number) => (db <= MIN_DB ? 0 : Math.min(MAX_LANE_GAIN, dbToGain(db)));
    // ABI 4.8: the gain lane is one ramp linear in dB to the fade's next break (the core's `Decibel` law), not a
    // segment: re-planning on the way finds it already heading there.
    const gEnd = brk === Number.POSITIVE_INFINITY ? end : brk;
    const gSeconds = Math.max(gEnd - now, minSeconds);
    // At the break, or just before it where the blend steps there (a fade out of 0 s at a hold's end): the next plan
    // writes that step.
    const gAt = brk === Number.POSITIVE_INFINITY ? mix : this.player.resolveAt(gEnd, base);
    const gBefore = brk === Number.POSITIVE_INFINITY ? mix : this.player.resolveAt(gEnd - BREAK_EPSILON, base);
    const write = (name: string, s: BusState) => {
      // A lane already heading for its value keeps its ramp (an edit of a snapshot not in force moves nothing).
      const atBreak = gainOf(gAt.levels[name] ?? 0), before = gainOf(gBefore.levels[name] ?? 0);
      const g = Math.abs(atBreak - before) < 1e-6 ? atBreak : before;
      if (s.snapshot.to !== g) this.lane(name, Lane.snapshot, s.snapshot, g, gSeconds, true, "db");
      const hz = this.carrierCutoff(name, mix.effects[name]);
      if (s.lp.to !== hz) this.retarget(s.lp, hz, seconds);
      if (at && s.snapshot.start === now) s.snapshot.from = gainOf(at.levels[name] ?? 0);
      if (at && s.lp.start === now) s.lp.from = this.carrierCutoff(name, at.effects[name]);
    };
    for (const [name, s] of this.buses) write(name, s);
    this.overrides = mix.effects;
    this.effectsDirty = true;
    this._dirty();
  }

  /** The blend's effect-parameter values (owner → effect id → param), as of the current segment's end. */
  private overrides: EffectOverrides = {};

  /** The lowest cutoff the blend sets on `name`'s low-pass carriers, or `OFF_HZ`. */
  private carrierCutoff(name: string, byId: EffectOverrides[string] | undefined): number {
    if (!byId) return OFF_HZ;
    const owner = this.ownerOf(name);
    if (!owner) return OFF_HZ;
    let hz = OFF_HZ;
    for (const [id, ps] of Object.entries(byId)) {
      const cutoff = ps.cutoff?.value;
      if (cutoff === undefined) continue;
      const e = owner.effects.find((x) => x.id === id);
      if (e && isCarrier(this.project, name, e)) hz = Math.min(hz, Math.max(10, cutoff));
    }
    return hz;
  }

  private ownerOf(name: string): ProjectBus | Return | undefined {
    return this.project.buses.find((b) => b.name === name) ?? this.project.returns.find((r) => r.name === name);
  }

  /** An effect parameter's base value (what an override blends from): main's estimate of its automation, else the project's. */
  private baseParam(owner: string, id: string, p: string): number | undefined {
    const auto = this.autoFx.get(owner)?.get(id)?.get(p);
    if (auto !== undefined) return auto;
    const e = this.ownerOf(owner)?.effects.find((x) => x.id === id);
    return e ? effectParam(e, p) : undefined;
  }

  // --- main's estimate of the effect automation (ADR 0344) ----------------------------------------------------------

  /**
   * Main's estimate of each `fx:<id>:<param>` automation at the current parameter values (frequency parameters in log
   * scale), what a snapshot override of that parameter blends from. The core runs every automation target itself (ABI
   * 4.8: effect parameters, sends, levels; `coreSectionOf`'s `automation`), so nothing here reaches the sound but the
   * override's starting point.
   */
  private evaluateAutomation(): void {
    this.autoFx.clear();
    for (const a of this.project.automation) {
      if (a.bypass || !a.target.startsWith("fx:")) continue;
      const def = this.project.parameters.find((p) => p.name === a.parameter);
      if (!def) continue;
      const x = this.paramValues[a.parameter] ?? parameterDefault(def);
      const [, id, p] = a.target.split(":");
      if (!id || !p) continue;
      const e = this.ownerOf(a.on)?.effects.find((x2) => x2.id === id);
      if (!e) continue;
      const byId = this.autoFx.get(a.on) ?? new Map<string, Map<string, number>>();
      const ps = byId.get(id) ?? new Map<string, number>();
      const ev = FREQUENCY_PARAMS.has(p) ? evalLogCurve : evalCurve;
      // ADR 0362 §5: a second parameter the lane also follows.
      const second = a.by ? this.project.parameters.find((q) => q.name === a.by!.input) : undefined;
      ps.set(p, a.by && second ? evalCurveBy(a.curve, a.by, x, secondValueOf(second, this.paramValues[second.name] ?? parameterDefault(second)), ev) : ev(a.curve, x));
      byId.set(id, ps);
      this.autoFx.set(a.on, byId);
    }
  }

  // --- live effects and sends (ADR 0344) -----------------------------------------------------------------------------

  /**
   * Each bus's (and return's) live effects: `audioSettings`' effects with, for an effect of the bus, the blend's
   * overrides (a catalogue effect also names them in `held`, so the core's automation of those parameters waits while the
   * override is in force, ABI 4.8); and its live sends (`_busSends`): each send of the view at its level, muted while the
   * bus is muted by the project, a script or a monitor control (a muted bus silences its sends, ADR 0344; the core ramps a
   * muted send to 0 and keeps its level; its automation runs in the core). An unchanged effect keeps its object, and an
   * unchanged send list its list, so a backend can compare by identity.
   */
  private refreshEffects(): void {
    if (!this.effectsDirty) return;
    this.effectsDirty = false;
    for (const [name, s] of this.buses) {
      s.sends = this.liveSends(name, s);
      const pb = this.ownerOf(name);
      const base = s.settings.effects;
      if (!pb) { s.effects = base; continue; }
      const shown = pb.effects.filter((e) => coreShown(this.project, name, e));
      let k = 0;
      let moved = false;
      const out = base.map((e): BusEffect => {
        if (e.type === "reverb") return e; // an old section's reverb send (the view never holds one)
        const ne = shown[k++];
        if (!ne) return e;
        const over = this.overrides[name]?.[ne.id];
        if (!over) return e;
        const params = { ...ne.params };
        for (const [p, v] of Object.entries(over)) params[p] = v.value;
        // The authored shape stays (a legacy filter or compressor stays legacy while an override moves it).
        const live: BusEffect = e.type === "fx" ? { ...e, params, held: Object.keys(over) } : toBusEffect({ ...ne, params }, []);
        if (JSON.stringify(live) === JSON.stringify(e)) return e;
        moved = true;
        return live;
      });
      const prev = s.effects;
      if (!moved) s.effects = base;
      else if (prev.length === out.length && prev.every((e, i) => JSON.stringify(e) === JSON.stringify(out[i]))) s.effects = prev;
      else s.effects = out;
    }
  }

  /** Bus `name`'s live sends (see `refreshEffects`); `s.sends` itself when nothing moved. */
  private liveSends(name: string, s: BusState): readonly LiveBusSend[] {
    const view = s.settings.sends;
    if (!view || view.length === 0) return NO_SENDS;
    const muted = s.authoredMute || s.mute || s.monitorMute;
    // The view's level: a send's automation (`send:<return>`, dB added) runs in the core (ABI 4.8).
    const out = view.map((v): LiveBusSend => ({ to: v.to, level: v.level, muted }));
    const prev = s.sends;
    return prev.length === out.length && prev.every((p, i) => p.to === out[i]!.to && p.level === out[i]!.level && p.muted === out[i]!.muted) ? prev : out;
  }

  /** @internal `Bus.volume` (`seconds` 0) and `Bus.fadeTo`: one ramp on the runtime lane, clamped to 0..2. */
  _setRuntime(name: string, v: number, seconds: number): void {
    const s = this.buses.get(name);
    if (s) this.lane(name, Lane.runtime, s.runtime, Math.min(2, Math.max(0, Number.isFinite(v) ? v : 0)), seconds);
  }

  /**
   * A new ramp on `r` from its value now to `to` over `seconds` (non-finite or <= 0: asap). Re-setting a settled lane to
   * its value writes nothing. `stamped` false (the authored lane's drag, Ma1): the ramp starts now, as the backend sends it asap.
   */
  private retarget(r: Ramp, to: number, seconds: number, stamped = true, law: RampLaw = "linear"): boolean {
    const now = this.time;
    const dur = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    // A ramp with a length starts where the backend stamps it (Dp1): from the lane's value there.
    let start = now;
    if (stamped && dur > 0 && this.clock && this.stampClock) {
      const at = this.stampClock();
      if (Number.isFinite(at) && at > now) start = at;
    }
    const from = rampAt(r, start);
    if (from === to && r.to === to) return false;
    r.from = from; r.to = to; r.start = start; r.seconds = dur; r.law = law; r.seq = ++this.seq;
    this._dirty();
    return true;
  }
  /** `retarget` on a lane main writes: when it wrote, the capture's tap hears the ramp (Rc3; one null check without a tap). */
  private lane(bus: string, lane: LaneId, r: Ramp, to: number, seconds: number, stamped = true, law: RampLaw = "linear"): void {
    if (this.retarget(r, to, seconds, stamped, law) && this.tap !== null) this.tap.busRamp(bus, lane, r.seconds, to);
  }
  private ramp(from: number, to: number, start: number, seconds: number): Ramp {
    return { from, to, start, seconds, law: "linear", seq: ++this.seq };
  }

  /** Advance the clock (when the mixer keeps its own), snapshots and ducking by `dt` seconds; tells listeners if anything moved. */
  update(dt: number): void {
    if (dt > 0 && !this.clock) this.ownTime += dt;
    const now = this.time;
    const prev = this.lastUpdate;
    const hdt = now - prev;
    this.lastUpdate = now;
    if (now >= this.segmentEnd) this.planSnapshots(now, 0, true, true);
    if (hdt > 0) {
      for (const s of this.buses.values()) {
        if (rampMoves(s.authored, prev, now) || rampMoves(s.vca, prev, now) || rampMoves(s.fader, prev, now) || rampMoves(s.runtime, prev, now) || rampMoves(s.snapshot, prev, now) || rampMoves(s.lp, prev, now) || rampMoves(s.dip, prev, now)) {
          this._dirty();
          break;
        }
      }
      if (this.duckSource) this.followDuckSource();
      else this.presenceDuck(hdt);
    }
    this.refreshEffects();
    if (this.changed) {
      this.changed = false;
      for (const l of this.listeners) l();
    }
  }

  /** Dp1: the core's duck lane moved (a new STATUS): listeners re-read the mix (selection's audibility uses it). */
  private followDuckSource(): void {
    for (const [name, s] of this.buses) {
      const g = this._duckOf(name, s);
      if (g !== s.duck) {
        s.duck = g;
        this._dirty();
      }
    }
  }

  /**
   * Presence ducking on main, the Babylon fallback's (on the core backend the core computes it, `_setDuckSource`): each bus heads for the
   * lowest multiplier any rule with a playing trigger asks for, easing `dt / attack` of the way as it deepens, or `dt / release`
   * (the longest of the rules it leaves) as it lifts, to a shallower rule's level or to none.
   */
  private presenceDuck(dt: number): void {
    const rules = this.settings.ducking.filter((r) => (r as { mode?: string }).mode !== "level");
    for (const [name, s] of this.buses) {
      let goal = 1, time = 0.5;
      for (const r of rules) {
        if (r.target !== name || (this.buses.get(r.trigger)?.voices ?? 0) === 0) continue;
        if (r.amount < goal) { goal = r.amount; time = r.attack; }
      }
      if (goal === 1) time = rules.filter((r) => r.target === name).reduce((m, r) => Math.max(m, r.release), 0);
      else if (goal > s.duck) {
        // Q20 (ADR 0386): the duck lifting to a shallower rule's level (a deeper trigger stopped) eases at the release of
        // the deeper rules it leaves, as the core's per-rule followers do; attack is only for a deepening duck.
        time = rules.filter((r) => r.target === name && r.amount < goal).reduce((m, r) => Math.max(m, r.release), 0);
      }
      if (s.duck !== goal) {
        const step = time > 0 ? Math.min(1, dt / time) : 1;
        const next = step >= 1 ? goal : s.duck + (goal - s.duck) * step;
        // The ease only nears its goal, and rounding stalls it a few ulps short: snap once the rest is inaudible.
        s.duck = Math.abs(goal - next) < DUCK_SETTLE ? goal : next;
        this._dirty();
      }
    }
  }

  /** Called after `update` when any bus changed (a backend re-applies the mix). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private stateOf(name: string): BusState | undefined { return this.buses.get(name); }
  private anySolo(): boolean { for (const s of this.buses.values()) if (s.solo || s.monitorSolo) return true; return false; }
  /** `name` and the buses above it to the root (a return's parent is its output). */
  private chain(name: string): string[] {
    const out: string[] = [];
    for (let n: string | undefined = name; n !== undefined && out.length < 64; n = this.buses.get(n)?.settings.parent) out.push(n);
    return out;
  }
  private soloed(n: string): boolean { const s = this.buses.get(n); return !!s && (s.solo || s.monitorSolo); }
  /** Whether solo state (script or monitor) lets `name` through (it's soloed, under a soloed bus, on the way to one, or a return: ADR 0344 keeps returns audible). */
  private audibleUnderSolo(name: string): boolean {
    if (this.returnSet.has(name)) return true;
    if (this.chain(name).some((n) => this.soloed(n))) return true;
    for (const other of this.buses.keys()) if (this.soloed(other) && this.chain(other).includes(name)) return true;
    // A return keeps its output chain audible.
    for (const r of this.returnSet) if (this.chain(r).includes(name)) return true;
    return false;
  }

  /** A bus's (or return's) resolved state, with its live effects. */
  resolve(name: string): ResolvedBus | null {
    const s = this.buses.get(name);
    if (!s) return null;
    this.refreshEffects();
    const now = this.time;
    const solo = this.anySolo();
    const gainOf = (n: string, st: BusState) =>
      st.authoredMute || st.mute || st.monitorMute || (solo && !this.audibleUnderSolo(n))
        ? 0
        : rampAt(st.fader, now) * rampAt(st.vca, now) * rampAt(st.runtime, now) * rampAt(st.snapshot, now) * rampAt(st.dip, now) * this._duckOf(n, st) * st.autoGain;
    let effective = 1;
    for (const n of this.chain(name)) effective *= gainOf(n, this.stateOf(n)!);
    const lp = Math.min(rampAt(s.lp, now), s.autoLp);
    return {
      name, parent: s.settings.parent ?? null, gain: gainOf(name, s), effectiveGain: effective,
      effects: s.effects, snapshotLowpass: lp < OFF_HZ ? lp : null,
    };
  }
  resolveAll(): ResolvedBus[] { return this.order.map((n) => this.resolve(n)!); }
}

/** Move `r`'s anchor from clock reading `now` to `at` (a clock swap), keeping its value and remaining length. */
function rebase(r: Ramp, now: number, at: number): void {
  const remaining = r.seconds > 0 ? Math.max(0, r.start + r.seconds - now) : 0;
  r.from = rampAt(r, now);
  r.start = at;
  r.seconds = remaining;
}

/** The one mixer: buses are a project setting, and the audio context is shared (ADR 0097). */
export const mixer = new Mixer();
