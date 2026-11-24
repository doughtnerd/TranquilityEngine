// ADR 0370 "Rendering" (T16): skinning on the GPU kernel executor's backends (`render/skinning/skinRuns.ts`) against a
// recording WebGPU device and WebGL2 context (no GPU headless), the CPU backend's output, the bounds library, and the
// Babylon skinned-mesh backend on NullEngine (the CPU executor; the GPU paths are checked on screen by the e2e capture).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { describe, expect, it } from "vitest";
import { BUFFER, type GpuDevice } from "../render/gpuKernels/webgpu";
import { FeedbackSkinRuns, JsSkinRuns, WebGpuSkinRuns } from "../render/skinning/skinRuns";
import { identityPalette, SKIN_STRIDE } from "../render/skinning/skinKernel";
import { morphedBox, morphReach, restBox, skinnedBox, transformBox } from "../render/skinning/skinBounds";
import type { SkinGeometry } from "../render/skinning/skinData";
import { BabylonSkinnedMeshes, skinExecutorFor } from "../render/babylon/skinnedMeshes";
import type { ModelMesh } from "../scene/models";

/** A two-vertex mesh, each vertex on its own joint; one morph target moving vertex 0 up. */
const GEOMETRY: SkinGeometry = {
  positions: new Float32Array([1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1]),
  tangents: null,
  skin: { influences: 4, joints: [0, 0, 0, 0, 1, 0, 0, 0], weights: [1, 0, 0, 0, 1, 0, 0, 0] },
  morphTargets: [{ name: "up", positions: new Float32Array([0, 2, 0, 0, 0, 0]), normals: null }],
};

/** Joint 0 at rest, joint 1 moved by +10 on x. */
const PALETTE = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0]);

interface Buf {
  size: number;
  usage: number;
  label?: string;
  destroyed: boolean;
}

function recordingDevice() {
  const rec = { buffers: [] as Buf[], writes: [] as { buffer: unknown; offset: number; bytes: number; data: unknown }[], dispatches: 0, submits: 0, passes: 0, pipelines: 0, setPipelines: 0, groups: [] as { binding: number; resource: unknown }[][] };
  const device = {
    createBuffer: (d: { size: number; usage: number; label?: string }) => {
      const b = { ...d, destroyed: false, destroy: () => (b.destroyed = true) };
      rec.buffers.push(b);
      return b;
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => (rec.pipelines++, {}),
    createBindGroup: (d: { entries: { binding: number; resource: unknown }[] }) => (rec.groups.push(d.entries), {}),
    createCommandEncoder: () => ({
      beginComputePass: () => (rec.passes++, { setPipeline: () => rec.setPipelines++, setBindGroup: () => {}, dispatchWorkgroups: () => rec.dispatches++, end: () => {} }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer: unknown, offset: number, data: unknown, at = 0, size?: number) =>
        rec.writes.push({ buffer, offset, bytes: size ?? 0, data: data instanceof ArrayBuffer ? new Float32Array(data.slice(at, at + (size ?? data.byteLength))) : data }),
      submit: () => rec.submits++,
    },
  };
  return { device: device as unknown as GpuDevice, rec };
}

function recordingGl() {
  const calls: [string, unknown[]][] = [];
  const values: Record<string, unknown> = { getShaderParameter: true, getProgramParameter: true };
  const gl = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (/^[A-Z0-9_]+$/.test(name)) return name.length;
        if (name === "isContextLost") return () => false;
        if (name === "getUniformLocation") return (_p: unknown, n: string) => ({ uniform: n });
        return (...args: unknown[]) => {
          calls.push([name, args]);
          return name in values ? values[name] : { object: name, n: calls.length };
        };
      },
    },
  ) as WebGL2RenderingContext;
  return { gl, calls, named: (n: string) => calls.filter(([c]) => c === n).map(([, a]) => a) };
}

