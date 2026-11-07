// Internal (ADR 0094): kernel particle systems on the Babylon backend. Makes runs on Babylon's own
// device or context (WebGPU compute, WebGL2 textures, or the JavaScript executor with an upload) and
// draws each output as one instanced mesh whose vertex shader reads the particle state: no copy back
// to the CPU. Babylon types stay in this folder (ADR 0010).
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture.js";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer.js";
import "@babylonjs/core/Rendering/depthRendererSceneComponent.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ModelMesh } from "../../scene/models";
import { KERNEL_FLOATS, LUT_SAMPLES, type KernelExecutor, type KernelSystem } from "../../scene/particleKernel";
import { JsRun, type KernelDepth, type KernelHost, type KernelRun } from "../particles/gpu/kernelEffect";
import { DRAW_MODE, glslDraw, wgslDraw } from "../particles/gpu/kernelShader";
import { STATE_WIDTH, WebGl2Run, supportsTextureKernels } from "../particles/gpu/webgl2Run";
import { WebGl2Sorter, WebGpuSorter, depthRow, sortLayout, sortPairsJs } from "../particles/gpu/sort";
import { outputSorts } from "../../scene/particleGraph";
import { heightFogShader, useHeightFog } from "./heightFog";
import { BUFFER, WebGpuRun, type GpuBuffer, type GpuDevice } from "../particles/gpu/webgpuRun";
import { hasSceneFrame, requestSceneDepth, sceneDepth } from "./frameGraph";
import { particleAlphaIndex } from "./particleMeshes";

/** What a draw binds each frame: the run's latest state, uniforms and look-up table. */
interface DrawSource {
  bind(mat: ShaderMaterial): void;
  /** Sort the latest state back to front by `row` (ADR 0126; `depthRow`), once per frame. */
  sort(row: readonly number[]): void;
  /** Bind the sorted pairs (`kidx`) for a sorted draw. */
  bindSort(mat: ShaderMaterial): void;
  /** Bind the trail history (`khist`) for a trail draw (ADR 0126). */
  bindTrail(mat: ShaderMaterial): void;
  /** The uniforms of the last step (the node's matrix and space, for `depthRow`). */
  readonly lastUniforms: Float32Array<ArrayBufferLike>;
}

type BabylonRun = KernelRun & DrawSource;

const deviceOf = (engine: AbstractEngine): GpuDevice | null => (engine.isWebGPU ? ((engine as unknown as { _device?: GpuDevice })._device ?? null) : null);
const glOf = (engine: AbstractEngine): WebGL2RenderingContext | null => {
  const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
  return !engine.isWebGPU && gl && typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? gl : null;
};

/** Kernel executors the engine can run, best first (ADR 0094's fallback order). */
export function kernelExecutors(engine: AbstractEngine): KernelExecutor[] {
  if (deviceOf(engine)) return ["webgpu", "js"];
  const gl = glOf(engine);
  if (gl && supportsTextureKernels(gl)) return ["webgl2", "js"];
  return ["js"];
}

/**
 * The scene's depth for soft particles and depth collision (ADR 0096). In a World it is the frame
 * graph's shared scene depth (ADR 0109: the geometry pass's linear view depth, requested once and
 * fetched each frame); scenes no frame graph draws (the Particle Graph preview, benchmarks) fall back
 * to Babylon's depth renderer storing camera-space Z. Both hold linear view depth, which the shaders
 * compare with as |z| (0 is "nothing drawn").
 */
export class SceneDepth {
  private release: (() => void) | null = null;
  private renderer: DepthRenderer | null = null;
  private camera: Camera | null = null;
  private readonly wrapped = new WeakMap<InternalTexture, BaseTexture>();
  constructor(private readonly scene: Scene) {}

