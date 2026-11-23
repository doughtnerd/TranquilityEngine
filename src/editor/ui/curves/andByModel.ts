/**
 * "And by" (owner spec §5.1; decided, UI pass decisions): a curve's second input. A lane driven by its own input (time, a
 * game parameter, distance) can also follow a second game parameter:
 *
 * - **Morph** blends between the lane's curve (Low) and a High curve by where the second input sits (0 at its minimum,
 *   1 at its maximum).
 * - **Scale** multiplies the lane's value by a curve over the second input (0..2×).
 * - **Rate** (time lanes only) runs the clock faster or slower by a curve over the second input (0.25..4×).
 * - A **labelled** second input (a surface, a game state) gives one curve per label: the first label is the lane's own
 *   curve, the others start as copies of it; the Table shows one value per label instead.
 *
 * The layers are edited in the same plot as the lane: the dialog asks `layerView` for a lane and a curve to show, and
 * writes the edit back with `writeLayer`. A host offers second inputs with `CurveEditorSpec.secondInputs` and reads each
 * lane's `by` from Apply's result (a host that doesn't, offers none: the bar doesn't show).
 *
 * Pure: no DOM.
 */
import { evalCurve, type Curve, type CurveKey } from "../../../engine/core/curve";
import { axisOf, evalLane, laneOf, withEnds, withLane, type CurveDraft, type CurveEditorSpec, type CurveInput, type CurveLane, type DraftLane } from "./curveEditorModel";

/** A game parameter a lane may also follow; `labels` makes it discrete (one curve per label). */
export interface SecondInput extends CurveInput {
  readonly labels?: readonly string[];
}

export type ByMode = "morph" | "scale" | "rate" | "labels";

/** A lane's second input and its layer. Curves are in the lane's units (morph, labels) or × (scale, rate). */
export interface LaneBy {
  readonly input: string;
  readonly mode: ByMode;
  /** Morph: the High curve (over the lane's own input). Scale and Rate: the × curve over the second input. */
  readonly curve?: readonly CurveKey[];
  /** Labels: the curve of each label after the first (a label without one uses the lane's curve). */
  readonly labels?: Readonly<Record<string, readonly CurveKey[]>>;
}

/** Which curve the plot edits: the lane's own, Morph's High, Scale's or Rate's ×, or a label's. */
export type ByLayer = "main" | "high" | "scale" | "rate" | `label:${string}`;

export const MODE_LABELS: Readonly<Record<ByMode, string>> = { morph: "Morph", scale: "Scale", rate: "Rate", labels: "Per label" };

/** The second inputs a lane may follow: every offered one but the input already driving it. */
export function secondChoices(spec: CurveEditorSpec, laneInput: string): SecondInput[] {
  return (spec.secondInputs ?? []).filter((i) => i.id !== laneInput);
}

export const secondInput = (spec: CurveEditorSpec, id: string): SecondInput | undefined => spec.secondInputs?.find((i) => i.id === id);

/** The modes a second input offers: a labelled one is per label; a scalar one Morph and Scale, and Rate on time lanes. */
export function byModes(spec: CurveEditorSpec, input: SecondInput, laneInput: string): ByMode[] {
  if (input.labels?.length) return ["labels"];
  return axisOf(spec, laneInput).kind === "time" ? ["morph", "scale", "rate"] : ["morph", "scale"];
}

const flat = (a: number, b: number, v: number): CurveKey[] => [[a, v], [b, v]];
const domain = (i: SecondInput): [number, number] => [i.min, i.max > i.min ? i.max : i.min + 1];

/** The layer a mode starts with: Morph's High is a copy of the lane's curve; Scale and Rate are flat at 1×. */
function startLayer(state: DraftLane, input: SecondInput, mode: ByMode): LaneBy {
  if (mode === "morph") return { input: input.id, mode, curve: state.curve.slice() };
  if (mode === "labels") return { input: input.id, mode, labels: {} };
  const [a, b] = domain(input);
  return { input: input.id, mode, curve: flat(a, b, 1) };
}

