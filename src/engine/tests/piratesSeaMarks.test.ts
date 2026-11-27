import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseParticleGraph } from "../scene/particleGraphFormat";
import { compileParticleKernels } from "../scene/particleKernel";
import { REST_SPEED, WakePath, bowWave, wakeStrength } from "../../../samples/pirates/scripts/seaMarkShapes";

// King of Pirates' marks on the sea (samples/pirates/scripts/seaMarkShapes.ts, drawn by seaMarks.ts): how strongly
// a ship's speed churns the water, a stern wake's path and a bow wave's V.

describe("King of Pirates: a ship's wake strength", () => {
  it("is nothing at rest and at or below the rest speed", () => {
    expect(wakeStrength(0, 9)).toBe(0);
    expect(wakeStrength(REST_SPEED, 9)).toBe(0);
    expect(wakeStrength(-3, 9)).toBe(0);
    expect(wakeStrength(Number.NaN, 9)).toBe(0);
  });

  it("rises with speed to 1 at full speed, and stays 1 beyond it", () => {
    let last = 0;
    for (let v = REST_SPEED + 0.25; v <= 9; v += 0.25) {
      const s = wakeStrength(v, 9);
      expect(s).toBeGreaterThan(last);
      last = s;
    }
    expect(wakeStrength(9, 9)).toBeCloseTo(1);
    expect(wakeStrength(14, 9)).toBe(1);
    // Barely under way still shows a little; half speed shows well.
    expect(wakeStrength(1.5, 9)).toBeGreaterThan(0.1);
    expect(wakeStrength(4.5, 9)).toBeGreaterThan(0.6);
  });
});

describe("King of Pirates: a stern wake's path", () => {
  it("lays points a spacing apart behind a ship under way, newest first", () => {
    const path = new WakePath(1, 3, 48);
    for (let i = 0; i <= 50; i++) path.step(0, i * 0.1, 0.1, true); // 1 m/s along +Z for 5 s
    expect(path.points[0]!.z).toBeCloseTo(5);
    for (let i = 1; i < path.points.length; i++) expect(path.points[i - 1]!.z - path.points[i]!.z).toBeCloseTo(1);
    // Points older than its life are gone: 3 s at 1 m/s leaves 3 points (laid at 5, 4 and 3 m).
    expect(path.points.map((p) => Math.round(p.z))).toEqual([5, 4, 3]);
  });

  it("reaches further behind a faster ship", () => {
    const slow = new WakePath(1, 2, 48), fast = new WakePath(1, 2, 48);
    for (let i = 0; i <= 60; i++) {
      slow.step(0, i * 0.05 * 3, 0.05, true);
      fast.step(0, i * 0.05 * 9, 0.05, true);
    }
    const reach = (p: WakePath) => p.points[0]!.z - p.points[p.points.length - 1]!.z;
    expect(reach(fast)).toBeGreaterThan(reach(slow) * 2);
  });

  it("lays nothing while not under way, and the old water calms until none is left", () => {
    const path = new WakePath(1, 2, 48);
    for (let i = 0; i < 10; i++) path.step(i, 0, 0.1, true);
    expect(path.points.length).toBeGreaterThan(0);
    for (let i = 0; i < 25; i++) path.step(10 + i, 0, 0.1, false);
    expect(path.points).toEqual([]);
  });

  it("keeps at most its point limit, and forgets everything when cleared", () => {
    const path = new WakePath(1, 100, 5);
    for (let i = 0; i < 20; i++) path.step(i * 2, 0, 0.1, true);
    expect(path.points.length).toBe(5);
    expect(path.points[0]!.x).toBe(38);
    path.clear();
    expect(path.points).toEqual([]);
  });
});

describe("King of Pirates: a bow wave", () => {
  const shape = { stem: 2.25, length: 3, spread: 30, perArm: 4 };

  it("runs from the port arm's end through the stem to the starboard arm's end, mirrored across the keel", () => {
    const v = bowWave(shape, 1.3);
    expect(v.length).toBe(9);
    expect(v[4]).toEqual({ x: 0, z: 2.25 });
    expect(v[0]!.x).toBeLessThan(0);
    expect(v[8]!.x).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      expect(v[i]!.x).toBeCloseTo(-v[8 - i]!.x);
      expect(v[i]!.z).toBeCloseTo(v[8 - i]!.z);
    }
  });

  it("sweeps back from the stem at its spread, each arm its length", () => {
    const v = bowWave(shape, 0);
    const tip = v[8]!;
    const back = shape.stem - tip.z;
    expect(back).toBeCloseTo(shape.length * Math.cos(Math.PI / 6));
    // The arm wavers by a few per cent sideways only.
    expect(Math.abs(tip.x / (shape.length * Math.sin(Math.PI / 6)) - 1)).toBeLessThan(0.07);
    expect(bowWave({ ...shape, length: 1 }, 0)[8]!.z).toBeGreaterThan(tip.z);
  });
});

describe("King of Pirates: rain rings the water where drops land", () => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../../samples/pirates/effects/rain.particles.json", import.meta.url)), "utf8"));
  const { graph, problems } = parseParticleGraph(raw, "rain.particles.json");
  const rain = graph.systems.find((s) => s.name === "Rain")!;
  const ripples = graph.systems.find((s) => s.name === "Ripples")!;

  it("kills each drop where it meets the scene's depth (the waves, a deck) and spawns a ring from some of those deaths", () => {
    expect(problems).toEqual([]);
    expect(rain.update.blocks.find((b) => b.type === "update.collisionDepth")?.inputs).toMatchObject({ kill: true, bounce: 0 });
    const kernels = compileParticleKernels(graph);
    expect(kernels.problems).toEqual([]);
    const child = kernels.systems[graph.systems.indexOf(ripples)];
    expect(child.event).toMatchObject({ parent: graph.systems.indexOf(rain), trigger: "death", inheritVelocity: false });
    expect(child.event!.probability).toBeGreaterThan(0);
    expect(child.event!.probability).toBeLessThan(1);
  });

  it("has a ring slot for every drop, and the rings lie flat, grow and fade", () => {
    // A GPU event child has capacity / parent capacity slots per parent: at least one.
    expect(ripples.settings.capacity).toBeGreaterThanOrEqual(rain.settings.capacity);
    expect(ripples.output.type).toBe("horizontal");
    expect(ripples.output.settings.texture).toBe("asset:textures/ripple.png");
    const alphas = (ripples.update.blocks.find((b) => b.type === "update.colorOverLife")!.inputs.color as { gradient: { alphas: [number, number][] } }).gradient.alphas;
    expect(alphas[0][1]).toBe(0);
    expect(alphas[alphas.length - 1][1]).toBe(0);
    expect(Math.max(...alphas.map((a) => a[1]))).toBeLessThanOrEqual(0.4); // faint
  });

  it("lets every drop live long enough to fall from the rain's height to the sea", () => {
    // weather.ts keeps the rain 24 m up; a drop that hits nothing on screen dies under the water.
    const life = rain.initialize.blocks.find((b) => b.type === "init.lifetime")!.inputs.lifetime as { random: [number, number] };
    const speed = rain.initialize.blocks.find((b) => b.type === "init.velocity")!.inputs.speed as { random: [number, number] };
    expect(life.random[0] * speed.random[0]).toBeGreaterThan(24 + 3);
  });
});
