/**
 * Internal (ADR 0370, 0250): an item kernel, the GPU kernel executor's "run this KSL kernel over N
 * items, from these inputs, into these outputs". Its body is KSL (`render/shaderSource`), written once;
 * this module wraps it in each backend's glue:
 *
 * - **WGSL** (`itemKernelWgsl`): a compute entry point `main`, one invocation per item. Group 0 holds
 *   `kitems` (binding 0: a `vec4u`, x = item count), the inputs in order (bindings 1..: read-only
 *   storage `array<vec4f>`), then `kout` (a read-write `array<vec4f>`, the outputs interleaved: item i's
 *   output k at `i * outputs + k`), so a draw can bind `kout` as a vertex buffer with a stride of
 *   `16 * outputs` bytes.
 * - **GLSL ES 3.0** (`itemKernelGlsl`): a full-screen fragment pass, one fragment per item; inputs are
 *   RGBA32F textures (`kin_<name>`, `kin_<name>_w` texels wide), outputs are render targets 0.. (up to
 *   four), item i at texel (i % kgridw, i / kgridw); a draw samples them by vertex index.
 * - **GLSL ES 3.0, transform feedback** (`itemKernelGlslFeedback`): a vertex shader, one vertex per item,
 *   inputs as above, outputs captured interleaved into one vertex buffer laid out like WebGPU's `kout`.
 * - **JavaScript** (`JsItemKernel`): the same KSL compiled to closures (`ShaderSource.js`), so tests and
 *   the CPU run the very maths the GPU compiles.
 *
 * The body defines `FN(void, kernelItem, KI i) { … }`, reads input tables with `in_<name>(KI j)` (any
 * row, not only row i: per-item data, a uniform block, a bone palette are all tables of vec4) and
 * writes each output to the global `out_<name>` (zero at the start of every item). A small uniform
 * block is an input table of a few rows, written each frame.
 *
 * The GPU runners are `GpuItemKernel` (`itemKernelWebgpu.ts`) and `GlItemKernel` (`itemKernelWebgl2.ts`).
 */
import { shaderSource, type ShaderSource } from "../shaderSource/shaderSource";

/** Most outputs an item kernel writes (WebGL2 guarantees four draw buffers). */
export const MAX_ITEM_OUTPUTS = 4;

/** Default `@workgroup_size` of an item kernel's WGSL. */
export const ITEM_WORKGROUP = 64;

export interface ItemKernelSpec {
  /** Names the kernel (labels, errors). */
  name: string;
  /** Input tables (vec4 rows), read by `in_<name>(j)`. */
  inputs: readonly string[];
  /** Outputs (one vec4 per item each, 1 to `MAX_ITEM_OUTPUTS`), written to `out_<name>`. */
  outputs: readonly string[];
  /** KSL defining `FN(void, kernelItem, KI i)` (and its helpers). */
  body: ShaderSource;
}

const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/** Throws when the spec can't make a kernel (bad names, no outputs, too many outputs): a programming error. */
export function checkItemKernel(spec: ItemKernelSpec): void {
  if (spec.outputs.length < 1 || spec.outputs.length > MAX_ITEM_OUTPUTS) throw new Error(`item kernel "${spec.name}": 1 to ${MAX_ITEM_OUTPUTS} outputs, not ${spec.outputs.length}`);
  const seen = new Set<string>();
  for (const n of [...spec.inputs, ...spec.outputs]) {
    if (!NAME.test(n)) throw new Error(`item kernel "${spec.name}": "${n}" isn't a plain name (letters and digits)`);
    if (seen.has(n)) throw new Error(`item kernel "${spec.name}": "${n}" is named twice`);
    seen.add(n);
  }
}

/** Bytes one item's outputs take in `kout` (the vertex stride on WebGPU). */
export function itemStride(spec: ItemKernelSpec): number {
  return spec.outputs.length * 16;
}

