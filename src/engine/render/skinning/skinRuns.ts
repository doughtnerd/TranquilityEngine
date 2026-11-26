/**
 * Internal (ADR 0370 "Rendering"): `mycoSkin` (`skinKernel.ts`) on the GPU kernel executor, renderer-neutral.
 * A `SkinRuns` backend makes palettes (one per skeleton) and runs (one per mesh: the kernel over its
 * vertices, its output a vertex buffer at `SKIN_STRIDE` that a renderer draws from):
 *
 * - `WebGpuSkinRuns`: `GpuItemKernel`, the output a storage buffer with `VERTEX` usage made by the
 *   renderer's factory (Babylon wraps it, so its draws bind the same buffer);
 * - `FeedbackSkinRuns` (WebGL2): `GlFeedbackItemKernel`, the output an ordinary vertex buffer written by
 *   transform feedback (T16's spike chose it over float textures with vertex pulling: every pass draws it
 *   with its own shaders unchanged);
 * - `JsSkinRuns`: `JsItemKernel`, the output a Float32Array the renderer uploads (no GPU kernel support,
 *   headless engines).
 *
 * On the GPU backends every palette is a range of one shared table (a storage buffer, or an RGBA32F
 * texture on WebGL2) with a CPU copy: `upload` writes the copy, and the changed span goes to the GPU in
 * one write before the next pass, so a frame's palettes cost one upload, not one per skeleton. A run
 * finds its skeleton's palette through the first joint in its params table. Dispatches are batched: on
 * WebGPU they're recorded into one compute pass and submitted by `flush` (one submit a frame); on WebGL2
 * the passes share their program, VAO and bindings, and `flush` restores what they changed.
 *
 * A run's geometry tables are written once; `setMorphWeights` rewrites the small params table; `dispatch`
 * runs the kernel. The caller decides when to dispatch (only after its palette or weights changed) and
 * calls `flush` after a frame's dispatches. On WebGL2 the caller restores its GL state after `flush`
 * (Babylon: `wipeCaches(true)`).
 */
import { GRID_WIDTH } from "../gpuKernels/layout";
import { JsItemKernel } from "../gpuKernels/itemKernel";
import { GpuItemKernel } from "../gpuKernels/itemKernelWebgpu";
import { GlFeedbackBatch, GlFeedbackItemKernel } from "../gpuKernels/itemKernelFeedback";
import { RangeAllocator, type Range } from "../gpuKernels/rangeAllocator";
import { floatTexture, writeFloatTexture } from "../gpuKernels/webgl2";
import { BUFFER, GpuComputeBatch, type BufferFactory, type GpuBuffer, type GpuDevice } from "../gpuKernels/webgpu";
import { influencesOf, packMorphTargets, packSkinParams, packSkinVertices, PALETTE_FLOATS, skinKernelSpec } from "./skinKernel";
import { vertexCount, type SkinGeometry } from "./skinData";

/** Which executor backend runs the kernel. */
export type SkinExecutor = "webgpu" | "webgl2" | "js";

/** One skeleton's bone palette on the GPU (or CPU), read by each of its meshes' runs. */
export interface SkinPalette {
  /** Upload a palette (12 floats a joint, D10); it takes more room when it has more joints than before. */
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
  /** Run the kernel over every vertex (on WebGPU, submitted by the backend's next `flush`). */
  dispatch(): void;
  dispose(): void;
}

/** An executor backend for skinning. */
export interface SkinRuns<O> {
  readonly executor: SkinExecutor;
  palette(label: string): SkinPalette;
  run(geometry: SkinGeometry): SkinRun<O>;
  /** After a frame's dispatches: submit them (WebGPU) or restore the state they changed (WebGL2). */
  flush(): void;
  /** Free the shared palette table (after every run and palette was disposed). */
  dispose?(): void;
}

/** What every backend's run keeps: the vertex and target counts, and the params table it rewrites. */
abstract class RunBase {
  readonly vertices: number;
  protected readonly targets: number;
  protected params: Float32Array;
  /** The first joint of its palette in the shared table, as the params table holds it. */
  protected base = 0;

  constructor(g: SkinGeometry) {
    this.vertices = vertexCount(g);
    this.targets = g.morphTargets.length;
    this.params = packSkinParams(this.vertices, this.targets, []);
  }

  protected packWeights(weights: ArrayLike<number>): Float32Array {
    this.params = packSkinParams(this.vertices, this.targets, weights, this.params, this.base);
    return this.params;
  }

  /** Whether the params table must be written again because the palette moved to `base`. */
  protected moved(base: number): boolean {
    if (base === this.base) return false;
    this.base = base;
    this.params[2] = base;
    return true;
  }
}

/**
 * The CPU copy of the shared palette table and its changed span, in joints (`PALETTE_FLOATS` floats
 * each). Ranges come from a `RangeAllocator`; the table only grows (`grow` says the GPU copy must be
 * remade and written whole).
 */