/** Lane `id` follows second input `input` (null: Nothing) in its first mode, or keeps its layer when it already does. */
export function setBy(spec: CurveEditorSpec, draft: CurveDraft, id: string, input: string | null): CurveDraft {
  const found = laneOf(spec, draft, id);
  if (!found) return draft;
  if (input === null) return withLane(draft, id, { by: undefined });
  const si = secondInput(spec, input);
  if (!si || found.state.by?.input === input) return draft;
  return withLane(draft, id, { by: startLayer(found.state, si, byModes(spec, si, found.state.input)[0]!) });
}

/** Lane `id`'s second input in mode `mode` (a fresh layer for that mode). */
export function setByMode(spec: CurveEditorSpec, draft: CurveDraft, id: string, mode: ByMode): CurveDraft {
  const found = laneOf(spec, draft, id);
  const by = found?.state.by;
  const si = by && secondInput(spec, by.input);
  if (!found || !by || !si || by.mode === mode || !byModes(spec, si, found.state.input).includes(mode)) return draft;
  return withLane(draft, id, { by: startLayer(found.state, si, mode) });
}

/** The layers the bar's second segmented control offers for a lane's mode, with their names. */
export function layersOf(spec: CurveEditorSpec, by: LaneBy | undefined): { id: ByLayer; label: string }[] {
  if (!by) return [{ id: "main", label: "Curve" }];
  if (by.mode === "morph") return [{ id: "main", label: "Low" }, { id: "high", label: "High" }];
  if (by.mode === "scale") return [{ id: "main", label: "Curve" }, { id: "scale", label: "×" }];
  if (by.mode === "rate") return [{ id: "main", label: "Curve" }, { id: "rate", label: "Rate" }];
  const labels = secondInput(spec, by.input)?.labels ?? [];
  return labels.map((l, i) => ({ id: i === 0 ? "main" : (`label:${l}` as ByLayer), label: l }));
}

/** The spec the plot runs on: the second inputs join the inputs (so a × layer has an axis). */
export function layerSpec(spec: CurveEditorSpec): CurveEditorSpec {
  const extra = (spec.secondInputs ?? []).filter((s) => !(spec.inputs ?? []).some((i) => i.id === s.id));
  return extra.length ? { ...spec, inputs: [...(spec.inputs ?? []), ...extra] } : spec;
}

/** The × lane of a Scale (0..2×) or Rate (0.25..4×, in octaves) layer. */
function multiplierLane(lane: CurveLane, mode: "scale" | "rate", curve: Curve): CurveLane {
  return mode === "scale"
    ? { id: lane.id, name: `${lane.name} ×`, unit: "×", min: 0, max: 2, step: 0.01, base: 1, color: lane.color, curve }
    : { id: lane.id, name: `${lane.name} rate`, unit: "×", min: 0.25, max: 4, step: 0.01, scale: "log", base: 1, color: lane.color, curve };
}

/**
 * What the plot shows for `layer` of lane `id`: a spec and draft in which that lane is the layer (its lane, curve and
 * input), so the plot's own edits apply to it; `writeLayer` puts the result back. Null when the lane has no such layer.
 */
export function layerView(spec: CurveEditorSpec, draft: CurveDraft, id: string, layer: ByLayer): { spec: CurveEditorSpec; draft: CurveDraft } | null {
  const found = laneOf(spec, draft, id);
  if (!found) return null;
  const { lane, state } = found;
  const by = state.by;
  const base = layerSpec(spec);
  if (layer === "main") return { spec: base, draft };
  if (!by) return null;
  const swap = (l: CurveLane, curve: readonly CurveKey[], input: string) => ({
    spec: { ...base, lanes: base.lanes.map((x) => (x.id === id ? l : x)) },
    draft: withLane(draft, id, { curve, input, bypass: false }),
  });
  if (layer === "high" && by.mode === "morph") return swap(lane, by.curve ?? state.curve, state.input);
  if ((layer === "scale" || layer === "rate") && by.mode === layer) {
    const si = secondInput(spec, by.input);
    if (!si) return null;
    const [a, b] = domain(si);
    const curve = withEnds(by.curve ?? [], a, b, { base: 1 });
    return swap(multiplierLane(lane, layer, curve), curve, by.input);
  }
  if (layer.startsWith("label:") && by.mode === "labels") return swap(lane, by.labels?.[layer.slice(6)] ?? state.curve, state.input);
  return null;
}