  /** The depth texture's internal texture for `camera` (default: the active one), asking for it on first use. */
  internal(camera: Camera | null = this.scene.activeCamera): InternalTexture | null {
    if (!camera) return null;
    if (hasSceneFrame(this.scene)) {
      this.release ??= requestSceneDepth(this.scene, this);
      return camera instanceof TargetCamera ? (sceneDepth(this.scene, camera)?.internal ?? null) : null;
    }
    if (!this.renderer || this.camera !== camera) {
      if (this.renderer) this.scene.disableDepthRenderer(this.camera ?? undefined);
      // storeCameraSpaceZ: the texture holds camera-space z, as the shared scene depth does.
      this.renderer = this.scene.enableDepthRenderer(camera, false, true, Constants.TEXTURE_NEAREST_SAMPLINGMODE, true);
      this.renderer.clearColor = new Color4(0, 0, 0, 0);
      this.camera = camera;
    }
    return this.renderer.getDepthMap().getInternalTexture();
  }

  /** The depth as a texture a material can bind (cached per internal texture). */
  map(camera: Camera | null = this.scene.activeCamera): BaseTexture | null {
    const internal = this.internal(camera);
    if (!internal) return null;
    let t = this.wrapped.get(internal);
    if (!t) {
      t = new BaseTexture(this.scene.getEngine(), internal);
      this.wrapped.set(internal, t);
    }
    return t;
  }

  /** Camera data for the kernels' depth collision. */
  info(): KernelDepth | null {
    const cam = this.scene.activeCamera;
    const internal = this.internal(cam);
    if (!internal || !cam) return null;
    const view = cam.getViewMatrix().m;
    return {
      viewProj: cam.getTransformationMatrix().m,
      viewZ: [view[2], view[6], view[10], view[14]],
      width: internal.width,
      height: internal.height,
      near: cam.minZ,
      far: cam.maxZ,
    };
  }

  dispose(): void {
    this.release?.();
    this.release = null;
    if (this.renderer) this.scene.disableDepthRenderer(this.camera ?? undefined);
    this.renderer = null;
  }
}

/** Makes kernel runs on a Babylon engine. */
export class BabylonKernelHost implements KernelHost {
  readonly executors: readonly KernelExecutor[];
  private readonly engine: AbstractEngine;

  constructor(
    private readonly scene: Scene,
    private readonly sceneDepth: SceneDepth,
    /** Force an executor list (tests, benchmarks). */
    executors?: readonly KernelExecutor[],
  ) {
    this.engine = scene.getEngine();
    this.executors = executors ?? kernelExecutors(this.engine);
  }

  depth(): KernelDepth | null {
    return this.sceneDepth.info();
  }

  createRun(kernel: KernelSystem, kind: KernelExecutor): BabylonRun {
    const device = deviceOf(this.engine);
    const gl = glOf(this.engine);
    if (kind === "webgpu" && device) return new WebGpuBabylonRun(this.engine, device, kernel, this.sceneDepth);
    if (kind === "webgl2" && gl) return new WebGl2BabylonRun(this.engine, gl, kernel, this.sceneDepth);
    return new JsBabylonRun(this.scene, kernel);
  }
}

// --- runs ---------------------------------------------------------------------------------------------------

