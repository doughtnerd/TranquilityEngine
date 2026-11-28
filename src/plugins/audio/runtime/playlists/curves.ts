/**
 * An entry's voice curves at runtime (ADR 0343 entry `curves`, ADR 0346): gain (dB), pitch (semitones), pan, low-pass and
 * high-pass (Hz), each keyed on a parameter or on voice time.
 *
 * - **Parameter and time curves** become automation bindings (the backend's `AutomationSink`: the core's curve tables,
 *   or `TsAutomation` on a backend without them), so the core follows the parameter, or advances the time, itself. A
 *   curve on `voiceTime`, `clipTime` or `sequenceTime` reads the core's time parameter of that name (ADR 0346:
 *   `TimeParam`; sequence time is the instance group's clock, which the sequence runtime re-anchors). The core's targets
 *   are a linear volume multiplier, a pitch ratio, a low-pass cutoff, a high-pass floor and a pan (ABI 4.4), so a dB or
 *   semitone curve is resampled into a curve of those (`toCoreCurve`); cutoffs (Hz) and pan (−1..1) go as they are.
 * - The accumulated static pan of a voice is a binding too (`staticPanBinding`): a constant curve on voice time, which the
 *   core sums with the voice's pan curves.
 * - `TimeCurve` and `evalTimeCurves` remain for main-thread time curves (none are made here since ADR 0346's core time
 *   parameters; sequence and instance-level automation lanes keyed on time make them). Gain, pitch and low-pass ones run
 *   on main; pan and high-pass ones become core bindings on the voice's time when the voice starts
 *   (`coreTimeBindings`, ABI 4.4).
 * - On the Babylon fallback pan and high-pass curves are ignored (`TsAutomation` warns once).
 * - ADR 0362 §5: a curve with a second input (`by`) binds its instance's slice of it (`byCurves.ts`), a curve id the
 *   slice redefines when the second parameter moves; a main-thread time curve reads the slice (`TimeCurve.live`).
 */
import { evalCurve, type Curve, type CurveKey } from "../../../../engine/core/curve";
import type { CurveInput, GenTarget, VoiceCurve, VoiceCurveTarget } from "../../../../engine/audio/playlist/types";
import { warnOnce } from "../core/handle";
import { AutoTarget, MAX_BINDINGS, TimeParam, timeParam, type Binding, type ParamRef } from "../automation";
import { QuantLane } from "./quantizedLanes";
import type { GenCurve } from "./liveNode";
import type { CurveBy } from "../../../../engine/audio/curveBy";
import { dbToGain, semitonesToRatio } from "../../../../engine/audio/decibels";
import type { LiveSlice } from "./byCurves";

/** The core target of each voice curve target. */
const TARGETS: Record<VoiceCurveTarget, AutoTarget> = {
  gain: AutoTarget.Volume,
  pitch: AutoTarget.Pitch,
  lowpass: AutoTarget.Lowpass,
  highpass: AutoTarget.Highpass,
  pan: AutoTarget.Pan,
};

/** A voice-time curve, evaluated per frame on main. */
export interface TimeCurve {
  /** Gain (dB), pitch (semitones) and low-pass (Hz) run on main; pan and high-pass go to the core (`coreTimeBindings`). */
  target: "gain" | "pitch" | "lowpass" | "pan" | "highpass";
  curve: Curve;
  /**
   * Heard time the curve's zero is at, when that isn't the voice's own start: a playlist's instance-level lane keyed on
   * the playlist's start (`PlaylistBody.automation`). The voice that plays it reads it from its own start
   * (`anchorTimeCurves` turns it into an `offset`).
   */
  origin?: number;
  /**
   * Seconds the voice reads the curve ahead of its own time: what the curve says at t + offset, at voice time t (a
   * sequence lane keyed on clip or sequence time, an anchored instance lane). Absent: 0. The curve itself is never
   * shifted: a core binding carries the offset as its time origin (ABI 4.9), so one curve id serves every voice whatever
   * its start (long instances can't fill the core's curve table with shifted copies).
   */
  offset?: number;
  /** ADR 0362 §5: the lane follows a second parameter: its slice now (`curve` is the lane's own, unsliced). */
  live?: LiveSlice;
}

/** `curves` for a voice starting at heard `start`: curves with an `origin` read from the voice's start (an `offset`). */
export function anchorTimeCurves(curves: readonly TimeCurve[], start: number): readonly TimeCurve[] {
  if (!curves.some((c) => c.origin !== undefined)) return curves;
  return curves.map((c) => (c.origin === undefined ? c : { target: c.target, curve: c.curve, offset: (c.offset ?? 0) + start - c.origin, ...(c.live ? { live: c.live } : {}) }));
}

