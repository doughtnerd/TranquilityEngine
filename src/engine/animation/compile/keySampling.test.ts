// ADR 0451: the one key sampler. Holds outside the keys, linear blends between them, the last of several keys sharing a
// time, quaternions on the shorter arc and normalised, and the stable sort of an out-of-order list.
import { describe, expect, it } from "vitest";
import { bracket, inTimeOrder, sampleQuat, sampleVec } from "./keySampling";

const s = Math.SQRT1_2;

describe("key sampling", () => {
  it("brackets any ascending store, holding its ends", () => {
    const times = [0, 1, 3];
    const at = (t: number) => bracket(times.length, (i) => times[i]!, t);
    expect(at(-1)).toEqual({ lo: 0, hi: 0, u: 0 });
    expect(at(2)).toEqual({ lo: 1, hi: 2, u: 0.5 });
    expect(at(5)).toEqual({ lo: 2, hi: 2, u: 0 });
    expect(bracket(1, () => 4, 9)).toEqual({ lo: 0, hi: 0, u: 0 });
  });

  it("blends vectors linearly and reads the last of keys sharing a time", () => {
    const keys = [[0, 0, 0, 0], [1, 2, 4, 6], [1, 10, 10, 10], [2, 20, 20, 20]];
    expect(sampleVec(keys, 0.5)).toEqual([1, 2, 3]);
    expect(sampleVec(keys, 1)).toEqual([10, 10, 10]);
    expect(sampleVec(keys, 3)).toEqual([20, 20, 20]);
    const out = [9, 9, 9, 9, 9];
    sampleVec(keys, 0.5, out, 2);
    expect(out).toEqual([9, 9, 1, 2, 3]);
  });

  it("blends quaternions on the shorter arc, normalised, by nlerp or slerp", () => {
    const quarter = [[0, 0, 0, 0, 1], [1, 0, 0, s, s]];
    const half = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    sampleQuat(quarter, 0.5, "slerp").forEach((v, i) => expect(v).toBeCloseTo(half[i]!, 12));
    sampleQuat(quarter, 0.5, "nlerp").forEach((v, i) => expect(v).toBeCloseTo(half[i]!, 12));
    // slerp keeps the angle uniform where nlerp doesn't: a quarter of the way is 22.5° about z.
    const q = sampleQuat(quarter, 0.25, "slerp");
    expect(q[2]).toBeCloseTo(Math.sin(Math.PI / 16), 12);
    // The far sign of the same rotation takes the short way; a key not of unit length samples to a unit rotation.
    const flipped = sampleQuat([[0, 0, 0, 0, 1], [1, 0, 0, -s, -s]], 0.5, "slerp");
    flipped.forEach((v, i) => expect(v).toBeCloseTo(half[i]!, 12));
    expect(sampleQuat([[0, 0, 0, 0, 2]], 0, "slerp")).toEqual([0, 0, 0, 1]);
  });

  it("sorts an out-of-order list stably, and returns an ordered one as it is", () => {
    const ordered = [{ time: 0 }, { time: 1 }];
    expect(inTimeOrder(ordered, (k) => k.time)).toBe(ordered);
    const keys = [{ time: 2, id: "a" }, { time: 1, id: "b" }, { time: 2, id: "c" }];
    expect(inTimeOrder(keys, (k) => k.time).map((k) => k.id)).toEqual(["b", "a", "c"]);
  });
});