describe("skinning on WebGPU (recording device)", () => {
  it("writes into a vertex-usage output; every palette in one table uploaded once; one pass and one submit per flush", () => {
    const { device, rec } = recordingDevice();
    const runs = new WebGpuSkinRuns(device);
    const hero = runs.palette("hero");
    const villain = runs.palette("villain");
    const a = runs.run(GEOMETRY);
    const b = runs.run(GEOMETRY);
    const c = runs.run(GEOMETRY);
    const out = rec.buffers.filter((x) => x.label === "kernel mycoSkin4 output");
    expect(out).toHaveLength(3);
    expect(out[0].size).toBe(2 * SKIN_STRIDE);
    expect(out[0].usage & (BUFFER.VERTEX | BUFFER.STORAGE)).toBe(BUFFER.VERTEX | BUFFER.STORAGE);
    expect(rec.pipelines).toBe(1); // one pipeline for every run of the spec
    a.setPalette(hero);
    b.setPalette(hero);
    c.setPalette(villain);
    const writes = rec.writes.length;
    hero.upload(PALETTE);
    villain.upload(identityPalette(3));
    expect(rec.writes.length - writes).toBe(0); // written before the next pass, not at once
    a.dispatch();
    const table = rec.buffers.find((x) => x.label === "skin palettes" && !x.destroyed)!;
    const tableWrites = rec.writes.filter((w) => w.buffer === table);
    expect(tableWrites).toEqual([expect.objectContaining({ offset: 0, bytes: 5 * 48 })]); // both palettes, one write
    b.dispatch();
    c.dispatch();
    expect(rec.writes.filter((w) => w.buffer === table)).toHaveLength(1);
    expect(rec.dispatches).toBe(3);
    expect(rec.submits).toBe(0); // recorded, not yet submitted
    runs.flush();
    expect(rec.submits).toBe(1);
    expect(rec.passes).toBe(1);
    expect(rec.setPipelines).toBe(1); // set once for the pass
    expect(rec.groups).toHaveLength(3); // one bind group per run, cached
    expect(rec.groups[0][3].resource).toEqual({ buffer: table }); // binding 3: bones, the shared table
    // The villain's run reads from joint 2 of the table: its params say so.
    const cParams = rec.writes.filter((w) => w.data instanceof Float32Array && w.data.length === 8 && w.data[2] === 2);
    expect(cParams).toHaveLength(1);
    // A flush without dispatches submits nothing; an unchanged frame uploads nothing.
    runs.flush();
    expect(rec.submits).toBe(1);
    a.dispatch();
    runs.flush();
    expect(rec.writes.filter((w) => w.buffer === table)).toHaveLength(1);
    expect(rec.submits).toBe(2);
    // A skeleton that outgrows the table regrows it; the runs rebind it.
    const big = runs.palette("big");
    big.upload(identityPalette(80));
    a.dispatch();
    runs.flush();
    expect(table.destroyed).toBe(true);
    const grown = rec.buffers.find((x) => x.label === "skin palettes" && !x.destroyed)!;
    expect(grown.size).toBeGreaterThanOrEqual(85 * 48);
    expect(rec.writes.filter((w) => w.buffer === grown)).toEqual([expect.objectContaining({ offset: 0, bytes: 85 * 48 })]); // written whole
    expect(rec.groups).toHaveLength(4);
    // Morph weights rewrite the small params table only.
    const before = rec.writes.length;
    a.setMorphWeights([0.5]);
    expect(rec.writes.length - before).toBe(1);
    for (const x of [a, b, c]) x.dispose();
    for (const p of [hero, villain, big]) p.dispose();
    runs.dispose();
    expect(rec.buffers.every((x) => x.destroyed)).toBe(true);
  });

  it("reuses a disposed skeleton's range and keeps a pass's table alive until it is submitted", () => {
    const { device, rec } = recordingDevice();
    const runs = new WebGpuSkinRuns(device);
    const one = runs.palette("one");
    one.upload(identityPalette(2));
    const run = runs.run(GEOMETRY);
    run.setPalette(one);
    run.dispatch(); // recorded with the first table
    const first = rec.buffers.find((x) => x.label === "skin palettes" && !x.destroyed)!;
    const big = runs.palette("big");
    big.upload(identityPalette(100)); // grows the table while the pass is pending
    const other = runs.run(GEOMETRY);
    other.setPalette(big);
    other.dispatch();
    expect(first.destroyed).toBe(false); // the pending pass still reads it
    runs.flush();
    expect(first.destroyed).toBe(true);
    one.dispose();
    const two = runs.palette("two");
    two.upload(identityPalette(2));
    run.setPalette(two);
    const writes = rec.writes.length;
    run.dispatch();
    runs.flush();
    const table = rec.buffers.find((x) => x.label === "skin palettes" && !x.destroyed)!;
    expect(rec.writes.slice(writes).filter((w) => w.buffer === table)).toEqual([expect.objectContaining({ offset: 0, bytes: 2 * 48 })]); // the freed range at joint 0
  });

  it("makes its outputs through the renderer's factory", () => {
    const { device } = recordingDevice();
    const made: [number, string][] = [];
    const runs = new WebGpuSkinRuns(device, (size, label) => {
      made.push([size, label]);
      return { destroy: () => {} };
    });
    runs.run(GEOMETRY);
    expect(made).toEqual([[96, "kernel mycoSkin4 output"]]);
  });

  it("doesn't dispatch without a palette", () => {
    const { device, rec } = recordingDevice();
    new WebGpuSkinRuns(device).run(GEOMETRY).dispatch();
    expect(rec.dispatches).toBe(0);
  });
});

