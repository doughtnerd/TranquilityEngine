/**
 * ADR 0158 §3–§4: what an audio backend does with event automation and sustain loops.
 *
 * Main decides things when they happen (a play, a parameter set, a release) and hands them to the backend through
 * `AutomationSink`. The core backend writes them to the core (CURVES, PARAM, AUTOMATE, BUS_AUTOMATE, SET_LOOP), which
 * smooths parameters and evaluates curves every quantum. Backends without the core (the Babylon fallback, tests) use
 * `TsAutomation`, the same semantics evaluated once per frame on main; that is the only case where events cost main
 * per-frame work.
 */

import { evalCurve, type Curve } from "../../../../engine/core/curve";
import { mixer } from "../../../../engine/audio/mixer";
import type { AudioVoice } from "../backend";
import { warnOnce } from "../core/handle";

/** What a curve drives. The numbers are the core's `target` values. */
export const enum AutoTarget { Volume = 0, Pitch = 1, Lowpass = 2 }

/** A parameter slot: one of the project's global parameters, or one of the voice's instance's local ones. */
export interface ParamRef {
  global: boolean;
  slot: number;
}

/** One curve applied to one property, read from one parameter. */
export interface Binding {
  param: ParamRef;
  /** A curve id given to `defineCurve`. */
  curve: number;
  target: AutoTarget;
  /**
   * ADR 0166 §2.3 (R6): a music stem's binding that moves only at the next `beat` or `bar` line. The core evaluates its
   * bindings continuously, so a quantised binding is never given to `bindVoice`: the music player evaluates it on main at
   * the grid point (`evaluateQuantized`) and stamps an in-voice ramp (`music/stems.ts` `quantizedRamp`).
   */
  quantize?: "beat" | "bar";
}

/** R6: the seconds of the stamped in-voice ramp a quantised binding makes (api-and-models §2.3: 20 ms). */
export const QUANTIZED_RAMP_SECONDS = 0.02;

/** R6: the bindings that follow their parameter continuously (what a sink's `bindVoice` takes). */
export function continuousBindings(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((b) => b.quantize === undefined);
}

/** R6: the quantised bindings, which the music player evaluates at grid points. */
export function quantizedBindings(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((b) => b.quantize !== undefined);
}

/** Global parameter slots, local slots per instance, instance ids, curves and bindings per voice or bus: the core's capacities (ADR 0158, E2). */
export const MAX_GLOBAL_SLOTS = 64;
export const MAX_LOCAL_SLOTS = 16;
export const MAX_GROUPS = 1024;
export const MAX_CURVES = 1024;
export const MAX_BINDINGS = 8;
/** The cutoff that means "no low-pass". */
export const LOWPASS_OFF = 24000;

export interface AutomationSink {
  /** Define or replace curve `id` (0..MAX_CURVES-1). */
  defineCurve(id: number, curve: Curve): void;
  /** Set a parameter's target: `group` 0 is global (slots 0..63), else an instance (1..1024; slots 0..15). `seekPerSecond` 0 jumps. */
  setParam(group: number, slot: number, value: number, seekPerSecond: number): void;
  /**
   * Bind a voice just played (replacing any earlier bindings): its instance `group` (as in its `PlayRequest`) and up to
   * `MAX_BINDINGS` curves. `base` is the volume and pitch it was played with (the evaluator multiplies onto them).
   */
  bindVoice(voice: AudioVoice, group: number, bindings: readonly Binding[], base: { volume: number; pitch: number }): void;
  /** Bind a bus to global parameters (replacing its earlier bindings); pitch bindings are ignored. */
  bindBus(bus: string, bindings: readonly Binding[]): void;
  /**
   * Loop a region of a playing clip (seconds; `end` 0 is the clip's end) or, with `looping` false, release it: the voice
   * finishes its current pass and plays on to the clip's end.
   */
  setLoop(voice: AudioVoice, start: number, end: number, looping: boolean): void;
}

/** A parameter being smoothed toward its target. */
export class ParamState {
  value: number;
  target: number;
  seek = 0;
  constructor(v = 0) { this.value = v; this.target = v; }
  set(target: number, seekPerSecond: number): void {
    this.target = target;
    this.seek = seekPerSecond;
    if (!(seekPerSecond > 0)) this.value = target;
  }
  /** Move toward the target by `seek × dt`, never past it. Returns whether the value changed. */
  advance(dt: number): boolean {
    if (this.value === this.target) return false;
    const step = this.seek * dt;
    if (!(step > 0) || Math.abs(this.target - this.value) <= step) this.value = this.target;
    else this.value += this.target > this.value ? step : -step;
    return true;
  }
}

