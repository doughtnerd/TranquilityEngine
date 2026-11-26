/**
 * Internal (ADR 0370, 0094): the GPU kernel executor's WebGPU backend. A `GpuKernel` is one compute
 * shader module (WGSL) with one or more entry points over an explicit bind group layout; each frame
 * its owner binds buffers (cached bind groups, by a key the owner chooses) and dispatches entry points
 * over N items in one compute pass, or records them into a `GpuComputeBatch` that many kernels share
 * (one pass and one submit for all of them). Kernels of the same spec on one device share one module
 * and its pipelines. Renderer-neutral: it takes a raw GPUDevice (Babylon's, or any) and
 * only the few WebGPU types below, so a renderer passes a `BufferFactory` when its draws must bind the
 * same buffers (Babylon wraps them in `StorageBuffer`s; a vertex buffer adds `BUFFER.VERTEX`).
 *
 * The kernel doesn't own buffers: its owner allocates them (`createBuffer` or its factory), so it
 * decides what a draw can bind. `GpuReadback` reads a small buffer back without stalling, and
 * `readBuffer` reads one back at once (tools; slow).
 *
 * Device loss: once `device.lost` settles, `dispatch` does nothing and `lost` is true. The owner
 * rebuilds on a new device (a lost device's objects never come back).
 */
import { dispatchGroups } from "./layout";

// The few WebGPU types used (the DOM lib in this TypeScript has none).
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface GpuBuffer {
  destroy(): void;
  mapAsync?(mode: number): Promise<void>;
  getMappedRange?(): ArrayBuffer;
  unmap?(): void;
}
export interface GpuDevice {
  createBuffer(d: { size: number; usage: number; label?: string }): GpuBuffer;
  createShaderModule(d: { code: string; label?: string }): any;
  createComputePipeline(d: any): any;
  createBindGroup(d: any): any;
  createCommandEncoder(): any;
  createTexture?(d: any): any;
  createBindGroupLayout?(d: any): any;
  createPipelineLayout?(d: any): any;
  queue: { writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBufferLike, dataOffset?: number, size?: number): void; submit(c: any[]): void; onSubmittedWorkDone?(): Promise<void> };
  /** Settles when the device is lost. */
  lost?: Promise<unknown>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** GPUBufferUsage flags. */
export const BUFFER = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, VERTEX: 0x0020 } as const;

/** GPUShaderStage.COMPUTE. */
const COMPUTE = 0x4;

/** Makes a buffer of `size` bytes that kernels read and write (STORAGE | COPY_DST | COPY_SRC, and whatever the renderer adds). */
export type BufferFactory = (size: number, label: string) => GpuBuffer;

/** The default factory: a plain storage buffer on `device`, with `extraUsage` (such as `BUFFER.VERTEX`). */
export function storageBufferFactory(device: GpuDevice, extraUsage = 0): BufferFactory {
  return (size, label) => device.createBuffer({ size, usage: BUFFER.STORAGE | BUFFER.COPY_DST | BUFFER.COPY_SRC | extraUsage, label });
}

/**
 * What a binding holds: `read` a read-only storage buffer (`var<storage, read>`), `storage` a
 * read-write one (`var<storage, read_write>`, atomics too), `texture` an unfilterable float texture
 * (`texture_2d<f32>`, read with `textureLoad`).
 */
export type GpuBindingKind = "read" | "storage" | "texture";

export interface GpuBinding {
  binding: number;
  kind: GpuBindingKind;
}

export interface GpuKernelSpec {
  /** Labels the module and pipelines (`label`, then `label entry` for entry points other than `main`). */
  label: string;
  /** The WGSL module. */
  code: string;
  /** Its compute entry points (`main` first, by convention). */
  entryPoints: readonly string[];
  /** Every binding of group 0, so a kernel that doesn't read one still gets it ("auto" layouts drop them). */
  bindings: readonly GpuBinding[];
  /** `@workgroup_size` of every entry point. */
  workgroup: number;
}

/** A resource at a binding: a buffer, or a texture view. */
export interface GpuResource {
  binding: number;
  buffer?: GpuBuffer;
  view?: unknown;
}

/** One dispatch: an entry point over `items` items. */
export interface GpuDispatch {
  entry: string;
  items: number;
}

