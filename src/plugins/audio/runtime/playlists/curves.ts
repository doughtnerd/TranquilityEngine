/**
 * An entry's voice curves at runtime (ADR 0329 entry `curves`, ADR 0332): gain (dB), pitch (semitones), pan, low-pass and
 * high-pass (Hz), each keyed on a parameter or on voice time.
 *
 * - **Parameter and time curves** become automation bindings (the backend's `AutomationSink`: the core's curve tables,
 *   or `TsAutomation` on a backend without them), so the core follows the parameter, or advances the time, itself. A
 *   curve on `voiceTime`, `clipTime` or `sequenceTime` reads the core's time parameter of that name (ADR 0332:
 *   `TimeParam`; sequence time is the instance group's clock, which the sequence runtime re-anchors). The core's targets
 *   are a linear volume multiplier, a pitch ratio and a low-pass cutoff, so a dB or semitone curve is resampled into a
 *   curve of those (`toCoreCurve`).
 * - `TimeCurve` and `evalTimeCurves` remain for main-thread time curves (none are made here since ADR 0332's core time
 *   parameters).
 * - Pan and high-pass have no automation target on any backend yet (no voice pan or high-pass control): they are
 *   skipped with one warning each.
 */
import { evalCurve, type Curve, type CurveKey } from "../../../../engine/core/curve";
import type { CurveInput, VoiceCurve, VoiceCurveTarget } from "../../../../engine/audio/playlist/types";
import { warnOnce } from "../core/handle";
import { AutoTarget, MAX_BINDINGS, TimeParam, timeParam, type Binding, type ParamRef } from "../events/automation";

/** A voice-time curve, evaluated per frame on main. */
export interface TimeCurve {
  target: "gain" | "pitch" | "lowpass";
  curve: Curve;
}

/** The most keys a resampled core curve gets (the core's curve key cap). */
const CORE_KEYS = 32;

/** ADR 0332: a curve input's time parameter. */
const TIME_INPUTS = { voiceTime: TimeParam.Voice, clipTime: TimeParam.Clip, sequenceTime: TimeParam.Sequence } as const;

const resampled = new WeakMap<Curve, { gain?: Curve; pitch?: Curve }>();

const dbToGain = (db: number): number => Math.pow(10, db / 20);
const stToRatio = (st: number): number => Math.pow(2, st / 12);

/** A dB curve as linear gain, or a semitone curve as a ratio, in linear keys (each segment subdivided to keep its shape). */
export function toCoreCurve(curve: Curve, target: "gain" | "pitch"): Curve {
  let c = resampled.get(curve);
  if (!c) resampled.set(curve, (c = {}));
  const hit = c[target];
  if (hit) return hit;
  const map = target === "gain" ? dbToGain : stToRatio;
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
}

/**
 * The bindings and voice-time curves of `curves`, added after the parent's. `paramRef` resolves a parameter name (null:
 * unknown, already warned); `curveId` gives a curve's id on the backend (null: the table is full).
 */
export function curveParts(
  curves: Partial<Record<VoiceCurveTarget, VoiceCurve>>,
  parent: { readonly bindings: readonly Binding[]; readonly timeCurves: readonly TimeCurve[] },
  paramRef: (name: string) => ParamRef | null,
  curveId: (curve: Curve) => number | null,
  where: string,
): CurveParts {
  let bindings = parent.bindings as Binding[];
  const timeCurves = parent.timeCurves as TimeCurve[];
  for (const target of Object.keys(curves) as VoiceCurveTarget[]) {
    const vc = curves[target];
    if (!vc || vc.bypass || vc.curve.length === 0) continue;
    if (target === "pan" || target === "highpass") {
      warnOnce(`playlist:curve:${target}`, `[myco] ${where}: ${target === "pan" ? "pan" : "high-pass"} voice curves need a voice ${target === "pan" ? "pan" : "high-pass"} control the audio core doesn't have yet; skipped.`);
      continue;
    }
    const input: CurveInput = vc.input;
    const p = typeof input === "string" ? timeParam(TIME_INPUTS[input] ?? TimeParam.Voice) : paramRef(input.parameter);
    if (!p) continue;
    const id = curveId(target === "lowpass" ? vc.curve : toCoreCurve(vc.curve, target));
    if (id === null) continue;
    if (bindings.length >= MAX_BINDINGS) {
      warnOnce(`playlist:bindings:${where}`, `[myco] ${where}: more than ${MAX_BINDINGS} parameter and time curves reach one voice; the rest are ignored.`);
      continue;
    }
    if (bindings === parent.bindings) bindings = bindings.slice();
    bindings.push({ param: p, curve: id, target: target === "gain" ? AutoTarget.Volume : target === "pitch" ? AutoTarget.Pitch : AutoTarget.Lowpass });
  }
  return { bindings, timeCurves };
}

/** The gain (linear), pitch (ratio) and low-pass (Hz, null: none) of `curves` at voice time `t` seconds. */
export function evalTimeCurves(curves: readonly TimeCurve[], t: number): { gain: number; pitch: number; lowpass: number | null } {
  let gain = 1, pitch = 1;
  let lowpass: number | null = null;
  for (const c of curves) {
    const y = evalCurve(c.curve, t);
    if (c.target === "gain") gain *= dbToGain(y);
    else if (c.target === "pitch") pitch *= stToRatio(y);
    else lowpass = lowpass === null ? y : Math.min(lowpass, y);
  }
  return { gain, pitch, lowpass };
}
