// ADR 0251, 0370 (T15): the particle kernels' generated WGSL and GLSL, pinned in full. The snapshots under
// `__snapshots__/particleKernelShaderText/` were written from the commit before the GPU kernel executor
// (`render/gpuKernels/`) took over the runners; the move must leave every byte as it was.
import { describe, expect, it } from "vitest";
import { compileParticleKernels, type KernelSystem } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { ContextKind, GraphInputValue, ParticleGraph, ParticleGraphSystem } from "../scene/particleGraph";
import { newGraphId, systemTemplate } from "../scene/particleGraphFormat";
import { GLSL_SIM_VERTEX, GLSL_TRAIL_HISTORY, glslDraw, glslSimulation, wgslDraw, wgslSimulation } from "../render/particles/gpu/kernelShader";

function addBlock(g: ParticleGraph, sys: ParticleGraphSystem, c: ContextKind, type: string, inputs: Record<string, GraphInputValue> = {}) {
  const b = defaultBlock(type, newGraphId(g, "b"));
  Object.assign(b.inputs, inputs);
  sys[c].blocks.push(b);
  return b;
}

function emptyGraph(): ParticleGraph {
  return { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
}

function system(g: ParticleGraph, capacity: number): ParticleGraphSystem {
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.settings.capacity = capacity;
  sys.settings.simulation = "gpu";
  addBlock(g, sys, "spawn", "spawn.rate", { rate: 20 });
  addBlock(g, sys, "initialize", "init.lifetime", { lifetime: 2 });
  addBlock(g, sys, "initialize", "init.velocity", { speed: 1 });
  addBlock(g, sys, "initialize", "init.positionPoint");
  return sys;
}

/** Graphs that between them reach every binding the runners set up: curves, events, depth, trails. */
function cases(): Record<string, KernelSystem[]> {
  const basic = emptyGraph();
  system(basic, 64);

  const curves = emptyGraph();
  const cs = system(curves, 2000);
  addBlock(curves, cs, "update", "update.gravity");
  addBlock(curves, cs, "update", "update.colorOverLife");
  addBlock(curves, cs, "update", "update.sizeOverLife", { size: { curve: [[0, 1], [1, 0]] } });
  addBlock(curves, cs, "update", "update.noise");

  const events = emptyGraph();
  const parent = system(events, 16);
  const trig = addBlock(events, parent, "update", "update.triggerEvent", { on: "death" });
  const child = systemTemplate(events, "empty", [0, 0]);
  events.systems.push(child);
  child.settings.capacity = 48;
  child.settings.simulation = "gpu";
  addBlock(events, child, "spawn", "spawn.burst", { time: 0, count: 2 });
  addBlock(events, child, "initialize", "init.lifetime", { lifetime: 1 });
  events.events.push({ from: `${parent.id}.${trig.id}`, to: `${child.id}.start` });

  const depth = emptyGraph();
  const ds = system(depth, 128);
  addBlock(depth, ds, "update", "update.collisionDepth");

  const trails = emptyGraph();
  const ts = system(trails, 32);
  ts.output.type = "trail";
  ts.output.settings.trailLength = 8;

  const out: Record<string, KernelSystem[]> = {};
  for (const [name, g] of Object.entries({ basic, curves, events, depth, trails })) {
    const kp = compileParticleKernels(g);
    expect(kp.problems).toEqual([]);
    out[name] = kp.systems;
  }
  return out;
}

const DIR = "./__snapshots__/particleKernelShaderText";

describe("particle kernel shader text (byte-identical through the GPU kernel executor)", () => {
  it("keeps the WebGL2 pass shaders", async () => {
    await expect(GLSL_SIM_VERTEX).toMatchFileSnapshot(`${DIR}/sim.vert.glsl`);
    await expect(GLSL_TRAIL_HISTORY).toMatchFileSnapshot(`${DIR}/trailHistory.frag.glsl`);
  });

  for (const [name, systems] of Object.entries(cases())) {
    it(`keeps the ${name} kernels' simulation and draw shaders`, async () => {
      for (let s = 0; s < systems.length; s++) {
        const k = systems[s];
        await expect(wgslSimulation(k)).toMatchFileSnapshot(`${DIR}/${name}.${s}.sim.wgsl`);
        await expect(wgslSimulation(k, { deadList: true })).toMatchFileSnapshot(`${DIR}/${name}.${s}.sim.deadList.wgsl`);
        await expect(glslSimulation(k)).toMatchFileSnapshot(`${DIR}/${name}.${s}.sim.frag.glsl`);
        for (let o = 0; o < k.outputs.length; o++) {
          const w = wgslDraw(k, o);
          const gl = glslDraw(k, o);
          await expect(`${w.vertex}\n// ---- fragment ----\n${w.fragment}`).toMatchFileSnapshot(`${DIR}/${name}.${s}.draw${o}.wgsl`);
          await expect(`${gl.vertex}\n// ---- fragment ----\n${gl.fragment}`).toMatchFileSnapshot(`${DIR}/${name}.${s}.draw${o}.glsl`);
        }
      }
    });
  }
});
