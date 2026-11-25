// ADR 0370 (T15): the GPU kernel executor (`render/gpuKernels`), through its interface: the shared
// layout arithmetic, item kernels' three outputs of one KSL body (JavaScript run here; WGSL and GLSL glue
// checked as text), and both GPU backends against a recording device / context (no GPU headless).
import { describe, expect, it } from "vitest";
import { shaderSource } from "../render/shaderSource/shaderSource";
import { dispatchGroups, gridLayout, padToGrid, PingPong, texelOf } from "../render/gpuKernels/layout";
import { JsItemKernel, checkItemKernel, itemKernelFeedbackVaryings, itemKernelGlsl, itemKernelGlslFeedback, itemKernelWgsl, itemStride, type ItemKernelSpec } from "../render/gpuKernels/itemKernel";
import { GlFeedbackBatch, GlFeedbackItemKernel } from "../render/gpuKernels/itemKernelFeedback";
import { GpuItemKernel } from "../render/gpuKernels/itemKernelWebgpu";
import { GlItemKernel } from "../render/gpuKernels/itemKernelWebgl2";
import { BUFFER, GpuComputeBatch, type GpuDevice } from "../render/gpuKernels/webgpu";
import { compileParticleKernels, U } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { ParticleGraph } from "../scene/particleGraph";
import { newGraphId, systemTemplate } from "../scene/particleGraphFormat";
import { WebGpuRun } from "../render/particles/gpu/webgpuRun";
import { WebGl2Run } from "../render/particles/gpu/webgl2Run";

/** A trivial kernel: moves each point by a uniform scale and offset, and writes its index. */
const MOVE: ItemKernelSpec = {
  name: "move",
  inputs: ["pos", "params"],
  outputs: ["moved", "index"],
  body: shaderSource(/* KSL */ `
FN(void, kernelItem, KI i) {
  VAR(KV4, p) = in_pos(i);
  VAR(KV4, s) = in_params(0);
  out_moved = KV4(p.x * s.x + s.y, p.y * s.x + s.y, p.z * s.x + s.y, p.w);
  if (i > 1) {
    out_index = KV4(KF(i), 0.0, 0.0, 1.0);
  }
}
`),
};

// --- a recording WebGPU device ------------------------------------------------------------------------

interface Rec {
  buffers: { size: number; usage: number; label?: string; destroyed: boolean }[];
  layouts: unknown[][];
  pipelines: string[];
  groups: { binding: number; resource: unknown }[][];
  dispatches: [string, number, number][];
  writes: { buffer: unknown; offset: number; bytes: number }[];
  shaders: string[];
}

function recordingDevice(lost?: Promise<unknown>): { device: GpuDevice; rec: Rec } {
  const rec: Rec = { buffers: [], layouts: [], pipelines: [], groups: [], dispatches: [], writes: [], shaders: [] };
  const device = {
    createBuffer: (d: { size: number; usage: number; label?: string }) => {
      const b = { ...d, destroyed: false, destroy: () => (b.destroyed = true) };
      rec.buffers.push(b);
      return b;
    },
    createShaderModule: (d: { code: string }) => {
      rec.shaders.push(d.code);
      return {};
    },
    createBindGroupLayout: (d: { entries: unknown[] }) => {
      rec.layouts.push(d.entries);
      return {};
    },
    createPipelineLayout: () => ({}),
    createComputePipeline: (d: { compute: { entryPoint: string } }) => {
      rec.pipelines.push(d.compute.entryPoint);
      return { entry: d.compute.entryPoint };
    },
    createBindGroup: (d: { entries: { binding: number; resource: unknown }[] }) => {
      rec.groups.push(d.entries);
      return { entries: d.entries };
    },
    createTexture: () => ({ createView: () => ({ dummy: true }) }),
    createCommandEncoder: () => {
      let pipeline = "";
      return {
        beginComputePass: () => ({
          setPipeline: (p: { entry: string }) => (pipeline = p.entry),
          setBindGroup: () => {},
          dispatchWorkgroups: (x: number, y = 1) => rec.dispatches.push([pipeline, x, y]),
          end: () => {},
        }),
        copyBufferToBuffer: () => {},
        finish: () => ({}),
      };
    },
    queue: {
      writeBuffer: (buffer: unknown, offset: number, _data: unknown, _o?: number, size?: number) => rec.writes.push({ buffer, offset, bytes: size ?? 0 }),
      submit: () => {},
    },
    lost,
  };
  return { device: device as unknown as GpuDevice, rec };
}

