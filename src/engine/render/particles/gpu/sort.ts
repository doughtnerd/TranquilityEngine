// Internal (ADR 0126): sorting kernel particles back to front for alpha-blended outputs. Each frame a key
// pass writes (key, slot) pairs, key = −view depth (dead slots +∞), padded to the next power of two, and a
// bitonic network sorts them ascending, so instance i of a sorted draw shows the i-th farthest particle.
// The same network runs as WebGPU compute dispatches, WebGL2 full-screen passes, or a JavaScript sort.
// Renderer-neutral: raw GPUDevice / WebGL2 contexts, like the executors.
import { KERNEL_FLOATS, U } from "../../../scene/particleKernel";
import type { GpuBuffer, GpuDevice } from "./webgpuRun";
import { BUFFER } from "./webgpuRun";

/** Sorted pairs a draw reads: the padded count, and its layout as a texture (width × height). */
export interface SortLayout {
  n: number;
  width: number;
  height: number;
}

/** Keys above this are dead slots. */
export const DEAD_KEY = 3.0e38;

/** The padded size and texture layout for `capacity` particles. */
export function sortLayout(capacity: number): SortLayout {
  let n = 1;
  while (n < capacity) n *= 2;
  n = Math.max(2, n);
  const width = Math.min(n, 1024);
  return { n, width, height: n / width };
}

/** The bitonic network's stages for `n` (a power of two): [k, j] pairs, in order. */
export function bitonicStages(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 2; k <= n; k *= 2) for (let j = k / 2; j >= 1; j /= 2) out.push([k, j]);
  return out;
}

/** Apply one bitonic stage to (key, value) pairs in place: what one GPU pass does. */
export function bitonicStep(pairs: Float32Array, n: number, k: number, j: number): void {
  for (let i = 0; i < n; i++) {
    const l = i ^ j;
    if (l <= i) continue;
    const up = (i & k) === 0;
    const a = pairs[i * 2];
    const b = pairs[l * 2];
    if (up ? a > b : a < b) {
      const v = pairs[i * 2 + 1];
      pairs[i * 2] = b;
      pairs[i * 2 + 1] = pairs[l * 2 + 1];
      pairs[l * 2] = a;
      pairs[l * 2 + 1] = v;
    }
  }
}

/**
 * The row that gives a particle's view depth from its simulated position (`dot(row.xyz, p) + row.w`):
 * the camera view matrix's z row (`viewZ`), carried through the node's matrix for local-space systems,
 * with its sign set so larger is farther (`rightHanded` scenes look down −z).
 */
export function depthRow(viewZ: ArrayLike<number>, uniforms: Float32Array, rightHanded: boolean): [number, number, number, number] {
  const sign = rightHanded ? -1 : 1;
  const world = uniforms[U.flags * 4 + 2] === 1;
  const r = [viewZ[0] * sign, viewZ[1] * sign, viewZ[2] * sign, viewZ[3] * sign];
  if (world) return r as [number, number, number, number];
  const m = uniforms.subarray(U.matrix * 4, U.matrix * 4 + 16); // column-major
  return [
    r[0] * m[0] + r[1] * m[1] + r[2] * m[2],
    r[0] * m[4] + r[1] * m[5] + r[2] * m[6],
    r[0] * m[8] + r[1] * m[9] + r[2] * m[10],
    r[0] * m[12] + r[1] * m[13] + r[2] * m[14] + r[3],
  ];
}

/** The JavaScript sort: (key, slot) pairs for `state`, sorted, into `out` (n × 2). */
export function sortPairsJs(state: Float32Array, capacity: number, row: readonly number[], out: Float32Array, layout: SortLayout): void {
  const n = layout.n;
  const keys = new Float32Array(n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    if (i >= capacity) {
      keys[i] = DEAD_KEY;
      continue;
    }
    const o = i * KERNEL_FLOATS;
    const alive = state[o + 7] > 0 && state[o + 3] < state[o + 7];
    keys[i] = alive ? -(row[0] * state[o] + row[1] * state[o + 1] + row[2] * state[o + 2] + row[3]) : DEAD_KEY;
  }
  order.sort((a, b) => keys[a] - keys[b] || a - b);
  for (let i = 0; i < n; i++) {
    out[i * 2] = keys[order[i]];
    out[i * 2 + 1] = order[i];
  }
}

