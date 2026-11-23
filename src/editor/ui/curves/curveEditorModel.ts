/**
 * The curve editor's model (ADR 0346): every rule of the one shared curve editor, with no DOM, so it is tested headless
 * and the view (`CurveEditorDialog.tsx`) only draws and forwards pointer positions.
 *
 * - A dialog edits **lanes**, one curve per property (`CurveLane`), in the property's own units. Each lane is driven by
 *   an **input**: the dialog's time axis (`"time"`, 0..length), the distance axis (`"distance"`, 0..axis end, with the
 *   Min/Max handles) or one of the host's parameters (`inputs`, min..max). The plot shows the active lane's input.
 * - The edits live in a **draft** (`CurveDraft`): the lanes' keys, inputs and bypass, and Min/Max. The dialog keeps the
 *   draft in its own panel history (ADR 0145) and hands it back in units through `draftResult` on Apply.
 * - Keys are engine curve keys (`core/curve.ts`). Every curve has a key at each end of its domain; end keys move
 *   vertically only and can't be deleted. Pointer positions come in as x in the axis's units and y normalised to 0..1
 *   over the lane's range (log lanes in octaves, ADR 0345's `scale`), quantised to 1/200 of it.
 * - Edits a user can get refused return `{ next } | { refused }` (ADR 0307, 0313); the view shows the reason.
 */
import { curveKeyHandles, evalCurve, type Curve, type CurveHandles, type CurveKey, type CurveKeyInterp } from "../../../engine/core/curve";
import { axisTicks } from "./keyList";

// --- types -----------------------------------------------------------------------------------------------------------

export type CurveEditorKind = "time" | "parameter" | "distance";
/** A key's segment shape: the engine's interps plus Bézier. */
export type KeyShape = CurveKeyInterp;

/** The shapes in the toolbar's order, with their names (the prototype's six modes). */
export const KEY_SHAPES: readonly KeyShape[] = ["linear", "smooth", "easeIn", "easeOut", "step", "bezier"];
export const SHAPE_LABELS: Readonly<Record<KeyShape, string>> = {
  linear: "Linear",
  smooth: "S-curve (flat tangents)",
  easeIn: "Ease in",
  easeOut: "Ease out",
  step: "Stepped",
  bezier: "Bézier (drag the handles)",
};

/** The input id of the dialog's time axis and of its distance axis; any other id names one of `inputs`. */
export const TIME_INPUT = "time";
export const DISTANCE_INPUT = "distance";

/** One property the dialog edits. Values (`min`, `max`, `base`, keys' y) are in `unit`. */
export interface CurveLane {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  /** The step of typed values (and their shown precision). */
  readonly step: number;
  /** `"log"` lanes interpolate and draw in octaves (a filter cutoff); needs `0 < min < max`. */
  readonly scale?: "linear" | "log";
  /** An on/off property: keys step between `min` (off) and `max` (on). */
  readonly bool?: boolean;
  /** Series colour index, 1..8 (`--series-N`); default by position. */
  readonly color?: number;
  /** The plain value: what Clear flattens to and what a bypassed lane uses. */
  readonly base: number;
  readonly curve: Curve;
  /** What drives it: `"time"`, `"distance"` or an input's id. Default: the dialog kind's own axis. */
  readonly input?: string;
  /** Keeps the keys but uses the plain value. */
  readonly bypass?: boolean;
}

/** A parameter a lane may be driven by. */
export interface CurveInput {
  readonly id: string;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly unit?: string;
  /** The game's value now (the "now" marker and the readout). */
  readonly now?: number;
}

/** What a dialog edits and over what. */
export interface CurveEditorSpec {
  readonly kind: CurveEditorKind;
  readonly lanes: readonly CurveLane[];
  readonly inputs?: readonly CurveInput[];
  /** The time axis's length in seconds (time kind, or lanes that may be driven by time). */
  readonly length?: number;
  /** The time axis's name ("Voice time", "Sample time"). */
  readonly timeName?: string;
  /** Distance: Min and Max in metres (keys stretch with them). */
  readonly minDistance?: number;
  readonly maxDistance?: number;
  /** Distance: where the axis ends; default max(60, Max × 1.5). */
  readonly distanceAxis?: number;
  /** The game's value now (parameter kind without inputs) or the listener's distance (distance kind). */
  readonly now?: number;
  /** Parameter kind without inputs: the parameter's name, range and unit. */
  readonly parameter?: { readonly name: string; readonly min: number; readonly max: number; readonly unit?: string };
  /** Keys are linear only (a particle curve): no shape tools, only presets made of linear keys. */
  readonly linearOnly?: boolean;
}

/** One lane's edited state. */
export interface DraftLane {
  readonly id: string;
  readonly curve: readonly CurveKey[];
  readonly input: string;
  readonly bypass: boolean;
}

/** Everything Apply returns; what the dialog's history holds. */
export interface CurveDraft {
  readonly lanes: readonly DraftLane[];
  readonly minDistance: number;
  readonly maxDistance: number;
}

/** Apply's payload: curves in units with each lane's input and bypass; Min/Max for distance. */
export interface CurveEditorResult {
  readonly kind: CurveEditorKind;
  readonly lanes: readonly { readonly id: string; readonly curve: CurveKey[]; readonly input: string; readonly bypass: boolean }[];
  readonly minDistance?: number;
  readonly maxDistance?: number;
}