/** The most keys a resampled core curve gets (the core's curve key cap). */
const CORE_KEYS = 32;

/** ADR 0346: a curve input's time parameter. */
const TIME_INPUTS = { voiceTime: TimeParam.Voice, clipTime: TimeParam.Clip, sequenceTime: TimeParam.Sequence } as const;

const resampled = new WeakMap<Curve, { gain?: Curve; pitch?: Curve }>();


/** A dB curve as linear gain, or a semitone curve as a ratio, in linear keys (each segment subdivided to keep its shape). */
export function toCoreCurve(curve: Curve, target: "gain" | "pitch"): Curve {
  let c = resampled.get(curve);
  if (!c) resampled.set(curve, (c = {}));
  const hit = c[target];
  if (hit) return hit;
  const map = target === "gain" ? dbToGain : semitonesToRatio;
  const keys: CurveKey[] = [];
  const n = curve.length;
  if (n <= 1) keys.push([n === 1 ? curve[0]![0] : 0, map(n === 1 ? curve[0]![1] : 0)]);
  else {
    const per = Math.max(1, Math.floor((CORE_KEYS - 1) / (n - 1)));
    for (let k = 0; k < n - 1; k++) {
      const a = curve[k]!, b = curve[k + 1]!;
      const steps = a[2] === "step" ? 1 : per;
      for (let s = 0; s < steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        keys.push(a[2] === "step" ? [x, map(a[1]), "step"] : [x, map(evalCurve(curve, x))]);
      }
    }
    keys.push([curve[n - 1]![0], map(curve[n - 1]![1])]);
  }
  c[target] = keys;
  return keys;
}

/** What an entry's curves add below it. */
export interface CurveParts {
  bindings: Binding[];
  timeCurves: TimeCurve[];
  /** Curves keyed on a parameter with `quantize` (`quantizedLanes.ts`), after the parent's; absent: none added. */
  quantized?: QuantLane[];
}

/**
 * The bindings and voice-time curves of `curves`, added after the parent's. `paramRef` resolves a parameter name (null:
 * unknown, already warned); `curveId` gives a curve's id on the backend (null: the table is full); `slice` gives the
 * instance's slice of a curve with a second input (ADR 0362 §5; absent: `by` is ignored).
 */
export function curveParts(
  curves: Partial<Record<VoiceCurveTarget | GenTarget, VoiceCurve>>,
  parent: { readonly bindings: readonly Binding[]; readonly timeCurves: readonly TimeCurve[]; readonly quantized?: readonly QuantLane[] },
  paramRef: (name: string) => ParamRef | null,
  curveId: (curve: Curve) => number | null,
  where: string,
  slice?: (main: Curve, by: CurveBy) => LiveSlice,
): CurveParts {
  let bindings = parent.bindings as Binding[];
  const timeCurves = parent.timeCurves as TimeCurve[];
  let quantized: QuantLane[] | undefined;
  for (const key of Object.keys(curves) as (VoiceCurveTarget | GenTarget)[]) {
    // ADR 0360 §4: a `gen:` curve drives the generator voice's parameter (`genCurvesOf`), not a voice control.
    if (isGenTarget(key)) continue;
    const target: VoiceCurveTarget = key;
    const vc = curves[target];
    if (!vc || vc.bypass || vc.curve.length === 0) continue;
    const input: CurveInput = vc.input;
    if (vc.quantize !== undefined) {
      // A curve on a parameter that moves only on the musical clock's boundaries: a quantised lane, not a binding.
      if (typeof input !== "string") {
        if (paramRef(input.parameter)) (quantized ??= [...(parent.quantized ?? [])]).push(new QuantLane(input.parameter, vc.curve, vc.quantize, where, target, vc.by));
        continue;
      }
      warnOnce(`playlist:quantize-time:${where}:${target}`, `[myco] ${where}: the ${target} curve is keyed on ${input}; quantize applies to curves keyed on a parameter and is ignored.`);
    }
    const p = typeof input === "string" ? timeParam(TIME_INPUTS[input] ?? TimeParam.Voice) : paramRef(input.parameter);
    if (!p) continue;
    const toCore = (c: Curve) => (target === "gain" || target === "pitch" ? toCoreCurve(c, target) : c);
    const id = vc.by && slice ? slice(vc.curve, vc.by).curveId(target, toCore) : curveId(toCore(vc.curve));
    if (id === null) continue;
    if (bindings.length >= MAX_BINDINGS) {
      warnOnce(`playlist:bindings:${where}`, `[myco] ${where}: more than ${MAX_BINDINGS} parameter and time curves reach one voice; the rest are ignored.`);
      continue;
    }
    if (bindings === parent.bindings) bindings = bindings.slice();
    bindings.push({ param: p, curve: id, target: TARGETS[target] });
  }
  return quantized ? { bindings, timeCurves, quantized } : { bindings, timeCurves };
}