// --- WebGPU ---------------------------------------------------------------------------------------------

const WG = 64;

/** The key pass (entry `sortKeys`) and one bitonic stage (entry `sortStep`) over `pairs`. */
export function wgslSort(): string {
  return `
struct KeyParams { row: vec4f, sizes: vec4f };
struct StepParams { k: u32, j: u32, n: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> state: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> pairs: array<vec2f>;
@group(0) @binding(2) var<uniform> kp: KeyParams;
@group(1) @binding(0) var<uniform> sp: StepParams;

@compute @workgroup_size(${WG})
fn sortKeys(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let i = gid.x + gid.y * groups.x * ${WG}u;
  let n = u32(kp.sizes.y);
  if (i >= n) { return; }
  var key = ${DEAD_KEY.toExponential()};
  if (f32(i) < kp.sizes.x) {
    let a0 = state[i * 4u];
    let a1 = state[i * 4u + 1u];
    if (a1.w > 0.0 && a0.w < a1.w) { key = -(dot(kp.row.xyz, a0.xyz) + kp.row.w); }
  }
  pairs[i] = vec2f(key, f32(i));
}

@compute @workgroup_size(${WG})
fn sortStep(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let i = gid.x + gid.y * groups.x * ${WG}u;
  if (i >= sp.n) { return; }
  let l = i ^ sp.j;
  if (l <= i) { return; }
  let a = pairs[i];
  let b = pairs[l];
  let up = (i & sp.k) == 0u;
  if ((up && a.x > b.x) || (!up && a.x < b.x)) {
    pairs[i] = b;
    pairs[l] = a;
  }
}
`;
}

/** Sorts one system's particles on a raw GPUDevice; `pairs` is the buffer a draw reads. */
export class WebGpuSorter {
  readonly layout: SortLayout;
  readonly pairs: GpuBuffer;
  private readonly keyParams: GpuBuffer;
  private readonly stepParams: GpuBuffer;
  private readonly keysPipeline: unknown;
  private readonly stepPipeline: unknown;
  private readonly stepGroups: unknown[];
  private readonly groupLayout0: unknown;
  private readonly groups0 = new Map<GpuBuffer, unknown>();
  private readonly stages: [number, number][];
  private readonly keyData = new Float32Array(8);

