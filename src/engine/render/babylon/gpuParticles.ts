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
import { BUFFER, WebGpuRun, type GpuBuffer, type GpuDevice } from "../particles/gpu/webgpuRun";
import { hasSceneFrame, requestSceneDepth, sceneDepth } from "./frameGraph";
import { particleAlphaIndex } from "./particleMeshes";

/** What a draw binds each frame: the run's latest state, uniforms and look-up table. */
interface DrawSource {
  bind(mat: ShaderMaterial): void;
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

  constructor(engine: AbstractEngine, device: GpuDevice, kernel: KernelSystem, depth: SceneDepth) {
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
    );
  }
  step(u: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    this.run.step(u, lut, parent instanceof WebGpuBabylonRun ? parent.run : null);
  }
  bind(mat: ShaderMaterial): void {
    mat.setStorageBuffer("ks", this.wrappers.get(this.run.current())!);
    mat.setStorageBuffer("ku", this.wrappers.get(this.run.uniforms)!);
    mat.setStorageBuffer("kl", this.wrappers.get(this.run.lut)!);
  }
  clear(): void {
    this.run.clear();
  }
  dispose(): void {
    for (const sb of this.wrappers.values()) sb.dispose();
    this.wrappers.clear();
  }
}

class WebGl2BabylonRun implements BabylonRun {
  readonly kind = "webgl2" as const;
  readonly run: WebGl2Run;
  private readonly textures = new Map<WebGLTexture, BaseTexture>();
  private uniforms: number[] = [];

  constructor(
    private readonly engine: AbstractEngine,
    gl: WebGL2RenderingContext,
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
    this.engine.wipeCaches(true); // we changed GL state behind Babylon's back
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
  clear(): void {
    this.run.clear();
  }
  dispose(): void {
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

/** One output of a kernel system: an instanced quad (or model) per particle slot. */
export class KernelDraw {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly soft: boolean;

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
    this.mesh = new Mesh(name, scene);
    const vd = new VertexData();
    if (out.type === "mesh") {
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
    const shaders = webgpu ? wgslDraw(kernel, output, { soft: this.soft }) : glslDraw(kernel, output, { soft: this.soft });
    const uniforms = ["viewProjection", "view", "kcam", "kdraw", "kdraw2", "kdraw3", ...(this.soft ? ["ksoft"] : []), ...(webgpu ? [] : ["ku", "kw"])];
    this.material = new ShaderMaterial(
      `${name} material`,
      scene,
      { vertexSource: shaders.vertex, fragmentSource: shaders.fragment },
      {
        attributes: ["position", "uv"],
        uniforms,
        samplers: webgpu ? ["ktex", ...(this.soft ? ["kdepthTex"] : [])] : ["ktex", "ks0", "ks1", "ks2", "ks3", "kl", ...(this.soft ? ["kdepthTex"] : [])],
        ...(webgpu ? { storageBuffers: ["ks", "ku", "kl"], shaderLanguage: ShaderLanguage.WGSL } : {}),
        needAlphaBlending: true,
      },
    );
    const m = this.material;
    m.backFaceCulling = false;
    m.disableDepthWrite = out.type !== "mesh";
    m.alphaMode = out.settings.blending === "additive" ? Constants.ALPHA_ADD : out.settings.blending === "premultiplied" ? Constants.ALPHA_PREMULTIPLIED : Constants.ALPHA_COMBINE;
    m.setTexture("ktex", texture);
    m.setVector4("kdraw", new Vector4(DRAW_MODE[out.type] ?? 0, out.settings.speedScale, out.settings.lengthScale, out.tiles[0]));
    m.setVector4("kdraw2", new Vector4(out.blendTiles ? 1 : 0, opts.softness, out.settings.blending === "premultiplied" ? 1 : 0, 0));
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
    (this.source as BabylonRun).bind(this.material);
    const cam = this.scene.activeCamera;
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
