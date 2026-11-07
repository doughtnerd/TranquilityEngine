// Internal (ADR 0094): the WebGPU compute executor. Runs a kernel's WGSL (`wgslSimulation`) on a raw
// GPUDevice (the Babylon engine's, or any): state in two storage buffers swapped each frame,
// uniforms and the look-up table in two more, one dispatch per frame. Renderer-neutral: the
// Babylon backend passes a buffer factory so its draws can bind the same buffers.
import { KERNEL_FLOATS, LUT_SAMPLES, type KernelSystem } from "../../../scene/particleKernel";
import type { KernelRun } from "./kernelEffect";
import { WORKGROUP, wgslSimulation } from "./kernelShader";

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
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** GPUBufferUsage flags. */
export const BUFFER = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080, VERTEX: 0x0020 } as const;

/** Makes a storage buffer of `size` bytes (STORAGE | COPY_DST | COPY_SRC). */
export type BufferFactory = (size: number, label: string) => GpuBuffer;

/** Holder for the depth texture view a depth-colliding kernel samples. */
export interface DepthViewSource {
  view(): unknown | null;
}

export class WebGpuRun implements KernelRun {
  readonly kind = "webgpu" as const;
  readonly state: [GpuBuffer, GpuBuffer];
  readonly uniforms: GpuBuffer;
  readonly lut: GpuBuffer;
  /** Index of the buffer holding the latest state. */
  cur = 0;
  private readonly pipeline: unknown;
  private readonly layout: unknown;
  private readonly groups = new Map<string, unknown>();
  private readonly zeros: Float32Array;
  private lastDepth: unknown = null;
  /** Shader compile messages, if the device reported any (tests). */
  readonly ready: Promise<string[]>;

  constructor(
    private readonly device: GpuDevice,
    readonly kernel: KernelSystem,
    factory: BufferFactory = (size, label) => device.createBuffer({ size, usage: BUFFER.STORAGE | BUFFER.COPY_DST | BUFFER.COPY_SRC, label }),
    private readonly depth: DepthViewSource | null = null,
  ) {
    const bytes = kernel.capacity * KERNEL_FLOATS * 4;
    this.state = [factory(bytes, `particles ${kernel.name} state 0`), factory(bytes, `particles ${kernel.name} state 1`)];
    this.uniforms = factory(kernel.uniformVec4 * 16, `particles ${kernel.name} uniforms`);
    this.lut = factory(Math.max(1, kernel.luts.length) * LUT_SAMPLES * 16, `particles ${kernel.name} lut`);
    this.zeros = new Float32Array(kernel.capacity * KERNEL_FLOATS);
    const module = device.createShaderModule({ code: wgslSimulation(kernel), label: `particles ${kernel.name}` });
    this.ready = typeof module.getCompilationInfo === "function" ? module.getCompilationInfo().then((info: { messages: { type: string; message: string; lineNum: number }[] }) => info.messages.filter((m) => m.type === "error").map((m) => `${m.lineNum}: ${m.message}`)) : Promise.resolve([]);
    // An explicit layout: "auto" would drop bindings a kernel doesn't read (a system without curves never reads kl).
    const COMPUTE = 0x4;
    const entries: unknown[] = [
      { binding: 0, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
    ];
    if (kernel.event) entries.push({ binding: 4, visibility: COMPUTE, buffer: { type: "read-only-storage" } });
    if (kernel.depth) entries.push({ binding: 5, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } });
    this.layout = device.createBindGroupLayout!({ entries });
    this.pipeline = device.createComputePipeline({ layout: device.createPipelineLayout!({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "main" }, label: `particles ${kernel.name}` });
    this.clear();
  }

  step(uniforms: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    const d = this.device;
    d.queue.writeBuffer(this.uniforms, 0, uniforms.buffer, uniforms.byteOffset, this.kernel.uniformVec4 * 16);
    if (lut) d.queue.writeBuffer(this.lut, 0, lut.buffer, lut.byteOffset, Math.max(1, this.kernel.luts.length) * LUT_SAMPLES * 16);
    const p = parent instanceof WebGpuRun ? parent : null;
    const depthView = this.kernel.depth ? (this.depth?.view() ?? null) : null;
    if (this.kernel.depth && depthView !== this.lastDepth) {
      this.groups.clear();
      this.lastDepth = depthView;
    }
    const key = `${this.cur}|${p ? `${p.cur}` : "-"}`;
    let group = this.groups.get(key);
    if (!group) {
      const entries: { binding: number; resource: unknown }[] = [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: this.state[this.cur] } },
        { binding: 2, resource: { buffer: this.state[1 - this.cur] } },
        { binding: 3, resource: { buffer: this.lut } },
      ];
      if (this.kernel.event) entries.push({ binding: 4, resource: { buffer: p ? p.state[p.cur] : this.state[this.cur] } });
      // Without a depth texture a 1×1 stand-in is bound; the kernel skips collision (ku[depth].z is 0).
      if (this.kernel.depth) entries.push({ binding: 5, resource: depthView ?? this.dummyDepth() });
      group = this.device.createBindGroup({ layout: this.layout, entries });
      this.groups.set(key, group);
    }
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    const n = Math.ceil(this.kernel.capacity / WORKGROUP);
    const x = Math.min(n, 65535);
    pass.dispatchWorkgroups(x, Math.ceil(n / x));
    pass.end();
    d.queue.submit([enc.finish()]);
    this.cur = 1 - this.cur;
  }

  private dummyView: unknown = null;
  private dummyDepth(): unknown {
    this.dummyView ??= this.device.createTexture!({ size: [1, 1], format: "r32float", usage: 0x04 }).createView();
    return this.dummyView;
  }

  /** The buffer the latest state is in (draws bind it). */
  current(): GpuBuffer {
    return this.state[this.cur];
  }

  clear(): void {
    for (const b of this.state) this.device.queue.writeBuffer(b, 0, this.zeros.buffer, 0, this.zeros.byteLength);
  }

  /** Read the latest state back (tests and tools; slow). */
  async read(): Promise<Float32Array> {
    const bytes = this.kernel.capacity * KERNEL_FLOATS * 4;
    const staging = this.device.createBuffer({ size: bytes, usage: BUFFER.MAP_READ | BUFFER.COPY_DST, label: "particles readback" });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.current(), 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync!(1);
    const out = new Float32Array(staging.getMappedRange!().slice(0));
    staging.unmap!();
    staging.destroy();
    return out;
  }

  dispose(): void {
    for (const b of this.state) b.destroy();
    this.uniforms.destroy();
    this.lut.destroy();
    this.groups.clear();
  }
}