/** The WGSL compute module of an item kernel (bindings as the module doc says). */
export function itemKernelWgsl(spec: ItemKernelSpec, workgroup = ITEM_WORKGROUP): string {
  checkItemKernel(spec);
  const n = spec.outputs.length;
  const lines = [`// Item kernel "${spec.name}" (render/gpuKernels): ${n} vec4 output${n === 1 ? "" : "s"} per item.`, "@group(0) @binding(0) var<storage, read> kitems: vec4u;"];
  spec.inputs.forEach((name, j) => lines.push(`@group(0) @binding(${j + 1}) var<storage, read> kin_${name}: array<vec4f>;`));
  lines.push(`@group(0) @binding(${spec.inputs.length + 1}) var<storage, read_write> kout: array<vec4f>;`);
  for (const name of spec.inputs) lines.push(`fn in_${name}(j: i32) -> vec4f { return kin_${name}[j]; }`);
  for (const name of spec.outputs) lines.push(`var<private> out_${name}: vec4f;`);
  return `${lines.join("\n")}
${spec.body.text("wgsl")}
@compute @workgroup_size(${workgroup})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${workgroup}u;
  if (i >= kitems.x) { return; }
${spec.outputs.map((o) => `  out_${o} = vec4f(0.0);`).join("\n")}
  kernelItem(i32(i));
${spec.outputs.map((o, k) => `  kout[i * ${n}u + ${k}u] = out_${o};`).join("\n")}
}
`;
}

/** The GLSL ES 3.0 fragment shader of an item kernel (run with `FULLSCREEN_VERTEX`). */
export function itemKernelGlsl(spec: ItemKernelSpec): string {
  checkItemKernel(spec);
  const lines = ["#version 300 es", "precision highp float;", "precision highp int;", "precision highp sampler2D;", `// Item kernel "${spec.name}" (render/gpuKernels).`, "uniform int kitems;", "uniform int kgridw;"];
  for (const name of spec.inputs) {
    lines.push(`uniform sampler2D kin_${name};`, `uniform int kin_${name}_w;`);
    lines.push(`vec4 in_${name}(int j) { return texelFetch(kin_${name}, ivec2(j % kin_${name}_w, j / kin_${name}_w), 0); }`);
  }
  for (const name of spec.outputs) lines.push(`vec4 out_${name};`);
  spec.outputs.forEach((_, k) => lines.push(`layout(location = ${k}) out vec4 kout${k};`));
  return `${lines.join("\n")}
${spec.body.text("glsl")}
void main() {
  int i = int(gl_FragCoord.y) * kgridw + int(gl_FragCoord.x);
  if (i >= kitems) { discard; }
${spec.outputs.map((o) => `  out_${o} = vec4(0.0);`).join("\n")}
  kernelItem(i);
${spec.outputs.map((o, k) => `  kout${k} = out_${o};`).join("\n")}
}
`;
}

/**
 * The GLSL ES 3.0 vertex shader of an item kernel run through transform feedback (`GlFeedbackItemKernel`):
 * one vertex per item (`gl_VertexID`), drawn as points with the rasterizer off; inputs are float textures
 * as in `itemKernelGlsl`, and the outputs are the varyings `kout0..` (`itemKernelFeedbackVaryings`),
 * captured interleaved into one buffer laid out like WebGPU's `kout` (item i's output k at
 * `(i * outputs + k) * 16` bytes), so a draw binds it as a vertex buffer with the same stride.
 */
export function itemKernelGlslFeedback(spec: ItemKernelSpec): string {
  checkItemKernel(spec);
  const lines = ["#version 300 es", "precision highp float;", "precision highp int;", "precision highp sampler2D;", `// Item kernel "${spec.name}" (render/gpuKernels, transform feedback).`];
  for (const name of spec.inputs) {
    lines.push(`uniform sampler2D kin_${name};`, `uniform int kin_${name}_w;`);
    lines.push(`vec4 in_${name}(int j) { return texelFetch(kin_${name}, ivec2(j % kin_${name}_w, j / kin_${name}_w), 0); }`);
  }
  for (const name of spec.outputs) lines.push(`vec4 out_${name};`);
  spec.outputs.forEach((_, k) => lines.push(`out vec4 kout${k};`));
  return `${lines.join("\n")}
${spec.body.text("glsl")}
void main() {
${spec.outputs.map((o) => `  out_${o} = vec4(0.0);`).join("\n")}
  kernelItem(gl_VertexID);
${spec.outputs.map((o, k) => `  kout${k} = out_${o};`).join("\n")}
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
`;
}