// --- a recording WebGL2 context -----------------------------------------------------------------------

function recordingGl(): { gl: WebGL2RenderingContext; calls: [string, unknown[]][]; lose: () => void } {
  const calls: [string, unknown[]][] = [];
  let lost = false;
  const values: Record<string, unknown> = {
    getShaderParameter: true,
    getProgramParameter: true,
    getExtension: {},
    getParameter: 8,
  };
  const gl = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (/^[A-Z0-9_]+$/.test(name)) return name.length; // a constant: any stable number
        if (name === "isContextLost") return () => lost;
        if (name === "getUniformLocation") return (_p: unknown, n: string) => ({ uniform: n });
        return (...args: unknown[]) => {
          calls.push([name, args]);
          return name in values ? values[name] : { object: name };
        };
      },
    },
  ) as WebGL2RenderingContext;
  return { gl, calls, lose: () => (lost = true) };
}

function trailDepthKernel() {
  const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
  const sys = systemTemplate(g, "empty", [0, 0]);
  g.systems.push(sys);
  sys.settings.capacity = 100;
  sys.settings.simulation = "gpu";
  for (const [c, type, inputs] of [
    ["spawn", "spawn.rate", { rate: 10 }],
    ["initialize", "init.lifetime", { lifetime: 1 }],
    ["update", "update.collisionDepth", {}],
  ] as const) {
    const b = defaultBlock(type, newGraphId(g, "b"));
    Object.assign(b.inputs, inputs);
    sys[c].blocks.push(b);
  }
  sys.output.type = "trail";
  sys.output.settings.trailLength = 4;
  const k = compileParticleKernels(g).systems[0];
  expect(k.depth && k.trail).toBeTruthy();
  return k;
}

