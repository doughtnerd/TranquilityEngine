import { describe, expect, it } from "vitest";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.pure";
import { busCreationSteps, busVolume, listenerQuaternion, planBuses, playbackRate, spatialParams, spatialSoundOptions } from "./babylonMapping";

describe("planBuses", () => {
  it("creates parents before children, in project order otherwise", () => {
    const plan = planBuses([{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }, { name: "Boss", parent: "Music" }]);
    expect(plan.map((b) => [b.name, b.parent])).toEqual([["Master", null], ["SFX", "Master"], ["Music", "Master"], ["Boss", "Music"]]);
  });

  it("puts a parent listed later first", () => {
    const plan = planBuses([{ name: "Child", parent: "Mid" }, { name: "Mid", parent: "Master" }, { name: "Master" }]);
    expect(plan.map((b) => b.name)).toEqual(["Master", "Mid", "Child"]);
    expect(plan[1]!.parent).toBe("Master");
  });

  it("makes a bus with an unknown parent, a self parent or a cycle a root, and drops repeated names", () => {
    const plan = planBuses([{ name: "A", parent: "Nope" }, { name: "B", parent: "B" }, { name: "C", parent: "D" }, { name: "D", parent: "C" }, { name: "A" }]);
    expect(plan.map((b) => b.name).sort()).toEqual(["A", "B", "C", "D"]);
    expect(plan.find((b) => b.name === "A")!.parent).toBeNull();
    expect(plan.find((b) => b.name === "B")!.parent).toBeNull();
    // The cycle is broken once: one of the two is a root and the other hangs off it.
    const c = plan.find((b) => b.name === "C")!;
    const d = plan.find((b) => b.name === "D")!;
    expect([c.parent, d.parent].filter((p) => p === null)).toHaveLength(1);
    expect(plan.indexOf(c) < plan.indexOf(d) ? d.parent : c.parent).not.toBeNull();
  });

  it("carries maxVoices, null when absent", () => {
    const plan = planBuses([{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: 4 }]);
    expect(plan.map((b) => b.maxVoices)).toEqual([null, 4]);
  });

  it("gives each step its starting volume (1 when the mix has no value yet)", () => {
    const steps = busCreationSteps(planBuses([{ name: "Master" }, { name: "SFX", parent: "Master" }]), new Map([["SFX", 0.25]]));
    expect(steps).toEqual([
      { name: "Master", parent: null, options: { volume: 1 } },
      { name: "SFX", parent: "Master", options: { volume: 0.25 } },
    ]);
    expect([busVolume(-1), busVolume(NaN), busVolume(1.5)]).toEqual([0, 1, 1.5]);
  });
});

describe("spatialParams", () => {
  it("maps rolloff to the distance model and keeps min, max and a rolloff factor of 1", () => {
    for (const rolloff of ["linear", "inverse", "exponential"] as const) {
      expect(spatialParams({ minDistance: 2, maxDistance: 50, rolloff })).toEqual({ distanceModel: rolloff, minDistance: 2, maxDistance: 50, rolloffFactor: 1, panningModel: "HRTF" });
    }
  });

  it("keeps max at or above min, never zero, and repairs bad numbers and names", () => {
    expect(spatialParams({ minDistance: 10, maxDistance: 3, rolloff: "linear" }).maxDistance).toBe(10);
    expect(spatialParams({ minDistance: 0, maxDistance: 0, rolloff: "linear" }).maxDistance).toBeGreaterThan(0);
    const bad = spatialParams({ minDistance: -4, maxDistance: Infinity, rolloff: "weird" as never });
    expect(bad).toMatchObject({ distanceModel: "inverse", minDistance: 0 });
    expect(Number.isFinite(bad.maxDistance)).toBe(true);
  });

  it("follows audio.spatial for the panning model", () => {
    expect(spatialParams({ minDistance: 1, maxDistance: 9, rolloff: "inverse" }, "equalPower").panningModel).toBe("equalpower");
  });

  it("names the same settings as sound options", () => {
    expect(spatialSoundOptions(spatialParams({ minDistance: 2, maxDistance: 50, rolloff: "linear" }))).toEqual({
      spatialEnabled: true, spatialDistanceModel: "linear", spatialMinDistance: 2, spatialMaxDistance: 50, spatialRolloffFactor: 1, spatialPanningModel: "HRTF",
    });
  });

  it("repairs a pitch", () => {
    expect([playbackRate(1.5), playbackRate(0), playbackRate(NaN)]).toEqual([1.5, 1, 1]);
  });
});

describe("listenerQuaternion", () => {
  /** What Babylon's own listener does with a rotation quaternion: forward = R * (0,0,-1), up = R * (0,1,0). */
  function viaBabylon(q: { x: number; y: number; z: number; w: number }) {
    const m = Matrix.Zero();
    Matrix.FromQuaternionToRef(new Quaternion(q.x, q.y, q.z, q.w), m);
    const f = Vector3.Zero();
    const u = Vector3.Zero();
    Vector3.TransformNormalToRef(Vector3.RightHandedForwardReadOnly, m, f);
    Vector3.TransformNormalToRef(Vector3.Up(), m, u);
    return { f, u };
  }
  const cases: [string, [number, number, number], [number, number, number]][] = [
    ["the default frame", [0, 0, -1], [0, 1, 0]],
    ["turned left", [-1, 0, 0], [0, 1, 0]],
    ["turned right", [1, 0, 0], [0, 1, 0]],
    ["looking up", [0, 1, 0], [0, 0, 1]],
    ["tilted", [0.3, -0.5, -0.8], [0.1, 0.9, -0.2]],
    ["rolled over", [0, 0, -1], [1, 0, 0]],
  ];
  for (const [name, f, u] of cases) {
    it(`reproduces ${name} through Babylon's matrix maths`, () => {
      const q = listenerQuaternion({ x: f[0], y: f[1], z: f[2] }, { x: u[0], y: u[1], z: u[2] });
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1);
      const { f: gotF, u: gotU } = viaBabylon(q);
      const len = Math.hypot(...f);
      expect([gotF.x, gotF.y, gotF.z].map((v) => +v.toFixed(5) + 0)).toEqual(f.map((v) => +(v / len).toFixed(5) + 0));
      // `up` comes back orthogonal to forward and on the same side as the given one.
      expect(gotU.x * u[0] + gotU.y * u[1] + gotU.z * u[2]).toBeGreaterThan(0);
      expect(gotF.x * gotU.x + gotF.y * gotU.y + gotF.z * gotU.z).toBeCloseTo(0);
    });
  }

  it("copes with a zero or parallel vector", () => {
    const q = listenerQuaternion({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(viaBabylon(q).f.z).toBeCloseTo(-1);
    const p = listenerQuaternion({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(viaBabylon(p).f.y).toBeCloseTo(1);
  });
});
