// ADR 0126: trails on kernel outputs (compiler, the JavaScript executor's history, the draw shaders).
import { describe, expect, it } from "vitest";
import { compileParticleGraph } from "../scene/particleCompile";
import { compileParticleKernels, KERNEL_FLOATS, LUT_SAMPLES, MAX_TRAIL_HISTORY } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { newGraphId, systemTemplate } from "../scene/particleGraphFormat";
import type { EvalContext } from "../scene/particleNodes";
import { KernelEffect, JsRun, type KernelHost } from "../render/particles/gpu/kernelEffect";
import { glslDraw, glslSimulation, wgslDraw, wgslSimulation } from "../render/particles/gpu/kernelShader";

const ctx = (): EvalContext => ({ time: 0, deltaTime: 0, playTime: 0, properties: new Map(), random: () => 0.5 });
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
}

function trailGraph(capacity = 16, points = 6): { g: ParticleGraph; sys: ParticleGraphSystem } {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.settings.capacity = capacity;
  sys.settings.simulation = "gpu";
  sys.spawn.settings.looping = false;
  addBlock(g, sys, "spawn", "spawn.burst", { time: 0, count: 2 });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 5 });
  addBlock(g, sys, "initialize", "init.velocity", { speed: 3 });
  addBlock(g, sys, "initialize", "init.positionPoint");
  sys.output.type = "trail";
  sys.output.settings.trailLength = points;
  return { g, sys };
}

describe("kernel trails (ADR 0126)", () => {
  it("compiles trail outputs with a history length and a width row", () => {
    const { g, sys } = trailGraph(16, 6);
    addBlock(g, sys, "output", "output.widthOverLength", { width: { curve: [[0, 1], [1, 0]] } });
    const kp = compileParticleKernels(g, compileParticleGraph(g));
    const k = kp.systems[0];
    expect(k.unsupported).toEqual([]);
    expect(k.trail).toBe(6);
    const row = k.outputs[0].trail!.widthRow;
    expect(k.luts[row].value).toEqual([[0, 1], [1, 0]]);
  });

  it("keeps the history within its budget, and points within 2 to 64", () => {
    const big = trailGraph(1_000_000, 64).g;
    const kp = compileParticleKernels(big, compileParticleGraph(big));
    expect(kp.systems[0].trail! * 1_000_000).toBeLessThanOrEqual(MAX_TRAIL_HISTORY);
    expect(kp.problems.some((p) => /points/.test(p.message))).toBe(true);
    const long = trailGraph(16, 500).g;
    expect(compileParticleKernels(long, compileParticleGraph(long)).systems[0].trail).toBe(64);
  });

  it("writes each slot's position and seed into this frame's block", () => {
    const { g } = trailGraph(4, 4);
    const program = compileParticleGraph(g);
    const kp = compileParticleKernels(g, program);
    const host: KernelHost = { executors: ["js"], createRun: (k) => new JsRun(k) };
    const fx = new KernelEffect(kp.systems, program.effect.emitters, host, { seed: 3 });
    const js = (fx.systems[0].run as JsRun).js;
    const frames: number[][] = [];
    for (let f = 0; f < 6; f++) {
      fx.step(1 / 30, IDENTITY, 1, [1, 1, 1, 1], ctx(), null);
      frames.push([js.state[1], js.uniforms[1 * 4 + 3]]); // slot 0's y, the frame number
    }
    const h = js.history!;
    const seed = js.state[15];
    // The last four frames' points of slot 0, newest at block frame % 4: all tagged with its seed, rising.
    for (let back = 0; back < 4; back++) {
      const [y, frame] = frames[5 - back];
      const o = ((frame % 4) * 4 + 0) * 4;
      expect(h[o + 3]).toBe(seed);
      expect(h[o + 1]).toBeCloseTo(y, 5);
    }
    expect(js.state[0 * KERNEL_FLOATS + 7]).toBeGreaterThan(0);
  });

  it("generates history writes and ribbon draws for every executor", () => {
    const { g } = trailGraph(16, 8);
    const k = compileParticleKernels(g, compileParticleGraph(g)).systems[0];
    expect(wgslSimulation(k)).toContain("k_trailWrite(i)");
    expect(wgslSimulation(k, { deadList: true }).match(/k_trailWrite\(i\);/g)?.length).toBe(2); // update and spawn passes
    expect(glslSimulation(k)).not.toContain("khist"); // WebGL2 writes it in its own pass
    const w = wgslDraw(k, 0, { soft: false, sorted: true });
    expect(w.vertex).toContain("k_trail(");
    expect(w.vertex).toContain("khist");
    expect(w.vertex).toContain("kidx");
    expect(glslDraw(k, 0, { soft: true }).vertex).toContain(`k_hist(float k)`);
    void LUT_SAMPLES;
  });
});
