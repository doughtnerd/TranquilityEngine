/**
 * Beat-quantised automation (ADR 0350 feature 5): an automation lane, or an entry voice curve, keyed on a parameter with
 * `quantize` set moves only on the next beat, bar or n-beat boundary of the instance's musical clock.
 *
 * A quantised lane is never given to the core as a parameter binding (the core follows its parameter continuously).
 * When the parameter changes, the lane finds the next boundary on the musical clock (`MusicalSource.nextGrid`) and, once
 * that boundary is within the scheduling lookahead, reads the parameter and moves every voice under it with a 20 ms ramp
 * starting at the boundary. A change that arrives after the boundary's ramp was stamped moves the level at the following
 * boundary. With no musical clock the lane moves at once (the change is never lost; the Studio lints a quantised lane on
 * a playlist without a tempo). Voices that start later begin at the lane's level.
 *
 * How the ramp reaches the voice depends on the target:
 *
 * - **Gain-like** (`volume`, `enabled`, a gain effect's `gain`, an entry's `gain` curve): the voice's own stamped gain
 *   ramp (`AudioVoice.paramsShaped({ gain, at })`, the stem level the music runtime's quantised stems used, which
 *   multiplies the voice's volume): sample-exact on the core. The voice has one such ramp, shared by its gain lanes
 *   (their product).
 * - **Pitch, pan, low-pass and high-pass** (an entry curve of that target, or a lane of `pitch`, `pan` or a low-pass or
 *   high-pass effect's `cutoff`): the core has no stamped ramp of these, so each voice gets a core binding on its own
 *   voice time (ADR 0346) to a curve of its own (`PlaylistHost.leaseCurve`) that holds the lane's level and steps to
 *   the new one over 20 ms at the boundary, in voice seconds. The lane redefines the curve when it stamps a boundary,
 *   a lookahead before it; up to the boundary the new curve says what the old one did, so whenever the redefinition
 *   lands the voice hears the change at the boundary. The core evaluates bindings once per 128-frame quantum and ramps
 *   gain, pitch and pan across it (filters step per quantum), so these move within one quantum of the boundary
 *   (2.7 ms at 48 kHz), not to the sample. Levels are in the core's units: a pitch ratio, a pan, a cutoff in Hz.
 */
import { evalCurve, type Curve, type CurveKey } from "../../../../engine/core/curve";
import type { Quantize } from "../../../../engine/audio/playlist/types";
import { evalCurveBy, secondValueOf, type CurveBy } from "../../../../engine/audio/curveBy";
import { dbToGain, semitonesToRatio } from "../../../../engine/audio/decibels";
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { AutoTarget, MAX_BINDINGS, QUANTIZED_RAMP_SECONDS, TimeParam, timeParam, type Binding } from "../automation";
import { warnOnce } from "../core/handle";
import { playlistHost } from "./host";
import type { PVoice } from "./liveNode";
import type { MusicalSource } from "./musical";

/** How far ahead of a boundary its ramp is stamped (the playlist runtime's scheduling lookahead). */
const LOOKAHEAD = 0.25;
const EPS = 1e-9;
/** The most steps a voice's stepped curve keeps (two keys each; the core's curves hold 64 keys). */
const MAX_STEPS = 24;


/** What a quantised lane moves: the voice's gain, or one of the controls a voice binding drives. */
export type QuantTarget = "gain" | "pitch" | "pan" | "lowpass" | "highpass";

const CORE_TARGET: Record<Exclude<QuantTarget, "gain">, AutoTarget> = {
  pitch: AutoTarget.Pitch, pan: AutoTarget.Pan, lowpass: AutoTarget.Lowpass, highpass: AutoTarget.Highpass,
};

/** One stamped move of a lane: from `from` to `to` over the ramp, starting at heard `at`. */
interface Step { at: number; from: number; to: number }

/**
 * One quantised lane below a playlist level: a curve on a parameter (dB for gain, semitones for pitch, Hz for the
 * filters, −1..1 for pan) and the voices it applies to.
 */
export class QuantLane {
  /** The level applied now, in the target's core units (NaN until first read). */
  level = Number.NaN;
  /** The boundary whose ramp is stamped, heard seconds (NaN: none). */
  stampedAt = Number.NaN;
  /** A timer waits for this boundary (NaN: none). */
  waitingFor = Number.NaN;
  readonly voices = new Set<PVoice>();
  /** Bound targets: the moves still sounding (or ahead), oldest first, and the level before the first. */
  steps: Step[] = [];
  /**
   * `by` (ADR 0362 §5): a second parameter the lane also follows; a change of either moves the lane at the next
   * boundary. `pre` maps the lane's value as its owner maps its curve (an `enabled` lane's step, an effect gain's offset).
   */
  constructor(readonly parameter: string, readonly curve: Curve, readonly grid: Quantize, readonly where: string, readonly target: QuantTarget = "gain", readonly by?: CurveBy, readonly pre?: (y: number) => number) {}
}