  constructor(
    private readonly device: GpuDevice,
    private readonly capacity: number,
    /** Makes the pairs buffer (the Babylon backend wraps it so draws can bind it). */
    factory: (size: number, label: string) => GpuBuffer = (size, label) => device.createBuffer({ size, usage: BUFFER.STORAGE | BUFFER.COPY_DST | BUFFER.COPY_SRC, label }),
  ) {
    const d = device;
    this.layout = sortLayout(capacity);
    this.stages = bitonicStages(this.layout.n);
    this.pairs = factory(this.layout.n * 8, "particles sort pairs");
    this.keyParams = d.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST, label: "particles sort keys" });
    // One 256-byte slot per stage (the uniform offset alignment), written once.
    this.stepParams = d.createBuffer({ size: Math.max(1, this.stages.length) * 256, usage: BUFFER.UNIFORM | BUFFER.COPY_DST, label: "particles sort stages" });
    const data = new Uint32Array(Math.max(1, this.stages.length) * 64);
    this.stages.forEach(([k, j], s) => data.set([k, j, this.layout.n, 0], s * 64));
    d.queue.writeBuffer(this.stepParams, 0, data.buffer, 0, data.byteLength);
    const module = d.createShaderModule({ code: wgslSort(), label: "particles sort" });
    const COMPUTE = 0x4;
    this.groupLayout0 = d.createBindGroupLayout!({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const layout1 = d.createBindGroupLayout!({ entries: [{ binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } }] });
    const pl = d.createPipelineLayout!({ bindGroupLayouts: [this.groupLayout0, layout1] });
    this.keysPipeline = d.createComputePipeline({ layout: pl, compute: { module, entryPoint: "sortKeys" }, label: "particles sort keys" });
    this.stepPipeline = d.createComputePipeline({ layout: pl, compute: { module, entryPoint: "sortStep" }, label: "particles sort step" });
    this.stepGroups = this.stages.map((_, s) => d.createBindGroup({ layout: layout1, entries: [{ binding: 0, resource: { buffer: this.stepParams, offset: s * 256, size: 16 } }] }));
    if (!this.stepGroups.length) this.stepGroups.push(d.createBindGroup({ layout: layout1, entries: [{ binding: 0, resource: { buffer: this.stepParams, offset: 0, size: 16 } }] }));
  }

  /** Sort the particles in `state` (the run's latest buffer) by `row` (see `depthRow`). */
  sort(state: GpuBuffer, row: readonly number[]): void {
    const d = this.device;
    this.keyData.set([row[0], row[1], row[2], row[3], this.capacity, this.layout.n, 0, 0]);
    d.queue.writeBuffer(this.keyParams, 0, this.keyData.buffer, 0, 32);
    let g0 = this.groups0.get(state);
    if (!g0) {
      g0 = d.createBindGroup({
        layout: this.groupLayout0,
        entries: [
          { binding: 0, resource: { buffer: state } },
          { binding: 1, resource: { buffer: this.pairs } },
          { binding: 2, resource: { buffer: this.keyParams } },
        ],
      });
      this.groups0.set(state, g0);
    }
    const groups = Math.ceil(this.layout.n / WG);
    const x = Math.min(groups, 65535);
    const y = Math.ceil(groups / x);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, g0);
    pass.setBindGroup(1, this.stepGroups[0]);
    pass.setPipeline(this.keysPipeline);
    pass.dispatchWorkgroups(x, y);
    pass.setPipeline(this.stepPipeline);
    for (let s = 0; s < this.stages.length; s++) {
      pass.setBindGroup(1, this.stepGroups[s]);
      pass.dispatchWorkgroups(x, y);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  dispose(): void {
    this.keyParams.destroy();
    this.stepParams.destroy();
    this.groups0.clear();
  }
}

// --- WebGL2 ---------------------------------------------------------------------------------------------

const SORT_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const GLSL_KEYS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D ks0;
uniform highp sampler2D ks1;
uniform int kw;
uniform int sw;
uniform vec4 row;
uniform vec2 sizes;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.y * sw + c.x;
  float key = ${DEAD_KEY.toExponential()};
  if (float(i) < sizes.x) {
    ivec2 sc = ivec2(i % kw, i / kw);
    vec4 a0 = texelFetch(ks0, sc, 0);
    vec4 a1 = texelFetch(ks1, sc, 0);
    if (a1.w > 0.0 && a0.w < a1.w) { key = -(dot(row.xyz, a0.xyz) + row.w); }
  }
  o = vec4(key, float(i), 0.0, 0.0);
}
`;

const GLSL_STEP = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D pairs;
uniform int sw;
uniform int k;
uniform int j;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.y * sw + c.x;
  int l = i ^ j;
  vec4 a = texelFetch(pairs, c, 0);
  vec4 b = texelFetch(pairs, ivec2(l % sw, l / sw), 0);
  bool up = (i & k) == 0;
  bool lower = i < l;
  // The lower index keeps the smaller key in an ascending block, the larger in a descending one.
  bool takeMin = lower == up;
  bool aFirst = a.x < b.x || (a.x == b.x && a.y < b.y);
  o = (takeMin == aFirst) ? a : b;
}
`;

