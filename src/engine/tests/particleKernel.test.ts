import { describe, expect, it } from "vitest";
import { compileParticleGraph } from "../scene/particleCompile";
import { compileParticleKernels, chooseBackend, KERNEL_FLOATS, type KernelSystem } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, GraphNode, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { defaultParticleGraph, newGraphId, systemTemplate } from "../scene/particleGraphFormat";
import type { EvalContext } from "../scene/particleNodes";
import { KernelEffect, JsRun, invert, type KernelHost } from "../render/particles/gpu/kernelEffect";
import { JsKernel } from "../render/particles/gpu/kernelJs";
import { krand, particleSeed, pcg } from "../render/particles/gpu/kernelMath";
import { EffectSimulation } from "../render/particles/simulation";

const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({ time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5, ...over });
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });

function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
  return b;
}

/** One system: a burst of `count` at t=0, point shape, `life` seconds, `speed` up, no gravity. */
function burstGraph(count = 1, life = 2, speed = 3): { g: ParticleGraph; sys: ParticleGraphSystem } {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.spawn.settings.looping = false;
  sys.spawn.settings.duration = 5;
  sys.settings.capacity = 64;
  addBlock(g, sys, "spawn", "spawn.burst", { time: 0, count });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: life });
  addBlock(g, sys, "initialize", "init.velocity", { speed });
  addBlock(g, sys, "initialize", "init.positionPoint");
  return { g, sys };
}

const jsHost: KernelHost = { executors: ["js"], createRun: (k) => new JsRun(k) };