/** The product of volume curves, product of pitch curves and the lowest low-pass among `bindings`. */
export function evaluate(bindings: readonly Binding[], curves: ReadonlyMap<number, Curve>, read: (p: ParamRef) => number): { gain: number; pitch: number; lowpass: number } {
  let gain = 1, pitch = 1, lowpass = LOWPASS_OFF;
  for (const b of bindings) {
    // A curve id that was never defined is the empty curve (0), as in the core's table.
    const y = evalCurve(curves.get(b.curve) ?? [], read(b.param));
    if (b.target === AutoTarget.Volume) gain *= Math.max(0, y);
    else if (b.target === AutoTarget.Pitch) pitch *= y > 0 ? y : 1;
    else lowpass = Math.min(lowpass, Math.max(10, y));
  }
  return { gain, pitch, lowpass };
}

/**
 * R6: the volume gain and low-pass of the quantised `bindings` at the parameter values `read` gives now: the same rules
 * as `evaluate`, over only the bindings with `quantize`. `grid` is the coarsest grid among them that applies (`bar`
 * beats `beat` when both are present: the stem moves when the slower grid arrives, so one ramp carries every binding).
 * `grid` is null when none is quantised.
 */
export function evaluateQuantized(bindings: readonly Binding[], curves: ReadonlyMap<number, Curve>, read: (p: ParamRef) => number): { gain: number; lowpass: number; grid: "beat" | "bar" | null } {
  const q = quantizedBindings(bindings);
  if (q.length === 0) return { gain: 1, lowpass: LOWPASS_OFF, grid: null };
  const r = evaluate(q, curves, read);
  return { gain: r.gain, lowpass: r.lowpass, grid: q.some((b) => b.quantize === "bar") ? "bar" : "beat" };
}

/** What `evaluateInto` writes: the same three numbers `evaluate` returns. */
export interface AutoResult {
  gain: number;
  pitch: number;
  lowpass: number;
}

const NO_CURVE: Curve = [];

/**
 * `evaluate` without a callback or a result object (E5.3c: the core backend's play path): `n` bindings as parallel
 * arrays (curve ids, `AutoTarget`s, and the parameter value each reads), written into `out`. The same rules and the
 * same order of multiplication as `evaluate`, so the numbers are identical.
 */
export function evaluateInto(n: number, curveIds: ArrayLike<number>, targets: ArrayLike<number>, x: ArrayLike<number>, curves: ReadonlyMap<number, Curve>, out: AutoResult): AutoResult {
  let gain = 1, pitch = 1, lowpass = LOWPASS_OFF;
  for (let j = 0; j < n; j++) {
    const y = evalCurve(curves.get(curveIds[j]!) ?? NO_CURVE, x[j]!);
    const target = targets[j];
    if (target === AutoTarget.Volume) gain *= Math.max(0, y);
    else if (target === AutoTarget.Pitch) pitch *= y > 0 ? y : 1;
    else lowpass = Math.min(lowpass, Math.max(10, y));
  }
  out.gain = gain;
  out.pitch = pitch;
  out.lowpass = lowpass;
  return out;
}

interface BoundVoice {
  voice: AudioVoice;
  group: number;
  bindings: readonly Binding[];
  base: { volume: number; pitch: number };
  gain: number;
  pitch: number;
}

/**
 * The evaluator for backends without the core: the same smoothing and curves as the core, once per frame (`update`),
 * applied through the voice setters (`setVolume`, `setPitch`) and the mixer's bus automation. Per-voice low-pass isn't
 * available here (warns once); loops use the voice's optional `setLoop`.
 */
export class TsAutomation implements AutomationSink {
  private readonly curves = new Map<number, Curve>();
  private readonly globals: ParamState[] = Array.from({ length: MAX_GLOBAL_SLOTS }, () => new ParamState());
  private readonly locals = new Map<number, ParamState[]>();
  private readonly voices: BoundVoice[] = [];
  private readonly buses = new Map<string, readonly Binding[]>();
  private dirty = true;

