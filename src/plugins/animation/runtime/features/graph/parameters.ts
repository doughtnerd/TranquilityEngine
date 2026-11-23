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

function floats(out: Uint32Array, at: number, values: readonly number[]): boolean {
  if (!values.every((v) => typeof v === "number" && Number.isFinite(Math.fround(v)))) return false;
  for (let k = 0; k < 4; k++) out[at + k] = k < values.length ? bits(values[k]!) : 0;
  return true;
}

/** @internal Writes `value` as a `type` parameter's four words at `out[at]`; false (nothing written) when it doesn't fit. */
export function encodeParameter(type: GraphParamType, value: unknown, out: Uint32Array, at: number): boolean {
  const arr = Array.isArray(value) ? (value as unknown[]) : null;
  switch (type) {
    case "float":
      return typeof value === "number" && floats(out, at, [value]);
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) return false;
      out.set([value >>> 0, 0, 0, 0], at);
      return true;
    case "bool":
      if (typeof value !== "boolean") return false;
      out.set([value ? 1 : 0, 0, 0, 0], at);
      return true;
    case "vec2":
      if (value instanceof Vector2) return floats(out, at, [value.x, value.y]);
      return arr?.length === 2 && floats(out, at, arr as number[]);
    case "vec3":
      if (value instanceof Vector3) return floats(out, at, [value.x, value.y, value.z]);
      return arr?.length === 3 && floats(out, at, arr as number[]);
    case "quat":
      if (value instanceof Quaternion) return floats(out, at, [value.x, value.y, value.z, value.w]);
      return arr?.length === 4 && floats(out, at, arr as number[]);
    case "node":
      if (value === null) out.set([NONE, 0, 0, 0], at);
      else if (value instanceof GameObject) out.set([value.entity >>> 0, 0, 0, 0], at);
      else return false;
      return true;
  }
}
