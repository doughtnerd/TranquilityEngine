// ADR 0372 (T32): graph parameter values as blackboard words, one case per parameter kind.
import { describe, expect, it } from "vitest";
import { Quaternion, Vector2, Vector3 } from "../../../../../engine/core/math";
import type { World } from "../../../../../engine/core/World";
import { GameObject } from "../../../../../engine/scene/GameObject";
import { encodeParameter } from "./parameters";

const f32 = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0]!;
function words(type: Parameters<typeof encodeParameter>[0], value: unknown): number[] | null {
  const out = new Uint32Array(8).fill(0xdead);
  return encodeParameter(type, value, out, 4) ? Array.from(out.subarray(4)) : null;
}

describe("encodeParameter", () => {
  it("float: f32 bits; refuses other kinds and non-finite numbers", () => {
    expect(words("float", 1.5)).toEqual([f32(1.5), 0, 0, 0]);
    expect(words("float", true)).toBeNull();
    expect(words("float", Number.NaN)).toBeNull();
    expect(words("float", 1e39)).toBeNull(); // not finite as an f32
  });

  it("int: i32; refuses fractions", () => {
    expect(words("int", -2)).toEqual([0xfffffffe, 0, 0, 0]);
    expect(words("int", 1.5)).toBeNull();
  });

  it("bool: 0 or 1; refuses numbers", () => {
    expect(words("bool", true)).toEqual([1, 0, 0, 0]);
    expect(words("bool", false)).toEqual([0, 0, 0, 0]);
    expect(words("bool", 1)).toBeNull();
  });

  it("vec2, vec3, quat: the engine's types or number arrays of their length", () => {
    expect(words("vec2", new Vector2(1, 2))).toEqual([f32(1), f32(2), 0, 0]);
    expect(words("vec2", [1, 2])).toEqual([f32(1), f32(2), 0, 0]);
    expect(words("vec2", new Vector3(1, 2, 3))).toBeNull();
    expect(words("vec3", new Vector3(1, 2, 3))).toEqual([f32(1), f32(2), f32(3), 0]);
    expect(words("vec3", [1, 2])).toBeNull();
    expect(words("quat", new Quaternion(0, 0, 0, 1))).toEqual([0, 0, 0, f32(1)]);
    expect(words("quat", [0, 0, 0])).toBeNull();
  });

  it("node: the node's entity, or NONE for null", () => {
    const node = new GameObject(null as unknown as World, 7, 0); // a handle only: the encoder reads its entity
    expect(words("node", node)).toEqual([7, 0, 0, 0]);
    expect(words("node", null)).toEqual([0xffffffff, 0, 0, 0]);
    expect(words("node", 7)).toBeNull();
  });
});
