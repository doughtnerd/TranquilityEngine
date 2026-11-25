// What a tween drives (ADR 0371 "Tweens"): `tween(target, field, …)` resolved once, when the tween is created, into the
// field's current value (its numbers), its value kind and width, and the write that puts a tween row back (the same
// writes property tracks bind to, `../properties/bindings.ts`: setters run, unchanged values aren't written,
// `material.<name>` is a per-renderer override, sub-paths of plain-object fields are written in place).
//
// - **Transform:** `position` and `scale` (vec3), `rotation` (quaternion), local, through the Transform.
// - **Component:** an animatable field (`@field(…, { animatable })`) or a sub-path of one (`drive.targetRotation`), or
//   `material.<name>` on a MeshRenderer (the override's current value; a property with no override can't be read, so
//   such a tween needs `from`). The kind comes from the value the field holds: a number (float), a boolean (stepped:
//   it switches at the end of each cycle), `Vector2`/`Vector3`, `Quaternion` (slerp), `Color` (RGBA), or a plain
//   object of `x, y[, z[, w]]` or `r, g, b[, a]` numbers (linear).
// - **Alive:** the target is gone once its node is destroyed or (a component) it was removed.
import { TRACK_KINDS } from "../../../../../engine/animation/tracks";
import type { Component } from "../../../../../engine/core/Component";
import { Color, Quaternion, Vector2, Vector3 } from "../../../../../engine/core/math";
import { MeshRenderer } from "../../../../../engine/render/components";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { Transform } from "../../../../../engine/scene/Transform";
import { componentFieldWrite, transformFieldWrite, type FieldWrite } from "../properties/bindings";
import type { TweenTarget, TweenValue } from "../../types";

const FLOAT = TRACK_KINDS.indexOf("float"), VEC2 = TRACK_KINDS.indexOf("vec2"), VEC3 = TRACK_KINDS.indexOf("vec3"), VEC4 = TRACK_KINDS.indexOf("vec4");
const COLOR = TRACK_KINDS.indexOf("color"), QUAT = TRACK_KINDS.indexOf("quat"), DISCRETE = TRACK_KINDS.indexOf("discrete");
/** `DiscreteType` bool. */
const BOOL = 0;

/** @internal A resolved tween target. */
export interface TweenBinding {
  /** The node whose entity carries `animation.Tweens`. */
  readonly node: GameObject;
  /** The target object and field path (chained group starts look a field up by both). */
  readonly target: object;
  readonly field: string;
  /** 1–4 floats; a quaternion is 4. */
  readonly width: number;
  readonly quat: boolean;
  readonly bool: boolean;
  /** False once the target node is destroyed or the component removed. */
  alive(): boolean;
  /** The field's current value (its numbers), or null when it can't be read (a material property with no override). */
  read(): number[] | null;
  /** Writes `width` floats from `values[at]` on (a boolean: 0 or 1). */
  write(values: ArrayLike<number>, at?: number): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KEY_SETS: readonly (readonly string[])[] = [["r", "g", "b", "a"], ["x", "y", "z", "w"]];

interface Shape {
  readonly kind: number;
  readonly width: number;
  readonly quat: boolean;
  readonly bool: boolean;
  /** Reads the numbers out of a value of this shape. */
  readonly numbers: (v: unknown) => number[] | null;
}

/** The shape of a field value; null for values a tween can't drive. */
function shapeOf(v: unknown): Shape | null {
  if (typeof v === "number") return { kind: FLOAT, width: 1, quat: false, bool: false, numbers: (x) => (typeof x === "number" ? [x] : null) };
  if (typeof v === "boolean") return { kind: DISCRETE, width: 1, quat: false, bool: true, numbers: (x) => (typeof x === "boolean" ? [x ? 1 : 0] : null) };
  if (v instanceof Quaternion) return { kind: QUAT, width: 4, quat: true, bool: false, numbers: (x) => (x instanceof Quaternion ? [x.x, x.y, x.z, x.w] : null) };
  if (v instanceof Color) return { kind: COLOR, width: 4, quat: false, bool: false, numbers: (x) => (x instanceof Color ? [x.r, x.g, x.b, x.a] : null) };
  if (v instanceof Vector3) return { kind: VEC3, width: 3, quat: false, bool: false, numbers: (x) => (x instanceof Vector3 ? [x.x, x.y, x.z] : null) };
  if (v instanceof Vector2) return { kind: VEC2, width: 2, quat: false, bool: false, numbers: (x) => (x instanceof Vector2 ? [x.x, x.y] : null) };
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((n) => typeof n === "number")) {
    const n = v.length;
    return { kind: n === 2 ? VEC2 : n === 3 ? VEC3 : VEC4, width: n, quat: false, bool: false, numbers: (x) => (Array.isArray(x) && x.length === n ? (x as number[]).slice() : null) };
  }
  if (isRecord(v)) {
    for (const keys of KEY_SETS) {
      let n = 0;
      while (n < keys.length && typeof v[keys[n]!] === "number") n++;
      if (n < 2 || (keys[0] === "r" && n < 3)) continue;
      const used = keys.slice(0, n);
      const kind = keys[0] === "r" ? COLOR : n === 2 ? VEC2 : n === 3 ? VEC3 : VEC4;
      return { kind, width: n, quat: false, bool: false, numbers: (x) => (isRecord(x) ? used.map((k) => (typeof x[k] === "number" ? (x[k] as number) : 0)) : null) };
    }
  }
  return null;
}

