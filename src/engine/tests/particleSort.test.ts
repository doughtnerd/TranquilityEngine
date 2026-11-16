// ADR 0126: kernel particles sorted back to front (the bitonic network the GPU passes run, the JS sort).
import { describe, expect, it } from "vitest";
import { KERNEL_FLOATS, U } from "../scene/particleKernel";
import { outputSorts } from "../scene/particleGraph";
import { parseParticleGraph } from "../scene/particleGraphFormat";
import { bitonicStages, bitonicStep } from "../render/particles/gpu/bitonic";
import { WebGpuSorter, depthRow, sortLayout, sortPairsJs } from "../render/particles/gpu/sort";
import type { GpuDevice } from "../render/particles/gpu/webgpuRun";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** State with particles at z = zs[i] (NaN: dead). */
function stateAt(zs: number[]): Float32Array {
  const s = new Float32Array(zs.length * KERNEL_FLOATS);
  zs.forEach((z, i) => {
    if (Number.isNaN(z)) return;
    s[i * KERNEL_FLOATS + 2] = z;
    s[i * KERNEL_FLOATS + 3] = 0.1; // age
    s[i * KERNEL_FLOATS + 7] = 1; // lifetime
  });
  return s;
}

describe("particle sorting (ADR 0126)", () => {
  it("lays out a power of two", () => {
    expect(sortLayout(1)).toEqual({ n: 2, width: 2, height: 1 });
    expect(sortLayout(1000)).toEqual({ n: 1024, width: 1024, height: 1 });
    expect(sortLayout(5000)).toEqual({ n: 8192, width: 1024, height: 8 });
    expect(bitonicStages(8)).toEqual([[2, 1], [4, 2], [4, 1], [8, 4], [8, 2], [8, 1]]);
    expect(bitonicStages(65536).length).toBe(136);
  });

  it("the bitonic network sorts any keys ascending", () => {
    const r = rng(3);
    for (const n of [2, 4, 64, 1024]) {
      const pairs = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        pairs[i * 2] = i % 7 === 0 ? 3e38 : Math.floor(r() * 100) - 50;
        pairs[i * 2 + 1] = i;
      }
      for (const [k, j] of bitonicStages(n)) bitonicStep(pairs, n, k, j);
      for (let i = 1; i < n; i++) expect(pairs[i * 2]).toBeGreaterThanOrEqual(pairs[(i - 1) * 2]);
      // A permutation: every slot once.
      expect(new Set(Array.from({ length: n }, (_, i) => pairs[i * 2 + 1])).size).toBe(n);
    }
  });

  it("orders particles farthest first, dead slots last", () => {
    const state = stateAt([2, NaN, 9, 5, NaN]);
    const layout = sortLayout(5);
    const out = new Float32Array(layout.n * 2);
    sortPairsJs(state, 5, [0, 0, 1, 0], out, layout); // depth = z
    const order = Array.from({ length: layout.n }, (_, i) => out[i * 2 + 1]);
    expect(order.slice(0, 3)).toEqual([2, 3, 0]);
    expect(out[3 * 2]).toBeGreaterThan(1e38); // a dead slot's key
  });

  it("carries the view row through the node's matrix for local-space systems", () => {
    const u = new Float32Array(32 * 4);
    // The node moved 10 along z: local z 1 is view depth 11 (left-handed view at the origin).
    u.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1], U.matrix * 4);
    const row = depthRow([0, 0, 1, 0], u, false);
    expect(row[2] * 1 + row[3]).toBeCloseTo(11);
    u[U.flags * 4 + 2] = 1; // world space: the matrix doesn't apply
    expect(depthRow([0, 0, 1, 0], u, false)).toEqual([0, 0, 1, 0]);
    expect(depthRow([0, 0, 1, 0], u, true)).toEqual([-0, -0, -1, -0]);
  });

  it("sorts alpha-blended outputs by default, and follows the setting", () => {
    expect(outputSorts({ blending: "alpha" })).toBe(true);
    expect(outputSorts({ blending: "additive" })).toBe(false);
    expect(outputSorts({ blending: "additive", sort: "on" })).toBe(true);
    expect(outputSorts({ blending: "alpha", sort: "off" })).toBe(false);
    const g = parseParticleGraph({ format: "myco.particles@2", systems: [{ id: "s", name: "S", position: [0, 0], settings: { space: "world", capacity: 10 }, spawn: { settings: {}, blocks: [] }, initialize: { blocks: [] }, update: { blocks: [] }, output: { type: "quad", settings: { sort: "off" }, blocks: [] } }] });
    expect(g.graph.systems[0].output.settings.sort).toBe("off");
  });

  it("builds the WebGPU sort from the WGSL key pass and one pipeline per entry, a step per network stage", () => {
    const shaders: string[] = [], entries: string[] = [];
    let stageGroups = 0;
    const device = new Proxy({} as Record<string, unknown>, {
      get: (_, key) => {
        if (key === "queue") return { writeBuffer: () => undefined, submit: () => undefined };
        if (key === "createShaderModule") return (d: { code: string }) => (shaders.push(d.code), {});
        if (key === "createComputePipeline") return (d: { compute: { entryPoint: string } }) => (entries.push(d.compute.entryPoint), {});
        if (key === "createBindGroup") return (d: { entries: { resource: { size?: number } }[] }) => (d.entries[0].resource.size === 16 && stageGroups++, {});
        return () => ({ destroy: () => undefined });
      },
    }) as unknown as GpuDevice;
    const sorter = new WebGpuSorter(device, 100);
    expect(sorter.layout.n).toBe(128);
    expect(shaders).toHaveLength(1);
    expect(shaders[0]).toContain("fn sortKeys(");
    expect(shaders[0]).toContain("fn sortStep(");
    expect(shaders[0]).toContain("var key = 3e+38;"); // dead slots' key
    expect(entries).toEqual(["sortKeys", "sortStep"]);
    expect(stageGroups).toBe(bitonicStages(128).length);
  });
});
