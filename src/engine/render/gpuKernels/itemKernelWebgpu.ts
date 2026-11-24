/**
 * Internal (ADR 0370): an item kernel (`itemKernel.ts`) on WebGPU. One compute dispatch per frame
 * (submitted alone, or recorded into a `GpuComputeBatch` with other kernels') writes every item's outputs into `output`, a storage buffer a draw can also bind as a vertex buffer
 * (stride `itemStride(spec)`). Inputs are storage buffers it owns, grown as tables grow.
 */
import { VEC4_BYTES } from "./layout";
import { ITEM_WORKGROUP, itemKernelWgsl, itemStride, type ItemKernelSpec } from "./itemKernel";
import { BUFFER, GpuKernel, readBuffer, storageBufferFactory, type BufferFactory, type GpuBinding, type GpuBuffer, type GpuComputeBatch, type GpuDevice, type GpuDispatch, type GpuResource } from "./webgpu";

export interface GpuItemKernelOptions {
  /** Makes `output` (default: a storage buffer with `BUFFER.VERTEX`, so a mesh can draw from it). */
  outputFactory?: BufferFactory;
  workgroup?: number;
}

export class GpuItemKernel {
  /** Every item's outputs, interleaved (item i's output k at `(i * outputs + k) * 16` bytes). */
  output: GpuBuffer;
  /** Bytes per item in `output`. */
  readonly stride: number;
  readonly ready: Promise<string[]>;
  private readonly gpu: GpuKernel;
  private readonly info: GpuBuffer;
  /** Each input's buffer: owned (grown by `setInput`), or another owner's (`bindInput`; `bytes` 0, never destroyed here). */
  private readonly inputs = new Map<string, { buffer: GpuBuffer; bytes: number }>();
  private readonly factory: BufferFactory;
  private n: number;
  private dispatches: readonly GpuDispatch[] = [];
  /** The bind group's resources (made once per bind group, so not a new closure each dispatch). */
  private readonly resources = (): GpuResource[] => {
    const r: GpuResource[] = [{ binding: 0, buffer: this.info }];
    this.spec.inputs.forEach((name, j) => r.push({ binding: j + 1, buffer: this.inputs.get(name)!.buffer }));
    r.push({ binding: this.spec.inputs.length + 1, buffer: this.output });
    return r;
  };

  constructor(
    private readonly device: GpuDevice,
    readonly spec: ItemKernelSpec,
    items: number,
    opts: GpuItemKernelOptions = {},
  ) {
    const workgroup = opts.workgroup ?? ITEM_WORKGROUP;
    this.stride = itemStride(spec);
    this.factory = opts.outputFactory ?? storageBufferFactory(device, BUFFER.VERTEX);
    const bindings: GpuBinding[] = [{ binding: 0, kind: "read" }, ...spec.inputs.map((_, j) => ({ binding: j + 1, kind: "read" as const })), { binding: spec.inputs.length + 1, kind: "storage" }];
    this.gpu = new GpuKernel(device, { label: `kernel ${spec.name}`, code: itemKernelWgsl(spec, workgroup), entryPoints: ["main"], bindings, workgroup });
    this.ready = this.gpu.ready;
    const usage = BUFFER.STORAGE | BUFFER.COPY_DST;
    this.info = device.createBuffer({ size: VEC4_BYTES, usage, label: `kernel ${spec.name} items` });
    for (const name of spec.inputs) this.inputs.set(name, { buffer: device.createBuffer({ size: VEC4_BYTES, usage, label: `kernel ${spec.name} ${name}` }), bytes: VEC4_BYTES });
    this.n = items;
    this.output = this.factory(Math.max(1, items) * this.stride, `kernel ${spec.name} output`);
    this.writeInfo();
  }

  get items(): number {
    return this.n;
  }

  get lost(): boolean {
    return this.gpu.lost;
  }

  /** Replace input `name`'s table (vec4 rows); its buffer grows when the table does. */
  setInput(name: string, data: Float32Array): void {
    const input = this.inputs.get(name);
    if (!input) throw new Error(`item kernel "${this.spec.name}" has no input "${name}"`);
    const bytes = Math.max(VEC4_BYTES, Math.ceil(data.byteLength / VEC4_BYTES) * VEC4_BYTES);
    if (bytes > input.bytes) {
      if (input.bytes) input.buffer.destroy();
      input.buffer = this.device.createBuffer({ size: bytes, usage: BUFFER.STORAGE | BUFFER.COPY_DST, label: `kernel ${this.spec.name} ${name}` });
      input.bytes = bytes;
      this.gpu.invalidate();
    }
    this.device.queue.writeBuffer(input.buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  }

  /**
   * Read input `name` from `buffer`, a storage buffer another owner writes (a table several kernels
   * share, such as one skeleton's bone palette for each of its meshes); it isn't destroyed here. A
   * later `setInput` gives the input a buffer of its own again.
   */
  bindInput(name: string, buffer: GpuBuffer): void {
    const input = this.inputs.get(name);
    if (!input) throw new Error(`item kernel "${this.spec.name}" has no input "${name}"`);
    if (input.buffer === buffer) return;
    if (input.bytes) input.buffer.destroy();
    input.buffer = buffer;
    input.bytes = 0;
    this.gpu.invalidate();
  }

  /** Run every item into `output`: submitted now, or recorded into `batch` (submitted with it). */
  dispatch(batch?: GpuComputeBatch): void {
    const group = this.gpu.group("0", this.resources);
    if (batch) this.gpu.record(batch, group, this.dispatches);
    else this.gpu.dispatch(group, this.dispatches);
  }

  /** Run over `items` items from now on: `output` is replaced (a draw rebinds it). */
  resize(items: number): void {
    if (items === this.n) return;
    this.output.destroy();
    this.n = items;
    this.output = this.factory(Math.max(1, items) * this.stride, `kernel ${this.spec.name} output`);
    this.gpu.invalidate();
    this.writeInfo();
  }

  /** Read `output` back (tools and tests; slow). */
  read(): Promise<Float32Array> {
    return readBuffer(this.device, this.output, Math.max(1, this.n) * this.stride, `kernel ${this.spec.name} readback`);
  }

  private writeInfo(): void {
    this.dispatches = [{ entry: "main", items: this.n }];
    this.device.queue.writeBuffer(this.info, 0, new Uint32Array([this.n, 0, 0, 0]).buffer, 0, VEC4_BYTES);
  }

  dispose(): void {
    this.gpu.dispose();
    this.info.destroy();
    for (const i of this.inputs.values()) if (i.bytes) i.buffer.destroy();
    this.output.destroy();
  }
}
