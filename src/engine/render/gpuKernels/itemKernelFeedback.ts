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
 * reads a texture another owner writes (one skeleton's palette for each of its meshes).
 *
 * The caller restores its GL state after `dispatch` (program, VAO, texture units, the array buffer
 * binding), as with every pass of `webgl2.ts`. Context loss: `dispatch` does nothing; the owner rebuilds.
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

export class GlFeedbackItemKernel {
  /** Shader compile or link errors (empty when it built); `dispatch` does nothing while there are any. */
  readonly errors: string[] = [];
  /** Every item's outputs, interleaved (item i's output k at `(i * outputs + k) * 16` bytes): a vertex buffer. */
  output: WebGLBuffer;
  /** Bytes per item in `output`. */
  readonly stride: number;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly feedback: WebGLTransformFeedback;
  private readonly loc = new Map<string, WebGLUniformLocation | null>();
  private readonly inputs = new Map<string, FeedbackInput>();
  private n: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly spec: ItemKernelSpec,
    items: number,
  ) {
    this.stride = itemStride(spec);
    const varyings = itemKernelFeedbackVaryings(spec);
    this.program = linkProgram(gl, itemKernelGlslFeedback(spec), FEEDBACK_FRAGMENT, this.errors, (p) => gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS));
    for (const name of itemKernelFeedbackUniforms(spec)) this.loc.set(name, gl.getUniformLocation(this.program, name));
    this.vao = gl.createVertexArray()!;
    this.feedback = gl.createTransformFeedback()!;
    for (const name of spec.inputs) this.inputs.set(name, { texture: floatTexture(gl, 1, 1), grid: { width: 1, height: 1 }, owned: true });
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
    if (input.owned) this.gl.deleteTexture(input.texture);
    input.texture = texture;
    input.grid = { width, height: 0 };
    input.owned = false;
  }

  /** Run every item into `output`. */
  dispatch(): void {
    const gl = this.gl;
    if (this.errors.length || this.lost || this.n <= 0) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    let unit = 0;
    for (const name of this.spec.inputs) {
      const input = this.inputs.get(name)!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.uniform1i(this.loc.get(`kin_${name}`) ?? null, unit);
      gl.uniform1i(this.loc.get(`kin_${name}_w`) ?? null, input.grid.width);
      unit++;
    }
    // A buffer captured into may not also be bound elsewhere during the draw.
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.output);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.n);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    for (let i = 0; i < unit; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
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
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteTransformFeedback(this.feedback);
    gl.deleteBuffer(this.output);
    for (const i of this.inputs.values()) if (i.owned) gl.deleteTexture(i.texture);
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
