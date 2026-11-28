/**
 * Skinned meshes for the Babylon backend (ADR 0370 "Rendering"; T16): `SkinnedDraws` (`render/skinning`)
 * on Babylon. Each draw is a plain `Mesh` whose position, normal and tangent vertex buffers are the
 * `mycoSkin` kernel's output (48 bytes a vertex, interleaved), so the main pass, shadow maps, depth and
 * every other pass draw the skinned vertices with their own shaders, skinned once a frame. Static
 * attributes (indices, UVs, colours) are ordinary vertex data. Babylon's own skeletons and animations are
 * never used (ADR 0370).
 *
 * The executor follows the engine (best first): WebGPU compute into a Babylon-owned storage buffer with
 * vertex usage; WebGL2 transform feedback into a GL buffer Babylon binds as a vertex buffer; otherwise the
 * kernel's JavaScript into an updatable vertex buffer (also NullEngine). On the GPU paths Babylon has no
 * CPU copy of the skinned vertices: bounds come from the caller (`setBounds`), and triangle picking finds
 * nothing (the editor frames and selects the mesh by its bounds; follow-up in the build log).
 *
 * Nothing here is public (ADR 0010); the Animation plugin's render feature builds it.
 */
import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer.js";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { WebGLDataBuffer } from "@babylonjs/core/Meshes/WebGL/webGLDataBuffer.js";
import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ModelMesh } from "../../scene/models";
import type { SlotRequest } from "../materialResolution";
import type { GpuBuffer, GpuDevice } from "../gpuKernels/webgpu";
import { SKIN_STRIDE } from "../skinning/skinKernel";
import { vertexCount, type SkinnedMeshSource } from "../skinning/skinData";
import type { Box6 } from "../skinning/skinBounds";
import type { SkinnedDraw, SkinnedDraws } from "../skinning/skinnedDraws";
import { FeedbackSkinRuns, JsSkinRuns, WebGpuSkinRuns, type SkinExecutor, type SkinPalette, type SkinRun, type SkinRuns } from "../skinning/skinRuns";
import type { BabylonMaterialLibrary } from "./materialLibrary";

/**
 * @internal What a skinned draw adds over `SkinnedDraw` for its model mesh's LOD levels (ADR 0459 §6): each level is a
 * mesh of its own that shares the draw's skinned and static vertex buffers (so one dispatch skins every level), its
 * bounds and its world matrix. The animation plugin's sync reads it structurally (`SkinnedLevels` in its `sync.ts`).
 */
export interface BabylonSkinnedLevels {
  readonly levelCount: number;
  levelMesh(level: number): Mesh;
  showLevels(mask: number | null): void;
}

/** @internal The mesh a skinned draw is (so a plugin's feature names no Babylon type). */
export type BabylonSkinnedMesh = Mesh;

/** @internal What the skinned-mesh backend takes from the renderer. */
export interface BabylonSkinnedHost {
  readonly scene: Scene;
  /** Materials by slot request (ADR 0089, 0127). */
  readonly materials: Pick<BabylonMaterialLibrary, "slotMaterials">;
  /** Force an executor (default: the best the engine has). */
  readonly executor?: SkinExecutor;
}

const deviceOf = (engine: AbstractEngine): GpuDevice | null => (engine.isWebGPU ? ((engine as unknown as { _device?: GpuDevice })._device ?? null) : null);
const glOf = (engine: AbstractEngine): WebGL2RenderingContext | null => {
  const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
  return !engine.isWebGPU && gl && typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? gl : null;
};

/** @internal The executor skinning uses on `engine`: WebGPU compute, WebGL2 transform feedback, else the CPU. */
export function skinExecutorFor(engine: AbstractEngine): SkinExecutor {
  if (deviceOf(engine)) return "webgpu";
  if (glOf(engine)) return "webgl2";
  return "js";
}

/** The skinned attributes: kind, byte offset in a vertex, floats. */
const SKINNED_KINDS = [
  [VertexBuffer.PositionKind, 0, 3],
  [VertexBuffer.NormalKind, 16, 3],
  [VertexBuffer.TangentKind, 32, 4],
] as const;