/** The bind group layout entries for `bindings` (pure: the plan the kernel hands the device). */
export function bindGroupLayoutEntries(bindings: readonly GpuBinding[]): unknown[] {
  return bindings.map(({ binding, kind }) =>
    kind === "texture"
      ? { binding, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } }
      : { binding, visibility: COMPUTE, buffer: { type: kind === "read" ? "read-only-storage" : "storage" } },
  );
}

/** What kernels with the same spec on one device share: the module, layout and pipelines. */
interface CompiledKernel {
  readonly ready: Promise<string[]>;
  readonly layout: unknown;
  readonly pipelines: ReadonlyMap<string, unknown>;
}

/** Compiled kernels per device, by spec (many kernels of one spec, such as one skinning kernel per mesh, compile once). */
const compiled = new WeakMap<GpuDevice, Map<string, CompiledKernel>>();

function compile(device: GpuDevice, spec: GpuKernelSpec): CompiledKernel {
  let byKey = compiled.get(device);
  if (!byKey) compiled.set(device, (byKey = new Map()));
  const key = JSON.stringify([spec.label, spec.code, spec.entryPoints, spec.bindings, spec.workgroup]);
  let c = byKey.get(key);
  if (c) return c;
  const module = device.createShaderModule({ code: spec.code, label: spec.label });
  const ready: Promise<string[]> =
    typeof module.getCompilationInfo === "function"
      ? module.getCompilationInfo().then((info: { messages: { type: string; message: string; lineNum: number }[] }) => info.messages.filter((m) => m.type === "error").map((m) => `${m.lineNum}: ${m.message}`))
      : Promise.resolve([]);
  const layout = device.createBindGroupLayout!({ entries: bindGroupLayoutEntries(spec.bindings) });
  const pipelineLayout = device.createPipelineLayout!({ bindGroupLayouts: [layout] });
  const pipelines = new Map<string, unknown>();
  for (const entry of spec.entryPoints) {
    pipelines.set(entry, device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: entry }, label: entry === "main" ? spec.label : `${spec.label} ${entry}` }));
  }
  c = { ready, layout, pipelines };
  byKey.set(key, c);
  return c;
}

/**
 * Records several kernels' dispatches into one compute pass of one command encoder, submitted once
 * (`submit`): a frame's many small kernels (one skinning kernel per mesh) cost one submit, not one each.
 * The pass opens at the first dispatch; a pipeline or bind group already set isn't set again. Queue
 * writes made before `submit` (`writeBuffer`) are seen by every dispatch of the batch.
 */
export class GpuComputeBatch {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private encoder: any = null;
  private pass: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  private pipeline: unknown = null;
  private group: unknown = null;

  constructor(private readonly device: GpuDevice) {}

  /** Whether dispatches wait for `submit`. */
  get pending(): boolean {
    return this.pass !== null;
  }

  /** Record one dispatch of `x` × `y` workgroups of `pipeline` with `group` at group 0. */
  dispatch(pipeline: unknown, group: unknown, x: number, y: number): void {
    if (!this.pass) {
      this.encoder = this.device.createCommandEncoder();
      this.pass = this.encoder.beginComputePass();
      this.pipeline = this.group = null;
    }
    if (pipeline !== this.pipeline) {
      this.pass.setPipeline(pipeline);
      this.pipeline = pipeline;
    }
    if (group !== this.group) {
      this.pass.setBindGroup(0, group);
      this.group = group;
    }
    this.pass.dispatchWorkgroups(x, y);
  }

  /** End the pass and submit it (nothing when nothing was recorded). */
  submit(): void {
    if (!this.pass) return;
    this.pass.end();
    this.device.queue.submit([this.encoder.finish()]);
    this.pass = this.encoder = this.pipeline = this.group = null;
  }
}

export class GpuKernel {
  /** Shader compile errors (`line: message`), if the device reports any. */
  readonly ready: Promise<string[]>;
  private readonly layout: unknown;
  private readonly pipelines: ReadonlyMap<string, unknown>;
  private readonly groups = new Map<string, unknown>();
  private isLost = false;

  constructor(
    private readonly device: GpuDevice,
    readonly spec: GpuKernelSpec,
  ) {
    const c = compile(device, spec);
    this.ready = c.ready;
    this.layout = c.layout;
    this.pipelines = c.pipelines;
    device.lost?.then(() => {
      this.isLost = true;
    });
  }