/** What the lanes need of their instance. */
export interface QuantHost {
  readonly stopped: boolean;
  clock(): number;
  startOf(at: number | null): number;
  /** ADR 0362 §1: the heard time a stamp at instance time `t` goes with. */
  heard(t: number): number;
  param(name: string): { value: number; def: ParameterDef } | null;
  musicalSource(): MusicalSource | null;
  schedule(at: number, run: () => void): void;
}

/** The grid spec of a `quantize` setting. */
export function gridOf(q: Quantize): GridSpec {
  return typeof q === "string" ? q : q.beats === 1 ? "beat" : { every: "beat", n: q.beats };
}

/** A bound lane's curve for one voice. */
interface VoiceCurveLease { lane: QuantLane; id: number; start: number }

/** An instance's quantised lanes: the voices under them and their parameter changes. */
export class QuantizedLanes {
  private readonly lanes = new Set<QuantLane>();
  private readonly byVoice = new WeakMap<PVoice, readonly QuantLane[]>();
  private readonly leasesOf = new WeakMap<PVoice, VoiceCurveLease[]>();
  /** Leases `bindings` made for the voice about to play, taken by the next `attach`. */
  private prepared: VoiceCurveLease[] = [];
  private preparedAlive: { voice: PVoice | null } = { voice: null };

  constructor(private readonly host: QuantHost) {}

  /**
   * The voice about to start at heard `start` under `lanes`: `bindings` with a voice-time binding added for each lane of
   * a bound target (pitch, pan, filters), on a curve of its own holding the lane's level. Call `attach` with the voice
   * once it plays.
   */
  bindings(bindings: readonly Binding[], lanes: readonly QuantLane[] | undefined, start: number): readonly Binding[] {
    this.prepared = [];
    if (!lanes || !lanes.some((l) => l.target !== "gain")) return bindings;
    const owner: { voice: PVoice | null } = { voice: null };
    this.preparedAlive = owner;
    let out = bindings;
    for (const l of lanes) {
      if (l.target === "gain") continue;
      if (Number.isNaN(l.level)) l.level = this.read(l);
      if (out.length >= MAX_BINDINGS) {
        warnOnce(`playlist:bindings:${l.where}`, `[myco] ${l.where}: more than ${MAX_BINDINGS} parameter and time curves reach one voice; the rest are ignored.`);
        break;
      }
      // Alive until the voice it is bound to is freed (a lease never attached, because the play failed, goes at once).
      const id = playlistHost().leaseCurve(this.stepCurve(l, start), () => owner.voice !== null && (owner.voice.voice.alive ?? owner.voice.voice.playing));
      if (id === null) continue;
      this.prepared.push({ lane: l, id, start });
      out = [...out, { param: timeParam(TimeParam.Voice), curve: id, target: CORE_TARGET[l.target] }];
    }
    return out;
  }

  /** A voice starting at heard `start` under `lanes`: its gain ramp starts at their levels now; bound lanes keep its curves. */
  attach(v: PVoice, lanes: readonly QuantLane[] | undefined, start: number): void {
    const leases = this.prepared;
    this.prepared = [];
    if (leases.length > 0) {
      this.preparedAlive.voice = v;
      this.leasesOf.set(v, leases);
    }
    if (!lanes || lanes.length === 0) return;
    for (const l of lanes) {
      if (Number.isNaN(l.level)) l.level = this.read(l);
      this.sweep(l);
      l.voices.add(v);
      this.lanes.add(l);
    }
    this.byVoice.set(v, lanes);
    if (lanes.some((l) => l.target === "gain")) v.voice.paramsShaped({ gain: this.gainOf(v), seconds: 0, at: this.host.heard(start) });
  }

  /** A parameter changed: every lane on it moves at its next boundary. */
  onParameter(name: string): void {
    for (const l of this.lanes) if (l.parameter === name || l.by?.input === name) this.change(l);
  }

  private read(l: QuantLane): number {
    const p = this.host.param(l.parameter);
    const second = l.by ? this.host.param(l.by.input) : null;
    const raw = !p ? Number.NaN : l.by && second ? evalCurveBy(l.curve, l.by, p.value, secondValueOf(second.def, second.value)) : evalCurve(l.curve, p.value);
    const y = l.pre && Number.isFinite(raw) ? l.pre(raw) : raw;
    switch (l.target) {
      case "gain": return Number.isFinite(y) ? dbToGain(y) : 1;
      case "pitch": return Number.isFinite(y) ? semitonesToRatio(y) : 1;
      case "pan": return Number.isFinite(y) ? Math.min(1, Math.max(-1, y)) : 0;
      case "lowpass": return Number.isFinite(y) ? y : 24000;
      case "highpass": return Number.isFinite(y) ? y : 0;
    }
  }