/** ADR 0360 §4: a `gen:<param>` target. */
export const isGenTarget = (target: string): target is GenTarget => target.startsWith("gen:");

/**
 * ADR 0360 §4: the `gen:<param>` curves of an entry's `curves` (not bypassed, with keys), after `parent`'s; `parent` itself
 * when there are none.
 */
export function genCurvesOf(curves: Partial<Record<VoiceCurveTarget | GenTarget, VoiceCurve>>, parent: readonly GenCurve[] | undefined): readonly GenCurve[] | undefined {
  let out = parent;
  for (const key of Object.keys(curves)) {
    if (!isGenTarget(key)) continue;
    const vc = curves[key];
    if (!vc || vc.bypass || vc.curve.length === 0) continue;
    const c: GenCurve = { param: key.slice(4), input: vc.input, curve: vc.curve, ...(vc.quantize !== undefined ? { quantize: vc.quantize } : {}) };
    out = out === parent ? [...(parent ?? []), c] : [...out!, c];
  }
  return out;
}

/**
 * ABI 4.4: `curves` (already anchored at the voice's start) split for a voice: the pan and high-pass ones become core
 * bindings on voice time, added after `bindings`; the rest stay main-thread time curves.
 */
export function coreTimeBindings(
  curves: readonly TimeCurve[],
  bindings: readonly Binding[],
  curveId: (curve: Curve) => number | null,
  where: string,
): { timeCurves: readonly TimeCurve[]; bindings: readonly Binding[] } {
  if (!curves.some((c) => c.target === "pan" || c.target === "highpass")) return { timeCurves: curves, bindings };
  let out = bindings;
  for (const c of curves) {
    if (c.target !== "pan" && c.target !== "highpass") continue;
    const vc: VoiceCurve = { input: "voiceTime", curve: c.curve, bypass: false };
    const before = out;
    // ADR 0362 §5: a lane with a second input binds its slice's curve.
    const id = c.live ? (): number | null => c.live!.curveId(c.target) : curveId;
    out = curveParts({ [c.target]: vc }, { bindings: out, timeCurves: [] }, () => null, id, where).bindings;
    // ABI 4.9: the lane's offset rides on the binding (its time origin), not on a shifted copy of the curve.
    const offset = c.offset ?? 0;
    if (out !== before && offset !== 0 && Number.isFinite(offset)) out = [...out.slice(0, -1), { ...out[out.length - 1]!, offset }];
  }
  return { timeCurves: curves.filter((c) => c.target !== "pan" && c.target !== "highpass"), bindings: out };
}

/** One constant curve per static pan value (curve ids are never freed, so equal pans share one). */
const panCurves = new Map<number, Curve>();

/**
 * A voice's static pan (−1..1, the tree's accumulated `pan`) as a binding: a constant curve on voice time, summed in the
 * core with the voice's pan curves. Null for pan 0 (nothing to do) or a full curve table.
 */
export function staticPanBinding(pan: number, curveId: (curve: Curve) => number | null): Binding | null {
  if (!(pan !== 0 && Number.isFinite(pan))) return null;
  const p = Math.min(1, Math.max(-1, pan));
  let curve = panCurves.get(p);
  if (!curve) panCurves.set(p, (curve = [[0, p]]));
  const id = curveId(curve);
  return id === null ? null : { param: timeParam(TimeParam.Voice), curve: id, target: AutoTarget.Pan };
}

/** The gain (linear), pitch (ratio) and low-pass (Hz, null: none) of `curves` at voice time `t` seconds. */
export function evalTimeCurves(curves: readonly TimeCurve[], t: number): { gain: number; pitch: number; lowpass: number | null } {
  let gain = 1, pitch = 1;
  let lowpass: number | null = null;
  for (const c of curves) {
    const y = evalCurve(c.live?.curve ?? c.curve, t + (c.offset ?? 0));
    if (c.target === "gain") gain *= dbToGain(y);
    else if (c.target === "pitch") pitch *= semitonesToRatio(y);
    else if (c.target === "lowpass") lowpass = lowpass === null ? y : Math.min(lowpass, y);
  }
  return { gain, pitch, lowpass };
}