function play(g: ParticleGraph, opts: { seed?: number } = {}) {
  const program = compileParticleGraph(g);
  const kp = compileParticleKernels(g, program);
  const fx = new KernelEffect(kp.systems, program.effect.emitters, jsHost, { seed: opts.seed ?? 1 });
  return { program, kp, fx, js: (i = 0) => (fx.systems.find((s) => s.kernel.emitter === i)!.run as JsRun).js };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const step = (fx: KernelEffect, dt: number, n = 1, world = IDENTITY) => {
  for (let i = 0; i < n; i++) fx.step(dt, world, 1, [1, 1, 1, 1], ctx(), null);
};
const aliveSlots = (js: JsKernel) => Array.from({ length: js.kernel.capacity }, (_, i) => i).filter((i) => js.alive(i));

describe("kernel compiler (ADR 0094)", () => {
  it("keeps plain systems on the CPU under auto, and on a kernel with gpu", () => {
    const g = defaultParticleGraph();
    const kp = compileParticleKernels(g, compileParticleGraph(g));
    const k = kp.systems[0];
    expect(k.needs).toEqual([]);
    expect(chooseBackend(undefined, k, ["webgpu"])).toBe("cpu");
    expect(chooseBackend("gpu", k, ["webgl2", "js"])).toBe("webgl2");
    expect(chooseBackend("gpu", k, [])).toBe("js");
    expect(chooseBackend("cpu", k, ["webgpu"])).toBe("cpu");
  });

  it("picks a kernel for per-particle operators, Set Attribute, several outputs and big capacities", () => {
    const { g, sys } = burstGraph();
    const b = addBlock(g, sys, "update", "attribute.size", { mode: "set" });
    g.nodes.push(node("n1", "particle.ageFraction"), node("n2", "multiply", { inputs: { b: 2 } }));
    g.edges.push({ from: "n1.out", to: "n2.a" }, { from: "n2.out", to: `${sys.id}.${b.id}.value` });
    const program = compileParticleGraph(g);
    // The CPU reports both as cpuOnly.
    expect(program.problems.every((p) => p.cpuOnly)).toBe(true);
    expect(program.problems.length).toBeGreaterThan(0);
    const k = compileParticleKernels(g, program).systems[0];
    expect(k.needs).toContain("a Set Attribute block");
    expect(k.needs).toContain("a per-particle operator chain");
    expect(chooseBackend("auto", k, ["webgpu"])).toBe("webgpu");

    const big = burstGraph().g;
    big.systems[0].settings.capacity = 10000;
    expect(chooseBackend("auto", compileParticleKernels(big, compileParticleGraph(big)).systems[0], ["webgl2"])).toBe("webgl2");
  });

  it("leaves big systems with CPU-only blocks on the CPU", () => {
    const { g, sys } = burstGraph();
    sys.settings.capacity = 10000;
    addBlock(g, sys, "update", "update.collisionColliders"); // CPU only (trails and material assets run on kernels since ADR 0126)
    const k = compileParticleKernels(g, compileParticleGraph(g)).systems[0];
    expect(k.unsupported.length).toBeGreaterThan(0);
    expect(chooseBackend("auto", k, ["webgpu"])).toBe("cpu");
  });
});

describe("the GPU Fountain template", () => {
  it("compiles cleanly and runs on a kernel with two outputs", () => {
    const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
    g.systems.push(systemTemplate(g, "gpuFountain", [0, 0]));
    const program = compileParticleGraph(g);
    const kp = compileParticleKernels(g, program);
    expect(kp.problems).toEqual([]);
    expect(kp.systems[0].outputs).toHaveLength(2);
    expect(kp.systems[0].needs).toContain("a per-particle operator chain");
    expect(chooseBackend(g.systems[0].settings.simulation, kp.systems[0], ["webgpu"])).toBe("webgpu");
  });
});

describe("JavaScript kernel executor", () => {
  it("spawns a burst into the ring and moves the particles", () => {
    const { g } = burstGraph(5, 2, 3);
    const { fx, js } = play(g);
    step(fx, 0.1);
    expect(aliveSlots(js())).toEqual([0, 1, 2, 3, 4]);
    const s = js().state;
    // Born this frame: at the origin, age 0, velocity (0, 3, 0), lifetime 2.
    expect([s[0], s[1], s[2], s[3]]).toEqual([0, 0, 0, 0]);
    expect(s[5]).toBeCloseTo(3);
    expect(s[7]).toBeCloseTo(2);
    step(fx, 0.1, 10);
    expect(s[1]).toBeCloseTo(3, 5); // 10 steps of 0.1 s at 3 m/s
    expect(s[3]).toBeCloseTo(1, 5);
    expect(fx.count).toBe(5);
  });

  it("matches the CPU simulation under gravity, a frame behind (spawns start at the frame's end)", () => {
    const { g, sys } = burstGraph(1, 3, 4);
    addBlock(g, sys, "update", "update.gravity", { strength: 1 });
    const program = compileParticleGraph(g);
    const cpu = new EffectSimulation(program.effect, { random: () => 0.5 });
    const { fx, js } = play(g);
    const dt = 1 / 60;
    step(fx, dt); // the kernel's spawn frame
    for (let i = 0; i < 30; i++) {
      cpu.step(dt, IDENTITY);
      step(fx, dt);
    }
    const p = cpu.emitters[0].pool[0];
    const s = js().state;
    expect(s[1]).toBeCloseTo(p.y, 4);
    expect(s[5]).toBeCloseTo(p.vy, 4);
  });

  it("marks a particle that died for one frame, then frees the slot", () => {
    const { g } = burstGraph(1, 0.25, 0);
    const { fx, js } = play(g);
    step(fx, 0.1, 3); // spawn, age 0.1, 0.2
    expect(js().state[7]).toBeCloseTo(0.25);
    step(fx, 0.1); // reaches 0.25: dies
    expect(js().state[7]).toBeCloseTo(-0.25);
    expect(js().alive(0)).toBe(false);
    step(fx, 0.1);
    expect(js().state[7]).toBe(0);
  });

  it("runs per-particle operators and Set Attribute in update and output", () => {
    const { g, sys } = burstGraph(1, 1, 0);
    // update: velocity += (0, age over lifetime × 10, 0) per frame (add mode)
    const vel = addBlock(g, sys, "update", "attribute.velocity", { mode: "add" });
    g.nodes.push(node("t", "particle.ageFraction"), node("v", "compose3", { inputs: { x: 0, z: 0 } }), node("m", "multiply", { inputs: { b: 10 } }));
    g.edges.push({ from: "t.out", to: "m.a" }, { from: "m.out", to: "v.y" }, { from: "v.out", to: `${sys.id}.${vel.id}.value` });
    // output: size = age over lifetime
    const size = addBlock(g, sys, "output", "attribute.size", { mode: "set" });
    g.nodes.push(node("t2", "particle.ageFraction"));
    g.edges.push({ from: "t2.out", to: `${sys.id}.${size.id}.value` });
    const { fx, js, kp } = play(g);
    expect(kp.problems).toEqual([]);
    step(fx, 0.25, 3); // spawn, then t = 0.25, 0.5
    expect(js().state[5]).toBeCloseTo(2.5 + 5, 5);
    expect(js().output(0, 0).size).toBeCloseTo(0.5, 5);
  });

  it("draws several outputs from one simulation, each with its own blocks", () => {
    const { g, sys } = burstGraph(1, 1, 0);
    sys.extraOutputs = [{ type: "quad", settings: { ...sys.output.settings }, blocks: [] }];
    addBlock(g, sys, "output", "attribute.color", { mode: "set", value: "#ff0000ff" });
    const { fx, js, kp } = play(g);
    expect(kp.systems[0].outputs).toHaveLength(2);
    expect(kp.systems[0].needs).toContain("several outputs");
    step(fx, 0.1);
    expect(js().output(0, 0).color).toEqual([1, 0, 0, 1]);
    expect(js().output(0, 1).color).toEqual([1, 1, 1, 1]);
  });

  it("applies over-life curves and gradients through the look-up table", () => {
    const { g, sys } = burstGraph(1, 1, 0);
    addBlock(g, sys, "update", "update.sizeOverLife", { size: { curve: [[0, 0], [1, 2]] } });
    addBlock(g, sys, "update", "update.colorOverLife", { color: { gradient: { colors: [[0, "#ffffff"], [1, "#000000"]], alphas: [[0, 1], [1, 0]] } } });
    const { fx, js } = play(g);
    step(fx, 0.5, 2); // t = 0.5
    const o = js().output(0, 0);
    expect(o.size).toBeCloseTo(0.1 * 1, 2); // start size 0.1 × curve(0.5) = 1
    expect(o.color[3]).toBeCloseTo(0.5, 2);
  });

  it("spawns children from GPU events with the slot mapping", () => {
    const { g, sys } = burstGraph(4, 0.15, 0);
    sys.settings.capacity = 4;
    const trig = addBlock(g, sys, "update", "update.triggerEvent", { on: "death" });
    const child = systemTemplate(g, "empty", [0, 0]);
    g.systems.push(child);
    child.settings.capacity = 12; // 3 slots per parent
    addBlock(g, child, "spawn", "spawn.burst", { time: 0, count: 2 });
    addBlock(g, child, "initialize", "init.lifetime", { lifetime: 5 });
    g.events.push({ from: `${sys.id}.${trig.id}`, to: `${child.id}.start` });
    const { fx, js, kp } = play(g);
    expect(kp.systems[1].event).toMatchObject({ parent: 0, trigger: "death" });
    step(fx, 0.1); // parents spawn
    expect(aliveSlots(js(1))).toEqual([]);
    step(fx, 0.1, 2); // parents die at 0.15
    expect(aliveSlots(js(0))).toEqual([]);
    // Two children per parent, in the first dead slots of each group of three.
    expect(aliveSlots(js(1))).toEqual([0, 1, 3, 4, 6, 7, 9, 10]);
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const { g, sys } = burstGraph(20, 2, 2);
    addBlock(g, sys, "initialize", "init.positionSphere", { radius: 1 });
    const a = play(g, { seed: 7 });
    const b = play(g, { seed: 7 });
    const c = play(g, { seed: 8 });
    for (const r of [a, b, c]) step(r.fx, 0.1, 5);
    expect(Array.from(a.js().state)).toEqual(Array.from(b.js().state));
    expect(Array.from(a.js().state)).not.toEqual(Array.from(c.js().state));
  });

  it("transforms world-space spawns by the node and keeps local ones in node space", () => {
    const { g, sys } = burstGraph(1, 2, 1);
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    sys.settings.space = "world";
    let r = play(g);
    step(r.fx, 0.1, 1, moved);
    expect(r.js().state[0]).toBeCloseTo(5);
    sys.settings.space = "local";
    r = play(g);
    step(r.fx, 0.1, 1, moved);
    expect(r.js().state[0]).toBeCloseTo(0);
  });
});

describe("kernel maths", () => {
  it("hashes in u32 and keeps seeds exact in f32", () => {
    expect(pcg(0)).toBe(pcg(0));
    expect(pcg(1)).not.toBe(pcg(2));
    const s = particleSeed(3, 4, 5);
    expect(Math.fround(s)).toBe(s);
    const r = krand(s, 11);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it("inverts matrices", () => {
    const m = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1];
    const i = invert(m);
    const mul = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, k) => {
      const col = Math.floor(k / 4);
      const row = k % 4;
      let s = 0;
      for (let j = 0; j < 4; j++) s += a[j * 4 + row] * b[col * 4 + j];
      return s;
    });
    mul(m, i).forEach((v, k) => expect(v).toBeCloseTo(IDENTITY[k]));
  });

  it("lays out 16 floats per particle", () => {
    const { g } = burstGraph();
    const k: KernelSystem = compileParticleKernels(g, compileParticleGraph(g)).systems[0];
    expect(new JsKernel(k).state.length).toBe(k.capacity * KERNEL_FLOATS);
  });
});
