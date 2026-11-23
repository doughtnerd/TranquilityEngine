// Internal (ADR 0094, 0370): particles on the GPU kernel executor's WebGL2 backend (`render/gpuKernels`).
// WebGL2 has no compute shaders, so the kernel (`glslSimulation`) runs as a full-screen fragment pass:
// one fragment per particle slot, writing the four state vec4s to four RGBA32F render targets; two sets
// of textures swap every frame. Renderer-neutral: it takes a raw WebGL2 context. The caller restores
// its own GL state after `step` (the Babylon backend calls `engine.wipeCaches(true)`).
import { KERNEL_FLOATS, LUT_SAMPLES, U, type KernelSystem } from "../../../scene/particleKernel";
import { GRID_WIDTH, PingPong, gridLayout } from "../../gpuKernels/layout";
import { GlKernel, clearFloatTargets, createFloatTargets, deleteFloatTargets, floatTexture, readFloatTarget, supportsFloatTargets, writeFloatTexture, type FloatTargets } from "../../gpuKernels/webgl2";
import type { KernelRun } from "./kernelEffect";
import { GLSL_SIM_VERTEX, GLSL_TRAIL_HISTORY, glslSimulation } from "./kernelShader";

/** Width of the state textures (slots run row by row). */
export const STATE_WIDTH = GRID_WIDTH;

/** Float render targets: what the texture executor needs beyond WebGL2. */
export function supportsTextureKernels(gl: WebGL2RenderingContext): boolean {
  return supportsFloatTargets(gl, 4);
}

const SIM_UNIFORMS = ["ku", "kw", "ks0", "ks1", "ks2", "ks3", "kl", "kp0", "kp1", "kp2", "kp3", "kpw", "kdepth"];

export class WebGl2Run implements KernelRun {
  readonly kind = "webgl2" as const;
  readonly width: number;
  readonly height: number;
  readonly lutTexture: WebGLTexture;
  private readonly sets: PingPong<FloatTargets>;
  private readonly sim: GlKernel;
  private readonly lutRows: number;
  private readonly dummy: WebGLTexture;
  /**
   * Trail history (ADR 0126): `kernel.trail` blocks of `height` rows, block `frame % points` written after
   * each step by a second pass. Null without trail outputs.
   */
  readonly history: { texture: WebGLTexture; targets: FloatTargets; pass: GlKernel } | null = null;
  /** Shader compile or link errors (empty when it built). */
  readonly errors: string[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly kernel: KernelSystem,
    /** The scene's depth texture for depth collision (a raw texture, or null). */
    private readonly depthTexture: () => WebGLTexture | null = () => null,
  ) {
    const grid = gridLayout(kernel.capacity, STATE_WIDTH);
    this.width = grid.width;
    this.height = grid.height;
    this.sets = new PingPong([createFloatTargets(gl, this.width, this.height, 4), createFloatTargets(gl, this.width, this.height, 4)]);
    this.lutRows = Math.max(1, kernel.luts.length);
    this.lutTexture = floatTexture(gl, LUT_SAMPLES, this.lutRows);
    this.dummy = floatTexture(gl, 1, 1);
    this.sim = new GlKernel(gl, { label: `particles ${kernel.name}`, vertex: GLSL_SIM_VERTEX, fragment: glslSimulation(kernel), uniforms: SIM_UNIFORMS });
    this.errors.push(...this.sim.errors);
    if (kernel.trail) {
      const targets = createFloatTargets(gl, this.width, this.height * kernel.trail, 1);
      const pass = new GlKernel(gl, { label: `particles ${kernel.name} trail history`, vertex: GLSL_SIM_VERTEX, fragment: GLSL_TRAIL_HISTORY, uniforms: ["ks0", "ks3", "yoff"] });
      this.errors.push(...pass.errors);
      this.history = { texture: targets.textures[0], targets, pass };
    }
    this.clear();
  }

  /** Index of the set holding the latest state. */
  get cur(): number {
    return this.sets.cur;
  }

  step(uniforms: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    const gl = this.gl;
    if (this.errors.length) return;
    if (lut) writeFloatTexture(gl, this.lutTexture, 0, 0, LUT_SAMPLES, this.lutRows, lut.subarray(0, LUT_SAMPLES * this.lutRows * 4));
    const src = this.sets.read;
    const dst = this.sets.write;
    this.sim.run({ targets: dst }, (b) => {
      src.textures.forEach((t, i) => b.texture(i, `ks${i}`, t));
      b.texture(4, "kl", this.lutTexture);
      if (this.kernel.event) {
        const p = parent instanceof WebGl2Run ? parent : null;
        const ptex = p ? p.current() : src.textures;
        ptex.forEach((t, i) => b.texture(5 + i, `kp${i}`, t));
        b.int("kpw", p ? p.width : this.width);
      }
      if (this.kernel.depth) b.texture(9, "kdepth", this.depthTexture() ?? this.dummy);
      b.vec4s("ku", uniforms.subarray(0, this.kernel.uniformVec4 * 4));
      b.int("kw", this.width);
    });
    const h = this.history;
    if (h) {
      // This frame's (position, seed) into its block of the history.
      const yoff = (uniforms[U.spawn * 4 + 3] % this.kernel.trail!) * this.height;
      h.pass.run({ targets: h.targets, viewport: [0, yoff, this.width, this.height] }, (b) => {
        b.texture(0, "ks0", dst.textures[0]);
        b.texture(1, "ks3", dst.textures[3]);
        b.int("yoff", yoff);
      });
    }
    this.sets.swap();
  }

  /** The textures holding the latest state (draws sample them). */
  current(): WebGLTexture[] {
    return this.sets.read.textures;
  }

  clear(): void {
    for (const set of this.sets.both) clearFloatTargets(this.gl, set);
  }

  /** Read the latest state back, interleaved like the other executors (the parity tool, bench/particles; slow). */
  read(): Float32Array {
    const out = new Float32Array(this.kernel.capacity * KERNEL_FLOATS);
    const px = new Float32Array(this.width * this.height * 4);
    for (let a = 0; a < 4; a++) {
      readFloatTarget(this.gl, this.sets.read, a, px);
      for (let i = 0; i < this.kernel.capacity; i++) for (let c = 0; c < 4; c++) out[i * KERNEL_FLOATS + a * 4 + c] = px[i * 4 + c];
    }
    return out;
  }

  /** Read the trail history back, block by block like the JavaScript executor's (the parity tool; slow). */
  readHistory(): Float32Array | null {
    const h = this.history;
    if (!h) return null;
    const points = this.kernel.trail ?? 0;
    const cap = this.kernel.capacity;
    const px = readFloatTarget(this.gl, h.targets, 0, new Float32Array(this.width * this.height * points * 4));
    const out = new Float32Array(points * cap * 4);
    for (let b = 0; b < points; b++) {
      for (let i = 0; i < cap; i++) {
        const o = ((b * this.height + Math.floor(i / this.width)) * this.width + (i % this.width)) * 4;
        out.set(px.subarray(o, o + 4), (b * cap + i) * 4);
      }
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const set of this.sets.both) deleteFloatTargets(gl, set);
    gl.deleteTexture(this.lutTexture);
    gl.deleteTexture(this.dummy);
    if (this.history) {
      deleteFloatTargets(gl, this.history.targets);
      this.history.pass.dispose();
    }
    this.sim.dispose();
  }
}