describe("skinning on WebGL2 (transform feedback, recording context)", () => {
  it("captures into a vertex buffer at stride 48, every palette in one texture, passes sharing their state", () => {
    const { gl, calls, named } = recordingGl();
    const runs = new FeedbackSkinRuns(gl);
    const hero = runs.palette("hero");
    const villain = runs.palette("villain");
    const eight = { ...GEOMETRY, skin: { influences: 8 as const, joints: new Array(16).fill(0), weights: [1, ...new Array(15).fill(0)] } };
    const a = runs.run(eight);
    const b = runs.run(eight);
    expect(named("transformFeedbackVaryings")).toHaveLength(1); // one program for every run of the spec
    expect(named("transformFeedbackVaryings")[0][1]).toEqual(["kout0", "kout1", "kout2"]);
    expect(named("bufferData")).toContainEqual([gl.ARRAY_BUFFER, 2 * SKIN_STRIDE, gl.DYNAMIC_COPY]);
    expect(named("shaderSource").some(([, src]) => String(src).includes("const int SKIN_INFLUENCES = 8;"))).toBe(true);
    a.setPalette(hero);
    b.setPalette(villain);
    hero.upload(PALETTE);
    villain.upload(PALETTE);
    expect(named("texSubImage2D").filter(([, , , , w]) => w === 1024)).toHaveLength(0); // uploaded before the next pass
    calls.length = 0;
    a.dispatch();
    b.dispatch();
    // The table: 1024 texels wide (three per joint), both palettes in one upload of its first row.
    expect(named("texStorage2D")[0].slice(3)).toEqual([1024, 3]);
    const uploads = named("texSubImage2D");
    expect(uploads[0]).toEqual([gl.TEXTURE_2D, 0, 0, 0, 1024, 1, gl.RGBA, gl.FLOAT, expect.any(Float32Array)]);
    // The only other upload: b's params table, now reading from joint 2 (the villain's range).
    expect(uploads).toHaveLength(2);
    expect(Array.from(uploads[1][8] as Float32Array).slice(0, 3)).toEqual([2, 1, 2]);
    expect(named("drawArrays")).toEqual([
      [gl.POINTS, 0, 2],
      [gl.POINTS, 0, 2],
    ]);
    expect(named("useProgram")).toHaveLength(1);
    expect(named("enable")).toEqual([[gl.RASTERIZER_DISCARD]]);
    expect(named("uniform1i").filter(([u]) => (u as { uniform: string }).uniform === "kin_bones_w")).toEqual([[{ uniform: "kin_bones_w" }, 1024]]); // set once
    expect(named("bindBufferBase").map((x) => x[2])).toEqual([a.output, b.output]);
    calls.length = 0;
    runs.flush(); // restores what the passes changed
    expect(named("disable")).toEqual([[gl.RASTERIZER_DISCARD]]);
    expect(named("bindBufferBase")).toEqual([[gl.TRANSFORM_FEEDBACK_BUFFER, 0, null]]);
    expect(named("bindVertexArray")).toEqual([[null]]);
    calls.length = 0;
    runs.flush(); // nothing ran since
    expect(calls).toHaveLength(0);
    a.dispose();
    b.dispose();
    hero.dispose();
    villain.dispose();
    runs.dispose();
    expect(named("deleteProgram")).toHaveLength(1);
  });
});