/** The fragment shader a transform feedback pass links with (never runs: the rasterizer is off). */
export const FEEDBACK_FRAGMENT = `#version 300 es
precision highp float;
out vec4 kfrag;
void main() {
  kfrag = vec4(0.0);
}
`;

/** The varyings a transform feedback pass captures, in output order. */
export function itemKernelFeedbackVaryings(spec: ItemKernelSpec): string[] {
  return spec.outputs.map((_, k) => `kout${k}`);
}

/** The uniform names the transform feedback pass sets. */
export function itemKernelFeedbackUniforms(spec: ItemKernelSpec): string[] {
  return spec.inputs.flatMap((n) => [`kin_${n}`, `kin_${n}_w`]);
}

/** The uniform names the GLSL pass sets. */
export function itemKernelGlslUniforms(spec: ItemKernelSpec): string[] {
  return ["kitems", "kgridw", ...spec.inputs.flatMap((n) => [`kin_${n}`, `kin_${n}_w`])];
}

/** The item kernel on the CPU: the body's KSL compiled to JavaScript, outputs interleaved like WebGPU's `kout`. */
export class JsItemKernel {
  /** Item i's output k at `(i * outputs + k) * 4`. */
  output: Float32Array;
  private readonly inputs = new Map<string, Float32Array>();
  private readonly run: (i: number) => void;
  private readonly read: (() => number[])[];

  constructor(
    readonly spec: ItemKernelSpec,
    private n: number,
  ) {
    checkItemKernel(spec);
    for (const name of spec.inputs) this.inputs.set(name, new Float32Array(4));
    // Each input as a one-row texture KTEX reads at (j, 0); outputs as globals, zeroed per item.
    const glue = spec.inputs.map((name) => `TEXTURE2D(kin_${name});\nFN(KV4, in_${name}, KI j) {\n  return KTEX(kin_${name}, KV2(KF(j), 0.0));\n}\n`).join("") + spec.outputs.map((o) => `GLOBAL(KV4, out_${o});\n`).join("");
    const entry = `FN(void, kernelItemRun, KI i) {\n${spec.outputs.map((o) => `  out_${o} = KV4(0.0);\n`).join("")}  kernelItem(i);\n}\n`;
    const textures: Record<string, (uv: number[]) => number[]> = {};
    for (const name of spec.inputs) {
      textures[`kin_${name}`] = (uv) => {
        const d = this.inputs.get(name)!;
        const o = Math.round(uv[0]) * 4;
        return o >= 0 && o + 4 <= d.length ? [d[o], d[o + 1], d[o + 2], d[o + 3]] : [0, 0, 0, 0];
      };
    }
    const program = shaderSource(glue, spec.body, entry).js({ textures });
    const fn = program.fn("kernelItemRun");
    this.run = (i) => void fn(i);
    this.read = spec.outputs.map((o) => () => program.global(`out_${o}`) as number[]);
    this.output = new Float32Array(n * spec.outputs.length * 4);
  }

  get items(): number {
    return this.n;
  }

  /** Replace input `name`'s table (vec4 rows). */
  setInput(name: string, data: Float32Array): void {
    if (!this.inputs.has(name)) throw new Error(`item kernel "${this.spec.name}" has no input "${name}"`);
    this.inputs.set(name, data);
  }

  /** Run every item into `output`. */
  dispatch(): void {
    const k = this.spec.outputs.length;
    for (let i = 0; i < this.n; i++) {
      this.run(i);
      for (let o = 0; o < k; o++) this.output.set(this.read[o](), (i * k + o) * 4);
    }
  }

  /** Run over `items` items from now on (the output is reallocated, zeroed). */
  resize(items: number): void {
    this.n = items;
    this.output = new Float32Array(items * this.spec.outputs.length * 4);
  }
}
