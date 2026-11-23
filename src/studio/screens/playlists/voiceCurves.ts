// An entry's voice curves in the shared curve editor (ADR 0343 entry `curves`, ADR 0346; the prototype's Voice curves):
// a dialog of kind "time" with a lane per target (gain dB, pitch st, pan %, low-pass and high-pass Hz on a log scale),
// each driven by voice time or by one of the playlist's parameters (local or global), and the dialog's result turned
// back into the entry's `curves`: only lanes that changed are written, a lane left flat at its plain value and not
// bypassed has no curve, and the Apply is one undo step labelled "Automate Gain · dirt_02" (one lane) or
// "Edit dirt_02 curves" (more). Each lane may also follow a second parameter ("And by", ADR 0362 §5): the dialog offers
// the playlist's parameters as second inputs and Apply writes the lane's `by` (a lane with one is never "flat").
// Pure.
import { TIME_INPUT, withEnds, type CurveEditorResult, type CurveEditorSpec, type CurveInput as DialogInput, type CurveLane } from "../../../editor/ui/curves/curveEditorModel";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { VOICE_CURVE_TARGETS } from "../../../engine/audio/playlist/format";
import type { CurveInput, VoiceCurve, VoiceCurveTarget } from "../../../engine/audio/playlist/types";
import type { Curve } from "../../../engine/core/curve";
import { curveByOf, curvesLabel, inputHistogram, laneByOf, parameterInputId, parameterInputs, parameterOfInput, secondInputsOf } from "../curveInputs";

export type VoiceCurves = Partial<Record<VoiceCurveTarget, VoiceCurve>>;

/** Each target's lane: name, unit, range, step, scale and plain value (what no curve means). */
export const VOICE_CURVE_LANES: Readonly<Record<VoiceCurveTarget, Omit<CurveLane, "id" | "curve" | "input" | "bypass">>> = {
  gain: { name: "Gain", unit: "dB", min: -60, max: 12, step: 0.1, base: 0 },
  pitch: { name: "Pitch", unit: "st", min: -24, max: 24, step: 0.1, base: 0 },
  pan: { name: "Pan", unit: "%", min: -100, max: 100, step: 1, base: 0 },
  lowpass: { name: "Low-pass", unit: "Hz", min: 20, max: 20000, step: 1, scale: "log", base: 20000 },
  highpass: { name: "High-pass", unit: "Hz", min: 20, max: 20000, step: 1, scale: "log", base: 20 },
};

/** The voice time axis is at least this long, seconds. */
const MIN_LENGTH = 2;

/** What the Playlists screen opens the curve editor with. */
export interface VoiceCurveDialog {
  readonly spec: CurveEditorSpec;
  /** The entry's name ("dirt_02"): the target, and the owner in undo labels. */
  readonly owner: string;
  readonly histogram?: readonly number[];
  /** The curves as they were. */
  readonly curves: VoiceCurves;
}

const inputId = (input: CurveInput): string => (typeof input === "string" ? TIME_INPUT : parameterInputId(input.parameter));

/** The time axis: long enough for every time-driven key, at least 2 s, in half seconds. */
function lengthOf(curves: VoiceCurves): number {
  let end = MIN_LENGTH;
  for (const c of Object.values(curves)) if (c && typeof c.input === "string") for (const k of c.curve) end = Math.max(end, k[0]);
  return Math.ceil(end * 2) / 2;
}

/**
 * The dialog for an entry's `curves`, with the parameters the playlist can use (`parameters`, test values in
 * `values`). A curve driven by a parameter that isn't among them gets an input over its keys' span, so it opens as it is.
 */
