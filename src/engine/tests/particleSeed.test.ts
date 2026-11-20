// ParticleSystem.seed (ADR 0057, 0251): the seeded generator, and kernel systems driven by it.
import { describe, expect, it } from "vitest";
import { JsRun, KernelEffect, type KernelHost } from "../render/particles/gpu/kernelEffect";
import { randomForSeed, seededRandom } from "../render/particles/random";
import { compileParticleGraph } from "../scene/particleCompile";
import { defaultBlock } from "../scene/particleBlocks";
import type { GraphInputValue, ParticleGraph } from "../scene/particleGraph";
import { newGraphId, systemTemplate } from "../scene/particleGraphFormat";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const host: KernelHost = { executors: ["js"], createRun: (k) => new JsRun(k) };

/** Particles shot from a sphere at 60 a second. */
function graph(): ParticleGraph {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  const add = (c: "spawn" | "initialize", type: string, inputs: Record<string, GraphInputValue> = {}) => {
    const b = defaultBlock(type, newGraphId(g, "b"));
    Object.assign(b.inputs, inputs);
    sys[c].blocks.push(b);
  };
  add("spawn", "spawn.rate", { rate: 60 });
  add("initialize", "init.lifetime", { lifetime: 5 });
  add("initialize", "init.velocity", { speed: 3 });
  add("initialize", "init.positionSphere", { radius: 1 });
  return g;
}

/** Step the effect for a second with the seed's generator; return every live particle's position. */
function play(seed: number): string[] {
  const program = compileParticleGraph(graph());
  const fx = new KernelEffect(program.kernels.systems, program.spawns, host, { random: randomForSeed(seed), seed });
  const ctx = { time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: randomForSeed(seed) };
  for (let i = 0; i < 60; i++) fx.step(1 / 60, IDENTITY, 1, [1, 1, 1, 1], ctx, null);
  const js = (fx.systems[0].run as JsRun).js;
  const out: string[] = [];
  for (let i = 0; i < js.kernel.capacity; i++) if (js.alive(i)) out.push([0, 1, 2].map((a) => js.state[i * 16 + a].toFixed(6)).join(","));
  return out;
}

describe("seeded particle random", () => {
  it("repeats for the same seed and differs for another", () => {
    expect(seededRandom(7)()).toBe(seededRandom(7)());
    expect(seededRandom(7)()).not.toBe(seededRandom(8)());
    const a = play(7);
    expect(a.length).toBeGreaterThan(10);
    expect(play(7)).toEqual(a);
    expect(play(8)).not.toEqual(a);
  });

  it("randomForSeed: 0 is Math.random, anything else is seeded", () => {
    expect(randomForSeed(0)).toBe(Math.random);
    expect(randomForSeed(3)()).toBe(seededRandom(3)());
    expect(play(0)).not.toEqual(play(0));
  });
});
