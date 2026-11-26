/**
 * Internal (ADR 0370; T16's WebGL2 spike): an item kernel (`itemKernel.ts`) on WebGL2 through transform
 * feedback. One vertex per item runs the kernel (`itemKernelGlslFeedback`), drawn as points with the
 * rasterizer off, and its outputs are captured interleaved into `output`, an ordinary vertex buffer laid
 * out exactly like WebGPU's `kout` (stride `itemStride(spec)`). A draw binds `output` as its vertex
 * buffer, so every pass (main, shadows, depth) draws the result without a shader of its own: that is
 * why skinning takes this path rather than `GlItemKernel`'s float textures, which every pass's vertex
 * shader would have to sample by vertex index.
 *
 * Inputs are float textures as in `GlItemKernel` (one texel per vec4 row, read with `texelFetch`); a
 * vertex shader samples them, so no float render target (`EXT_color_buffer_float`) is needed. `bindInput`
 * reads a texture another owner writes (the shared bone palettes for each mesh).
 *
 * Kernels of one spec on a context share one program. A `GlFeedbackBatch` runs many kernels' passes back
 * to back (a frame's skinning, one kernel per mesh): the program, VAO, rasterizer discard and transform
 * feedback object are set once, a texture already bound to its unit and a uniform already holding its
 * value aren't set again, and `end` restores what the passes changed.
 *
 * The caller restores its GL state after `dispatch` or a batch's `end` (program, VAO, texture units, the
 * array buffer binding), as with every pass of `webgl2.ts`. Context loss: `dispatch` does nothing; the
 * owner rebuilds.
 */
import { gridLayout, padToGrid, type GridLayout } from "./layout";
import { FEEDBACK_FRAGMENT, itemKernelFeedbackUniforms, itemKernelFeedbackVaryings, itemKernelGlslFeedback, itemStride, type ItemKernelSpec } from "./itemKernel";
import { floatTexture, linkProgram, writeFloatTexture } from "./webgl2";

interface FeedbackInput {
  texture: WebGLTexture;
  grid: GridLayout;
  /** False for a texture `bindInput` was given (another owner's: never deleted here). */
  owned: boolean;
}

/** One spec's program on one context, shared by its kernels (deleted with the last). */
interface FeedbackProgram {
  readonly program: WebGLProgram;
  readonly errors: string[];
  readonly loc: Map<string, WebGLUniformLocation | null>;
  /** The program's integer uniforms as last set (uniforms are program state). */
  readonly ints: Map<string, number>;
  users: number;
}

const programs = new WeakMap<WebGL2RenderingContext, Map<ItemKernelSpec, FeedbackProgram>>();

function acquireProgram(gl: WebGL2RenderingContext, spec: ItemKernelSpec): FeedbackProgram {
  let bySpec = programs.get(gl);
  if (!bySpec) programs.set(gl, (bySpec = new Map()));
  let p = bySpec.get(spec);
  if (!p) {
    const errors: string[] = [];
    const varyings = itemKernelFeedbackVaryings(spec);
    const program = linkProgram(gl, itemKernelGlslFeedback(spec), FEEDBACK_FRAGMENT, errors, (q) => gl.transformFeedbackVaryings(q, varyings, gl.INTERLEAVED_ATTRIBS));
    const loc = new Map<string, WebGLUniformLocation | null>();
    for (const name of itemKernelFeedbackUniforms(spec)) loc.set(name, gl.getUniformLocation(program, name));
    p = { program, errors, loc, ints: new Map(), users: 0 };
    bySpec.set(spec, p);
  }
  p.users++;
  return p;
}

function releaseProgram(gl: WebGL2RenderingContext, spec: ItemKernelSpec, p: FeedbackProgram): void {
  if (--p.users > 0) return;
  gl.deleteProgram(p.program);
  programs.get(gl)?.delete(spec);
}

/**
 * Runs transform-feedback passes back to back on one context. The first pass sets the shared state;
 * `end` puts it back (and must come before anything else draws). A batch with no pass does nothing.
 */
export class GlFeedbackBatch {
  private open = false;
  private program: WebGLProgram | null = null;
  /** What each texture unit holds as far as the batch knows (undefined: unknown); units below `touched` were used. */
  private readonly units: (WebGLTexture | undefined)[] = [];
  private touched = 0;
  private readonly vao: WebGLVertexArrayObject;
  private readonly feedback: WebGLTransformFeedback;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.vao = gl.createVertexArray()!;
    this.feedback = gl.createTransformFeedback()!;
  }

  /** Start a pass with `program` (opens the batch, switches program when needed). */
  use(program: WebGLProgram): void {
    const gl = this.gl;
    if (!this.open) {
      this.open = true;
      // A buffer captured into may not also be bound elsewhere during the draw.
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(this.vao);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
      gl.enable(gl.RASTERIZER_DISCARD);
      this.program = null;
      this.units.length = 0;
      this.touched = 0;
    }
    if (this.program !== program) {
      gl.useProgram(program);
      this.program = program;
    }
  }

  /** Bind `texture` to `unit` unless it already is. */
  texture(unit: number, texture: WebGLTexture): void {
    if (this.units[unit] === texture) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.units[unit] = texture;
    this.touched = Math.max(this.touched, unit + 1);
  }

  /**
   * Forget which textures the units hold: call it after binding textures outside the batch while it is
   * open (a `setInput` or another texture upload between two passes binds on the active unit).
   */
  invalidate(): void {
    this.units.fill(undefined);
  }

  /** Restore what the passes changed (nothing when none ran). */
  end(): void {
    if (!this.open) return;
    const gl = this.gl;
    this.open = false;
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    for (let i = 0; i < this.touched; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.units.length = 0;
    this.touched = 0;
    this.program = null;
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteTransformFeedback(this.feedback);
  }
}

