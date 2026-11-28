/**
 * Ghost layouts (ADR 0033, T11): which values of a replicated node are sent, in what order, and
 * how each is encoded and interpolated. A layout is one flat record, encoded with the codec
 * (`recordCodec`) so changes are delta-compressed field by field:
 *
 * 1. `Replicated`'s `ownerId` (i32) and `mode` (u8: 0 interpolated, 1 predicted).
 * 2. With `replicateTransform`: local position x, y, z (to 1 mm), rotation as a quaternion
 *    x, y, z, w (steps of 0.0005, under 0.06° of error), scale x, y, z (to 0.001). A 2D node only
 *    changes x, y and the quaternion's z and w, and an unchanged field costs one bit.
 * 3. Each replicated data component (`replicate(def, …)`) on the node, by id: its chosen fields,
 *    with their `encoding`.
 * 4. Each of the node's own behaviors with fields declared `@field(Number | Boolean,
 *    { replicate: true })` (or `predicted`), in component order: numbers as f32 (with their
 *    `quantize`), booleans as u8. String fields replicate outside the layout, whole when they
 *    change (`strings.ts`, ADR 0068); fields of other types aren't replicated (warned once).
 *
 * A layout's predicted values (T13, `predictedPlan` at the bottom) are the transform, the data
 * fields listed in `replicate(def, { predicted })` and the behavior fields declared `predicted`;
 * on the owning client `prediction.ts` simulates them instead of taking received states.
 *
 * Both ends build a layout from a `LayoutSpec` (sent with the ghost's spawn). The spec carries each
 * component's field shapes (type and quantize step), so a client can always decode a ghost's
 * record: parts for a component it doesn't know, or whose fields differ from the server's, are
 * decoded and ignored (warned once) instead of making the whole snapshot unreadable.
 */
import type { Component } from "../../core/Component";
import { getDataComponentDef, f32, i32, u8, type DataComponentDef, type ScalarType } from "../../core/data";
import { getComponentClass, getComponentId, getFields, type ComponentClass } from "../../core/registry";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { fieldSignature, recordCodec, type FieldEncoding, type RecordCodec } from "../codec";
import type { Replicated } from "../Replicated";
import { replicationOf } from "../replication";

const SCALARS: Record<ScalarType["kind"], ScalarType> = { f32, i32, u8 };

/** Position step: 1 mm. */
export const POSITION_STEP = 0.001;
/** Quaternion component step. */
export const ROTATION_STEP = 0.0005;
/** Scale step. */
export const SCALE_STEP = 0.001;

/** A ghost's values, in layout order. Never mutated once stored (states are shared between peers and ticks). */
export type GhostState = readonly number[];

/** One replicated field as it's encoded: its type and quantize step (0: full precision). */
export interface FieldShape {
  readonly kind: ScalarType["kind"];
  readonly quantize: number;
}

/** What a ghost replicates, as sent in its spawn. */
export interface LayoutSpec {
  readonly transform: boolean;
  /** Replicated data components, by id (sorted), with their fields' shapes. */
  readonly data: readonly { readonly id: string; readonly fields: readonly FieldShape[] }[];
  /** Behaviors with replicated fields: component id, which of the node's components of that class (0 = first), and the fields' shapes. */
  readonly behaviors: readonly { readonly id: string; readonly index: number; readonly fields: readonly FieldShape[] }[];
}

/** How a field is interpolated: lerped, part of the rotation quaternion, or snapped. */
const SNAP = 0;
const LERP = 1;
const ROTATION = 2;

interface BehaviorField {
  readonly name: string;
  readonly boolean: boolean;
  readonly quantize?: number;
  /** Declared `predicted` (T13). */
  readonly predicted: boolean;
}

type Part =
  | { readonly kind: "transform"; readonly at: number }
  | { readonly kind: "data"; readonly def: DataComponentDef; readonly fields: readonly string[]; readonly at: number }
  | { readonly kind: "behavior"; readonly type: ComponentClass; readonly index: number; readonly fields: readonly BehaviorField[]; readonly at: number }
  /** A component this end doesn't know, or knows differently: decoded (the shapes say how) and ignored. */
  | { readonly kind: "ignored"; readonly at: number };

export interface Layout {
  /** The spec as a string: equal strings, equal layouts. */
  readonly key: string;
  readonly spec: LayoutSpec;
  readonly codec: RecordCodec;
  readonly size: number;
  /** @internal */ readonly parts: readonly Part[];
  /** @internal Per field: SNAP, LERP or ROTATION. */
  readonly interpolation: Uint8Array;
}