describe("GPU kernel executor: layout", () => {
  it("covers N items with workgroups, wrapping past the per-dimension limit", () => {
    expect(dispatchGroups(0, 64)).toEqual([0, 0]);
    expect(dispatchGroups(1, 64)).toEqual([1, 1]);
    expect(dispatchGroups(64, 64)).toEqual([1, 1]);
    expect(dispatchGroups(65, 64)).toEqual([2, 1]);
    expect(dispatchGroups(65535 * 64, 64)).toEqual([65535, 1]);
    expect(dispatchGroups(65536 * 64, 64)).toEqual([65535, 2]);
  });

  it("lays items out row by row in a float texture", () => {
    expect(gridLayout(0)).toEqual({ width: 1, height: 1 });
    expect(gridLayout(100)).toEqual({ width: 100, height: 1 });
    expect(gridLayout(1024)).toEqual({ width: 1024, height: 1 });
    expect(gridLayout(1025)).toEqual({ width: 1024, height: 2 });
    expect(gridLayout(10, 4)).toEqual({ width: 4, height: 3 });
    expect(texelOf(1030, 1024)).toEqual([6, 1]);
    const padded = padToGrid(new Float32Array([1, 2, 3, 4]), { width: 2, height: 1 });
    expect(Array.from(padded)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    const full = new Float32Array(8);
    expect(padToGrid(full, { width: 2, height: 1 })).toBe(full);
  });

  it("swaps the read and write copies", () => {
    const p = new PingPong(["a", "b"] as const);
    expect([p.read, p.write]).toEqual(["a", "b"]);
    p.swap();
    expect([p.read, p.write, p.cur]).toEqual(["b", "a", 1]);
  });
});

describe("GPU kernel executor: item kernels", () => {
  it("runs the KSL body in JavaScript over every item, outputs interleaved and zeroed per item", () => {
    const k = new JsItemKernel(MOVE, 3);
    k.setInput("pos", new Float32Array([1, 2, 3, 1, 0, 0, 0, 1, -1, 4, 0, 1]));
    k.setInput("params", new Float32Array([2, 0.5, 0, 0]));
    k.dispatch();
    expect(Array.from(k.output)).toEqual([2.5, 4.5, 6.5, 1, 0, 0, 0, 0, 0.5, 0.5, 0.5, 1, 0, 0, 0, 0, -1.5, 8.5, 0.5, 1, 2, 0, 0, 1]);
    k.resize(1);
    k.dispatch();
    expect(Array.from(k.output)).toEqual([2.5, 4.5, 6.5, 1, 0, 0, 0, 0]);
  });

  it("wraps the same body in WGSL compute and GLSL fragment glue", () => {
    const wgsl = itemKernelWgsl(MOVE);
    expect(wgsl).toContain("@group(0) @binding(0) var<storage, read> kitems: vec4u;");
    expect(wgsl).toContain("@group(0) @binding(2) var<storage, read> kin_params: array<vec4f>;");
    expect(wgsl).toContain("@group(0) @binding(3) var<storage, read_write> kout: array<vec4f>;");
    expect(wgsl).toContain("fn kernelItem(i: i32) {");
    expect(wgsl).toContain("@compute @workgroup_size(64)");
    expect(wgsl).toContain("kout[i * 2u + 1u] = out_index;");
    expect(itemKernelWgsl(MOVE, 128)).toContain("let i = gid.x + gid.y * nwg.x * 128u;");
    const glsl = itemKernelGlsl(MOVE);
    expect(glsl.startsWith("#version 300 es\n")).toBe(true);
    expect(glsl).toContain("vec4 in_pos(int j) { return texelFetch(kin_pos, ivec2(j % kin_pos_w, j / kin_pos_w), 0); }");
    expect(glsl).toContain("layout(location = 1) out vec4 kout1;");
    expect(glsl).toContain("void kernelItem(int i) {");
    expect(glsl).toContain("float(i)"); // KF(i) in GLSL
    expect(itemStride(MOVE)).toBe(32);
  });

  it("refuses specs it can't wrap", () => {
    const body = MOVE.body;
    expect(() => checkItemKernel({ name: "x", inputs: [], outputs: [], body })).toThrow(/1 to 4 outputs/);
    expect(() => checkItemKernel({ name: "x", inputs: [], outputs: ["a", "b", "c", "d", "e"], body })).toThrow(/1 to 4 outputs/);
    expect(() => checkItemKernel({ name: "x", inputs: ["a_b"], outputs: ["o"], body })).toThrow(/plain name/);
    expect(() => checkItemKernel({ name: "x", inputs: ["a"], outputs: ["a"], body })).toThrow(/named twice/);
  });

  it("dispatches on WebGPU into a vertex-bindable output, and rebinds after a resize or a grown input", () => {
    const { device, rec } = recordingDevice();
    const k = new GpuItemKernel(device, MOVE, 100);
    expect(rec.layouts[0]).toEqual([
      { binding: 0, visibility: 4, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: 4, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: 4, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: 4, buffer: { type: "storage" } },
    ]);
    const out = rec.buffers.find((b) => b.label === "kernel move output")!;
    expect(out.size).toBe(100 * 32);
    expect(out.usage & BUFFER.VERTEX).toBe(BUFFER.VERTEX);
    k.setInput("params", new Float32Array([1, 0, 0, 0]));
    k.dispatch();
    k.dispatch();
    expect(rec.dispatches).toEqual([["main", 2, 1], ["main", 2, 1]]);
    expect(rec.groups).toHaveLength(1); // cached
    k.resize(200);
    expect(out.destroyed).toBe(true);
    expect(rec.buffers.filter((b) => b.label === "kernel move output").map((b) => b.size)).toEqual([3200, 6400]);
    k.dispatch();
    expect(rec.groups).toHaveLength(2);
    expect(rec.groups[1][3].resource).toEqual({ buffer: k.output });
    k.setInput("pos", new Float32Array(200 * 4)); // grows from one row
    k.dispatch();
    expect(rec.groups).toHaveLength(3);
    expect(rec.dispatches.at(-1)).toEqual(["main", 4, 1]);
    k.dispose();
    expect(rec.buffers.every((b) => b.destroyed)).toBe(true);
  });

  it("stops dispatching once the WebGPU device is lost", async () => {
    let lose!: (v: unknown) => void;
    const { device, rec } = recordingDevice(new Promise((r) => (lose = r)));
    const k = new GpuItemKernel(device, MOVE, 10);
    k.dispatch();
    lose({ reason: "destroyed" });
    await Promise.resolve();
    expect(k.lost).toBe(true);
    k.dispatch();
    expect(rec.dispatches).toHaveLength(1);
  });

  it("runs on WebGL2 as one pass into a float target per output, and skips while the context is lost", () => {
    const { gl, calls, lose } = recordingGl();
    const k = new GlItemKernel(gl, MOVE, 1500);
    expect(k.errors).toEqual([]);
    expect(k.grid).toEqual({ width: 1024, height: 2 });
    expect(k.outputs()).toHaveLength(2);
    k.setInput("pos", new Float32Array(1500 * 4));
    calls.length = 0;
    k.dispatch();
    const named = (n: string) => calls.filter(([c]) => c === n).map(([, a]) => a);
    expect(named("drawBuffers")[0][0]).toHaveLength(2);
    expect(named("viewport")).toEqual([[0, 0, 1024, 2]]);
    expect(named("uniform1i")).toContainEqual([{ uniform: "kitems" }, 1500]);
    expect(named("uniform1i")).toContainEqual([{ uniform: "kin_pos_w" }, 1024]);
    expect(named("drawArrays")).toHaveLength(1);
    lose();
    k.dispatch();
    expect(named("drawArrays")).toHaveLength(1);
  });
});

describe("GPU kernel executor: shared inputs and transform feedback (T16)", () => {
  it("reads a WebGPU input from another owner's buffer, never destroying it, until setInput owns one again", () => {
    const { device, rec } = recordingDevice();
    const k = new GpuItemKernel(device, MOVE, 4);
    const ownParams = rec.buffers.find((b) => b.label === "kernel move params")!;
    const shared = device.createBuffer({ size: 64, usage: BUFFER.STORAGE, label: "shared" });
    k.bindInput("params", shared);
    expect(ownParams.destroyed).toBe(true);
    k.dispatch();
    expect(rec.groups[0][2].resource).toEqual({ buffer: shared });
    k.bindInput("params", shared); // the same buffer: the cached bind group stays
    k.dispatch();
    expect(rec.groups).toHaveLength(1);
    k.dispose();
    expect(rec.buffers.find((b) => b.label === "shared")!.destroyed).toBe(false);
    expect(() => k.bindInput("nope", shared)).toThrow(/no input/);
  });

  it("compiles one spec once per device, and records many kernels into one pass and one submit", () => {
    const { device, rec } = recordingDevice();
    let submits = 0;
    let encoders = 0;
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (c) => (submits++, submit(c));
    const encoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = () => (encoders++, encoder());
    const kernels = [new GpuItemKernel(device, MOVE, 4), new GpuItemKernel(device, MOVE, 100), new GpuItemKernel(device, MOVE, 0)];
    expect(rec.shaders).toHaveLength(1);
    expect(rec.pipelines).toEqual(["main"]);
    const batch = new GpuComputeBatch(device);
    expect(batch.pending).toBe(false);
    for (const k of kernels) k.dispatch(batch);
    expect(batch.pending).toBe(true);
    expect(submits).toBe(0);
    expect(rec.dispatches).toEqual([
      ["main", 1, 1],
      ["main", 2, 1],
    ]); // no items: no dispatch
    batch.submit();
    batch.submit(); // nothing recorded since
    expect([submits, encoders]).toEqual([1, 1]);
    kernels[0].dispatch(); // alone: its own pass and submit, as before
    expect([submits, encoders]).toEqual([2, 2]);
  });

  it("wraps the body in a transform-feedback vertex shader capturing kout0.. interleaved", () => {
    const vs = itemKernelGlslFeedback(MOVE);
    expect(vs).toContain("out vec4 kout0;\nout vec4 kout1;");
    expect(vs).toContain("kernelItem(gl_VertexID);");
    expect(vs).toContain("vec4 in_params(int j) { return texelFetch(kin_params, ivec2(j % kin_params_w, j / kin_params_w), 0); }");
    expect(vs).not.toMatch(/gl_FragCoord|kgridw|layout\(location/);
    expect(itemKernelFeedbackVaryings(MOVE)).toEqual(["kout0", "kout1"]);
  });

  it("runs on WebGL2 through transform feedback into one vertex buffer, inputs owned or shared", () => {
    const { gl, calls, lose } = recordingGl();
    const k = new GlFeedbackItemKernel(gl, MOVE, 300);
    expect(k.errors).toEqual([]);
    expect(k.stride).toBe(32);
    const named = (n: string) => calls.filter(([c]) => c === n).map(([, a]) => a);
    expect(named("transformFeedbackVaryings")).toEqual([[{ object: "createProgram" }, ["kout0", "kout1"], gl.INTERLEAVED_ATTRIBS]]);
    expect(named("bufferData")).toContainEqual([gl.ARRAY_BUFFER, 300 * 32, gl.DYNAMIC_COPY]);
    k.setInput("pos", new Float32Array(300 * 4));
    const shared = { texture: "palette" } as unknown as WebGLTexture;
    k.bindInput("params", shared, 7);
    calls.length = 0;
    k.dispatch();
    expect(named("enable")).toEqual([[gl.RASTERIZER_DISCARD]]);
    expect(named("disable")).toEqual([[gl.RASTERIZER_DISCARD]]);
    expect(named("beginTransformFeedback")).toEqual([[gl.POINTS]]);
    expect(named("drawArrays")).toEqual([[gl.POINTS, 0, 300]]);
    expect(named("bindBufferBase")).toEqual([[gl.TRANSFORM_FEEDBACK_BUFFER, 0, k.output], [gl.TRANSFORM_FEEDBACK_BUFFER, 0, null]]);
    expect(named("bindBuffer")).toContainEqual([gl.ARRAY_BUFFER, null]); // never bound elsewhere while captured into
    expect(named("bindTexture")).toContainEqual([gl.TEXTURE_2D, shared]);
    expect(named("uniform1i")).toContainEqual([{ uniform: "kin_params_w" }, 7]);
    expect(named("uniform1i")).toContainEqual([{ uniform: "kin_pos_w" }, 300]);
    const first = k.output;
    k.resize(10);
    expect(named("deleteBuffer")).toEqual([[first]]);
    calls.length = 0;
    k.dispose();
    expect(named("deleteTexture")).toHaveLength(1); // its own input, not the shared one
    lose();
    calls.length = 0;
    k.dispatch();
    expect(named("drawArrays")).toHaveLength(0);
  });
});

describe("GPU kernel executor: particles on it", () => {
  it("WebGPU keeps the simulation's bindings, entry points and dispatches", () => {
    const k = trailDepthKernel();
    const { device, rec } = recordingDevice();
    const run = new WebGpuRun(device, k, undefined, null, { deadList: true });
    expect(rec.pipelines).toEqual(["main", "spawn"]);
    expect(rec.layouts[0]).toEqual([
      { binding: 0, visibility: 4, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: 4, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: 4, buffer: { type: "storage" } },
      { binding: 3, visibility: 4, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: 4, texture: { sampleType: "unfilterable-float" } },
      { binding: 6, visibility: 4, buffer: { type: "storage" } },
      { binding: 7, visibility: 4, buffer: { type: "storage" } },
      { binding: 8, visibility: 4, buffer: { type: "storage" } },
    ]);
    const u = new Float32Array(k.uniformVec4 * 4);
    u[U.spawn * 4 + 1] = 3; // three to spawn
    const first = run.current();
    run.step(u, null, null);
    expect(rec.dispatches).toEqual([["main", 2, 1], ["spawn", 1, 1]]);
    expect(rec.groups[0].map((e) => e.binding)).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(rec.groups[0][1].resource).toEqual({ buffer: first });
    expect(rec.groups[0][4].resource).toEqual({ dummy: true }); // no depth yet: the stand-in
    expect(run.current()).not.toBe(first); // swapped
    run.step(new Float32Array(k.uniformVec4 * 4), null, null);
    expect(rec.dispatches.at(-1)).toEqual(["main", 2, 1]); // nothing to spawn: no spawn dispatch
    run.dispose();
  });

  it("WebGL2 runs the simulation then the trail history pass into this frame's block", () => {
    const k = trailDepthKernel();
    const { gl, calls } = recordingGl();
    const run = new WebGl2Run(gl, k);
    expect(run.errors).toEqual([]);
    expect([run.width, run.height]).toEqual([100, 1]);
    calls.length = 0;
    const u = new Float32Array(k.uniformVec4 * 4);
    u[U.spawn * 4 + 3] = 6; // the frame number: block 6 % 4
    run.step(u, null, null);
    const named = (n: string) => calls.filter(([c]) => c === n).map(([, a]) => a);
    expect(named("viewport")).toEqual([[0, 0, 100, 1], [0, 2, 100, 1]]);
    expect(named("drawBuffers").map((a) => (a[0] as unknown[]).length)).toEqual([4, 1]);
    expect(named("uniform1i")).toContainEqual([{ uniform: "yoff" }, 2]);
    expect(named("uniform1i")).toContainEqual([{ uniform: "kdepth" }, 9]);
    expect(named("drawArrays")).toHaveLength(2);
    run.dispose();
  });
});