/** Whether two slot requests name the same materials (compared field by field: no key string a frame). */
const sameRequest = (a: SlotRequest, b: SlotRequest): boolean => {
  if (a.mesh !== b.mesh || a.material !== b.material) return false;
  const x = a.materials ?? [];
  const y = b.materials ?? [];
  if (x === y) return true;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

const boundsMin = new Vector3();
const boundsMax = new Vector3();

/** @internal Skinned meshes drawn by Babylon. */
export class BabylonSkinnedMeshes implements SkinnedDraws<Mesh> {
  readonly executor: SkinExecutor;
  private readonly runs: SkinRuns<unknown>;
  private readonly engine: AbstractEngine;
  /** WebGPU: the Babylon storage buffer around each run output (its draws bind it). */
  private readonly wrappers = new Map<GpuBuffer, StorageBuffer>();
  private readonly draws = new Set<BabylonSkinnedDraw>();
  private dispatched = false;

  constructor(private readonly host: BabylonSkinnedHost) {
    this.engine = host.scene.getEngine();
    const executor = host.executor ?? skinExecutorFor(this.engine);
    const device = executor === "webgpu" ? deviceOf(this.engine) : null;
    const gl = executor === "webgl2" ? glOf(this.engine) : null;
    if (device) {
      this.runs = new WebGpuSkinRuns(device, (size, label) => {
        const sb = new StorageBuffer(this.engine as never, size, Constants.BUFFER_CREATIONFLAG_VERTEX | Constants.BUFFER_CREATIONFLAG_READWRITE, label);
        const gpu = sb.getBuffer().underlyingResource as GpuBuffer;
        this.wrappers.set(gpu, sb);
        return gpu;
      }) as SkinRuns<unknown>;
      this.executor = "webgpu";
    } else if (gl) {
      this.runs = new FeedbackSkinRuns(gl) as SkinRuns<unknown>;
      this.executor = "webgl2";
    } else {
      this.runs = new JsSkinRuns() as SkinRuns<unknown>;
      this.executor = "js";
    }
  }

  palette(label: string): SkinPalette {
    return this.runs.palette(label);
  }

  create(source: SkinnedMeshSource, name: string): SkinnedDraw<Mesh> {
    const run = this.runs.run(source.geometry);
    const draw = new BabylonSkinnedDraw(this, source, name, run);
    this.draws.add(draw);
    return draw;
  }

  endDispatches(): void {
    // WebGPU: one submit for the frame's dispatches; WebGL2: the passes' shared state restored.
    this.runs.flush();
    // WebGL2 passes changed GL state behind Babylon's back.
    if (this.dispatched && this.executor === "webgl2") this.engine.wipeCaches(true);
    this.dispatched = false;
  }

  dispose(): void {
    for (const d of [...this.draws]) d.dispose();
    this.runs.dispose?.();
  }

  // --- for draws ---------------------------------------------------------------------------------------

  /** @internal */ get scene(): Scene {
    return this.host.scene;
  }

  /** @internal */ get materialLibrary(): BabylonSkinnedHost["materials"] {
    return this.host.materials;
  }

  /** @internal A run's output as a Babylon buffer of skinned vertices (stride 48 bytes); `update` refreshes a CPU one. */
  skinnedBuffer(run: SkinRun<unknown>): { buffer: Buffer; update?: () => void; release(): void } {
    const output = run.output;
    if (output instanceof Float32Array) {
      const buffer = new Buffer(this.engine, output, true, SKIN_STRIDE / 4);
      return { buffer, update: () => buffer.update(run.output as Float32Array), release: () => buffer.dispose() };
    }
    let data: DataBuffer;
    let release = () => {};
    if (this.executor === "webgpu") {
      const sb = this.wrappers.get(output as GpuBuffer)!;
      data = sb.getBuffer();
      release = () => {
        this.wrappers.delete(output as GpuBuffer);
        sb.dispose();
      };
    } else data = new WebGLDataBuffer(output as WebGLBuffer);
    return { buffer: new Buffer(this.engine, data, false, SKIN_STRIDE, false, false, true), release };
  }

  /** @internal */ noteDispatch(): void {
    this.dispatched = true;
  }

  /** @internal */ forget(d: BabylonSkinnedDraw): void {
    this.draws.delete(d);
  }
}

class BabylonSkinnedDraw implements SkinnedDraw<Mesh>, BabylonSkinnedLevels {
  readonly mesh: Mesh;
  private readonly skinned: { buffer: Buffer; update?: () => void; release(): void };
  private readonly matrix = new Matrix();
  private readonly bounds: BoundingInfo;
  private material: SlotRequest | null = null;
  private disposed = false;
  /** The static streams (UVs, colours), one `VertexBuffer` shared by every level's mesh. */
  private readonly statics: VertexBuffer[] = [];
  /** Level meshes by level (0 is `mesh`), made on first ask; they share the skinned and static vertex buffers. */
  private readonly meshes: (Mesh | undefined)[] = [];
  /** Per-view drawing: the levels enabled (bit i), or null for level 0 only. */
  private shown: number | null = null;
  private on = true;
  private receive = true;
  readonly levelCount: number;

  constructor(
    private readonly owner: BabylonSkinnedMeshes,
    readonly source: SkinnedMeshSource,
    name: string,
    private readonly run: SkinRun<unknown>,
  ) {
    const scene = owner.scene;
    const model: ModelMesh = source.model;
    const d = model.data;
    const n = vertexCount(source.geometry);
    const mesh = (this.mesh = new Mesh(name, scene));
    this.skinned = owner.skinnedBuffer(run);
    for (const [kind, offset, size] of SKINNED_KINDS) {
      if (kind === VertexBuffer.TangentKind && !source.geometry.tangents) continue; // the material derives tangents itself
      mesh.setVerticesBuffer(this.skinned.buffer.createVertexBuffer(kind, offset, size, SKIN_STRIDE, false, true), true, n);
    }
    // Static streams are `VertexBuffer`s of their own, shared by this mesh and its levels' (ADR 0459 §1, §6).
    const engine = scene.getEngine();
    for (const [kind, data, size] of [[VertexBuffer.UVKind, d.uvs, 2], [VertexBuffer.UV2Kind, d.uvs2, 2], [VertexBuffer.ColorKind, d.colors, 4]] as const) {
      if (!data || !data.length) continue;
      const shared = new VertexBuffer(engine, data as Float32Array, kind, false, false, size);
      this.statics.push(shared);
      mesh.setVerticesBuffer(shared, true, n);
    }
    mesh.setIndices(d.indices, n);
    this.levelCount = model.lods?.levels.length ?? 1;
    this.meshes[0] = mesh;
    mesh.isPickable = true;
    this.bounds = new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1), mesh.getWorldMatrix());
    mesh.setBoundingInfo(this.bounds);
  }

  get lost(): boolean {
    return this.run.lost;
  }

  setPalette(palette: SkinPalette): void {
    this.run.setPalette(palette);
  }

  setMorphWeights(weights: ArrayLike<number>): void {
    this.run.setMorphWeights(weights);
  }

  dispatch(): void {
    if (this.disposed) return;
    this.run.dispatch();
    this.skinned.update?.();
    this.owner.noteDispatch();
  }

  /** The mesh drawing `level` (0 is `mesh`): a mesh of its own sharing this draw's vertex buffers and bounds, made on first ask. */
  levelMesh(level: number): Mesh {
    const l = Math.max(0, Math.min(level, this.levelCount - 1));
    let m = this.meshes[l];
    if (m) return m;
    const model = this.source.model.lods!.levels[l].mesh;
    const d = model.data;
    const base = this.mesh;
    const n = vertexCount(this.source.geometry);
    m = this.meshes[l] = new Mesh(`${base.name}:lod${l}`, base.getScene());
    for (const [kind] of SKINNED_KINDS) {
      const b = base.getVertexBuffer(kind);
      if (b) m.setVerticesBuffer(b, true, n);
    }
    for (const b of this.statics) m.setVerticesBuffer(b, true, n);
    m.setIndices(d.indices, n);
    m.isPickable = true;
    m.setBoundingInfo(this.bounds);
    m.receiveShadows = this.receive;
    m.freezeWorldMatrix(this.matrix);
    if (this.material) this.applyMaterial(m, l);
    m.setEnabled(false);
    this.applyEnabled();
    return m;
  }

  showLevels(mask: number | null): void {
    this.shown = mask;
    this.applyEnabled();
  }

  /** Enable the meshes the draw is on for: level 0 alone, or the levels `showLevels` named. */
  private applyEnabled(): void {
    for (let l = 0; l < this.meshes.length; l++) {
      const m = this.meshes[l];
      if (!m) continue;
      const on = this.on && (this.shown === null ? l === 0 : (this.shown & (1 << l)) !== 0);
      if (m.isEnabled(false) !== on) m.setEnabled(on);
    }
  }

  setWorldMatrix(m: ArrayLike<number>, offset: number): void {
    Matrix.FromArrayToRef(m as unknown as number[], offset, this.matrix);
    for (const mesh of this.meshes) mesh?.freezeWorldMatrix(this.matrix);
  }

  setBounds(b: Box6): void {
    // The same BoundingInfo, rebuilt in place (no objects a frame), shared by every level's mesh.
    boundsMin.set(b[0], b[1], b[2]);
    boundsMax.set(b[3], b[4], b[5]);
    this.bounds.reConstruct(boundsMin, boundsMax, this.mesh.getWorldMatrix());
    for (const mesh of this.meshes) if (mesh && mesh.getBoundingInfo() !== this.bounds) mesh.setBoundingInfo(this.bounds);
  }

  setEnabled(enabled: boolean): void {
    this.on = enabled;
    this.applyEnabled();
  }

  setShadows(_cast: boolean, receive: boolean): void {
    // Casting is the render feature's `casters`; receiving is the mesh's flag.
    this.receive = receive;
    for (const mesh of this.meshes) if (mesh) mesh.receiveShadows = receive;
  }

  setMaterials(request: SlotRequest): void {
    if (this.material && sameRequest(this.material, request)) return;
    this.material = { mesh: request.mesh, material: request.material, materials: request.materials ? [...request.materials] : undefined };
    this.meshes.forEach((m, l) => m && this.applyMaterial(m, l));
  }

  /** The request's materials on a level's mesh, picked for that level's groups (a level has LOD0's surfaces). */
  private applyMaterial(mesh: Mesh, level: number): void {
    const model = level === 0 ? this.source.model : this.source.model.lods!.levels[level].mesh;
    const pick = this.owner.materialLibrary.slotMaterials(this.material!, [model]);
    mesh.material = pick(model, mesh) as BabylonMaterial;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of this.meshes) m?.dispose(false, false);
    this.run.dispose();
    this.skinned.release();
    for (const b of this.statics) b.dispose();
    this.owner.forget(this);
  }
}