class WebGpuBabylonRun implements BabylonRun {
  readonly kind = "webgpu" as const;
  readonly run: WebGpuRun;
  private readonly wrappers = new Map<GpuBuffer, StorageBuffer>();
  lastUniforms: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private sorter: WebGpuSorter | null = null;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly device: GpuDevice,
    kernel: KernelSystem,
    depth: SceneDepth,
  ) {
    this.run = new WebGpuRun(
      device,
      kernel,
      (size, label) => {
        const sb = new StorageBuffer(engine as never, size, Constants.BUFFER_CREATIONFLAG_READWRITE, label);
        const gpu = (sb.getBuffer().underlyingResource ?? null) as GpuBuffer;
        this.wrappers.set(gpu, sb);
        return gpu;
      },
      {
        view: () => {
          const t = kernel.depth ? depth.internal() : null;
          return (t?._hardwareTexture as { view?: unknown } | null | undefined)?.view ?? null;
        },
      },
      { deadList: true },
    );
  }
  get alive(): number | null {
    return this.run.alive;
  }
  step(u: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    this.run.step(u, lut, parent instanceof WebGpuBabylonRun ? parent.run : null);
    this.lastUniforms = u;
  }
  bind(mat: ShaderMaterial): void {
    mat.setStorageBuffer("ks", this.wrappers.get(this.run.current())!);
    mat.setStorageBuffer("ku", this.wrappers.get(this.run.uniforms)!);
    mat.setStorageBuffer("kl", this.wrappers.get(this.run.lut)!);
  }
  sort(row: readonly number[]): void {
    this.sorter ??= new WebGpuSorter(this.device, this.run.kernel.capacity, (size, label) => {
      const sb = new StorageBuffer(this.engine as never, size, Constants.BUFFER_CREATIONFLAG_READWRITE, label);
      const gpu = (sb.getBuffer().underlyingResource ?? null) as GpuBuffer;
      this.wrappers.set(gpu, sb);
      return gpu;
    });
    this.sorter.sort(this.run.current(), row);
  }
  bindSort(mat: ShaderMaterial): void {
    const pairs = this.sorter && this.wrappers.get(this.sorter.pairs);
    if (pairs) mat.setStorageBuffer("kidx", pairs);
  }
  bindTrail(mat: ShaderMaterial): void {
    const h = this.run.history && this.wrappers.get(this.run.history);
    if (h) mat.setStorageBuffer("khist", h);
  }
  clear(): void {
    this.run.clear();
  }
  dispose(): void {
    this.sorter?.dispose();
    for (const sb of this.wrappers.values()) sb.dispose();
    this.wrappers.clear();
  }
}

class WebGl2BabylonRun implements BabylonRun {
  readonly kind = "webgl2" as const;
  readonly run: WebGl2Run;
  private readonly textures = new Map<WebGLTexture, BaseTexture>();
  private uniforms: number[] = [];
  lastUniforms: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private sorter: WebGl2Sorter | null = null;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly gl: WebGL2RenderingContext,
    kernel: KernelSystem,
    depth: SceneDepth,
  ) {
    this.run = new WebGl2Run(gl, kernel, () => {
      const t = kernel.depth ? depth.internal() : null;
      return ((t?._hardwareTexture?.underlyingResource ?? null) as WebGLTexture | null) ?? null;
    });
    if (this.run.errors.length) console.error(`[myco] particle kernel "${kernel.name}" didn't compile for WebGL2:\n${this.run.errors.join("\n")}`);
    engine.wipeCaches(true);
  }
  step(u: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    this.run.step(u, lut, parent instanceof WebGl2BabylonRun ? parent.run : null);
    this.uniforms = Array.from(u.subarray(0, this.run.kernel.uniformVec4 * 4));
    this.lastUniforms = u;
    this.engine.wipeCaches(true); // we changed GL state behind Babylon's back
  }
  sort(row: readonly number[]): void {
    if (!this.sorter) {
      this.sorter = new WebGl2Sorter(this.gl, this.run.kernel.capacity);
      if (this.sorter.errors.length) console.error(`[myco] particle sort didn't compile for WebGL2:\n${this.sorter.errors.join("\n")}`);
    }
    const cur = this.run.current();
    this.sorter.sort(cur[0], cur[1], this.run.width, row);
    this.engine.wipeCaches(true);
  }
  bindSort(mat: ShaderMaterial): void {
    const s = this.sorter;
    if (!s) return;
    mat.setTexture("kidx", this.wrap(s.current, s.layout.width, s.layout.height));
    mat.setFloat("kidxW", s.layout.width);
  }
  bindTrail(mat: ShaderMaterial): void {
    const h = this.run.history;
    if (h) mat.setTexture("khist", this.wrap(h.texture, this.run.width, this.run.height * (this.run.kernel.trail ?? 1)));
  }
  private wrap(t: WebGLTexture, w: number, h: number): BaseTexture {
    let b = this.textures.get(t);
    if (!b) {
      const internal = (this.engine as unknown as { wrapWebGLTexture(t: WebGLTexture, mip: boolean, s: number, w: number, h: number): never }).wrapWebGLTexture(t, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, w, h);
      b = new BaseTexture(this.engine, internal);
      this.textures.set(t, b);
    }
    return b;
  }
  bind(mat: ShaderMaterial): void {
    const r = this.run;
    r.current().forEach((t, i) => mat.setTexture(`ks${i}`, this.wrap(t, r.width, r.height)));
    mat.setTexture("kl", this.wrap(r.lutTexture, LUT_SAMPLES, Math.max(1, r.kernel.luts.length)));
    mat.setFloat("kw", r.width);
    if (this.uniforms.length) mat.setArray4("ku", this.uniforms);
  }
  clear(): void {
    this.run.clear();
    this.engine.wipeCaches(true);
  }
  dispose(): void {
    for (const b of this.textures.values()) b.dispose();
    this.textures.clear();
    this.sorter?.dispose();
    this.run.dispose();
  }
}

