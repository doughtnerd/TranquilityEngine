/**
 * Internal (ADR 0370, 0094): the GPU kernel executor's WebGL2 backend. WebGL2 has no compute shaders,
 * so a kernel runs as a full-screen fragment pass: one fragment per item, its inputs in float textures
 * (read with `texelFetch`), its outputs written to up to four RGBA32F render targets (`FloatTargets`),
 * one texel per item, row by row in a grid (`gridLayout`). A draw then samples those textures by item
 * index (vertex pulling). Transform feedback is the second pass kind (`GlFeedbackItemKernel`,
 * `itemKernelFeedback.ts`): a vertex program with the rasterizer off writes every item's outputs into
 * one vertex buffer, which skinning draws from (T16's spike).
 *
 * Renderer-neutral: it takes a raw WebGL2 context. It changes GL state (framebuffer, viewport, program,
 * texture units, blend/depth/cull/scissor/stencil off), so the caller restores its own afterwards (the
 * Babylon backend calls `engine.wipeCaches(true)`).
 *
 * Context loss: while the context is lost, `run` does nothing and `lost` is true; `dispose` is safe.
 * On restore the owner rebuilds (GL objects don't survive a loss).
 */
import { gridLayout, type GridLayout } from "./layout";

/** A full-screen triangle (vertex index only, no attributes): the vertex shader of a kernel pass. */
export const FULLSCREEN_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Float render targets with `targets` draw buffers: what a kernel pass needs beyond WebGL2. */
export function supportsFloatTargets(gl: WebGL2RenderingContext, targets = 4): boolean {
  return !!gl.getExtension("EXT_color_buffer_float") && (gl.getParameter(gl.MAX_DRAW_BUFFERS) as number) >= targets;
}

/** An RGBA32F texture, nearest-sampled and clamped, `w` × `h`. */
export function floatTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
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

/** Writes `data` (RGBA floats, `w` × `h` of them) into `texture` from texel (x, y). */
export function writeFloatTexture(gl: WebGL2RenderingContext, texture: WebGLTexture, x: number, y: number, w: number, h: number, data: Float32Array): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.FLOAT, data);
}

/** RGBA32F textures attached to one framebuffer as colour attachments 0.., all `width` × `height`. */
export interface FloatTargets {
  readonly textures: WebGLTexture[];
  readonly fbo: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
}

/** `count` float targets of one size on a new framebuffer. */
export function createFloatTargets(gl: WebGL2RenderingContext, width: number, height: number, count: number): FloatTargets {
  const textures = Array.from({ length: count }, () => floatTexture(gl, width, height));
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  textures.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { textures, fbo, width, height };
}

/** Float targets laid out for `items` texels (`gridLayout`). */
export function createItemTargets(gl: WebGL2RenderingContext, items: number, count: number, grid: GridLayout = gridLayout(items)): FloatTargets {
  return createFloatTargets(gl, grid.width, grid.height, count);
}

/** Clears every target to zero. */
export function clearFloatTargets(gl: WebGL2RenderingContext, t: FloatTargets): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  for (let i = 0; i < t.textures.length; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** Reads target `index` back into `out` (RGBA floats; `h` rows of `w` from row `y`; slow: tools and tests). */
export function readFloatTarget(gl: WebGL2RenderingContext, t: FloatTargets, index: number, out: Float32Array, y = 0, h = t.height, w = t.width): Float32Array {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + index);
  gl.readPixels(0, y, w, h, gl.RGBA, gl.FLOAT, out);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return out;
}

export function deleteFloatTargets(gl: WebGL2RenderingContext, t: FloatTargets): void {
  for (const tex of t.textures) gl.deleteTexture(tex);
  gl.deleteFramebuffer(t.fbo);
}

/** Where a pass draws: `targets`' first `attachments` colour attachments (all by default), within `viewport` (x, y, w, h; the whole grid by default). */
export interface GlPassTarget {
  targets: FloatTargets;
  attachments?: number;
  viewport?: [number, number, number, number];
}

/** What a pass binds, handed to the owner's `bind` callback during `run`. */
export interface GlPassBindings {
  /** Bind `texture` to unit `unit` and the sampler uniform `name` to it. */
  texture(unit: number, name: string, texture: WebGLTexture): void;
  int(name: string, value: number): void;
  vec4s(name: string, data: Float32Array): void;
}

export interface GlKernelSpec {
  /** Names the program in errors. */
  label: string;
  /** Vertex shader (default `FULLSCREEN_VERTEX`). */
  vertex?: string;
  /** Fragment shader: the kernel, one fragment per item. */
  fragment: string;
  /** Uniform names the passes set (samplers too). */
  uniforms: readonly string[];
}

/** One fragment-kernel program. */
export class GlKernel {
  /** Shader compile or link errors (empty when it built); `run` does nothing while there are any. */
  readonly errors: string[] = [];
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly loc = new Map<string, WebGLUniformLocation | null>();
  private readonly binder: GlPassBindings;
  private units = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly spec: GlKernelSpec,
  ) {
    this.program = linkProgram(gl, spec.vertex ?? FULLSCREEN_VERTEX, spec.fragment, this.errors);
    this.vao = gl.createVertexArray()!;
    for (const name of spec.uniforms) this.loc.set(name, gl.getUniformLocation(this.program, name));
    this.binder = {
      texture: (unit, name, texture) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.loc.get(name) ?? null, unit);
        this.units = Math.max(this.units, unit + 1);
      },
      int: (name, value) => gl.uniform1i(this.loc.get(name) ?? null, value),
      vec4s: (name, data) => gl.uniform4fv(this.loc.get(name) ?? null, data),
    };
  }

  /** Whether the context is lost (passes do nothing). */
  get lost(): boolean {
    return this.gl.isContextLost?.() ?? false;
  }

  /**
   * Draw the kernel into `target` (one fragment per texel of its viewport) with the bindings `bind`
   * sets. Leaves the framebuffer, VAO and the texture units it used unbound, and unit 0 active.
   */
  run(target: GlPassTarget, bind: (b: GlPassBindings) => void): void {
    const gl = this.gl;
    if (this.errors.length || this.lost) return;
    const t = target.targets;
    const n = target.attachments ?? t.textures.length;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.drawBuffers(Array.from({ length: n }, (_, i) => gl.COLOR_ATTACHMENT0 + i));
    const [x, y, w, h] = target.viewport ?? [0, 0, t.width, t.height];
    gl.viewport(x, y, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    this.units = 0;
    bind(this.binder);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < this.units; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }
}

/**
 * Compiles and links a program, pushing compile and link logs to `errors`. `beforeLink` runs on the
 * program before it links (a transform feedback pass names its captured varyings there).
 */
export function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string, errors: string[], beforeLink?: (program: WebGLProgram) => void): WebGLProgram {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) errors.push(gl.getShaderInfoLog(sh) ?? "compile failed");
    return sh;
  };
  const p = gl.createProgram()!;
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  beforeLink?.(p);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) errors.push(gl.getProgramInfoLog(p) ?? "link failed");
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}