/** `draft` with `curve` written into `layer` of lane `id`. */
export function writeLayer(draft: CurveDraft, id: string, layer: ByLayer, curve: readonly CurveKey[]): CurveDraft {
  if (layer === "main") return withLane(draft, id, { curve });
  const state = draft.lanes.find((l) => l.id === id);
  const by = state?.by;
  if (!by) return draft;
  if (layer.startsWith("label:")) return withLane(draft, id, { by: { ...by, labels: { ...by.labels, [layer.slice(6)]: curve } } });
  return withLane(draft, id, { by: { ...by, curve } });
}

/** Where `at` sits on a second input, 0..1. */
const share = (i: SecondInput, at: number) => {
  const [a, b] = domain(i);
  return Math.min(1, Math.max(0, (at - a) / (b - a)));
};

/**
 * The lane's value at `x` with the second input at `at` (the plot's dashed "Preview at" line): Morph's blend of Low and
 * High, Scale's product, Rate's clock run at the rate (x × rate, held at the end), a label's curve. Null when the lane
 * follows nothing.
 */
export function previewValue(spec: CurveEditorSpec, draft: CurveDraft, id: string, x: number, at: number): number | null {
  const found = laneOf(spec, draft, id);
  const by = found?.state.by;
  const si = by && secondInput(spec, by.input);
  if (!found || !by || !si) return null;
  const { lane, state } = found;
  const main = (t: number) => evalLane(lane, state.curve, t);
  if (by.mode === "morph") {
    const w = share(si, at);
    return main(x) * (1 - w) + evalLane(lane, by.curve ?? state.curve, x) * w;
  }
  if (by.mode === "scale") return main(x) * evalCurve(by.curve ?? flat(si.min, si.max, 1), at);
  if (by.mode === "rate") {
    const ax = axisOf(spec, state.input);
    return main(Math.min(ax.max, ax.min + (x - ax.min) * evalCurve(by.curve ?? flat(si.min, si.max, 1), at)));
  }
  const labels = si.labels ?? [];
  const label = labels[Math.round(Math.min(labels.length - 1, Math.max(0, at)))];
  const curve = label && label !== labels[0] ? by.labels?.[label] : undefined;
  return evalLane(lane, curve ?? state.curve, x);
}

/** One row of the Table (a labelled second input): the label, and its value when its curve is flat, else its key count. */
export interface LabelRow {
  readonly label: string;
  readonly layer: ByLayer;
  /** Its value when flat (one value everywhere), else null. */
  readonly value: number | null;
  readonly keys: number;
}

const flatValue = (curve: readonly CurveKey[]): number | null => (curve.every((k) => Math.abs(k[1] - curve[0]![1]) < 1e-9 && k.length === 2) ? curve[0]![1] : null);

export function labelRows(spec: CurveEditorSpec, draft: CurveDraft, id: string): LabelRow[] {
  const found = laneOf(spec, draft, id);
  const by = found?.state.by;
  const labels = by?.mode === "labels" ? (secondInput(spec, by.input)?.labels ?? []) : [];
  return labels.map((label, i) => {
    const curve = i === 0 ? found!.state.curve : (by!.labels?.[label] ?? found!.state.curve);
    return { label, layer: i === 0 ? "main" : (`label:${label}` as ByLayer), value: flatValue(curve), keys: curve.length };
  });
}

/** Label `layer`'s curve set flat at `value` over the lane's domain (the Table's field). */
export function setLabelValue(spec: CurveEditorSpec, draft: CurveDraft, id: string, layer: ByLayer, value: number): CurveDraft {
  const found = laneOf(spec, draft, id);
  if (!found) return draft;
  const ax = axisOf(spec, found.state.input);
  return writeLayer(draft, id, layer, flat(ax.min, ax.max, value));
}
