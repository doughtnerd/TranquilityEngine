/**
 * Beat-quantised automation (ADR 0336 feature 5): an automation lane keyed on a parameter with `quantize` set moves only
 * on the next beat, bar or n-beat boundary of the instance's musical clock, sample-exactly on the audio clock.
 *
 * A quantised lane is never given to the core as a binding (the core follows its parameter continuously). Its level is
 * the voice's own gain ramp instead (`AudioVoice.paramsShaped({ gain, at })`, the stem level the music runtime's
 * quantised stems used, which multiplies the voice's volume, so the instance's other gains and bindings are unchanged):
 * when the parameter changes, the lane finds the next boundary on the musical clock (`MusicalSource.nextGrid`) and, once
 * that boundary is within the scheduling lookahead, reads the parameter and stamps a 20 ms ramp starting exactly at the
 * boundary on every voice under it. A change that arrives after the boundary's ramp was stamped moves the level at the
 * following boundary. With no musical clock the lane moves at once (the change is never lost; the Studio lints a
 * quantised lane on a playlist without a tempo).
 *
 * Targets: gain-like lanes only (`volume`, `enabled`, a gain effect's `gain`): the voice has one stamped gain ramp. Other
 * quantised lanes follow their parameter continuously (one warning).
 */
import { evalCurve, type Curve } from "../../../../engine/core/curve";
import type { Quantize } from "../../../../engine/audio/playlist/types";
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { QUANTIZED_RAMP_SECONDS } from "../automation";
import { warnOnce } from "../core/handle";
import type { PVoice } from "./liveNode";
import type { MusicalSource } from "./musical";

/** How far ahead of a boundary its ramp is stamped (the playlist runtime's scheduling lookahead). */
const LOOKAHEAD = 0.25;
const EPS = 1e-9;

const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** One quantised lane below a playlist level: a gain curve (dB) on a parameter, and the voices it applies to. */
export class QuantLane {
  /** The linear gain applied now (NaN until first read). */
  level = Number.NaN;
  /** The boundary whose ramp is stamped, heard seconds (NaN: none). */
  stampedAt = Number.NaN;
  /** A timer waits for this boundary (NaN: none). */
  waitingFor = Number.NaN;
  readonly voices = new Set<PVoice>();
  constructor(readonly parameter: string, readonly curve: Curve, readonly grid: Quantize, readonly where: string) {}
}

/** What the lanes need of their instance. */
export interface QuantHost {
  readonly stopped: boolean;
  clock(): number;
  startOf(at: number | null): number;
  param(name: string): { value: number; def: ParameterDef } | null;
  musicalSource(): MusicalSource | null;
  schedule(at: number, run: () => void): void;
}

/** The grid spec of a `quantize` setting. */
export function gridOf(q: Quantize): GridSpec {
  return typeof q === "string" ? q : q.beats === 1 ? "beat" : { every: "beat", n: q.beats };
}

/** An instance's quantised lanes: the voices under them and their parameter changes. */
export class QuantizedLanes {
  private readonly lanes = new Set<QuantLane>();
  private readonly byVoice = new WeakMap<PVoice, readonly QuantLane[]>();

  constructor(private readonly host: QuantHost) {}

  /** A voice starting at heard `start` under `lanes`: its gain ramp starts at their levels now. */
  attach(v: PVoice, lanes: readonly QuantLane[] | undefined, start: number): void {
    if (!lanes || lanes.length === 0) return;
    for (const l of lanes) {
      if (Number.isNaN(l.level)) l.level = this.read(l);
      l.voices.add(v);
      this.lanes.add(l);
    }
    this.byVoice.set(v, lanes);
    v.voice.paramsShaped({ gain: this.gainOf(v), seconds: 0, at: start });
  }

  /** A parameter changed: every lane on it moves at its next boundary. */
  onParameter(name: string): void {
    for (const l of this.lanes) if (l.parameter === name) this.change(l);
  }

  private read(l: QuantLane): number {
    const p = this.host.param(l.parameter);
    return p ? dbToGain(evalCurve(l.curve, p.value)) : 1;
  }

  private gainOf(v: PVoice): number {
    let g = 1;
    for (const l of this.byVoice.get(v) ?? []) g *= l.level;
    return Math.min(4, Math.max(0, g));
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
    l.level = level;
    for (const v of [...l.voices]) {
      if (!(v.voice.alive ?? v.voice.playing)) { l.voices.delete(v); continue; }
      if (v.leaving) continue;
      v.voice.paramsShaped({ gain: this.gainOf(v), seconds: QUANTIZED_RAMP_SECONDS, ...(at !== null ? { at } : {}) });
    }
  }
}