/** An axis a lane runs over. */
export interface CurveAxis {
  readonly id: string;
  readonly name: string;
  readonly kind: CurveEditorKind;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  /** Where x snaps to. */
  readonly snap: number;
  /** The input's value now (parameter, distance); time's "now" is the playhead, which the view holds. */
  readonly now?: number;
}

/** The next value, or why the edit was refused (nothing changes). */
export type CurveEdit<T> = { readonly next: T } | { readonly refused: string };
const accept = <T>(next: T): CurveEdit<T> => ({ next });
const refuse = (reason: string): { readonly refused: string } => ({ refused: reason });

// --- numbers ---------------------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const EPS = 1e-9;
/** A float without noise (6 significant figures). */
export const tidy = (v: number): number => (v === 0 ? 0 : Number(v.toPrecision(6)));
const decimalsOf = (step: number): number => {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
};
/** `x` rounded to a multiple of `step`, without float noise. */
export function snapTo(x: number, step: number): number {
  if (!(step > 0)) return x;
  return Number((Math.round(x / step) * step).toFixed(decimalsOf(step) + 2));
}

// --- axes ------------------------------------------------------------------------------------------------------------

/** The default distance axis end. */
export const distanceAxisEnd = (spec: CurveEditorSpec): number => spec.distanceAxis ?? Math.max(60, Math.ceil((spec.maxDistance ?? 40) * 1.5));
const paramSnap = (span: number) => (span > 20 ? 1 : 0.01);

/** The axis `input` names in this dialog (an unknown input falls back to the kind's own axis). */
export function axisOf(spec: CurveEditorSpec, input: string): CurveAxis {
  const found = spec.inputs?.find((i) => i.id === input);
  if (found) return { id: found.id, name: found.name, kind: "parameter", min: found.min, max: found.max > found.min ? found.max : found.min + 1, unit: found.unit ?? "", snap: paramSnap(found.max - found.min), now: found.now };
  if (input === TIME_INPUT) return { id: TIME_INPUT, name: spec.timeName ?? "Time", kind: "time", min: 0, max: spec.length && spec.length > 0 ? spec.length : 1, unit: "s", snap: 0.01 };
  if (input === DISTANCE_INPUT) return { id: DISTANCE_INPUT, name: "Distance", kind: "distance", min: 0, max: distanceAxisEnd(spec), unit: "m", snap: 0.1, now: spec.now };
  if (input === "parameter" && spec.parameter) {
    const p = spec.parameter;
    const max = p.max > p.min ? p.max : p.min + 1;
    return { id: "parameter", name: p.name, kind: "parameter", min: p.min, max, unit: p.unit ?? "", snap: paramSnap(max - p.min), now: spec.now };
  }
  return axisOf(spec, defaultInput(spec));
}

/** The input a lane without one is driven by. */
export function defaultInput(spec: CurveEditorSpec): string {
  if (spec.kind === "time") return TIME_INPUT;
  if (spec.kind === "distance") return DISTANCE_INPUT;
  if (spec.parameter) return "parameter";
  return spec.inputs?.[0]?.id ?? TIME_INPUT;
}

/** The inputs a lane may switch between ("Driven by"): only offered with more than one. */
export function inputChoices(spec: CurveEditorSpec): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  if (spec.kind === "time" || (spec.length ?? 0) > 0) out.push({ id: TIME_INPUT, name: spec.timeName ?? "Time" });
  if (spec.kind === "distance") out.push({ id: DISTANCE_INPUT, name: "Distance" });
  if (spec.parameter) out.push({ id: "parameter", name: spec.parameter.name });
  for (const i of spec.inputs ?? []) out.push({ id: i.id, name: i.name });
  return out;
}

/** Axis labels: `n` positions (`[min, max]` ends included) inside `range`. */
export function xTicks(axis: CurveAxis, range: readonly [number, number]): number[] {
  const inner = axisTicks(range, axis.kind === "distance" ? 7 : 5);
  return [range[0], ...inner, range[1]];
}

/** An x value as the axis shows it. */
export function formatX(axis: CurveAxis, x: number): string {
  if (axis.kind === "time") return `${x.toFixed(2)} s`;
  if (axis.kind === "distance") return `${x.toFixed(1)} m`;
  const v = axis.max - axis.min > 20 ? String(Math.round(x)) : x.toFixed(2);
  return axis.unit ? `${v} ${axis.unit}` : v;
}

// --- values ----------------------------------------------------------------------------------------------------------

const isLog = (lane: CurveLane) => lane.scale === "log" && lane.min > 0 && lane.max > lane.min;
const span = (lane: CurveLane) => (lane.max - lane.min) || 1;

/** A value as 0..1 over the lane's range (octaves for log lanes); not clamped. */
export function toNorm(lane: CurveLane, v: number): number {
  if (isLog(lane)) return Math.log(Math.max(lane.min * 1e-6, v) / lane.min) / Math.log(lane.max / lane.min);
  return (v - lane.min) / span(lane);
}

/** The inverse of `toNorm`. */
export function fromNorm(lane: CurveLane, n: number): number {
  if (isLog(lane)) return lane.min * Math.pow(lane.max / lane.min, n);
  return lane.min + n * span(lane);
}

/**
 * The value a pointer at `yNorm` sets: quantised to 1/200 of the range and clamped into it; on/off for a switch. A
 * linear range holding 0 quantises on a grid through 0 (so 0 dB can be hit); otherwise the grid starts at the bottom
 * (in octaves on a log lane).
 */