class PaletteTable {
  readonly ranges = new RangeAllocator();
  data = new Float32Array(0);
  /** Changed joints [lo, hi). */
  lo = Infinity;
  hi = 0;
  /** Bumped when `data` grew (the GPU table must be remade). */
  generation = 0;

  constructor(private readonly roundUp: (joints: number) => number) {}

  /** A range of `joints` joints; the table grows (all of it then changed) when the range ends past it. */
  allocate(joints: number): Range {
    const r = this.ranges.allocate(joints);
    const need = this.ranges.end * PALETTE_FLOATS;
    if (need > this.data.length) {
      const grown = new Float32Array(this.roundUp(Math.max(this.ranges.end, (this.data.length / PALETTE_FLOATS) * 2, 64)) * PALETTE_FLOATS);
      grown.set(this.data);
      this.data = grown;
      this.generation++;
      this.lo = 0;
      this.hi = this.ranges.end;
    }
    return r;
  }

  write(r: Range, palette: Float32Array): void {
    const floats = Math.min(palette.length, r.size * PALETTE_FLOATS);
    this.data.set(floats === palette.length ? palette : palette.subarray(0, floats), r.offset * PALETTE_FLOATS);
    if (r.offset < this.lo) this.lo = r.offset;
    if (r.offset + r.size > this.hi) this.hi = r.offset + r.size;
  }

  get dirty(): boolean {
    return this.hi > this.lo;
  }

  clean(): void {
    this.lo = Infinity;
    this.hi = 0;
  }
}

/** A palette: a range of a backend's shared table. */
class TablePalette implements SkinPalette {
  range: Range | null = null;

  constructor(private readonly table: PaletteTable) {}

  upload(palette: Float32Array): void {
    const joints = Math.max(1, Math.ceil(palette.length / PALETTE_FLOATS));
    if (!this.range || this.range.size < joints) {
      if (this.range) this.table.ranges.release(this.range);
      this.range = this.table.allocate(joints);
    }
    this.table.write(this.range, palette);
  }

  dispose(): void {
    if (this.range) this.table.ranges.release(this.range);
    this.range = null;
  }
}

// --- WebGPU ------------------------------------------------------------------------------------------

/** The shared palette table as one storage buffer, written from the CPU copy before the next pass. */
class WebGpuPalettes {
  readonly table = new PaletteTable((j) => j);
  buffer: GpuBuffer;
  private generation = -1;
  private readonly retired: GpuBuffer[] = [];

  constructor(
    private readonly device: GpuDevice,
    private readonly batch: GpuComputeBatch,
  ) {
    this.buffer = this.make(1);
  }

  /** Write the changed span (remaking the buffer when the table grew). */
  flush(): void {
    const t = this.table;
    if (t.generation !== this.generation) {
      this.generation = t.generation;
      // A pass recorded but not yet submitted may still read the old buffer: destroy it after the submit.
      if (this.batch.pending) this.retired.push(this.buffer);
      else this.buffer.destroy();
      this.buffer = this.make(t.data.length / PALETTE_FLOATS);
    }
    if (!t.dirty) return;
    const bytes = PALETTE_FLOATS * 4;
    this.device.queue.writeBuffer(this.buffer, t.lo * bytes, t.data.buffer, t.data.byteOffset + t.lo * bytes, (t.hi - t.lo) * bytes);
    t.clean();
  }

  afterSubmit(): void {
    for (const b of this.retired) b.destroy();
    this.retired.length = 0;
  }

  dispose(): void {
    this.afterSubmit();
    this.buffer.destroy();
  }

  private make(joints: number): GpuBuffer {
    return this.device.createBuffer({ size: Math.max(1, joints) * PALETTE_FLOATS * 4, usage: BUFFER.STORAGE | BUFFER.COPY_DST, label: "skin palettes" });
  }
}

class WebGpuRun extends RunBase implements SkinRun<GpuBuffer> {
  private readonly kernel: GpuItemKernel;
  private palette: TablePalette | null = null;

  constructor(
    private readonly owner: WebGpuSkinRuns,
    device: GpuDevice,
    g: SkinGeometry,
    factory: BufferFactory | undefined,
  ) {
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
    this.palette = palette as TablePalette;
  }

  setMorphWeights(weights: ArrayLike<number>): void {
    if (this.targets) this.kernel.setInput("params", this.packWeights(weights));
  }

  dispatch(): void {
    const range = this.palette?.range;
    if (!range) return;
    const palettes = this.owner.palettes;
    palettes.flush();
    this.kernel.bindInput("bones", palettes.buffer); // no-op unless the table's buffer was remade
    if (this.moved(range.offset)) this.kernel.setInput("params", this.params);
    this.kernel.dispatch(this.owner.batch);
  }

  dispose(): void {
    this.kernel.dispose();
  }
}

/** Skinning on WebGPU compute. `outputFactory` makes each run's output (default: a storage buffer with `VERTEX` usage). */
export class WebGpuSkinRuns implements SkinRuns<GpuBuffer> {
  readonly executor = "webgpu" as const;
  /** @internal This frame's dispatches, one compute pass. */
  readonly batch: GpuComputeBatch;
  /** @internal Every palette. */
  readonly palettes: WebGpuPalettes;