/** Layouts by spec key, with what the spec's components resolved to when each was made (`resolvedFor`). */
const layouts = new Map<string, { readonly layout: Layout; readonly resolved: readonly unknown[] }>();
const behaviorFieldCache = new Map<ComponentClass, readonly BehaviorField[]>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${message}`);
}

/** A behavior class's replicated fields (numbers and booleans), cached. */
export function behaviorFields(type: ComponentClass): readonly BehaviorField[] {
  let out = behaviorFieldCache.get(type);
  if (out) return out;
  const list: BehaviorField[] = [];
  for (const f of getFields(type)) {
    if (!f.options?.replicate && !f.options?.predicted) continue;
    if (f.type === String) continue; // sent whole when it changes, outside the layout (ADR 0068, `strings.ts`)
    if (f.type !== Number && f.type !== Boolean) {
      warnOnce(`${type.name}.${f.name}`, `${getComponentId(type) ?? type.name}.${f.name} is declared with replicate, but only Number, Boolean and String fields replicate; it isn't sent.`);
      continue;
    }
    list.push({ name: f.name, boolean: f.type === Boolean, quantize: f.type === Number ? f.options.quantize : undefined, predicted: !!f.options.predicted });
  }
  behaviorFieldCache.set(type, (out = list));
  return out;
}

const shapesKey = (fields: readonly FieldShape[]) => fields.map((f) => fieldSignature(f.kind, f.quantize)).join(" ");

function specKey(spec: LayoutSpec): string {
  return `${spec.transform ? "T" : "-"}|${spec.data.map((d) => `${d.id}(${shapesKey(d.fields)})`).join(",")}|${spec.behaviors.map((b) => `${b.id}#${b.index}(${shapesKey(b.fields)})`).join(",")}`;
}

/** The shapes of a data component's replicated fields, as this end defines them. */
function dataShapes(def: DataComponentDef): FieldShape[] {
  const options = replicationOf(def);
  if (!options) return [];
  return (options.fields ?? def.fields).map((f) => {
    const kind = def.schema[f].kind;
    return { kind, quantize: kind === "f32" ? Math.fround(options.encoding?.[f]?.quantize ?? 0) : 0 }; // float32, as the spawn carries it
  });
}

/** The shapes of a behavior class's replicated fields, as this end defines them. */
function behaviorShapes(type: ComponentClass): FieldShape[] {
  return behaviorFields(type).map((f) => ({ kind: f.boolean ? "u8" : "f32", quantize: f.boolean ? 0 : Math.fround(f.quantize ?? 0) }));
}

const sameShapes = (a: readonly FieldShape[], b: readonly FieldShape[]) => a.length === b.length && a.every((f, i) => f.kind === b[i].kind && f.quantize === b[i].quantize);

/**
 * The layout for `spec` (cached). Its record follows the spec's shapes, so it always decodes; a
 * component this end lacks, or defines with other fields, becomes an ignored part (warned once).
 */
export function layoutOf(spec: LayoutSpec): Layout {
  const key = specKey(spec);
  const resolved = resolvedFor(spec);
  const cached = layouts.get(key);
  if (cached && cached.resolved.every((r, i) => r === resolved[i])) return cached.layout;

  const schema: Record<string, ScalarType> = {};
  const encoding: Record<string, FieldEncoding> = {};
  const interpolation: number[] = [];
  const parts: Part[] = [];
  const add = (type: ScalarType, how: number, quantize?: number) => {
    const name = String(interpolation.length);
    schema[name] = type;
    if (quantize !== undefined) encoding[name] = { quantize };
    interpolation.push(how);
  };

  add(i32, SNAP); // ownerId
  add(u8, SNAP); // mode
  if (spec.transform) {
    parts.push({ kind: "transform", at: interpolation.length });
    for (let i = 0; i < 3; i++) add(f32, LERP, POSITION_STEP);
    for (let i = 0; i < 4; i++) add(f32, ROTATION, ROTATION_STEP);
    for (let i = 0; i < 3; i++) add(f32, LERP, SCALE_STEP);
  }
  const addShapes = (fields: readonly FieldShape[]) => {
    for (const f of fields) add(SCALARS[f.kind], f.kind === "f32" ? LERP : SNAP, f.quantize || undefined);
  };
  for (const d of spec.data) {
    const def = getDataComponentDef(d.id);
    const at = interpolation.length;
    if (def && replicationOf(def) && sameShapes(dataShapes(def), d.fields)) {
      parts.push({ kind: "data", def, fields: replicationOf(def)!.fields ?? def.fields, at });
    } else {
      warnOnce(`data:${d.id}`, `Replicated data component "${d.id}" ${def ? "is replicated differently here than on the server" : "isn't defined here"}; its values are ignored.`);
      parts.push({ kind: "ignored", at });
    }
    addShapes(d.fields);
  }
  for (const b of spec.behaviors) {
    const type = getComponentClass(b.id);
    const at = interpolation.length;
    if (type && sameShapes(behaviorShapes(type), b.fields)) {
      parts.push({ kind: "behavior", type, index: b.index, fields: behaviorFields(type), at });
    } else {
      warnOnce(`behavior:${b.id}`, `Replicated fields of "${b.id}" ${type ? "differ here from the server's" : "belong to a component that isn't registered here"}; they're ignored.`);
      parts.push({ kind: "ignored", at });
    }
    addShapes(b.fields);
  }

  const layout: Layout = {
    key,
    spec,
    codec: recordCodec(schema, encoding),
    size: interpolation.length,
    parts,
    interpolation: Uint8Array.from(interpolation),
  };
  layouts.set(key, { layout, resolved });
  return layout;
}