export function valueAt(lane: CurveLane, yNorm: number): number {
  if (lane.bool) return yNorm >= 0.5 ? lane.max : lane.min;
  if (yNorm >= 1 - 1 / 400) return lane.max;
  if (yNorm <= 1 / 400) return lane.min;
  if (!isLog(lane) && lane.min < 0 && lane.max > 0) {
    const q = span(lane) / 200;
    return tidy(clamp(Math.round(fromNorm(lane, yNorm) / q) * q, lane.min, lane.max));
  }
  return tidy(fromNorm(lane, clamp(Math.round(yNorm * 200) / 200, 0, 1)));
}

/** A handle offset `[dx, dy]` (units) from a key at `y` as a normalised offset. */
function handleToNorm(lane: CurveLane, y: number, h: readonly [number, number]): [number, number] {
  return [h[0], toNorm(lane, y + h[1]) - toNorm(lane, y)];
}
/** A normalised handle offset from a key at `y` as a units offset. */
function handleFromNorm(lane: CurveLane, y: number, h: readonly [number, number]): [number, number] {
  return [tidy(h[0]), tidy(fromNorm(lane, toNorm(lane, y) + h[1]) - y)];
}

const keyShape = (k: CurveKey): KeyShape => (k.length > 2 ? (k[2] as KeyShape) : "linear");
/** A key with a new position, keeping its shape and handles. */
const at = (k: CurveKey, x: number, y: number): CurveKey => (k.length === 2 ? [x, y] : k.length === 3 ? [x, y, k[2]] : [x, y, "bezier", k[3]]);
const shaped = (x: number, y: number, shape: KeyShape, handles?: CurveHandles): CurveKey =>
  shape === "bezier" ? [x, y, "bezier", handles ?? { in: [0, 0], out: [0, 0] }] : shape === "linear" ? [x, y] : [x, y, shape];

/** The curve in normalised y (handles too), so a log lane interpolates in octaves. */
export function normCurve(lane: CurveLane, curve: Curve): CurveKey[] {
  return curve.map((k) => {
    const h = curveKeyHandles(k);
    const y = toNorm(lane, k[1]);
    if (!h) return at(k, k[0], y);
    const handles: CurveHandles = { in: handleToNorm(lane, k[1], h.in), out: handleToNorm(lane, k[1], h.out), ...(h.free ? { free: true } : {}) };
    return [k[0], y, "bezier", handles];
  });
}

/** The lane's value at `x`: the engine evaluator, in octaves for a log lane (ADR 0346 "units in, units out"). */
export function evalLane(lane: CurveLane, curve: Curve, x: number): number {
  if (!isLog(lane)) return evalCurve(curve, x);
  return fromNorm(lane, evalCurve(normCurve(lane, curve), x));
}

/**
 * Points to draw the lane over `range`: `[x, yNorm]`, `n` even samples plus each key (and just before it, so a step
 * draws as a riser), in x order.
 */
export function samplePath(lane: CurveLane, curve: Curve, range: readonly [number, number], n = 240): [number, number][] {
  const norm = normCurve(lane, curve);
  const [a, b] = range;
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) xs.push(a + ((b - a) * i) / n);
  const w = (b - a) * 1e-6;
  for (const k of norm) if (k[0] > a && k[0] < b) xs.push(k[0] - w, k[0]);
  xs.sort((p, q) => p - q);
  return xs.map((x) => [x, evalCurve(norm, x)]);
}

/** A value as the readout and the axis show it: the lane's step precision and unit, On/Off, −∞ dB at a dB floor. */
export function formatValue(lane: CurveLane, v: number): string {
  if (lane.bool) return v >= (lane.min + lane.max) / 2 ? "On" : "Off";
  if (lane.unit === "dB" && v <= lane.min && lane.min <= -60) return "−∞ dB";
  const text = v.toFixed(decimalsOf(lane.step)).replace("-", "−");
  const shown = /^−?0(\.0+)?$/.test(text) ? text.replace("−", "") : text;
  return lane.unit ? `${shown} ${lane.unit}` : shown;
}

/** A typed value as stored: clamped into the range, rounded to the lane's precision; on/off for a switch. */
export function typedValue(lane: CurveLane, v: number): number {
  if (lane.bool) return v >= (lane.min + lane.max) / 2 ? lane.max : lane.min;
  return Number(clamp(v, lane.min, lane.max).toFixed(decimalsOf(lane.step) + 2));
}

/** The top, middle and bottom labels of the y axis (the middle is the geometric middle on a log lane). */
export function yLabels(lane: CurveLane): [string, string, string] {
  return [formatValue(lane, lane.max), lane.bool ? "" : formatValue(lane, fromNorm(lane, 0.5)), formatValue(lane, lane.min)];
}

/** The lane's colour token. */
export const laneColor = (lane: CurveLane, index: number): string => `var(--series-${lane.color && lane.color >= 1 && lane.color <= 8 ? Math.floor(lane.color) : (index % 8) + 1})`;

// --- end keys --------------------------------------------------------------------------------------------------------

/**
 * `curve` with a key at each end of `[a, b]`: keys outside the domain are dropped and an end without a key gains one
 * holding the curve's value there (so the curve evaluates the same inside the domain). An empty curve becomes flat at
 * `base`. A switch's keys step.
 */
