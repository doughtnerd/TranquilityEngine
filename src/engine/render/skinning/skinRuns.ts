/**
 * Internal (ADR 0370 "Rendering"): `mycoSkin` (`skinKernel.ts`) on the GPU kernel executor, renderer-neutral.
 * A `SkinRuns` backend makes palettes (one per skeleton: uploaded once a frame, read by each of its meshes'
 * kernels through `bindInput`) and runs (one per mesh: the kernel over its vertices, its output a vertex
 * buffer at `SKIN_STRIDE` that a renderer draws from):
 *
 * - `WebGpuSkinRuns`: `GpuItemKernel`, the output a storage buffer with `VERTEX` usage made by the
 *   renderer's factory (Babylon wraps it, so its draws bind the same buffer);
 * - `FeedbackSkinRuns` (WebGL2): `GlFeedbackItemKernel`, the output an ordinary vertex buffer written by
 *   transform feedback (T16's spike chose it over float textures with vertex pulling: every pass draws it
 *   with its own shaders unchanged);
 * - `JsSkinRuns`: `JsItemKernel`, the output a Float32Array the renderer uploads (no GPU kernel support,
 *   headless engines).
 *
 * A run's geometry tables are written once; `setMorphWeights` rewrites the small params table; `dispatch`
 * runs the kernel. The caller decides when to dispatch (only after its palette or weights changed). On
 * WebGL2 the caller restores its GL state after dispatches (Babylon: `wipeCaches(true)`).
 */
import { gridLayout, padToGrid, type GridLayout } from "../gpuKernels/layout";
import { JsItemKernel } from "../gpuKernels/itemKernel";
import { GpuItemKernel } from "../gpuKernels/itemKernelWebgpu";
import { GlFeedbackItemKernel } from "../gpuKernels/itemKernelFeedback";
import { floatTexture, writeFloatTexture } from "../gpuKernels/webgl2";
import { BUFFER, type BufferFactory, type GpuBuffer, type GpuDevice } from "../gpuKernels/webgpu";
import { influencesOf, packMorphTargets, packSkinParams, packSkinVertices, PALETTE_FLOATS, skinKernelSpec } from "./skinKernel";
import { vertexCount, type SkinGeometry } from "./skinData";

/** Which executor backend runs the kernel. */
export type SkinExecutor = "webgpu" | "webgl2" | "js";

/** One skeleton's bone palette on the GPU (or CPU), read by each of its meshes' runs. */
export interface SkinPalette {
  /** Upload a palette (12 floats a joint, D10); the storage grows when it has more joints than before. */
  upload(palette: Float32Array): void;
  dispose(): void;
}

/** One mesh's kernel. */
export interface SkinRun<O> {
  /** The skinned vertices (position, normal, tangent; `SKIN_STRIDE` bytes a vertex): the same object for the run's life. */
  readonly output: O;
  readonly vertices: number;
  /** Whether the device or context was lost (dispatches do nothing; the owner rebuilds). */
  readonly lost: boolean;
  /** Read bones from `palette` from now on. */
  setPalette(palette: SkinPalette): void;
  setMorphWeights(weights: ArrayLike<number>): void;
  /** Run the kernel over every vertex. */
  dispatch(): void;
  dispose(): void;
}

/** An executor backend for skinning. */
export interface SkinRuns<O> {
  readonly executor: SkinExecutor;
  palette(label: string): SkinPalette;
  run(geometry: SkinGeometry): SkinRun<O>;
}

/** What every backend's run keeps: the vertex and target counts, and the params table it rewrites. */
abstract class RunBase {
  readonly vertices: number;
  protected readonly targets: number;
  protected params: Float32Array;

  constructor(g: SkinGeometry) {
    this.vertices = vertexCount(g);
    this.targets = g.morphTargets.length;
    this.params = packSkinParams(this.vertices, this.targets, []);
  }

  protected packWeights(weights: ArrayLike<number>): Float32Array {
    this.params = packSkinParams(this.vertices, this.targets, weights, this.params);
    return this.params;
  }
}

// --- WebGPU ------------------------------------------------------------------------------------------

class WebGpuPalette implements SkinPalette {
  /** Replaced when an upload outgrows it: runs bind it at each dispatch. */
  buffer: GpuBuffer;
  private bytes = 0;

  constructor(
    private readonly device: GpuDevice,
    private readonly label: string,
  ) {
    this.buffer = this.make(PALETTE_FLOATS * 4);
  }

  upload(palette: Float32Array): void {
    if (palette.byteLength > this.bytes) {
      this.buffer.destroy();
      this.buffer = this.make(palette.byteLength);
    }
    this.device.queue.writeBuffer(this.buffer, 0, palette.buffer, palette.byteOffset, palette.byteLength);
  }

  dispose(): void {
    this.buffer.destroy();
  }

  private make(bytes: number): GpuBuffer {
    this.bytes = Math.ceil(bytes / 16) * 16;
    return this.device.createBuffer({ size: this.bytes, usage: BUFFER.STORAGE | BUFFER.COPY_DST, label: `${this.label} palette` });
  }
}

class WebGpuRun extends RunBase implements SkinRun<GpuBuffer> {
  private readonly kernel: GpuItemKernel;
  private palette: WebGpuPalette | null = null;

  constructor(device: GpuDevice, g: SkinGeometry, factory: BufferFactory | undefined) {
    super(g);
    this.kernel = new GpuItemKernel(device, skinKernelSpec(influencesOf(g)), this.vertices, factory ? { outputFactory: factory } : {});
    this.kernel.setInput("verts", packSkinVertices(g));
    this.kernel.setInput("morphs", packMorphTargets(g));
    this.kernel.setInput("params", this.params);
  }