/**
 * What a spec's components resolve to here now: each data component's definition and replication
 * options, and each behavior's class. Scripts loaded again (the editor reloads them, ADR 0030; a
 * dedicated server's tests load a project more than once) register new ones under the same ids,
 * so a cached layout, which holds the old ones, is only reused while these are unchanged.
 */
function resolvedFor(spec: LayoutSpec): unknown[] {
  const out: unknown[] = [];
  for (const d of spec.data) {
    const def = getDataComponentDef(d.id);
    out.push(def, def ? replicationOf(def) : null);
  }
  for (const b of spec.behaviors) out.push(getComponentClass(b.id));
  return out;
}

/** Server: the spec of a replicated node as it is now. */
export function specOf(world: World, node: GameObject, rep: Replicated): LayoutSpec {
  const data = world
    ._dataComponentsOf(node.entity)
    .filter((def) => replicationOf(def))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((def) => ({ id: def.id, fields: dataShapes(def) }));
  const behaviors: { id: string; index: number; fields: FieldShape[] }[] = [];
  const seen = new Map<ComponentClass, number>();
  for (const c of world._componentsOf(node.entity)) {
    const type = c.constructor as ComponentClass;
    const index = seen.get(type) ?? 0;
    seen.set(type, index + 1);
    if (c === (rep as Component)) continue;
    const id = getComponentId(type);
    if (!id || behaviorFields(type).length === 0) continue;
    behaviors.push({ id, index, fields: behaviorShapes(type) });
  }
  return { transform: rep.replicateTransform && !!node.transform, data, behaviors };
}

/** Server: read a node's values in layout order. */
export function readState(layout: Layout, node: GameObject, rep: Replicated): GhostState {
  const world = node.world;
  const e = node.entity;
  const out = new Array<number>(layout.size);
  out[0] = rep.ownerId | 0;
  out[1] = rep.mode === "predicted" ? 1 : 0;
  for (const part of layout.parts) {
    let at = part.at;
    if (part.kind === "transform") {
      for (let i = 0; i < 3; i++) out[at++] = world.tPos[e * 3 + i];
      for (let i = 0; i < 4; i++) out[at++] = world.tRot[e * 4 + i];
      for (let i = 0; i < 3; i++) out[at++] = world.tScl[e * 3 + i];
    } else if (part.kind === "ignored") {
      continue; // only a client builds these
    } else if (part.kind === "data") {
      const view = node.getData(part.def) as Record<string, number> | null;
      for (const f of part.fields) out[at++] = view ? view[f] : 0;
    } else {
      const c = node.getBehaviors(part.type as abstract new () => Component)[part.index] as unknown as Record<string, unknown> | undefined;
      for (const f of part.fields) {
        const v = c?.[f.name];
        out[at++] = f.boolean ? (v ? 1 : 0) : typeof v === "number" && Number.isFinite(v) ? v : 0;
      }
    }
  }
  return out;
}

/** Whether two states would encode the same: the layout's codec sees no changed field (`sameAt`). */
export function sameState(layout: Layout, a: GhostState, b: GhostState): boolean {
  const codec = layout.codec;
  for (let i = 0; i < layout.size; i++) if (!codec.sameAt(i, a[i], b[i])) return false;
  return true;
}