export function withEnds(curve: Curve, a: number, b: number, lane: Pick<CurveLane, "base" | "bool">): CurveKey[] {
  const flatShape: KeyShape = lane.bool ? "step" : "linear";
  if (curve.length === 0) return [shaped(a, lane.base, flatShape), shaped(b, lane.base, flatShape)];
  const tol = (b - a) * 1e-9 + EPS;
  const inside = curve.filter((k) => k[0] >= a - tol && k[0] <= b + tol).map((k) => (Math.abs(k[0] - a) <= tol ? at(k, a, k[1]) : Math.abs(k[0] - b) <= tol ? at(k, b, k[1]) : k));
  const out: CurveKey[] = inside.slice();
  if (!out.length || out[0][0] > a) out.unshift(shaped(a, evalCurve(curve, a), flatShape));
  if (out[out.length - 1][0] < b) out.push(shaped(b, evalCurve(curve, b), flatShape));
  return out;
}

const isEnd = (curve: Curve, i: number) => i === 0 || i === curve.length - 1;

// --- the draft -------------------------------------------------------------------------------------------------------

/** A lane's domain: its axis's range. */
export function domainOf(spec: CurveEditorSpec, input: string): [number, number] {
  const ax = axisOf(spec, input);
  return [ax.min, ax.max];
}

/** The draft a dialog opens with: each lane's keys (with ends), input and bypass, and Min/Max. */
export function createDraft(spec: CurveEditorSpec): CurveDraft {
  const lanes = spec.lanes.map((l): DraftLane => {
    const input = l.input && inputChoices(spec).some((c) => c.id === l.input) ? l.input : defaultInput(spec);
    const [a, b] = domainOf(spec, input);
    return { id: l.id, curve: withEnds(l.curve, a, b, l), input, bypass: !!l.bypass };
  });
  const minDistance = Math.max(0, spec.minDistance ?? 2);
  const maxDistance = Math.max(minDistance + 1, spec.maxDistance ?? 40);
  return { lanes, minDistance, maxDistance };
}

/** The lane spec and its draft state. */
export function laneOf(spec: CurveEditorSpec, draft: CurveDraft, id: string): { lane: CurveLane; state: DraftLane; index: number } | null {
  const index = spec.lanes.findIndex((l) => l.id === id);
  const state = draft.lanes.find((l) => l.id === id);
  return index < 0 || !state ? null : { lane: spec.lanes[index], state, index };
}

