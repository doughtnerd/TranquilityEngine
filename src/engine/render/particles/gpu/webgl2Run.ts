// Internal (ADR 0094): the WebGL2 texture executor. WebGL2 has no compute shaders, so the kernel
// (`glslSimulation`) runs as a full-screen fragment pass: one fragment per particle slot, writing
// the four state vec4s to four RGBA32F render targets; two sets of textures swap every frame.
// Renderer-neutral: it takes a raw WebGL2 context. The caller restores its own GL state after `step`
// (the Babylon backend calls `engine.wipeCaches(true)`).
import { KERNEL_FLOATS, LUT_SAMPLES, U, type KernelSystem } from "../../../scene/particleKernel";
import type { KernelRun } from "./kernelEffect";
import { GLSL_SIM_VERTEX, GLSL_TRAIL_HISTORY, glslSimulation } from "./kernelShader";

/** Width of the state textures (slots run row by row). */
export const STATE_WIDTH = 1024;

/** Float render targets: what the texture executor needs beyond WebGL2. */
export function supportsTextureKernels(gl: WebGL2RenderingContext): boolean {
  return !!gl.getExtension("EXT_color_buffer_float") && (gl.getParameter(gl.MAX_DRAW_BUFFERS) as number) >= 4;
}

interface StateSet {
  textures: WebGLTexture[];
  fbo: WebGLFramebuffer;
}

export class WebGl2Run implements KernelRun {
  readonly kind = "webgl2" as const;
  readonly width: number;
  readonly height: number;
  readonly sets: [StateSet, StateSet];
  readonly lutTexture: WebGLTexture;
  /** Index of the set holding the latest state. */
  cur = 0;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly loc: Record<string, WebGLUniformLocation | null> = {};
  private readonly lutRows: number;
  private readonly dummy: WebGLTexture;
  /**
   * Trail history (ADR 0126): `kernel.trail` blocks of `height` rows, block `frame % points` written after
   * each step by a second pass. Null without trail outputs.
   */
  readonly history: { texture: WebGLTexture; fbo: WebGLFramebuffer; program: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> } | null = null;
  /** Shader compile or link errors (empty when it built). */
  readonly errors: string[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly kernel: KernelSystem,
    /** The scene's depth texture for depth collision (a raw texture, or null). */
    private readonly depthTexture: () => WebGLTexture | null = () => null,
  ) {
    this.width = Math.min(STATE_WIDTH, kernel.capacity);
    this.height = Math.ceil(kernel.capacity / this.width);
    this.sets = [this.makeSet(), this.makeSet()];
    this.lutRows = Math.max(1, kernel.luts.length);
    this.lutTexture = this.makeTexture(LUT_SAMPLES, this.lutRows);
    this.dummy = this.makeTexture(1, 1);
    this.program = this.link(GLSL_SIM_VERTEX, glslSimulation(kernel));
    this.vao = gl.createVertexArray()!;
    for (const name of ["ku", "kw", "ks0", "ks1", "ks2", "ks3", "kl", "kp0", "kp1", "kp2", "kp3", "kpw", "kdepth"]) this.loc[name] = gl.getUniformLocation(this.program, name);
    if (kernel.trail) {
      const texture = this.makeTexture(this.width, this.height * kernel.trail);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const program = this.link(GLSL_SIM_VERTEX, GLSL_TRAIL_HISTORY);
      this.history = { texture, fbo, program, loc: { ks0: gl.getUniformLocation(program, "ks0"), ks3: gl.getUniformLocation(program, "ks3"), yoff: gl.getUniformLocation(program, "yoff") } };
    }
    this.clear();
  }

  private makeTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  private makeSet(): StateSet {
    const gl = this.gl;
    const textures = [0, 1, 2, 3].map(() => this.makeTexture(this.width, this.height));
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { textures, fbo };
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) this.errors.push(gl.getShaderInfoLog(sh) ?? "compile failed");
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) this.errors.push(gl.getProgramInfoLog(p) ?? "link failed");
    return p;
  }

  step(uniforms: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    const gl = this.gl;
    if (this.errors.length) return;
    if (lut) {
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SAMPLES, this.lutRows, gl.RGBA, gl.FLOAT, lut.subarray(0, LUT_SAMPLES * this.lutRows * 4));
    }
    const src = this.sets[this.cur];
    const dst = this.sets[1 - this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const unit = (i: number, tex: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.loc[name], i);
    };
    src.textures.forEach((t, i) => unit(i, t, `ks${i}`));
    unit(4, this.lutTexture, "kl");
    if (this.kernel.event) {
      const p = parent instanceof WebGl2Run ? parent : null;
      const ptex = p ? p.sets[p.cur].textures : src.textures;
      ptex.forEach((t, i) => unit(5 + i, t, `kp${i}`));
      gl.uniform1i(this.loc.kpw, p ? p.width : this.width);
    }
    if (this.kernel.depth) unit(9, this.depthTexture() ?? this.dummy, "kdepth");
    gl.uniform4fv(this.loc.ku, uniforms.subarray(0, this.kernel.uniformVec4 * 4));
    gl.uniform1i(this.loc.kw, this.width);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const h = this.history;
    if (h) {
      // This frame's (position, seed) into its block of the history.
      const yoff = (uniforms[U.spawn * 4 + 3] % this.kernel.trail!) * this.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, h.fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, yoff, this.width, this.height);
      gl.useProgram(h.program);
      unit(0, dst.textures[0], "ks0");
      gl.uniform1i(h.loc.ks0, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dst.textures[3]);
      gl.uniform1i(h.loc.ks3, 1);
      gl.uniform1i(h.loc.yoff, yoff);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < 10; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.cur = 1 - this.cur;
  }

  /** The textures holding the latest state (draws sample them). */
  current(): WebGLTexture[] {
    return this.sets[this.cur].textures;
  }

  clear(): void {
    const gl = this.gl;
    for (const set of this.sets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, set.fbo);
      for (let i = 0; i < 4; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Read the latest state back, interleaved like the other executors (tests and tools; slow). */
  read(): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(this.kernel.capacity * KERNEL_FLOATS);
    const px = new Float32Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sets[this.cur].fbo);
    for (let a = 0; a < 4; a++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + a);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, px);
      for (let i = 0; i < this.kernel.capacity; i++) for (let c = 0; c < 4; c++) out[i * KERNEL_FLOATS + a * 4 + c] = px[i * 4 + c];
    }
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Read the trail history back, block by block like the JavaScript executor's (tests; slow). */
  readHistory(): Float32Array | null {
    const h = this.history;
    if (!h) return null;
    const gl = this.gl;
    const points = this.kernel.trail ?? 0;
    const cap = this.kernel.capacity;
    const px = new Float32Array(this.width * this.height * points * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, h.fbo);
    gl.readPixels(0, 0, this.width, this.height * points, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Float32Array(points * cap * 4);
    for (let b = 0; b < points; b++) for (let i = 0; i < cap; i++) out.set(px.subarray(((b * this.height + Math.floor(i / this.width)) * this.width + (i % this.width)) * 4, ((b * this.height + Math.floor(i / this.width)) * this.width + (i % this.width)) * 4 + 4), (b * cap + i) * 4);
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const set of this.sets) {
      for (const t of set.textures) gl.deleteTexture(t);
      gl.deleteFramebuffer(set.fbo);
    }
    gl.deleteTexture(this.lutTexture);
    gl.deleteTexture(this.dummy);
    if (this.history) {
      gl.deleteTexture(this.history.texture);
      gl.deleteFramebuffer(this.history.fbo);
      gl.deleteProgram(this.history.program);
    }
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