  constructor(
    private readonly device: GpuDevice,
    private readonly outputFactory?: BufferFactory,
  ) {
    this.batch = new GpuComputeBatch(device);
    this.palettes = new WebGpuPalettes(device, this.batch);
  }

  palette(_label: string): SkinPalette {
    return new TablePalette(this.palettes.table);
  }

  run(geometry: SkinGeometry): SkinRun<GpuBuffer> {
    return new WebGpuRun(this, this.device, geometry, this.outputFactory);
  }

  flush(): void {
    this.palettes.flush();
    this.batch.submit();
    this.palettes.afterSubmit();
  }

  dispose(): void {
    this.batch.submit();
    this.palettes.dispose();
  }
}

// --- WebGL2 (transform feedback) ----------------------------------------------------------------------

/** Texels per joint in the palette texture (three vec4 rows). */
const JOINT_TEXELS = PALETTE_FLOATS / 4;

/** The shared palette table as one RGBA32F texture `GRID_WIDTH` texels wide, written from the CPU copy before the next pass. */
class FeedbackPalettes {
  // Whole rows of the texture (a joint is three texels, so whole rows are multiples of GRID_WIDTH joints).
  readonly table = new PaletteTable((j) => Math.ceil(j / GRID_WIDTH) * GRID_WIDTH);
  texture: WebGLTexture;
  readonly width = GRID_WIDTH;
  private height = 1;
  private generation = -1;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly batch: GlFeedbackBatch,
  ) {
    this.texture = floatTexture(gl, this.width, 1);
  }

  /** Write the changed rows (remaking the texture when the table grew). */
  flush(): void {
    const t = this.table;
    const gl = this.gl;
    if (t.generation !== this.generation) {
      this.generation = t.generation;
      gl.deleteTexture(this.texture);
      this.height = Math.max(1, Math.floor(t.data.length / 4 / this.width));
      this.texture = floatTexture(gl, this.width, this.height);
      this.batch.invalidate(); // making it bound it on the active unit
    }
    if (!t.dirty) return;
    const y0 = Math.floor((t.lo * JOINT_TEXELS) / this.width);
    const y1 = Math.min(this.height, Math.ceil((t.hi * JOINT_TEXELS) / this.width));
    writeFloatTexture(gl, this.texture, 0, y0, this.width, y1 - y0, t.data.subarray(y0 * this.width * 4, y1 * this.width * 4));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.batch.invalidate(); // the upload bound the texture on the active unit
    t.clean();
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}

class FeedbackRun extends RunBase implements SkinRun<WebGLBuffer> {
  private readonly kernel: GlFeedbackItemKernel;
  private palette: TablePalette | null = null;

  constructor(
    private readonly owner: FeedbackSkinRuns,
    gl: WebGL2RenderingContext,
    g: SkinGeometry,
  ) {
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
    this.palette = palette as TablePalette;
  }

  setMorphWeights(weights: ArrayLike<number>): void {
    if (!this.targets) return;
    this.kernel.setInput("params", this.packWeights(weights));
    this.owner.batch.invalidate();
  }

  dispatch(): void {
    const range = this.palette?.range;
    if (!range) return;
    const { palettes, batch } = this.owner;
    palettes.flush();
    this.kernel.bindInput("bones", palettes.texture, palettes.width);
    if (this.moved(range.offset)) {
      this.kernel.setInput("params", this.params);
      batch.invalidate();
    }
    this.kernel.dispatch(batch);
  }

  dispose(): void {
    this.kernel.dispose();
  }
}

/** Skinning on WebGL2 through transform feedback into a vertex buffer. */
export class FeedbackSkinRuns implements SkinRuns<WebGLBuffer> {
  readonly executor = "webgl2" as const;
  /** @internal This frame's passes. */
  readonly batch: GlFeedbackBatch;
  /** @internal Every palette. */
  readonly palettes: FeedbackPalettes;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.batch = new GlFeedbackBatch(gl);
    this.palettes = new FeedbackPalettes(gl, this.batch);
  }

  palette(_label: string): SkinPalette {
    return new TablePalette(this.palettes.table);
  }

  run(geometry: SkinGeometry): SkinRun<WebGLBuffer> {
    return new FeedbackRun(this, this.gl, geometry);
  }

  flush(): void {
    this.batch.end();
  }

  dispose(): void {
    this.batch.end();
    this.batch.dispose();
    this.palettes.dispose();
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

/** Skinning on the CPU: the kernel's JavaScript output (`JsItemKernel`). Each palette is its own table (first joint 0). */
export class JsSkinRuns implements SkinRuns<Float32Array> {
  readonly executor = "js" as const;

  palette(_label: string): SkinPalette {
    return new JsPalette();
  }

  run(geometry: SkinGeometry): SkinRun<Float32Array> {
    return new JsRun(geometry);
  }

  flush(): void {}
}