/** Client: where a ghost's values go on its node. Resolved once per node. */
export interface Binding {
  readonly node: GameObject;
  readonly rep: Replicated;
  /** Per part: a data view or a behavior, or null if the node has no such behavior here (per-World components). */
  readonly targets: readonly (Record<string, unknown> | null)[];
}

/** Client: bind a layout to a ghost's node. Replicated data components the node lacks are added. */
export function bind(layout: Layout, node: GameObject, rep: Replicated): Binding {
  const targets = layout.parts.map((part) => {
    if (part.kind === "transform") {
      if (!node.transform) node.world._addTransform(node.entity);
      return null;
    }
    if (part.kind === "ignored") return null;
    if (part.kind === "data") return (node.getData(part.def) ?? node.addData(part.def)) as Record<string, unknown>;
    return (node.getBehaviors(part.type as abstract new () => Component)[part.index] as unknown as Record<string, unknown>) ?? null;
  });
  return { node, rep, targets };
}

/**
 * Client: write values (in layout order) to the bound node. With `skipPredicted`, the values the
 * owning client predicts (T13, `predictedPlan`) are left alone: prediction owns them.
 */
export function applyState(layout: Layout, binding: Binding, values: ArrayLike<number>, skipPredicted = false): void {
  const { node, rep } = binding;
  rep.ownerId = values[0];
  rep.mode = values[1] === 1 ? "predicted" : "interpolated";
  const world = node.world;
  const e = node.entity;
  const skip = skipPredicted ? predictedPlan(layout).mask : null;
  layout.parts.forEach((part, p) => {
    let at = part.at;
    if (part.kind === "transform") {
      if (skip) return; // a replicated transform is always predicted
      let changed = false;
      const put = (array: Float32Array, offset: number, v: number) => {
        if (array[offset] !== Math.fround(v)) {
          array[offset] = v;
          changed = true;
        }
      };
      for (let i = 0; i < 3; i++) put(world.tPos, e * 3 + i, values[at++]);
      // Quantized components are a little off unit length; normalize.
      const len = Math.hypot(values[at], values[at + 1], values[at + 2], values[at + 3]) || 1;
      for (let i = 0; i < 4; i++) put(world.tRot, e * 4 + i, values[at++] / len);
      for (let i = 0; i < 3; i++) put(world.tScl, e * 3 + i, values[at++]);
      if (changed) world.markTransformDirty(e);
      return;
    }
    const target = binding.targets[p];
    if (!target || part.kind === "ignored") return;
    if (part.kind === "data") {
      for (const f of part.fields) {
        if (!skip?.[at]) target[f] = values[at];
        at++;
      }
    } else {
      for (const f of part.fields) {
        if (!skip?.[at]) target[f.name] = f.boolean ? values[at] !== 0 : values[at];
        at++;
      }
    }
  });
}

// --- prediction (T13, ADR 0312) -----------------------------------------------------------------

/** A predicted value's tolerance, relative to its size, for unquantized f32 fields. */
const F32_TOLERANCE = 1e-5;
/**
 * Two predicted rotations closer than this angle (radians) agree. Each received quaternion
 * component is off by up to half a `ROTATION_STEP`; a whole step on all four moves the rotation by
 * at most about 4 steps of angle (0.002 rad, 0.11°), so float noise never trips it.
 */
export const ROTATION_TOLERANCE = 4 * ROTATION_STEP;

/**
 * One run of predicted values at its layout index `at`. A predicted state is every slot's values,
 * in layout order: picking from a received state, reading the node, writing it and comparing all
 * walk the same slots.
 */
type Slot =
  /** 3 values each; compared one by one, each within its quantization step. */
  | { readonly kind: "position"; readonly at: number; readonly tolerance: number }
  | { readonly kind: "scale"; readonly at: number; readonly tolerance: number }
  /** 4 values, a quaternion; compared as a rotation (the angle between, q and -q the same). */
  | { readonly kind: "rotation"; readonly at: number }
  /** 1 value: a data or behavior field (its part and name in the binding). */
  | {
      readonly kind: "field";
      readonly at: number;
      readonly part: number;
      readonly name: string;
      readonly boolean: boolean;
      /** Integer (i32, u8, booleans): exact. Step: within `tolerance`. Relative (unquantized f32): within `tolerance` times its size (at least 1). */
      readonly compare: "integer" | "step" | "relative";
      readonly tolerance: number;
    };

const WIDTH = { position: 3, rotation: 4, scale: 3, field: 1 } as const;