  get output(): GpuBuffer {
    return this.kernel.output;
  }

  get lost(): boolean {
    return this.kernel.lost;
  }

  setPalette(palette: SkinPalette): void {
    this.palette = palette as WebGpuPalette;
  }

  setMorphWeights(weights: ArrayLike<number>): void {
    if (this.targets) this.kernel.setInput("params", this.packWeights(weights));
  }

  dispatch(): void {
    const p = this.palette;
    if (!p) return;
    this.kernel.bindInput("bones", p.buffer); // no-op unless the palette's buffer was replaced
    this.kernel.dispatch();
  }

  dispose(): void {
    this.kernel.dispose();
  }
}

/** Skinning on WebGPU compute. `outputFactory` makes each run's output (default: a storage buffer with `VERTEX` usage). */
export class WebGpuSkinRuns implements SkinRuns<GpuBuffer> {
  readonly executor = "webgpu" as const;

  constructor(
    private readonly device: GpuDevice,
    private readonly outputFactory?: BufferFactory,
  ) {}

  palette(label: string): SkinPalette {
    return new WebGpuPalette(this.device, label);
  }

  run(geometry: SkinGeometry): SkinRun<GpuBuffer> {
    return new WebGpuRun(this.device, geometry, this.outputFactory);
  }
}

// --- WebGL2 (transform feedback) ----------------------------------------------------------------------

class FeedbackPalette implements SkinPalette {
  texture: WebGLTexture;
  grid: GridLayout = { width: 1, height: 1 };

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.texture = floatTexture(gl, 1, 1);
  }

  upload(palette: Float32Array): void {
    const gl = this.gl;
    const grid = gridLayout(Math.ceil(palette.length / 4));
    if (grid.width !== this.grid.width || grid.height !== this.grid.height) {
      gl.deleteTexture(this.texture);
      this.texture = floatTexture(gl, grid.width, grid.height);
      this.grid = grid;
    }
    writeFloatTexture(gl, this.texture, 0, 0, grid.width, grid.height, padToGrid(palette, grid));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}

class FeedbackRun extends RunBase implements SkinRun<WebGLBuffer> {
  private readonly kernel: GlFeedbackItemKernel;
  private palette: FeedbackPalette | null = null;

  constructor(gl: WebGL2RenderingContext, g: SkinGeometry) {
    super(g);
    this.kernel = new GlFeedbackItemKernel(gl, skinKernelSpec(influencesOf(g)), this.vertices);
    this.kernel.setInput("verts", packSkinVertices(g));
    this.kernel.setInput("morphs", packMorphTargets(g));
    this.kernel.setInput("params", this.params);
  }

  get output(): WebGLBuffer {
    return this.kernel.output;
  }

  get lost(): boolean {
    return this.kernel.lost;
  }

  /** Shader compile or link errors (empty when it built). */
  get errors(): readonly string[] {
    return this.kernel.errors;
  }

  setPalette(palette: SkinPalette): void {
    this.palette = palette as FeedbackPalette;
  }

  setMorphWeights(weights: ArrayLike<number>): void {
    if (this.targets) this.kernel.setInput("params", this.packWeights(weights));
  }

  dispatch(): void {
    const p = this.palette;
    if (!p) return;
    this.kernel.bindInput("bones", p.texture, p.grid.width); // cheap: binds at dispatch, follows a regrown texture
    this.kernel.dispatch();
  }

  dispose(): void {
    this.kernel.dispose();
  }
}

/** Skinning on WebGL2 through transform feedback into a vertex buffer. */
export class FeedbackSkinRuns implements SkinRuns<WebGLBuffer> {
  readonly executor = "webgl2" as const;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  palette(_label: string): SkinPalette {
    return new FeedbackPalette(this.gl);
  }

  run(geometry: SkinGeometry): SkinRun<WebGLBuffer> {
    return new FeedbackRun(this.gl, geometry);
  }
}

// --- CPU --------------------------------------------------------------------------------------------------

class JsPalette implements SkinPalette {
  data = new Float32Array(PALETTE_FLOATS);

  upload(palette: Float32Array): void {
    this.data = palette.slice();
  }

  dispose(): void {}
}

class JsRun extends RunBase implements SkinRun<Float32Array> {
  readonly lost = false;
  private readonly kernel: JsItemKernel;
  private palette: JsPalette | null = null;

  constructor(g: SkinGeometry) {
    super(g);
    this.kernel = new JsItemKernel(skinKernelSpec(influencesOf(g)), this.vertices);
    this.kernel.setInput("verts", packSkinVertices(g));
    this.kernel.setInput("morphs", packMorphTargets(g));
    this.kernel.setInput("params", this.params);
  }

  get output(): Float32Array {
    return this.kernel.output;
  }

  setPalette(palette: SkinPalette): void {
    this.palette = palette as JsPalette;
  }

  setMorphWeights(weights: ArrayLike<number>): void {
    if (this.targets) this.kernel.setInput("params", this.packWeights(weights).slice());
  }

  dispatch(): void {
    if (!this.palette) return;
    this.kernel.setInput("bones", this.palette.data);
    this.kernel.dispatch();
  }

  dispose(): void {}
}

/** Skinning on the CPU: the kernel's JavaScript output (`JsItemKernel`). */
export class JsSkinRuns implements SkinRuns<Float32Array> {
  readonly executor = "js" as const;

  palette(_label: string): SkinPalette {
    return new JsPalette();
  }

  run(geometry: SkinGeometry): SkinRun<Float32Array> {
    return new JsRun(geometry);
  }
}