export class GlFeedbackItemKernel {
  /** Shader compile or link errors (empty when it built); `dispatch` does nothing while there are any. */
  readonly errors: string[];
  /** Every item's outputs, interleaved (item i's output k at `(i * outputs + k) * 16` bytes): a vertex buffer. */
  output: WebGLBuffer;
  /** Bytes per item in `output`. */
  readonly stride: number;
  private readonly shared: FeedbackProgram;
  private readonly inputs = new Map<string, FeedbackInput>();
  /** The inputs in order with their uniforms (a pass binds input i to texture unit i). */
  private readonly order: { input: FeedbackInput; sampler: string; width: string }[] = [];
  private ownBatch: GlFeedbackBatch | null = null;
  private n: number;
  private disposed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly spec: ItemKernelSpec,
    items: number,
  ) {
    this.stride = itemStride(spec);
    this.shared = acquireProgram(gl, spec);
    this.errors = this.shared.errors;
    for (const name of spec.inputs) {
      const input: FeedbackInput = { texture: floatTexture(gl, 1, 1), grid: { width: 1, height: 1 }, owned: true };
      this.inputs.set(name, input);
      this.order.push({ input, sampler: `kin_${name}`, width: `kin_${name}_w` });
    }
    this.n = items;
    this.output = this.createOutput(items);
  }

  get items(): number {
    return this.n;
  }

  /** Whether the context is lost (dispatches do nothing). */
  get lost(): boolean {
    return this.gl.isContextLost?.() ?? false;
  }

  /** Replace input `name`'s table (vec4 rows) in a texture of its own, remade when the table's grid changes. */
  setInput(name: string, data: Float32Array): void {
    const input = this.input(name);
    const grid = gridLayout(Math.ceil(data.length / 4));
    if (!input.owned || grid.width !== input.grid.width || grid.height !== input.grid.height) {
      if (input.owned) this.gl.deleteTexture(input.texture);
      input.texture = floatTexture(this.gl, grid.width, grid.height);
      input.grid = grid;
      input.owned = true;
    }
    writeFloatTexture(this.gl, input.texture, 0, 0, grid.width, grid.height, padToGrid(data, grid));
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
  }

  /**
   * Read input `name` from `texture`, an RGBA32F texture another owner writes, `width` texels wide (row j
   * at texel (j % width, j / width), as `gridLayout` lays tables out). It isn't deleted here.
   */
  bindInput(name: string, texture: WebGLTexture, width: number): void {
    const input = this.input(name);
    if (!input.owned && input.texture === texture) {
      input.grid.width = width;
      return;
    }
    if (input.owned) this.gl.deleteTexture(input.texture);
    input.texture = texture;
    input.grid = { width, height: 0 };
    input.owned = false;
  }

  /** Run every item into `output`: now (restoring what it changed), or as one pass of `batch` (whose `end` restores). */
  dispatch(batch?: GlFeedbackBatch): void {
    const gl = this.gl;
    if (this.errors.length || this.n <= 0 || this.disposed || this.lost) return;
    const b = batch ?? (this.ownBatch ??= new GlFeedbackBatch(gl));
    b.use(this.shared.program);
    for (let unit = 0; unit < this.order.length; unit++) {
      const o = this.order[unit];
      b.texture(unit, o.input.texture);
      this.int(o.sampler, unit);
      this.int(o.width, o.input.grid.width);
    }
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.output);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.n);
    gl.endTransformFeedback();
    if (!batch) b.end();
  }

  /** Run over `items` items from now on: `output` is replaced (a draw rebinds it). */
  resize(items: number): void {
    if (items === this.n) return;
    this.gl.deleteBuffer(this.output);
    this.n = items;
    this.output = this.createOutput(items);
  }

  /** Read `output` back (tools and tests; slow: it waits for the GPU). */
  read(): Float32Array {
    const gl = this.gl;
    const out = new Float32Array((Math.max(1, this.n) * this.stride) / 4);
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.output);
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    releaseProgram(gl, this.spec, this.shared);
    this.ownBatch?.dispose();
    gl.deleteBuffer(this.output);
    for (const i of this.inputs.values()) if (i.owned) gl.deleteTexture(i.texture);
  }

  /** Set an integer uniform of the shared program (in use) unless it already holds `value`. */
  private int(name: string, value: number): void {
    const ints = this.shared.ints;
    if (ints.get(name) === value) return;
    ints.set(name, value);
    this.gl.uniform1i(this.shared.loc.get(name) ?? null, value);
  }

  private input(name: string): FeedbackInput {
    const input = this.inputs.get(name);
    if (!input) throw new Error(`item kernel "${this.spec.name}" has no input "${name}"`);
    return input;
  }

  private createOutput(items: number): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, Math.max(1, items) * this.stride, gl.DYNAMIC_COPY);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return b;
  }
}