/**
 * @internal T13: a layout's predicted values, which the owning client simulates instead of taking
 * received states (`prediction.ts`): the transform (if replicated), data fields listed in
 * `replicate(def, { predicted })` that are sent, and behavior fields declared `predicted`. The plan
 * owns their one order (layout order) for every operation on a predicted state.
 */
export class PredictedPlan {
  /** Per layout value: 1 if predicted (`applyState` leaves these alone on the owning client). */
  readonly mask: Uint8Array;
  /** Values in a predicted state. */
  readonly size: number;
  /** Whether the transform is predicted (it is whenever it's replicated). */
  readonly hasTransform: boolean;
  private readonly slots: readonly Slot[];

  constructor(layout: Layout) {
    const slots: Slot[] = [];
    layout.parts.forEach((part, p) => {
      if (part.kind === "transform") {
        slots.push({ kind: "position", at: part.at, tolerance: POSITION_STEP });
        slots.push({ kind: "rotation", at: part.at + 3 });
        slots.push({ kind: "scale", at: part.at + 7, tolerance: SCALE_STEP });
      } else if (part.kind === "data") {
        const predicted = replicationOf(part.def)?.predicted ?? [];
        for (const name of predicted) {
          if (!part.fields.includes(name)) warnOnce(`predicted:${part.def.id}.${name}`, `${part.def.id}.${name} is listed as predicted but isn't replicated (not in "fields"); it isn't predicted.`);
        }
        part.fields.forEach((name, i) => {
          if (predicted.includes(name)) slots.push(fieldSlot(layout, part.at + i, p, name, false));
        });
      } else if (part.kind === "behavior") {
        part.fields.forEach((f, i) => {
          if (f.predicted) slots.push(fieldSlot(layout, part.at + i, p, f.name, f.boolean));
        });
      }
    });
    slots.sort((a, b) => a.at - b.at);
    this.slots = slots;
    this.mask = new Uint8Array(layout.size);
    let size = 0;
    for (const s of slots) {
      this.mask.fill(1, s.at, s.at + WIDTH[s.kind]);
      size += WIDTH[s.kind];
    }
    this.size = size;
    this.hasTransform = slots.some((s) => s.kind === "position");
  }

  /** The predicted values of a full (received) state. */
  pick(state: GhostState): number[] {
    const out: number[] = [];
    for (const s of this.slots) for (let k = 0; k < WIDTH[s.kind]; k++) out.push(state[s.at + k]);
    return out;
  }

  /** The bound node's predicted values now. */
  read(binding: Binding): number[] {
    const out: number[] = [];
    const { node } = binding;
    const world = node.world;
    const e = node.entity;
    for (const s of this.slots) {
      if (s.kind === "position") for (let i = 0; i < 3; i++) out.push(world.tPos[e * 3 + i]);
      else if (s.kind === "rotation") for (let i = 0; i < 4; i++) out.push(world.tRot[e * 4 + i]);
      else if (s.kind === "scale") for (let i = 0; i < 3; i++) out.push(world.tScl[e * 3 + i]);
      else {
        const v = binding.targets[s.part]?.[s.name];
        out.push(s.boolean ? (v ? 1 : 0) : typeof v === "number" ? v : 0);
      }
    }
    return out;
  }

  /** Write predicted values (from `read` or `pick`) to the bound node. */
  apply(binding: Binding, values: ArrayLike<number>): void {
    const { node } = binding;
    const world = node.world;
    const e = node.entity;
    let at = 0;
    for (const s of this.slots) {
      if (s.kind === "position") {
        for (let i = 0; i < 3; i++) world.tPos[e * 3 + i] = values[at++];
      } else if (s.kind === "rotation") {
        // Received rotations are quantized, a little off unit length; normalize.
        const len = Math.hypot(values[at], values[at + 1], values[at + 2], values[at + 3]) || 1;
        for (let i = 0; i < 4; i++) world.tRot[e * 4 + i] = values[at++] / len;
      } else if (s.kind === "scale") {
        for (let i = 0; i < 3; i++) world.tScl[e * 3 + i] = values[at++];
      } else {
        const target = binding.targets[s.part];
        const v = values[at++];
        if (target) target[s.name] = s.boolean ? v !== 0 : v;
      }
    }
    if (this.hasTransform) world.markTransformDirty(e);
  }