/** `draft` with lane `id`'s state changed. */
export function withLane(draft: CurveDraft, id: string, patch: Partial<Omit<DraftLane, "id">>): CurveDraft {
  return { ...draft, lanes: draft.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

/** Whether two drafts differ (what the footer's "Unsaved changes" reads). */
export function draftChanged(a: CurveDraft, b: CurveDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** What Apply returns: fresh curves in units. */
export function draftResult(spec: CurveEditorSpec, draft: CurveDraft): CurveEditorResult {
  const lanes = draft.lanes.map((l) => ({ id: l.id, curve: l.curve.map((k) => at(k, k[0], k[1])), input: l.input, bypass: l.bypass }));
  return spec.kind === "distance" ? { kind: spec.kind, lanes, minDistance: draft.minDistance, maxDistance: draft.maxDistance } : { kind: spec.kind, lanes };
}

// --- key edits -------------------------------------------------------------------------------------------------------

/** What a key edit needs to know about its lane. */
export interface LaneContext {
  readonly lane: CurveLane;
  readonly axis: CurveAxis;
  readonly linearOnly: boolean;
}

export function laneContext(spec: CurveEditorSpec, draft: CurveDraft, id: string): LaneContext | null {
  const found = laneOf(spec, draft, id);
  return found ? { lane: found.lane, axis: axisOf(spec, found.state.input), linearOnly: !!spec.linearOnly } : null;
}

export interface SnapOptions {
  /** Snap x to the axis's step (Alt turns it off). Default true. */
  readonly snap?: boolean;
}

/**
 * A key added at `x` (snapped, clamped into the domain) with the value under `yNorm`. Refused within half a snap step
 * of an existing key. It takes the shape of the key before it, so the segment it splits keeps its shape (a switch's
 * keys step; a Bézier key gets handles from its neighbours).
 */
export function addKey(ctx: LaneContext, curve: Curve, x: number, yNorm: number, opts: SnapOptions = {}): CurveEdit<{ curve: CurveKey[]; index: number }> {
  return insertKey(ctx, curve, x, valueAt(ctx.lane, yNorm), opts);
}

/** `addKey` with the value given in units (a key at the playhead holds the curve's value exactly). */
function insertKey(ctx: LaneContext, curve: Curve, x: number, value: number, opts: SnapOptions): CurveEdit<{ curve: CurveKey[]; index: number }> {
  const { axis, lane } = ctx;
  const px = clamp(opts.snap === false ? x : snapTo(x, axis.snap), axis.min, axis.max);
  if (curve.some((k) => Math.abs(k[0] - px) < axis.snap / 2)) return refuse("a key is already there");
  let index = curve.findIndex((k) => k[0] > px);
  if (index < 0) index = curve.length;
  const before = index > 0 ? keyShape(curve[index - 1]) : "linear";
  const shape: KeyShape = lane.bool ? "step" : ctx.linearOnly ? "linear" : before;
  const next = curve.slice();
  next.splice(index, 0, shaped(px, lane.bool ? typedValue(lane, value) : value, shape === "bezier" ? "linear" : shape));
  if (shape === "bezier") {
    const set = setKeyShape(ctx, next, index, "bezier");
    if ("next" in set) return accept({ curve: set.next, index });
  }
  return accept({ curve: next, index });
}

/**
 * Key `index` dragged to `x`, `yNorm`: x snaps (unless `snap: false`) and stays a snap step inside its neighbours; an
 * end key keeps its x. The value is quantised; shape and handles are kept.
 */
export function moveKey(ctx: LaneContext, curve: Curve, index: number, x: number, yNorm: number, opts: SnapOptions = {}): CurveKey[] {
  const k = curve[index];
  if (!k) return curve.slice();
  const nx = isEnd(curve, index) ? k[0] : clampBetween(ctx, curve, index, opts.snap === false ? x : snapTo(x, ctx.axis.snap));
  const next = curve.slice();
  next[index] = at(k, nx, valueAt(ctx.lane, yNorm));
  return next;
}

/** `x` kept a snap step inside key `index`'s neighbours (or where it is when they're closer than that). */
function clampBetween(ctx: LaneContext, curve: Curve, index: number, x: number): number {
  const s = ctx.axis.snap;
  const lo = index > 0 ? curve[index - 1][0] + s : ctx.axis.min;
  const hi = index < curve.length - 1 ? curve[index + 1][0] - s : ctx.axis.max;
  if (lo > hi) return curve[index][0];
  return clamp(x, lo, hi);
}

/** Key `index` moved to `x` (the key field, the dope sheet, Move to playhead). End keys stay where they are. */
export function setKeyX(ctx: LaneContext, curve: Curve, index: number, x: number, opts: SnapOptions = {}): CurveEdit<CurveKey[]> {
  const k = curve[index];
  if (!k) return refuse("no such key");
  if (isEnd(curve, index)) return refuse("end keys stay at the ends");
  if (!Number.isFinite(x)) return refuse("not a number");
  const next = curve.slice();
  next[index] = at(k, clampBetween(ctx, curve, index, opts.snap === false ? x : snapTo(x, ctx.axis.snap)), k[1]);
  return accept(next);
}

/** Key `index` set to the typed `value` (units): clamped into the range, on/off for a switch. */
export function setKeyValue(ctx: LaneContext, curve: Curve, index: number, value: number): CurveEdit<CurveKey[]> {
  const k = curve[index];
  if (!k) return refuse("no such key");
  if (!Number.isFinite(value)) return refuse("not a number");
  const next = curve.slice();
  next[index] = at(k, k[0], typedValue(ctx.lane, value));
  return accept(next);
}

/** `curve` without key `index`. End keys can't be deleted, and a curve keeps at least two keys. */
export function deleteKey(curve: Curve, index: number): CurveEdit<CurveKey[]> {
  if (index < 0 || index >= curve.length) return refuse("no such key");
  if (isEnd(curve, index)) return refuse("end keys can't be deleted");
  return accept(curve.filter((_, i) => i !== index));
}

/** Why a shape can't be set on this lane, or null. */
export function shapeRefusal(ctx: LaneContext, shape: KeyShape): string | null {
  if (ctx.lane.bool && shape !== "step") return "an on/off property steps";
  if (ctx.linearOnly && shape !== "linear") return "this curve's keys are linear";
  return null;
}

/**
 * Key `index`'s shape set. Setting Bézier derives the handles from the neighbours' slope (Catmull-like, each handle
 * (next.x − prev.x) / 6 long, in normalised y so a log lane's handles follow octaves), mirrored.
 */
export function setKeyShape(ctx: LaneContext, curve: Curve, index: number, shape: KeyShape): CurveEdit<CurveKey[]> {
  const k = curve[index];
  if (!k) return refuse("no such key");
  const why = shapeRefusal(ctx, shape);
  if (why) return refuse(why);
  const next = curve.slice();
  if (shape !== "bezier") {
    next[index] = shaped(k[0], k[1], shape);
    return accept(next);
  }
  const { lane, axis } = ctx;
  const w = axis.max - axis.min;
  const prev = curve[index - 1];
  const after = curve[index + 1];
  const d = ((after ? after[0] : k[0] + w * 0.2) - (prev ? prev[0] : k[0] - w * 0.2)) / 6;
  const slope = prev && after && after[0] > prev[0] ? (toNorm(lane, after[1]) - toNorm(lane, prev[1])) / (after[0] - prev[0]) : 0;
  next[index] = [k[0], k[1], "bezier", { in: handleFromNorm(lane, k[1], [-d, -slope * d]), out: handleFromNorm(lane, k[1], [d, slope * d]) }];
  return accept(next);
}

/** A Bézier key's handles made free (each side on its own) or mirrored again. */
export function setKeyFree(curve: Curve, index: number, free: boolean): CurveEdit<CurveKey[]> {
  const k = curve[index];
  const h = k && curveKeyHandles(k);
  if (!h) return refuse("only a Bézier key has handles");
  const next = curve.slice();
  next[index] = [k[0], k[1], "bezier", { in: h.in, out: h.out, ...(free ? { free: true } : {}) }];
  return accept(next);
}

/**
 * A Bézier key's `which` handle dragged to `x`, `yNorm` (absolute): an out handle stays right of the key and an in
 * handle left of it (at least half a snap step); unless the key's handles are free, the other side mirrors it.
 */
export function dragHandle(ctx: LaneContext, curve: Curve, index: number, which: "in" | "out", x: number, yNorm: number): CurveKey[] {
  const k = curve[index];
  const h = k && curveKeyHandles(k);
  if (!h) return curve.slice();
  const { lane, axis } = ctx;
  const dx = which === "out" ? Math.max(axis.snap / 2, x - k[0]) : Math.min(-axis.snap / 2, x - k[0]);
  const dy = yNorm - toNorm(lane, k[1]);
  const moved = handleFromNorm(lane, k[1], [dx, dy]);
  const mirror = handleFromNorm(lane, k[1], [-dx, -dy]);
  const handles: CurveHandles =
    which === "out" ? { in: h.free ? h.in : mirror, out: moved, ...(h.free ? { free: true } : {}) } : { in: moved, out: h.free ? h.out : mirror, ...(h.free ? { free: true } : {}) };
  const next = curve.slice();
  next[index] = [k[0], k[1], "bezier", handles];
  return next;
}

/** A key's handle positions as absolute `[x, yNorm]`, or null when it isn't Bézier. The ends show only their inner one. */
export function handlePoints(lane: CurveLane, curve: Curve, index: number): { in?: [number, number]; out?: [number, number] } | null {
  const k = curve[index];
  const h = k && curveKeyHandles(k);
  if (!h) return null;
  const point = (o: readonly [number, number]): [number, number] => [k[0] + o[0], toNorm(lane, k[1] + o[1])];
  return { ...(index > 0 ? { in: point(h.in) } : {}), ...(index < curve.length - 1 ? { out: point(h.out) } : {}) };
}

/** A key's shape (linear when it has none). */
export const shapeOf = keyShape;

// --- lanes -----------------------------------------------------------------------------------------------------------

/** Lane `id` driven by `input`: its keys' x and handle dx rescale from the old domain to the new one. */
export function setLaneInput(spec: CurveEditorSpec, draft: CurveDraft, id: string, input: string): CurveEdit<CurveDraft> {
  const found = laneOf(spec, draft, id);
  if (!found) return refuse("no such curve");
  if (!inputChoices(spec).some((c) => c.id === input)) return refuse("no such input");
  if (found.state.input === input) return accept(draft);
  const [f0, f1] = domainOf(spec, found.state.input);
  const [t0, t1] = domainOf(spec, input);
  const r = (t1 - t0 || 1) / (f1 - f0 || 1);
  const curve = found.state.curve.map((k): CurveKey => {
    const x = tidy(t0 + (k[0] - f0) * r);
    const h = curveKeyHandles(k);
    if (!h) return at(k, x, k[1]);
    return [x, k[1], "bezier", { in: [tidy(h.in[0] * r), h.in[1]], out: [tidy(h.out[0] * r), h.out[1]], ...(h.free ? { free: true } : {}) }];
  });
  return accept(withLane(draft, id, { input, curve: withEnds(curve, t0, t1, found.lane) }));
}

/** Lane `id` cleared: flat at its plain value across its domain, and on again. */
export function clearLane(spec: CurveEditorSpec, draft: CurveDraft, id: string): CurveEdit<CurveDraft> {
  const found = laneOf(spec, draft, id);
  if (!found) return refuse("no such curve");
  const [a, b] = domainOf(spec, found.state.input);
  return accept(withLane(draft, id, { curve: withEnds([], a, b, found.lane), bypass: false }));
}

/** Whether a curve changes anywhere (more than two keys, or keys at different values). */
export function isShaped(curve: Curve): boolean {
  return curve.length > 2 || curve.some((k) => Math.abs(k[1] - curve[0][1]) > 1e-9);
}

/** The properties list's note: "N keys" or "constant". */
export const keyCountText = (curve: Curve): string => (isShaped(curve) ? `${curve.length} keys` : "constant");

/** Each lane's value at its probe (the playhead for time lanes, the input's now, the listener), as the readout shows it. */
export function readout(spec: CurveEditorSpec, draft: CurveDraft, playhead: number): { id: string; name: string; text: string }[] {
  return spec.lanes.map((lane) => {
    const state = draft.lanes.find((l) => l.id === lane.id)!;
    if (state.bypass) return { id: lane.id, name: lane.name, text: `${formatValue(lane, lane.base)} · off` };
    const axis = axisOf(spec, state.input);
    const probe = axis.kind === "time" ? playhead : axis.now ?? (axis.min + axis.max) / 2;
    return { id: lane.id, name: lane.name, text: formatValue(lane, evalLane(lane, state.curve, probe)) };
  });
}

/** Where the readout reads: "At the playhead, 0.60 s". */
export function readoutHeading(axis: CurveAxis, playhead: number): string {
  if (axis.kind === "time") return `At the playhead, ${formatX(axis, playhead)}`;
  const now = axis.now ?? (axis.min + axis.max) / 2;
  return axis.kind === "distance" ? `At the listener, ${formatX(axis, now)}` : `At game now, ${formatX(axis, now)}`;
}

// --- distance --------------------------------------------------------------------------------------------------------

/**
 * Min and Max moved, with every distance lane's keys stretched with them (the attenuation format's `stretchAttenuation`
 * maths up to Max: keys inside Min scale with Min, keys between map onto the new span; beyond Max keys compress toward
 * the axis end so the end key stays there). Handle dx scales with its region. Min is kept ≥ 0.5 m and 1 m inside Max;
 * Max inside the axis. Values snap to 0.1 m.
 */
export function stretchDistance(spec: CurveEditorSpec, draft: CurveDraft, newMin: number, newMax: number): CurveDraft {
  const end = distanceAxisEnd(spec);
  const oMin = draft.minDistance, oMax = draft.maxDistance;
  const nMax = clamp(snapTo(newMax, 0.1), Math.min(end, Math.max(1.5, snapTo(newMin, 0.1) + 1)), end);
  const nMin = clamp(snapTo(newMin, 0.1), 0.5, Math.max(0.5, nMax - 1));
  const factor = (x: number) => (x <= oMin ? (oMin > 0 ? nMin / oMin : 1) : x <= oMax ? (nMax - nMin) / (oMax - oMin || 1) : (end - nMax) / (end - oMax || 1));
  const map = (x: number) => (x <= oMin ? (oMin > 0 ? (x * nMin) / oMin : x) : x <= oMax ? nMin + ((x - oMin) * (nMax - nMin)) / (oMax - oMin || 1) : nMax + ((x - oMax) * (end - nMax)) / (end - oMax || 1));
  const lanes = draft.lanes.map((l) => {
    if (l.input !== DISTANCE_INPUT) return l;
    const curve = l.curve.map((k): CurveKey => {
      const x = tidy(map(k[0]));
      const h = curveKeyHandles(k);
      if (!h) return at(k, x, k[1]);
      const f = factor(k[0]);
      return [x, k[1], "bezier", { in: [tidy(h.in[0] * f), h.in[1]], out: [tidy(h.out[0] * f), h.out[1]], ...(h.free ? { free: true } : {}) }];
    });
    return { ...l, curve };
  });
  return { lanes, minDistance: nMin, maxDistance: nMax };
}

// --- presets ---------------------------------------------------------------------------------------------------------

export type BuiltInPreset = "flat" | "linear" | "easeIn" | "easeOut" | "sCurve" | "inverseSquare";

/** A preset as the strip shows it. `icon` is an SVG path in a 40 × 24 box. */
export interface PresetInfo {
  readonly id: BuiltInPreset;
  readonly name: string;
  readonly tip: string;
  readonly icon: string;
}

const PRESETS: Readonly<Record<BuiltInPreset, PresetInfo>> = {
  inverseSquare: { id: "inverseSquare", name: "Inverse square", tip: "Physically based roll-off between Min and Max", icon: "M2 2H8C12 14 20 20 38 22" },
  flat: { id: "flat", name: "Flat", tip: "The same value everywhere", icon: "M2 12H38" },
  linear: { id: "linear", name: "Linear", tip: "Straight line between the ends", icon: "M2 22L38 2" },
  easeIn: { id: "easeIn", name: "Ease in", tip: "Slow start, fast finish", icon: "M2 22C24 22 34 14 38 2" },
  easeOut: { id: "easeOut", name: "Ease out", tip: "Fast start, slow finish", icon: "M2 22C6 10 16 2 38 2" },
  sCurve: { id: "sCurve", name: "S-curve", tip: "Flat at both ends", icon: "M2 22C20 22 20 2 38 2" },
};

/** The presets offered for this lane: Inverse square for a distance lane in dB; only linear ones for a linear-only curve; Flat for a switch. */
export function presetsFor(ctx: LaneContext): PresetInfo[] {
  if (ctx.lane.bool) return [PRESETS.flat];
  const ids: BuiltInPreset[] = ctx.linearOnly ? ["flat", "linear"] : ["flat", "linear", "easeIn", "easeOut", "sCurve"];
  if (ctx.axis.kind === "distance" && ctx.lane.unit === "dB") ids.unshift("inverseSquare");
  return ids.map((id) => PRESETS[id]);
}

/** The span presets apply over: Min..Max for distance, else the whole domain. */
export function presetSpan(ctx: LaneContext, draft: CurveDraft): [number, number] {
  return ctx.axis.kind === "distance" ? [draft.minDistance, draft.maxDistance] : [ctx.axis.min, ctx.axis.max];
}

/**
 * The curve preset `id` gives this lane: between the span's ends, from the curve's value at the start to its value at
 * the end (from the bottom of the range to the top when those are equal). A distance span starting past 0 leads with a
 * key at 0 holding the start value. Inverse square is 0 dB to Min, −20·log10(d/Min) between Min and Max (6 keys), then
 * silence just past Max.
 */
export function presetCurve(ctx: LaneContext, draft: CurveDraft, curve: Curve, id: BuiltInPreset): CurveKey[] {
  const { lane, axis } = ctx;
  const [a, b] = presetSpan(ctx, draft);
  let ya = evalLane(lane, curve, a);
  let yb = evalLane(lane, curve, b);
  if (Math.abs(toNorm(lane, ya) - toNorm(lane, yb)) < 1e-6 && id !== "flat") {
    ya = lane.min;
    yb = lane.max;
  }
  const lead = (keys: CurveKey[]): CurveKey[] => (a > axis.min ? [[axis.min, ya] as CurveKey, ...keys] : keys);
  let keys: CurveKey[];
  switch (id) {
    case "flat":
      keys = [shaped(axis.min, ya, lane.bool ? "step" : "linear"), shaped(axis.max, ya, lane.bool ? "step" : "linear")];
      break;
    case "linear":
      keys = lead([[a, ya], [b, yb]]);
      break;
    case "easeIn":
      keys = lead([[a, ya, "easeIn"], [b, yb]]);
      break;
    case "easeOut":
      keys = lead([[a, ya, "easeOut"], [b, yb]]);
      break;
    case "sCurve":
      keys = lead([[a, ya, "smooth"], [b, yb]]);
      break;
    case "inverseSquare": {
      const top = clamp(0, lane.min, lane.max);
      keys = a > axis.min ? [[axis.min, top]] : [];
      const minD = Math.max(a, 1e-3);
      for (let i = 0; i <= 5; i++) {
        const d = minD * Math.pow(b / minD, i / 5);
        keys.push([tidy(d), tidy(clamp(top - 20 * Math.log10(d / minD), lane.min, lane.max))]);
      }
      if (b + 0.1 < axis.max) keys.push([tidy(b + 0.1), lane.min]);
      break;
    }
  }
  return withEnds(keys, axis.min, axis.max, lane);
}

/** A user preset: keys with x and y normalised to 0..1 (handles too), so it fits any lane. */
export interface UserPreset {
  readonly name: string;
  readonly keys: readonly CurveKey[];
}

/** The lane's curve over the preset span as a user preset named "My curve N" (the first free N), appended to `list`. */
export function saveUserPreset(ctx: LaneContext, draft: CurveDraft, curve: Curve, list: readonly UserPreset[]): CurveEdit<UserPreset[]> {
  const [a, b] = presetSpan(ctx, draft);
  const d = b - a || 1;
  const norm = normCurve(ctx.lane, curve).filter((k) => k[0] >= a - EPS && k[0] <= b + EPS);
  if (norm.length === 0) return refuse("the curve has no keys in its span");
  const keys = norm.map((k): CurveKey => {
    const x = tidy((k[0] - a) / d);
    const y = tidy(k[1]);
    const h = curveKeyHandles(k);
    if (!h) return at(k, x, y);
    return [x, y, "bezier", { in: [tidy(h.in[0] / d), tidy(h.in[1])], out: [tidy(h.out[0] / d), tidy(h.out[1])], ...(h.free ? { free: true } : {}) }];
  });
  let n = 1;
  while (list.some((p) => p.name === `My curve ${n}`)) n++;
  return accept([...list, { name: `My curve ${n}`, keys }]);
}

/** A user preset laid over the lane's preset span (values from its normalised y). */
export function applyUserPreset(ctx: LaneContext, draft: CurveDraft, preset: UserPreset): CurveKey[] {
  const { lane, axis } = ctx;
  const [a, b] = presetSpan(ctx, draft);
  const d = b - a || 1;
  const keys = preset.keys.map((k): CurveKey => {
    const x = tidy(a + k[0] * d);
    const yn = clamp(k[1], 0, 1);
    const y = lane.bool ? (yn >= 0.5 ? lane.max : lane.min) : tidy(fromNorm(lane, yn));
    const h = curveKeyHandles(k);
    if (lane.bool) return [x, y, "step"];
    if (ctx.linearOnly) return [x, y];
    if (!h) return at(k, x, y);
    return [x, y, "bezier", { in: handleFromNorm(lane, y, [h.in[0] * d, h.in[1]]), out: handleFromNorm(lane, y, [h.out[0] * d, h.out[1]]), ...(h.free ? { free: true } : {}) }];
  });
  return withEnds(keys, axis.min, axis.max, lane);
}

/** User presets from the stored preference, leniently: anything that isn't `{ name, keys }` with valid keys is dropped. */
export function parseUserPresets(raw: unknown): UserPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: UserPreset[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object" || typeof (p as { name?: unknown }).name !== "string" || !Array.isArray((p as { keys?: unknown }).keys)) continue;
    const keys = ((p as { keys: unknown[] }).keys).filter((k): k is CurveKey => Array.isArray(k) && k.length >= 2 && Number.isFinite(k[0]) && Number.isFinite(k[1]));
    if (keys.length) out.push({ name: (p as { name: string }).name, keys });
  }
  return out;
}

/** A user preset's icon: its curve sampled into the 40 × 24 box. */
export function presetIcon(preset: UserPreset): string {
  const pts: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    pts.push(`${(2 + u * 36).toFixed(1)} ${(22 - clamp(evalCurve(preset.keys, u), 0, 1) * 20).toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}

// --- time view: playhead, visible range, dope sheet --------------------------------------------------------------------

/** A range dragged on the ruler, or null when it is under 3% of the length (a click). Clamped into 0..length. */
export function rulerRange(x0: number, x1: number, length: number): [number, number] | null {
  const a = clamp(Math.min(x0, x1), 0, length);
  const b = clamp(Math.max(x0, x1), 0, length);
  return b - a > length * 0.03 ? [a, b] : null;
}

/** The playhead after a click on the ruler: clamped and rounded to 0.01 s. */
export const playheadAt = (x: number, length: number): number => snapTo(clamp(x, 0, length), 0.01);

/** A key added on the lane at the playhead, holding the curve's value there. */
export function keyAtPlayhead(ctx: LaneContext, curve: Curve, playhead: number): CurveEdit<{ curve: CurveKey[]; index: number }> {
  return insertKey(ctx, curve, playhead, tidy(evalLane(ctx.lane, curve, playhead)), { snap: true });
}

/** The lanes the dope sheet lists: those driven by time. */
export function dopeLanes(spec: CurveEditorSpec, draft: CurveDraft): string[] {
  return draft.lanes.filter((l) => l.input === TIME_INPUT).map((l) => l.id);
}