/** The value at `path` below `root`. */
function walk(root: unknown, path: readonly string[]): unknown {
  let v = root;
  for (const p of path) v = isRecord(v) || v instanceof Object ? (v as Record<string, unknown>)[p] : undefined;
  return v;
}

/** The numbers of a tween value, `width` long; components it lacks are null (filled from the start value). */
export function tweenNumbers(v: TweenValue | undefined, width: number): (number | null)[] | null {
  if (v === undefined) return null;
  let n: number[];
  if (typeof v === "number") n = [v];
  else if (typeof v === "boolean") n = [v ? 1 : 0];
  else if (Array.isArray(v)) n = (v as readonly unknown[]).map((x) => (typeof x === "number" && Number.isFinite(x) ? x : NaN));
  else if (v instanceof Quaternion) n = [v.x, v.y, v.z, v.w];
  else if (v instanceof Color) n = [v.r, v.g, v.b, v.a];
  else if (v instanceof Vector3) n = [v.x, v.y, v.z];
  else if (v instanceof Vector2) n = [v.x, v.y];
  else return null;
  const out: (number | null)[] = [];
  for (let i = 0; i < width; i++) out.push(i < n.length && Number.isFinite(n[i]) ? n[i]! : null);
  return out;
}

/** @internal Resolves `target`'s `field` for a tween; a string says why it can't be tweened. */
export function resolveTweenTarget(target: TweenTarget, field: string, to: TweenValue): TweenBinding | string {
  if (target instanceof Transform) {
    const node = target.node;
    if (!node.isValid) return "its node is destroyed";
    const shape = field === "rotation" ? shapeOf(target.rotation) : field === "position" || field === "scale" ? shapeOf(target.position) : null;
    if (!shape) return `a Transform tweens "position", "rotation" or "scale", not "${field}"`;
    const write = transformFieldWrite(node, field, shape.kind);
    if (typeof write === "string") return write;
    const read = () => shape.numbers(field === "position" ? target.position : field === "scale" ? target.scale : target.rotation);
    return binding(node, target, field, shape, () => node.isValid, read, write);
  }
  const c = target as Component;
  const node = c.node;
  if (!node?.isValid || c._destroyed) return "it is destroyed";
  const world = node.world;
  const material = c instanceof MeshRenderer && field.startsWith("material.") ? field.slice(9) : null;
  const path = field.split(".");
  const readValue = (): unknown => (material !== null ? (c as MeshRenderer).getMaterialProperty(material) : walk(c, path));
  const current = readValue();
  const shape = shapeOf(current ?? (material !== null ? materialShapeOf(to) : undefined));
  if (!shape) return current === undefined ? (material !== null ? `the material property "${material}" has no value to start from on this renderer; give \`from\`` : `no field "${field}"`) : `"${field}" isn't a number, boolean, vector, quaternion or colour`;
  const write = componentFieldWrite(world, c, field, shape.kind, shape.width, shape.bool ? BOOL : 0);
  if (typeof write === "string") return write;
  return binding(node, c, field, shape, () => node.isValid && !c._destroyed, () => shape.numbers(readValue()), write);
}

/** A material property's shape from the tween's end value (when the renderer has no override yet). */
function materialShapeOf(to: TweenValue): unknown {
  if (to instanceof Color || typeof to === "number" || to instanceof Vector2 || to instanceof Vector3) return to;
  return Array.isArray(to) ? [...(to as number[])] : undefined;
}

function binding(node: GameObject, target: object, field: string, shape: Shape, alive: () => boolean, read: () => number[] | null, write: FieldWrite): TweenBinding {
  const f = new Float32Array(4);
  const u = new Uint32Array(4);
  return {
    node,
    target,
    field,
    width: shape.width,
    quat: shape.quat,
    bool: shape.bool,
    alive,
    read,
    write(values, at = 0) {
      if (!alive()) return;
      for (let i = 0; i < shape.width; i++) f[i] = values[at + i]!;
      if (shape.bool) u[0] = values[at]! >= 0.5 ? 1 : 0;
      write(f, u, 0);
    },
  };
}