  private gainOf(v: PVoice): number {
    let g = 1;
    for (const l of this.byVoice.get(v) ?? []) if (l.target === "gain") g *= l.level;
    return Math.min(4, Math.max(0, g));
  }

  /** Forget the voices under `l` that have ended. */
  private sweep(l: QuantLane): void {
    for (const v of l.voices) if (!(v.voice.alive ?? v.voice.playing)) l.voices.delete(v);
  }

  /** The next boundary of `l`'s grid at or after heard `from`, null without a musical clock. */
  private boundary(l: QuantLane, from: number): number | null {
    const src = this.host.musicalSource();
    if (!src || !src.hasGrid) return null;
    return src.nextGrid(gridOf(l.grid), from)?.time ?? null;
  }

  private change(l: QuantLane): void {
    if (this.host.stopped) return;
    // The first boundary a ramp can still be stamped at (one already stamped there is stamped again, the later record
    // replacing it at the same sample).
    const at = this.boundary(l, this.host.startOf(null));
    if (at === null) {
      warnOnce(`playlist:quantize:${l.where}`, `[myco] ${l.where}: a quantised automation lane has no musical clock to wait for (no tempo); it moves at once.`);
      this.apply(l, null);
      return;
    }
    if (Math.abs(at - l.waitingFor) <= EPS) return; // that boundary's timer reads the parameter when it fires
    if (at - LOOKAHEAD <= this.host.clock()) { this.apply(l, at); return; }
    l.waitingFor = at;
    this.host.schedule(at - LOOKAHEAD, () => {
      if (Math.abs(l.waitingFor - at) > EPS) return;
      l.waitingFor = Number.NaN;
      this.apply(l, at);
    });
  }

  /** Reads the parameter and ramps every voice under `l` to its new level, starting at heard `at` (null: now). */
  private apply(l: QuantLane, at: number | null): void {
    const level = this.read(l);
    const restamp = at !== null && Math.abs(at - l.stampedAt) <= EPS;
    l.stampedAt = at ?? Number.NaN;
    if (level === l.level && !restamp) return;
    if (l.target !== "gain") { this.step(l, level, at ?? this.host.startOf(null)); return; }
    l.level = level;
    for (const v of [...l.voices]) {
      if (!(v.voice.alive ?? v.voice.playing)) { l.voices.delete(v); continue; }
      if (v.leaving) continue;
      v.voice.paramsShaped({ gain: this.gainOf(v), seconds: QUANTIZED_RAMP_SECONDS, ...(at !== null ? { at: this.host.heard(at) } : {}) });
    }
  }

  /** A bound lane moves to `level` at heard `at`: its step list gains the move and every voice's curve is redefined. */
  private step(l: QuantLane, level: number, at: number): void {
    const now = this.host.clock();
    // A restamp of the same boundary replaces its move; moves whose ramp has ended fold into the level before the rest.
    const replaced = l.steps.find((s) => s.at >= at - EPS);
    let steps = l.steps.filter((s) => s.at < at - EPS);
    const from = steps.length > 0 ? steps[steps.length - 1]!.to : replaced ? replaced.from : l.level;
    while (steps.length > 0 && steps[0]!.at + QUANTIZED_RAMP_SECONDS < now - EPS) steps = steps.slice(1);
    steps.push({ at, from, to: level });
    if (steps.length > MAX_STEPS) steps = steps.slice(steps.length - MAX_STEPS);
    l.steps = steps;
    l.level = level;
    const host = playlistHost();
    for (const v of [...l.voices]) {
      if (!(v.voice.alive ?? v.voice.playing)) { l.voices.delete(v); continue; }
      const lease = this.leasesOf.get(v)?.find((x) => x.lane === l);
      if (lease) host.redefineCurve(lease.id, this.stepCurve(l, lease.start));    }
  }

  /**
   * The stepped curve of a bound lane for a voice starting at heard `start`, in voice seconds: the level before the
   * lane's pending moves, then each move as a 20 ms linear ramp at its boundary (a move that ended before the voice
   * started is its starting level).
   */
  private stepCurve(l: QuantLane, start: number): Curve {
    let base = l.steps.length > 0 ? l.steps[0]!.from : l.level;
    const keys: CurveKey[] = [];
    for (const s of l.steps) {
      const x = s.at - start;
      if (x + QUANTIZED_RAMP_SECONDS <= 0) { base = s.to; continue; }
      const x0 = Math.max(x, keys.length > 0 ? keys[keys.length - 1]![0] : -1);
      keys.push([x0, s.from], [x0 + QUANTIZED_RAMP_SECONDS, s.to]);
    }
    return [[-1, base], ...keys];
  }
}
