// ADR 0371: imported keyframes as tracks: sampler evaluation per interpolation, STEP holds, Bézier keys from cubic
// splines, node and property tracks, activation ranges, and the space maps (checked against the matrix product).
import { describe, expect, it } from "vitest";
import { evalCurve } from "../../core/curve";
import { buildTake, evaluateSampler, samplerCurves, type Sampler } from "./channels";
import { compose, decompose, mapRotation, mapScale, mapTranslation, mul, trsSpace, IDENTITY_SPACE } from "./space";

const near = (a: ArrayLike<number>, b: readonly number[], eps = 1e-9) => b.forEach((v, i) => expect(Math.abs(a[i] - v), `${i}: ${a[i]} vs ${v}`).toBeLessThan(eps));

describe("samplers", () => {
  const cubic: Sampler = { times: [0, 2], values: [0, 0, 1, 9, 9, 0], width: 1, interpolation: "CUBICSPLINE" };
  it("evaluates LINEAR, STEP and CUBICSPLINE", () => {
    expect(evaluateSampler({ times: [0, 1], values: [0, 10], width: 1, interpolation: "LINEAR" }, 0.25)).toEqual([2.5]);
    expect(evaluateSampler({ times: [0, 1], values: [0, 10], width: 1, interpolation: "STEP" }, 0.99)).toEqual([0]);
    // Hermite from 0 (out-tangent 1) to 9 (in-tangent 9) over 2 s at u = .5: .125·2·1 + .5·9 - .125·2·9.
    near(evaluateSampler(cubic, 1), [0.25 + 4.5 - 2.25]);
  });

  it("keeps a CUBICSPLINE as Bézier keys that evaluate like the spline", () => {
    const [curve] = samplerCurves(cubic);
    for (const t of [0.3, 1, 1.7]) expect(evalCurve(curve, t)).toBeCloseTo(evaluateSampler(cubic, t)[0], 3);
  });

  it("writes STEP as step keys", () => {
    expect(samplerCurves({ times: [0, 1], values: [3, 4], width: 1, interpolation: "STEP" })).toEqual([[[0, 3, "step"], [1, 4]]]);
  });
});

describe("takes", () => {
  it("merges bone channels per bone, holds STEP rotations and clamps to the duration", () => {
    const take = buildTake("T", [
      { target: { kind: "bone", bone: "Hips", path: "translation", space: IDENTITY_SPACE }, sampler: { times: [0, 1], values: [0, 0, 0, 1, 2, 3], width: 3, interpolation: "LINEAR" } },
      { target: { kind: "bone", bone: "Hips", path: "rotation", space: IDENTITY_SPACE }, sampler: { times: [0, 1], values: [0, 0, 0, 1, 0, 0, 0, -1], width: 4, interpolation: "STEP" } },
    ]);
    expect(take.duration).toBe(1);
    expect(take.tracks).toHaveLength(1);
    const t = take.tracks[0];
    if (t.kind !== "bone") throw new Error("bone track expected");
    expect(t.translation).toEqual([[0, 0, 0, 0], [1, 1, 2, 3]]);
    // Held, then the last key flipped into the same hemisphere (-identity is the identity).
    expect(t.rotation.map((k) => +k[0].toFixed(4))).toEqual([0, 0.9999, 1]);
    near(t.rotation[2], [1, 0, 0, 0, 1]);
  });

  it("makes node, property and activation tracks", () => {
    const take = buildTake("T", [
      { target: { kind: "node", nodePath: "Door", path: "scale", space: IDENTITY_SPACE }, sampler: { times: [0, 1], values: [1, 1, 1, 2, 2, 2], width: 3, interpolation: "LINEAR" } },
      { target: { kind: "property", track: "float", binding: { nodePath: "Lamp", component: "engine.Light", field: "range" }, map: (v) => [v[0] * 2] }, sampler: { times: [0, 1], values: [1, 3], width: 1, interpolation: "LINEAR" } },
      { target: { kind: "activation", nodePath: "Fx" }, sampler: { times: [0, 0.5, 2], values: [0, 1, 1], width: 1, interpolation: "STEP" } },
    ]);
    expect(take.tracks).toEqual([
      { kind: "vec3", target: { nodePath: "Door", component: "engine.Transform", field: "scale" }, name: "", curves: [[[0, 1], [1, 2]], [[0, 1], [1, 2]], [[0, 1], [1, 2]]] },
      { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "range" }, name: "", curves: [[[0, 2], [1, 6]]] },
      { kind: "activation", target: { nodePath: "Fx", component: "", field: "" }, keys: [{ time: 0.5, end: 2 }] },
    ]);
  });
});

describe("space maps", () => {
  it("match the matrix product A · local · B for the import matrices (mirror, scale, z-up)", () => {
    const mirror = compose([0, 0, 0], [0, 0, 0, 1], [-1, 1, 1]);
    const zUp = compose([0, 0, 0], [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], [1, 1, 1]);
    const m = mul(mul(mirror, compose([0, 0, 0], [0, 0, 0, 1], [0.5, 0.5, 0.5])), zUp);
    const fold = compose([1, 2, 3], [0, 0.6, 0, 0.8], [2, 2, 2]);
    const a = mul(m, fold);
    const b = mul(compose([0, 0, 0], [0, 0, 0, 1], [2, 2, 2]), mul(zUp, mirror)); // M⁻¹ up to the scale: (M⁻¹ = zUp⁻¹ · S⁻¹ · mirror)
    const space = trsSpace(a, b);
    const t = [0.5, -1, 2], q = [0.1, 0.7, -0.1, 0.7], s = [1, 3, 2];
    const len = Math.hypot(...q);
    const qn = q.map((v) => v / len);
    const want = decompose(mul(mul(a, compose(t as [number, number, number], qn as [number, number, number, number], s as [number, number, number])), b));
    near(mapTranslation(space, t), want.t, 1e-9);
    const got = mapRotation(space, qn);
    const sign = Math.sign(got[3]) === Math.sign(want.q[3]) ? 1 : -1;
    near(got.map((v) => v * sign), want.q, 1e-9);
    near(mapScale(space, s), want.s, 1e-9);
  });
});
