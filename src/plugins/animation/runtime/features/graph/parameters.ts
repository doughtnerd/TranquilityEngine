// Graph parameter values as the core's blackboard stores them (ADR 0372; `anim-wire`'s graph family: four `u32` words
// per parameter): floats and vectors as f32 bits, ints as i32, bools 0/1, nodes as the node's entity id (`NONE` for
// none). Engine types at the edge: numbers, booleans, `Vector2`, `Vector3`, `Quaternion` and `GameObject`; number
// arrays too (the Animator's saved `parameters`). A value of another kind doesn't encode. A pure library.
import type { GraphParamType } from "../../../../../engine/animation/animGraph";
import { Quaternion, Vector2, Vector3 } from "../../../../../engine/core/math";
import { GameObject } from "../../../../../engine/scene/GameObject";

/** @internal `myco.animgraph@1`'s parameter type ids. */
export const PARAM_TYPE_IDS: Readonly<Record<GraphParamType, number>> = Object.freeze({ float: 0, int: 1, bool: 2, vec2: 3, vec3: 4, quat: 5, node: 6 });

const NONE = 0xffffffff;
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (v: number): number => {
  f32[0] = v;
  return u32[0]!;
};

/** A number that stays finite as an f32. */
const isFloat = (v: unknown): v is number => typeof v === "number" && Number.isFinite(Math.fround(v));

/** The first `n` (1–4) of a, b, c, d as f32 bits at `out[at]`, the rest of the four words 0; false when one isn't a finite f32. */
function floats(out: Uint32Array, at: number, n: number, a: unknown, b: unknown, c: unknown, d: unknown): boolean {
  if (!isFloat(a) || (n > 1 && !isFloat(b)) || (n > 2 && !isFloat(c)) || (n > 3 && !isFloat(d))) return false;
  out[at] = bits(a);
  out[at + 1] = n > 1 ? bits(b as number) : 0;
  out[at + 2] = n > 2 ? bits(c as number) : 0;
  out[at + 3] = n > 3 ? bits(d as number) : 0;
  return true;
}

/** `word`, then three 0 words, at `out[at]`. */
function word(out: Uint32Array, at: number, w: number): void {
  out[at] = w;
  out[at + 1] = 0;
  out[at + 2] = 0;
  out[at + 3] = 0;
}

const fromBits = (w: number): number => {
  u32[0] = w;
  return f32[0]!;
};

/**
 * @internal Reads a `type` parameter's four words at `words[at]` back as a plain value: a number (float, int), a
 * boolean, or numbers for vec2, vec3 and quat. Null for `node` (an entity id means nothing in another World).
 */
export function decodeParameter(type: GraphParamType, words: Uint32Array, at: number): number | boolean | number[] | null {
  switch (type) {
    case "float":
      return fromBits(words[at]!);
    case "int":
      return words[at]! | 0;
    case "bool":
      return words[at] !== 0;
    case "vec2":
      return [fromBits(words[at]!), fromBits(words[at + 1]!)];
    case "vec3":
      return [fromBits(words[at]!), fromBits(words[at + 1]!), fromBits(words[at + 2]!)];
    case "quat":
      return [fromBits(words[at]!), fromBits(words[at + 1]!), fromBits(words[at + 2]!), fromBits(words[at + 3]!)];
    case "node":
      return null;
  }
}

/** @internal Writes `value` as a `type` parameter's four words at `out[at]`; false (nothing written) when it doesn't fit. */
export function encodeParameter(type: GraphParamType, value: unknown, out: Uint32Array, at: number): boolean {
  // No arrays made here: the host writes parameters every frame (motion matching's inputs, gameplay's `set`).
  const arr = Array.isArray(value) ? (value as unknown[]) : null;
  switch (type) {
    case "float":
      return floats(out, at, 1, value, 0, 0, 0);
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) return false;
      word(out, at, value >>> 0);
      return true;
    case "bool":
      if (typeof value !== "boolean") return false;
      word(out, at, value ? 1 : 0);
      return true;
    case "vec2":
      if (value instanceof Vector2) return floats(out, at, 2, value.x, value.y, 0, 0);
      return arr?.length === 2 && floats(out, at, 2, arr[0], arr[1], 0, 0);
    case "vec3":
      if (value instanceof Vector3) return floats(out, at, 3, value.x, value.y, value.z, 0);
      return arr?.length === 3 && floats(out, at, 3, arr[0], arr[1], arr[2], 0);
    case "quat":
      if (value instanceof Quaternion) return floats(out, at, 4, value.x, value.y, value.z, value.w);
      return arr?.length === 4 && floats(out, at, 4, arr[0], arr[1], arr[2], arr[3]);
    case "node":
      if (value === null) word(out, at, NONE);
      else if (value instanceof GameObject) word(out, at, value.entity >>> 0);
      else return false;
      return true;
  }
}