describe("skinning on the CPU", () => {
  it("skins, morphs and re-skins only when dispatched", () => {
    const runs = new JsSkinRuns();
    const palette = runs.palette("p");
    const run = runs.run(GEOMETRY);
    run.setPalette(palette);
    palette.upload(PALETTE);
    run.dispatch();
    expect(Array.from(run.output.subarray(0, 4))).toEqual([1, 0, 0, 1]);
    expect(Array.from(run.output.subarray(12, 16))).toEqual([10, 1, 0, 1]);
    run.setMorphWeights([1]);
    expect(run.output[1]).toBe(0); // not yet dispatched
    run.dispatch();
    expect(Array.from(run.output.subarray(0, 3))).toEqual([1, 2, 0]);
  });
});

describe("skinned bounds", () => {
  it("unites the used joints' transformed (morphed) rest boxes", () => {
    const rest = restBox(GEOMETRY);
    expect(rest).toEqual([0, 0, 0, 1, 1, 0]);
    const reach = morphReach(GEOMETRY);
    expect(Array.from(reach)).toEqual([0, 2, 0]);
    expect(morphedBox(rest, reach, [0.5])).toEqual([0, -1, 0, 1, 2, 0]);
    expect(skinnedBox(rest, PALETTE, [0, 1])).toEqual([0, 0, 0, 11, 1, 0]);
    expect(skinnedBox(rest, PALETTE, [1])).toEqual([10, 0, 0, 11, 1, 0]); // only the joints the mesh uses
    expect(skinnedBox(rest, PALETTE, [])).toEqual(rest); // no skin: the rest box
  });

  it("transforms a box by a column-major world matrix", () => {
    const m = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]; // 90° about z, then +5 on x
    expect(transformBox([0, 0, 0, 1, 2, 3], m)).toEqual([3, 0, 0, 5, 1, 3]);
  });
});

describe("Babylon skinned meshes (NullEngine: the CPU executor)", () => {
  const model = {
    name: "body",
    materials: [],
    surfaces: [],
    data: { positions: GEOMETRY.positions, normals: GEOMETRY.normals, uvs: new Float32Array(4), indices: new Uint32Array([0, 1, 0]), groups: [] },
  } as unknown as ModelMesh;

  it("draws the kernel's output as the mesh's positions and normals, with caller bounds, materials and shadows", () => {
    const scene = new Scene(new NullEngine());
    expect(skinExecutorFor(scene.getEngine())).toBe("js");
    const requests: unknown[] = [];
    const material = { name: "m" };
    const draws = new BabylonSkinnedMeshes({ scene, materials: { slotMaterials: (req) => (requests.push(req), () => material as never) } });
    expect(draws.executor).toBe("js");
    const palette = draws.palette("p");
    const draw = draws.create({ model, geometry: GEOMETRY }, "hero:body");
    const mesh: Mesh = draw.mesh;
    expect(scene.meshes).toContain(mesh);
    expect(mesh.getVertexBuffer(VertexBuffer.PositionKind)?.byteStride).toBe(48);
    expect(mesh.getVertexBuffer(VertexBuffer.NormalKind)?.byteOffset).toBe(16);
    expect(mesh.getVertexBuffer(VertexBuffer.TangentKind)).toBeFalsy(); // the geometry has no tangents
    expect(mesh.getTotalIndices()).toBe(3);
    draw.setPalette(palette);
    palette.upload(PALETTE);
    draw.dispatch();
    draws.endDispatches();
    expect(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)!)).toEqual([1, 0, 0, 10, 1, 0]);
    expect(Array.from(mesh.getVerticesData(VertexBuffer.NormalKind)!)).toEqual([0, 0, 1, 0, 0, 1]);
    draw.setBounds([0, 0, 0, 11, 1, 0]);
    draw.setWorldMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1], 0);
    const box = mesh.getBoundingInfo().boundingBox;
    expect([box.maximumWorld.x, box.maximumWorld.y]).toEqual([11, 6]);
    draw.setMaterials({ mesh: "asset:hero.glb", material: "", materials: [] });
    draw.setMaterials({ mesh: "asset:hero.glb", material: "", materials: [] }); // unchanged: not resolved again
    expect(requests).toHaveLength(1);
    expect(mesh.material).toBe(material);
    draw.setShadows(true, false);
    expect(mesh.receiveShadows).toBe(false);
    draw.setEnabled(false);
    expect(mesh.isEnabled()).toBe(false);
    draw.dispose();
    expect(scene.meshes).not.toContain(mesh);
    draws.dispose();
  });
});