export function voiceCurveDialog(owner: string, curves: VoiceCurves, parameters: readonly ParameterDef[], values: Readonly<Record<string, number>> = {}): VoiceCurveDialog {
  const inputs: DialogInput[] = parameterInputs(parameters, values);
  for (const c of Object.values(curves)) {
    if (!c || typeof c.input === "string" || inputs.some((i) => i.id === inputId(c.input))) continue;
    const xs = c.curve.map((k) => k[0]);
    const min = xs.length ? Math.min(...xs) : 0;
    const max = xs.length ? Math.max(...xs) : 1;
    inputs.push({ id: inputId(c.input), name: `${c.input.parameter} (unknown)`, min, max: max > min ? max : min + 1 });
  }
  const lanes: CurveLane[] = VOICE_CURVE_TARGETS.map((t) => {
    const c = curves[t];
    const by = laneByOf(c?.by);
    return { id: t, ...VOICE_CURVE_LANES[t], curve: c?.curve ?? [], ...(c ? { input: inputId(c.input), bypass: c.bypass } : {}), ...(by ? { by } : {}) };
  });
  const seconds = VOICE_CURVE_TARGETS.flatMap((t) => (curves[t]?.by ? [curves[t]!.by!.input] : []));
  const secondInputs = secondInputsOf(parameters, values, parameterInputId, seconds);
  const spec: CurveEditorSpec = { kind: "time", timeName: "Voice time", length: lengthOf(curves), lanes, inputs, ...(secondInputs.length ? { secondInputs } : {}) };
  const first = VOICE_CURVE_TARGETS.map((t) => curves[t]).find((c) => c !== undefined);
  const histogram = first ? inputHistogram(inputId(first.input), inputs) : undefined;
  return { spec, owner, curves, ...(histogram ? { histogram } : {}) };
}

const flatAt = (c: Curve, y: number) => c.length > 0 && c.every((k) => k[1] === y);

/** The domain of input `id` in `spec`. */
function domain(spec: CurveEditorSpec, id: string): [number, number] {
  if (id === TIME_INPUT) return [0, spec.length ?? MIN_LENGTH];
  const i = spec.inputs?.find((x) => x.id === id);
  return i ? [i.min, i.max] : [0, 1];
}

/**
 * The entry's curves after the dialog's `result`, and the undo label; null when nothing changed. A lane driven by
 * time keeps the time it had (clip or sequence time on a curve that had one), else voice time.
 */
export function applyVoiceCurveResult(dialog: VoiceCurveDialog, result: CurveEditorResult): { curves: VoiceCurves; label: string } | null {
  const next: VoiceCurves = { ...dialog.curves };
  const changed: string[] = [];
  for (const r of result.lanes) {
    if (!(VOICE_CURVE_TARGETS as readonly string[]).includes(r.id)) continue;
    const t = r.id as VoiceCurveTarget;
    const lane = VOICE_CURVE_LANES[t];
    const was = dialog.curves[t];
    const parameter = parameterOfInput(r.input);
    const input: CurveInput = parameter !== null ? { parameter } : was && typeof was.input === "string" ? was.input : "voiceTime";
    const by = curveByOf(r.by, parameter === null);
    const withBy = by ? { by } : {};
    const none = !r.bypass && flatAt(r.curve, lane.base) && !by;
    if (!was) {
      if (none) continue;
      next[t] = { input, curve: r.curve, bypass: r.bypass, ...withBy };
      changed.push(lane.name);
      continue;
    }
    if (none) {
      delete next[t];
      changed.push(lane.name);
      continue;
    }
    const [a, b] = domain(dialog.spec, inputId(was.input));
    const same =
      inputId(was.input) === r.input &&
      was.bypass === r.bypass &&
      JSON.stringify(was.by ?? null) === JSON.stringify(by ?? null) &&
      (JSON.stringify(was.curve) === JSON.stringify(r.curve) || JSON.stringify(withEnds(was.curve, a, b, lane)) === JSON.stringify(r.curve));
    if (same) continue;
    // A quantised curve stays quantised while it is still keyed on a parameter (quantize means nothing on time).
    next[t] = { input, curve: r.curve, bypass: r.bypass, ...(was.quantize !== undefined && parameter !== null ? { quantize: was.quantize } : {}), ...withBy };
    changed.push(lane.name);
  }
  const label = curvesLabel(dialog.owner, changed);
  return label === null ? null : { curves: next, label };
}