  defineCurve(id: number, curve: Curve): void {
    if (id >= 0 && id < MAX_CURVES) { this.curves.set(id, curve); this.dirty = true; }
  }

  setParam(group: number, slot: number, value: number, seekPerSecond: number): void {
    const p = this.param(group, slot);
    if (!p) return;
    p.set(value, seekPerSecond);
    this.dirty = true;
  }

  bindVoice(voice: AudioVoice, group: number, bindings: readonly Binding[], base: { volume: number; pitch: number }): void {
    const i = this.voices.findIndex((v) => v.voice === voice);
    if (i >= 0) this.voices.splice(i, 1);
    bindings = continuousBindings(bindings); // R6: a quantised binding is the music player's, never followed per frame
    if (bindings.length === 0) return;
    if (bindings.some((b) => b.target === AutoTarget.Lowpass)) warnOnce("events:lowpass-fallback", "Audio events: low-pass automation needs the audio core; it is ignored on the Babylon fallback.");
    const v: BoundVoice = { voice, group, bindings: bindings.slice(0, MAX_BINDINGS), base: { ...base }, gain: NaN, pitch: NaN };
    this.voices.push(v);
    this.apply(v);
  }

  bindBus(bus: string, bindings: readonly Binding[]): void {
    const global = bindings.filter((b) => b.param.global && b.target !== AutoTarget.Pitch).slice(0, MAX_BINDINGS);
    if (global.length === 0) { this.buses.delete(bus); mixer._setAutomation(bus, 1, LOWPASS_OFF); }
    else this.buses.set(bus, global);
    this.dirty = true;
  }

  setLoop(voice: AudioVoice, start: number, end: number, looping: boolean): void {
    if (voice.setLoop) voice.setLoop(start, end, looping);
    else warnOnce("events:loop-fallback", "Audio events: this audio backend can't loop part of a clip; sustain plays the clip once.");
  }

  /** Once per frame: smooth parameters, then re-apply every bound voice and bus whose inputs moved. */
  update(dt: number): void {
    for (const p of this.globals) if (p.advance(dt)) this.dirty = true;
    for (const ps of this.locals.values()) for (const p of ps) if (p.advance(dt)) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    let w = 0;
    for (const v of this.voices) {
      if (!v.voice.playing) continue;
      this.voices[w++] = v;
      this.apply(v);
    }
    this.voices.length = w;
    for (const [bus, bindings] of this.buses) {
      const r = evaluate(bindings, this.curves, (p) => this.read(0, p));
      mixer._setAutomation(bus, r.gain, r.lowpass);
    }
  }

  /** Forget an instance's local parameters (its group id is free again). */
  releaseGroup(group: number): void {
    this.locals.delete(group);
  }

  /** The current (smoothed) value of a parameter, for tests and debugging. */
  valueOf(group: number, slot: number): number {
    return this.param(group, slot)?.value ?? 0;
  }

  /**
   * Only the voice setters carry the automated gain and pitch; the `PlayRequest` keeps the base values (the request's
   * volume is `base.volume`). A voice still waiting for the core (`PendingCoreBackend`) stores setter values in its
   * request, so `EventInstance.resend` sets the base values back before the core's own automation binds.
   */
  private apply(v: BoundVoice): void {
    const r = evaluate(v.bindings, this.curves, (p) => this.read(v.group, p));
    if (r.gain !== v.gain) { v.gain = r.gain; v.voice.setVolume(v.base.volume * r.gain); }
    if (r.pitch !== v.pitch) { v.pitch = r.pitch; v.voice.setPitch(v.base.pitch * r.pitch); }
  }

  private read(group: number, p: ParamRef): number {
    return (p.global ? this.globals[p.slot] : this.locals.get(group)?.[p.slot])?.value ?? 0;
  }

  private param(group: number, slot: number): ParamState | null {
    if (group === 0) return slot >= 0 && slot < MAX_GLOBAL_SLOTS ? this.globals[slot] : null;
    if (group < 1 || group > MAX_GROUPS || slot < 0 || slot >= MAX_LOCAL_SLOTS) return null;
    let ps = this.locals.get(group);
    if (!ps) { ps = Array.from({ length: MAX_LOCAL_SLOTS }, () => new ParamState()); this.locals.set(group, ps); }
    return ps[slot];
  }
}