/** The JavaScript executor, with its state uploaded each frame for the draws. */
class JsBabylonRun implements BabylonRun {
  readonly kind = "js" as const;
  readonly run: JsRun;
  private readonly webgpu: boolean;
  private buffers: { ks: StorageBuffer; ku: StorageBuffer; kl: StorageBuffer } | null = null;
  private textures: RawTexture[] = [];
  private lutTexture: RawTexture | null = null;
  private planes: Float32Array[] = [];
  private uniforms: number[] = [];
  private readonly width: number;
  private readonly height: number;
  private lutDirty = true;
  private sortPairs: Float32Array | null = null;
  private sortBuffer: StorageBuffer | null = null;
  private sortTexture: RawTexture | null = null;
  private sortTexels: Float32Array | null = null;
  private histBuffer: StorageBuffer | null = null;
  private histTexture: RawTexture | null = null;
  private histTexels: Float32Array | null = null;
  private histFrame = -1;
  get lastUniforms(): Float32Array {
    return this.run.js.uniforms;
  }

  constructor(
    private readonly scene: Scene,
    readonly kernel: KernelSystem,
  ) {
    this.run = new JsRun(kernel);
    const engine = scene.getEngine();
    this.webgpu = engine.isWebGPU;
    this.width = Math.min(STATE_WIDTH, kernel.capacity);
    this.height = Math.ceil(kernel.capacity / this.width);
    if (this.webgpu) {
      const e = engine as never;
      this.buffers = {
        ks: new StorageBuffer(e, kernel.capacity * KERNEL_FLOATS * 4, Constants.BUFFER_CREATIONFLAG_READWRITE, "particles js state"),
        ku: new StorageBuffer(e, kernel.uniformVec4 * 16, Constants.BUFFER_CREATIONFLAG_READWRITE, "particles js uniforms"),
        kl: new StorageBuffer(e, Math.max(1, kernel.luts.length) * LUT_SAMPLES * 16, Constants.BUFFER_CREATIONFLAG_READWRITE, "particles js lut"),
      };
    } else {
      const n = this.width * this.height * 4;
      this.planes = [0, 1, 2, 3].map(() => new Float32Array(n));
      this.textures = this.planes.map((p) => RawTexture.CreateRGBATexture(p, this.width, this.height, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT));
      this.lutTexture = RawTexture.CreateRGBATexture(this.run.js.lut, LUT_SAMPLES, Math.max(1, kernel.luts.length), scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    }
  }
  get alive(): number {
    return this.run.alive;
  }
  step(u: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    this.run.step(u, lut, parent instanceof JsBabylonRun ? parent.run : null);
    if (lut) this.lutDirty = true;
    const s = this.run.js.state;
    if (this.buffers) {
      this.buffers.ks.update(s);
      this.buffers.ku.update(this.run.js.uniforms);
      if (this.lutDirty) this.buffers.kl.update(this.run.js.lut);
    } else {
      const cap = this.kernel.capacity;
      for (let a = 0; a < 4; a++) {
        const p = this.planes[a];
        for (let i = 0; i < cap; i++) {
          const o = i * KERNEL_FLOATS + a * 4;
          p[i * 4] = s[o];
          p[i * 4 + 1] = s[o + 1];
          p[i * 4 + 2] = s[o + 2];
          p[i * 4 + 3] = s[o + 3];
        }
        this.textures[a].update(p);
      }
      if (this.lutDirty) this.lutTexture?.update(this.run.js.lut);
      this.uniforms = Array.from(this.run.js.uniforms);
    }
    this.lutDirty = false;
  }
  bind(mat: ShaderMaterial): void {
    if (this.buffers) {
      mat.setStorageBuffer("ks", this.buffers.ks);
      mat.setStorageBuffer("ku", this.buffers.ku);
      mat.setStorageBuffer("kl", this.buffers.kl);
      return;
    }
    this.textures.forEach((t, i) => mat.setTexture(`ks${i}`, t));
    if (this.lutTexture) mat.setTexture("kl", this.lutTexture);
    mat.setFloat("kw", this.width);
    if (this.uniforms.length) mat.setArray4("ku", this.uniforms);
  }
  sort(row: readonly number[]): void {
    const layout = sortLayout(this.kernel.capacity);
    this.sortPairs ??= new Float32Array(layout.n * 2);
    sortPairsJs(this.run.js.state, this.kernel.capacity, row, this.sortPairs, layout);
    if (this.webgpu) {
      this.sortBuffer ??= new StorageBuffer(this.scene.getEngine() as never, layout.n * 8, Constants.BUFFER_CREATIONFLAG_READWRITE, "particles js sort");
      this.sortBuffer.update(this.sortPairs);
      return;
    }
    const texels = (this.sortTexels ??= new Float32Array(layout.n * 4));
    for (let i = 0; i < layout.n; i++) {
      texels[i * 4] = this.sortPairs[i * 2];
      texels[i * 4 + 1] = this.sortPairs[i * 2 + 1];
    }
    if (!this.sortTexture) this.sortTexture = RawTexture.CreateRGBATexture(texels, layout.width, layout.height, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    else this.sortTexture.update(texels);
  }
  bindTrail(mat: ShaderMaterial): void {
    const h = this.run.js.history;
    if (!h) return;
    const frame = this.run.js.uniforms[1 * 4 + 3];
    if (this.webgpu) {
      this.histBuffer ??= new StorageBuffer(this.scene.getEngine() as never, h.byteLength, Constants.BUFFER_CREATIONFLAG_READWRITE, "particles js trail");
      if (this.histFrame !== frame) this.histBuffer.update(h);
      this.histFrame = frame;
      mat.setStorageBuffer("khist", this.histBuffer);
      return;
    }
    // The GLSL draw reads the history as blocks of the state texture's layout.
    const cap = this.kernel.capacity;
    const points = this.kernel.trail ?? 1;
    const w = this.width;
    const rows = this.height;
    const texels = (this.histTexels ??= new Float32Array(w * rows * points * 4));
    if (this.histFrame !== frame) {
      for (let b = 0; b < points; b++) for (let i = 0; i < cap; i++) texels.set(h.subarray((b * cap + i) * 4, (b * cap + i) * 4 + 4), ((b * rows + Math.floor(i / w)) * w + (i % w)) * 4);
      if (!this.histTexture) this.histTexture = RawTexture.CreateRGBATexture(texels, w, rows * points, this.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
      else this.histTexture.update(texels);
    }
    this.histFrame = frame;
    if (this.histTexture) mat.setTexture("khist", this.histTexture);
  }
  bindSort(mat: ShaderMaterial): void {
    if (this.sortBuffer) mat.setStorageBuffer("kidx", this.sortBuffer);
    if (this.sortTexture) {
      mat.setTexture("kidx", this.sortTexture);
      mat.setFloat("kidxW", sortLayout(this.kernel.capacity).width);
    }
  }
  clear(): void {
    this.run.clear();
  }
  dispose(): void {
    this.histBuffer?.dispose();
    this.histTexture?.dispose();
    this.sortBuffer?.dispose();
    this.sortTexture?.dispose();
    if (this.buffers) for (const b of Object.values(this.buffers)) b.dispose();
    for (const t of this.textures) t.dispose();
    this.lutTexture?.dispose();
    void this.scene;
  }
}

// --- drawing ------------------------------------------------------------------------------------------------

export interface KernelDrawOptions {
  /** The model mesh of a mesh output (else a cube). */
  mesh?: ModelMesh;
  /** Soft particles: fade over this many metres in front of surfaces (0: off). */
  softness: number;
}

/** The frame each run was last sorted in (several sorted outputs of one system share the sort). */
const sortedAt = new WeakMap<object, number>();

/** The camera view matrix's z row: a point's view depth is `dot(row.xyz, p) + row.w`. */
function viewZRow(cam: Camera): [number, number, number, number] {
  const m = cam.getViewMatrix().m;
  return [m[2], m[6], m[10], m[14]];
}

/** One output of a kernel system: an instanced quad (or model) per particle slot. */
export class KernelDraw {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly soft: boolean;
  /** Drawn back to front (ADR 0126: `sort`, auto for alpha blending). */
  readonly sorted: boolean;
  /** A trail output (ADR 0126): a ribbon through each particle's history. */
  readonly trail: boolean;

  constructor(
    private readonly scene: Scene,
    name: string,
    readonly kernel: KernelSystem,
    readonly output: number,
    private readonly source: KernelRun,
    texture: BaseTexture,
    private readonly sceneDepth: SceneDepth,
    opts: KernelDrawOptions,
  ) {
    const out = kernel.outputs[output];
    const webgpu = scene.getEngine().isWebGPU;
    this.soft = opts.softness > 0;
    this.sorted = outputSorts(out.settings);
    this.trail = out.type === "trail" && !!kernel.trail && !!out.trail;
    this.mesh = new Mesh(name, scene);
    const vd = new VertexData();
    if (this.trail) {
      // A strip of `points` pairs: position (side ±0.5, point index), V across.
      const points = kernel.trail!;
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      for (let k = 0; k < points; k++) {
        positions.push(-0.5, k, 0, 0.5, k, 0);
        uvs.push(0, 0, 0, 1);
        if (k + 1 < points) {
          const a = k * 2;
          indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
      }
      vd.positions = positions;
      vd.uvs = uvs;
      vd.indices = indices;
    } else if (out.type === "mesh") {
      const m = opts.mesh?.data;
      if (m) {
        vd.positions = Array.from(m.positions);
        vd.indices = Array.from(m.indices);
        vd.uvs = m.uvs ? Array.from(m.uvs) : new Array((m.positions.length / 3) * 2).fill(0);
      } else {
        // A unit cube.
        const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((x) => x * 0.5);
        vd.positions = p;
        vd.indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3];
        vd.uvs = new Array(16).fill(0.5);
      }
    } else {
      vd.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
      vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      vd.indices = [0, 1, 2, 0, 2, 3];
    }
    vd.applyToMesh(this.mesh);
    const fog = heightFogShader(webgpu ? "wgsl" : "glsl");
    const shaderOpts = { soft: this.soft, sorted: this.sorted, fog: fog.decl };
    const shaders = webgpu ? wgslDraw(kernel, output, shaderOpts) : glslDraw(kernel, output, shaderOpts);
    const uniforms = ["viewProjection", "view", "kcam", "kdraw", "kdraw2", "kdraw3", ...(this.trail ? ["ktrail"] : []), ...fog.uniforms, ...(this.soft ? ["ksoft"] : []), ...(webgpu ? [] : ["ku", "kw", ...(this.sorted ? ["kidxW"] : [])])];
    this.material = new ShaderMaterial(
      `${name} material`,
      scene,
      { vertexSource: shaders.vertex, fragmentSource: shaders.fragment },
      {
        attributes: ["position", "uv"],
        uniforms,
        samplers: webgpu ? ["ktex", ...(this.soft ? ["kdepthTex"] : [])] : ["ktex", "ks0", "ks1", "ks2", "ks3", "kl", ...(this.sorted ? ["kidx"] : []), ...(this.trail ? ["khist"] : []), ...(this.soft ? ["kdepthTex"] : [])],
        ...(webgpu ? { storageBuffers: ["ks", "ku", "kl", ...(this.sorted ? ["kidx"] : []), ...(this.trail ? ["khist"] : [])], shaderLanguage: ShaderLanguage.WGSL } : {}),
        defines: [],
        needAlphaBlending: true,
      },
    );
    const m = this.material;
    m.backFaceCulling = false;
    m.disableDepthWrite = out.type !== "mesh";
    m.alphaMode = out.settings.blending === "additive" ? Constants.ALPHA_ADD : out.settings.blending === "premultiplied" ? Constants.ALPHA_PREMULTIPLIED : Constants.ALPHA_COMBINE;
    m.setTexture("ktex", texture);
    m.setVector4("kdraw", new Vector4(DRAW_MODE[out.type] ?? 0, out.settings.speedScale, out.settings.lengthScale, out.tiles[0]));
    m.setVector4("kdraw2", new Vector4(out.blendTiles ? 1 : 0, opts.softness, out.settings.blending === "premultiplied" ? 1 : 0, out.settings.blending === "additive" ? 1 : 0));
    useHeightFog(m, scene);
    m.setVector4("kdraw3", new Vector4(out.tiles[1], 0, 0, 0));
    m.onBindObservable.add(() => {
      const cam = scene.activeCamera;
      const effect = m.getEffect();
      if (!cam || !effect) return;
      effect.setVector3("kcam", cam.globalPosition);
      if (this.soft) {
        // The camera drawing now: each camera has its own depth (ADR 0109).
        const map = this.sceneDepth.map(cam);
        if (map) {
          effect.setTexture("kdepthTex", map);
          const s = map.getSize();
          effect.setFloat4("ksoft", s.width, s.height, 0, 0);
        }
      }
    });
    this.mesh.material = m;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.isPickable = false;
    this.mesh.forcedInstanceCount = kernel.capacity;
    this.mesh.alphaIndex = particleAlphaIndex(out.settings.renderOrder);
    this.mesh.doNotSyncBoundingInfo = true;
  }

  /** Bind this frame's state (ping-pong buffers change every frame). */
  update(): void {
    const src = this.source as BabylonRun;
    src.bind(this.material);
    const cam = this.scene.activeCamera;
    if (this.sorted && cam) {
      // Once a frame per system, for the active camera (split-screen views share its order).
      const frame = this.scene.getFrameId();
      if (sortedAt.get(src) !== frame) {
        sortedAt.set(src, frame);
        src.sort(depthRow(viewZRow(cam), src.lastUniforms, this.scene.useRightHandedSystem));
      }
      src.bindSort(this.material);
    }
    if (this.trail) {
      src.bindTrail(this.material);
      const out = this.kernel.outputs[this.output];
      this.material.setVector4("ktrail", new Vector4(src.lastUniforms[1 * 4 + 3] ?? 0, this.kernel.trail!, 0, out.trail!.widthRow));
    }
    if (cam) this.material.setVector3("kcam", cam.globalPosition ?? Vector3.Zero());
    if (this.soft) {
      // Bound per camera while drawing (onBind); set here too so the material has a texture to compile with.
      const map = this.sceneDepth.map();
      if (map) this.material.setTexture("kdepthTex", map);
    }
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.material.dispose(false, false);
  }
}

/** For tests: the GPU buffer usage flags the WebGPU path needs (storage, written from the CPU). */
export const KERNEL_BUFFER_USAGE = BUFFER.STORAGE | BUFFER.COPY_DST;
