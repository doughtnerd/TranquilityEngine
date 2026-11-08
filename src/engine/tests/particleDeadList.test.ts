// ADR 0126: kernel systems keep a dead list on WebGPU and JavaScript (full systems stop spawning, exact counts).
import { describe, expect, it } from "vitest";
import { compileParticleGraph } from "../scene/particleCompile";
import { compileParticleKernels, KERNEL_FLOATS } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { newGraphId, systemTemplate } from "../scene/particleGraphFormat";
import type { EvalContext } from "../scene/particleNodes";
import { KernelEffect, JsRun, type KernelHost } from "../render/particles/gpu/kernelEffect";
import { wgslSimulation } from "../render/particles/gpu/kernelShader";

const ctx = (): EvalContext => ({ time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5 });
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
}

/** A looping system emitting `rate` a second into `capacity` slots, each living `life` seconds. */
function loopGraph(capacity: number, rate: number, life: number): ParticleGraph {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.spawn.settings.looping = true;
  sys.spawn.settings.duration = 5;
  sys.settings.capacity = capacity;
  addBlock(g, sys, "spawn", "spawn.rate", { rate });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: life });
  addBlock(g, sys, "initialize", "init.velocity", { speed: 1 });
  addBlock(g, sys, "initialize", "init.positionPoint");
  return g;
}

function play(g: ParticleGraph, deadList: boolean, seed = 7) {
  const host: KernelHost = { executors: ["js"], createRun: (k) => new JsRun(k, { deadList }) };
  const program = compileParticleGraph(g);
  const kp = compileParticleKernels(g, program);
  const fx = new KernelEffect(kp.systems, program.effect.emitters, host, { seed });
  const js = (fx.systems[0].run as JsRun).js;
  const step = (n: number, dt = 1 / 30) => {
    for (let i = 0; i < n; i++) fx.step(dt, IDENTITY, 1, [1, 1, 1, 1], ctx(), null);
  };
  const seeds = () => {
    const out: number[] = [];
    for (let i = 0; i < js.kernel.capacity; i++) if (js.alive(i)) out.push(js.state[i * KERNEL_FLOATS + 15]);
    return out.sort();
  };
  const alive = () => Array.from({ length: js.kernel.capacity }, (_, i) => i).filter((i) => js.alive(i)).length;
  return { fx, js, step, seeds, alive };
}

describe("kernel dead list (ADR 0126)", () => {
  it("stops spawning when full instead of replacing the oldest particles", () => {
    const dead = play(loopGraph(8, 60, 10), true);
    dead.step(15); // ~30 spawns wanted, 8 slots
    expect(dead.alive()).toBe(8);
    const kept = dead.seeds();
    dead.step(15);
    expect(dead.seeds()).toEqual(kept); // the same eight particles live on

    const ring = play(loopGraph(8, 60, 10), false);
    ring.step(15);
    const first = ring.seeds();
    ring.step(15);
    expect(ring.seeds()).not.toEqual(first); // the ring replaced them
  });

  it("frees slots when particles finish and reuses them", () => {
    const p = play(loopGraph(16, 30, 0.2), true);
    for (let i = 0; i < 60; i++) {
      p.step(1);
      expect(p.alive()).toBeLessThanOrEqual(16);
    }
    // At 30/s for 0.2 s about six are alive at any time, and spawning never stalls.
    expect(p.alive()).toBeGreaterThanOrEqual(4);
    expect(p.alive()).toBeLessThanOrEqual(8);
  });

  it("counts exactly", () => {
    const p = play(loopGraph(64, 45, 0.5), true);
    for (let i = 0; i < 40; i++) {
      p.step(1);
      expect(p.fx.count).toBe(p.alive());
    }
    const ring = play(loopGraph(64, 45, 0.5), false);
    ring.step(20);
    expect(ring.fx.count).toBe(ring.alive()); // JavaScript counts ring systems too
  });

  it("repeats for a seed and restarts with every slot free", () => {
    const a = play(loopGraph(32, 40, 1), true, 11);
    const b = play(loopGraph(32, 40, 1), true, 11);
    a.step(40);
    b.step(40);
    expect(Array.from(a.js.state)).toEqual(Array.from(b.js.state));
    a.fx.restart();
    expect(a.fx.count).toBe(0);
    a.step(1);
    expect(a.js.alive(0)).toBe(true); // slots fill from 0 again
  });

  it("generates a spawn pass with atomics for WebGPU, but not for event children", () => {
    const g = loopGraph(32, 10, 1);
    const k = compileParticleKernels(g, compileParticleGraph(g)).systems[0];
    const wgsl = wgslSimulation(k, { deadList: true });
    expect(wgsl).toContain("fn spawn(");
    expect(wgsl).toContain("atomic<i32>");
    expect(wgslSimulation(k)).not.toContain("fn spawn(");
    expect(wgslSimulation({ ...k, event: { parent: 0, trigger: "death", probability: 1, inheritVelocity: false } }, { deadList: true })).not.toContain("fn spawn(");
  });
});