function program(gl: WebGL2RenderingContext, fs: string): { p: WebGLProgram; error: string | null } {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const vs = make(gl.VERTEX_SHADER, SORT_VERTEX);
  const f = make(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  const error = gl.getProgramParameter(p, gl.LINK_STATUS) ? null : `${gl.getShaderInfoLog(f) ?? ""}${gl.getProgramInfoLog(p) ?? ""}`;
  gl.deleteShader(vs);
  gl.deleteShader(f);
  return { p, error };
}

/** Sorts one system's particles with WebGL2 full-screen passes over two RG32F textures (ping-pong). */
export class WebGl2Sorter {
  readonly layout: SortLayout;
  readonly textures: [WebGLTexture, WebGLTexture];
  /** The texture holding the sorted pairs after `sort`. */
  current: WebGLTexture;
  readonly errors: string[] = [];
  private readonly fbos: [WebGLFramebuffer, WebGLFramebuffer];
  private readonly keys: WebGLProgram;
  private readonly stepProgram: WebGLProgram;
  private readonly stages: [number, number][];
  private readonly vao: WebGLVertexArrayObject;
  private readonly u: Record<string, WebGLUniformLocation | null>;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly capacity: number,
  ) {
    this.layout = sortLayout(capacity);
    this.stages = bitonicStages(this.layout.n);
    const make = (): [WebGLTexture, WebGLFramebuffer] => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.layout.width, this.layout.height, 0, gl.RG, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return [t, f];
    };
    const a = make();
    const b = make();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.textures = [a[0], b[0]];
    this.fbos = [a[1], b[1]];
    this.current = a[0];
    const k = program(gl, GLSL_KEYS);
    const s = program(gl, GLSL_STEP);
    for (const e of [k.error, s.error]) if (e) this.errors.push(e);
    this.keys = k.p;
    this.stepProgram = s.p;
    this.vao = gl.createVertexArray()!;
    this.u = {
      ks0: gl.getUniformLocation(k.p, "ks0"),
      ks1: gl.getUniformLocation(k.p, "ks1"),
      kw: gl.getUniformLocation(k.p, "kw"),
      ksw: gl.getUniformLocation(k.p, "sw"),
      row: gl.getUniformLocation(k.p, "row"),
      sizes: gl.getUniformLocation(k.p, "sizes"),
      pairs: gl.getUniformLocation(s.p, "pairs"),
      sw: gl.getUniformLocation(s.p, "sw"),
      k: gl.getUniformLocation(s.p, "k"),
      j: gl.getUniformLocation(s.p, "j"),
    };
  }

  /** Sort the state in `ks0`/`ks1` (`stateWidth` wide) by `row`. Changes GL state: the caller restores its own. */
  sort(ks0: WebGLTexture, ks1: WebGLTexture, stateWidth: number, row: readonly number[]): void {
    const gl = this.gl;
    const { width, height } = this.layout;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[0]);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.useProgram(this.keys);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ks0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ks1);
    gl.uniform1i(this.u.ks0, 0);
    gl.uniform1i(this.u.ks1, 1);
    gl.uniform1i(this.u.kw, stateWidth);
    gl.uniform1i(this.u.ksw, width);
    gl.uniform4f(this.u.row, row[0], row[1], row[2], row[3]);
    gl.uniform2f(this.u.sizes, this.capacity, this.layout.n);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.stepProgram);
    gl.uniform1i(this.u.pairs, 0);
    gl.uniform1i(this.u.sw, width);
    let cur = 0;
    for (const [k, j] of this.stages) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1 - cur]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[cur]);
      gl.uniform1i(this.u.k, k);
      gl.uniform1i(this.u.j, j);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cur = 1 - cur;
    }
    this.current = this.textures[cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  /** Read the sorted pairs back (tests; slow). */
  read(): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(this.layout.width * this.layout.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.current === this.textures[0] ? 0 : 1]);
    gl.readPixels(0, 0, this.layout.width, this.layout.height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const pairs = new Float32Array(this.layout.n * 2);
    for (let i = 0; i < this.layout.n; i++) {
      pairs[i * 2] = out[i * 4];
      pairs[i * 2 + 1] = out[i * 4 + 1];
    }
    return pairs;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    for (const f of this.fbos) gl.deleteFramebuffer(f);
    gl.deleteProgram(this.keys);
    gl.deleteProgram(this.stepProgram);
    gl.deleteVertexArray(this.vao);
  }
}