  /** Whether the device was lost (dispatches do nothing). */
  get lost(): boolean {
    return this.isLost;
  }

  /** The bind group for `key`, made from `resources()` the first time (keys name what's bound: the ping-pong index, a parent's…). */
  group(key: string, resources: () => readonly GpuResource[]): unknown {
    let g = this.groups.get(key);
    if (!g) {
      const entries = resources().map((r) => ({ binding: r.binding, resource: r.buffer ? { buffer: r.buffer } : r.view }));
      g = this.device.createBindGroup({ layout: this.layout, entries });
      this.groups.set(key, g);
    }
    return g;
  }

  /** Forget the cached bind groups (a bound buffer or view was replaced: a resize, a new depth texture). */
  invalidate(): void {
    this.groups.clear();
  }

  /**
   * Run `dispatches` in order in one compute pass with `group` bound (a later dispatch sees an earlier
   * one's writes), then `after` records more on the encoder (copies for a readback), and submit.
   * Dispatches over no items are skipped.
   */
  dispatch(group: unknown, dispatches: readonly GpuDispatch[], after?: (encoder: { copyBufferToBuffer(...a: unknown[]): void }) => void): void {
    if (this.isLost) return;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (const d of dispatches) {
      const [x, y] = dispatchGroups(d.items, this.spec.workgroup);
      if (x === 0) continue;
      pass.setPipeline(this.pipelines.get(d.entry));
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x, y);
    }
    pass.end();
    after?.(enc);
    this.device.queue.submit([enc.finish()]);
  }

  /** Record `dispatches` with `group` bound into `batch` (one pass for many kernels; `batch.submit()` submits). */
  record(batch: GpuComputeBatch, group: unknown, dispatches: readonly GpuDispatch[]): void {
    if (this.isLost) return;
    for (const d of dispatches) {
      const [x, y] = dispatchGroups(d.items, this.spec.workgroup);
      if (x !== 0) batch.dispatch(this.pipelines.get(d.entry), group, x, y);
    }
  }

  dispose(): void {
    this.groups.clear();
  }
}

/**
 * Reads a small buffer back without waiting: `record` copies it into a free staging buffer (one of
 * `slots`) on an encoder, `resolve` maps that one after submit and hands its bytes over a frame or two
 * later. While every staging buffer is in flight, `record` returns -1 and the frame isn't read.
 */
export class GpuReadback {
  private readonly staging: GpuBuffer[];
  private readonly busy: boolean[];
  private disposed = false;

  constructor(
    device: GpuDevice,
    readonly bytes: number,
    label: string,
    slots = 2,
  ) {
    this.staging = Array.from({ length: slots }, (_, i) => device.createBuffer({ size: bytes, usage: BUFFER.MAP_READ | BUFFER.COPY_DST, label: `${label} ${i}` }));
    this.busy = this.staging.map(() => false);
  }

  /** Copy `source` into a free staging buffer on `encoder`; the slot to `resolve`, or -1 when none is free. */
  record(encoder: { copyBufferToBuffer(...a: unknown[]): void }, source: GpuBuffer): number {
    const slot = this.busy.indexOf(false);
    if (slot >= 0) encoder.copyBufferToBuffer(source, 0, this.staging[slot], 0, this.bytes);
    return slot;
  }

  /** After the submit that recorded `slot`: map it and call `done` with its bytes (not after `dispose`). */
  resolve(slot: number, done: (data: ArrayBuffer) => void): void {
    const staging = this.staging[slot];
    if (!staging?.mapAsync) return;
    this.busy[slot] = true;
    staging.mapAsync(1).then(
      () => {
        if (!this.disposed) done(staging.getMappedRange!().slice(0, this.bytes));
        staging.unmap!();
        this.busy[slot] = false;
      },
      () => {
        this.busy[slot] = false;
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.staging) b.destroy();
  }
}

/** Reads `bytes` of `source` back now (copy, submit, map; slow: tools and tests). */
export async function readBuffer(device: GpuDevice, source: GpuBuffer, bytes: number, label: string): Promise<Float32Array> {
  const staging = device.createBuffer({ size: bytes, usage: BUFFER.MAP_READ | BUFFER.COPY_DST, label });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(source, 0, staging, 0, bytes);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync!(1);
  const out = new Float32Array(staging.getMappedRange!().slice(0));
  staging.unmap!();
  staging.destroy();
  return out;
}