  /**
   * How far a predicted state is from the server's: the largest difference of any value beyond its
   * tolerance (a rotation's in radians), or 0 if every value is within it (a correct prediction).
   */
  error(predicted: ArrayLike<number>, authoritative: ArrayLike<number>): number {
    let error = 0;
    let at = 0;
    for (const s of this.slots) {
      if (s.kind === "rotation") {
        const d = rotationError(predicted, authoritative, at);
        if (d > error) error = d;
      } else {
        for (let k = 0; k < WIDTH[s.kind]; k++) {
          const d = valueError(s, predicted[at + k], authoritative[at + k]);
          if (d > error) error = d;
        }
      }
      at += WIDTH[s.kind];
    }
    return error;
  }
}

function fieldSlot(layout: Layout, at: number, part: number, name: string, boolean: boolean): Slot {
  // A quantized value is off by up to half a step; allow one step, so float noise never trips it.
  const { codec } = layout;
  const step = codec.quantizeAt(at);
  if (step > 0) return { kind: "field", at, part, name, boolean, compare: "step", tolerance: step };
  if (codec.schema[codec.fields[at]].kind === "f32") return { kind: "field", at, part, name, boolean, compare: "relative", tolerance: F32_TOLERANCE };
  return { kind: "field", at, part, name, boolean, compare: "integer", tolerance: 0 };
}

/** One value's difference beyond its tolerance (0 within it; Infinity for NaN). */
function valueError(s: Exclude<Slot, { kind: "rotation" }>, a: number, b: number): number {
  if (s.kind === "field" && s.compare === "integer") return Math.abs((a | 0) - (b | 0));
  const d = Math.abs(Math.fround(a) - b);
  const tolerance = s.kind === "field" && s.compare === "relative" ? s.tolerance * Math.max(1, Math.abs(b)) : s.tolerance;
  if (d <= tolerance) return 0;
  return d > 0 ? d : Infinity; // NaN
}

/** The angle between the quaternions at `a[at..at+3]` and `b[at..at+3]` beyond `ROTATION_TOLERANCE` (0 within it; Infinity for NaN or a zero quaternion). */
function rotationError(a: ArrayLike<number>, b: ArrayLike<number>, at: number): number {
  const la = Math.hypot(a[at], a[at + 1], a[at + 2], a[at + 3]);
  const lb = Math.hypot(b[at], b[at + 1], b[at + 2], b[at + 3]);
  const dot = (a[at] * b[at] + a[at + 1] * b[at + 1] + a[at + 2] * b[at + 2] + a[at + 3] * b[at + 3]) / (la * lb);
  // q and -q are the same rotation: the angle uses |dot|.
  const angle = 2 * Math.acos(Math.min(1, Math.abs(dot)));
  if (angle <= ROTATION_TOLERANCE) return 0;
  return angle > 0 ? angle : Infinity; // NaN
}

const plans = new WeakMap<Layout, PredictedPlan>();

/** @internal T13: a layout's predicted plan (made once per layout). */
export function predictedPlan(layout: Layout): PredictedPlan {
  let plan = plans.get(layout);
  if (!plan) plans.set(layout, (plan = new PredictedPlan(layout)));
  return plan;
}

/**
 * Client: the values between `a` (t = 0) and `b` (t = 1), into `out`. Past 1 extrapolates: numbers
 * continue in a line, rotations keep turning; snapped fields take `b`'s value from t = 1 on and
 * `a`'s before.
 */
export function interpolate(layout: Layout, a: GhostState, b: GhostState, t: number, out: number[]): number[] {
  const how = layout.interpolation;
  for (let i = 0; i < layout.size; i++) {
    if (how[i] === LERP) out[i] = a[i] + (b[i] - a[i]) * t;
    else if (how[i] === SNAP) out[i] = t >= 1 ? b[i] : a[i];
    else {
      slerp(a, b, i, t, out);
      i += 3;
    }
  }
  return out;
}

/** Spherical interpolation of the quaternions at `a[i..i+3]` and `b[i..i+3]`, the short way round. */
function slerp(a: GhostState, b: GhostState, i: number, t: number, out: number[]): void {
  const ax = a[i], ay = a[i + 1], az = a[i + 2], aw = a[i + 3];
  let bx = b[i], by = b[i + 1], bz = b[i + 2], bw = b[i + 3];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let wa: number, wb: number;
  if (dot > 0.9995) {
    // Nearly the same rotation: lerp, then normalize below.
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(Math.min(1, dot));
    const s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  let x = ax * wa + bx * wb, y = ay * wa + by * wb, z = az * wa + bz * wb, w = aw * wa + bw * wb;
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  out[i] = x; out[i + 1] = y; out[i + 2] = z; out[i + 3] = w;
}
