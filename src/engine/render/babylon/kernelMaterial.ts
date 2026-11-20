// Internal (ADR 0126, 0251): kernel particle outputs drawn with a material asset. The output's mesh (a
// quad, the model of a mesh output, or a trail's strip) is drawn instanced with an unshared copy of the
// material (a PBR material: built-in material assets and shader graphs) carrying
// `MycoKernelParticlePlugin`, which reads each particle from textures in the material's own vertex
// shader and places, turns and tints the vertex (a trail's along the particle's history, as Unity's
// Trails module draws with its trail material). So lights, shadows received, fog and the frame graph's
// effects apply as on any mesh, and a graph's Particle Color node (ADR 0096) sees the particle's colour
// (it arrives as the vertex colour).
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ModelMesh } from "../../scene/models";
import type { KernelSystem } from "../../scene/particleKernel";
import { outputSorts } from "../../scene/particleGraph";
import { DRAW_MODE, materialTrails, materialVertexCode } from "../particles/gpu/kernelShader";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";
import type { Draw } from "./particleDraw";

/** The textures a material draw reads, from the run (latest state, uniforms, look-up table, sorted pairs). */
export interface KernelTextures {
  /** One texture of four texels per particle (WebGPU's copy of its buffer), else four. */
  interleaved: boolean;
  state: BaseTexture[];
  /** Particles per row of the state texture(s). */
  width: number;
  uniforms: BaseTexture;
  lut: BaseTexture;
  pairs: BaseTexture | null;
  pairsWidth: number;
  /** A trail output's history (block b of the state layout holds each slot's point b), else null. */
  history: BaseTexture | null;
  /** The frame the last step wrote (its history block is `frame % points`). */
  frame: number;
}

/** What a material draw needs from a run. */
export interface KernelTextureSource {
  /** This frame's textures (after the step; `sorted` also the sorted pairs, sorted by the caller; `trail` the history). */
  textures(sorted: boolean, trail: boolean): KernelTextures | null;
}

class KernelParticleDefines extends MaterialDefines {
  /**
   * A hash of the spliced code, not just on/off: Babylon shares compiled effects between materials whose
   * defines match, and each kernel output's code differs.
   */
  MYCO_KERNEL_PARTICLES = 0;
}

/** A 31-bit hash of a string (FNV-1a). */
function hashCode(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 1) || 1;
}

interface PluginConfig {
  kernel: KernelSystem;
  output: number;
  opts: { sorted: boolean; interleaved: boolean };
  trail: boolean;
}

/** Places a material's vertices from kernel particle state (one per output draw). */
class MycoKernelParticlePlugin extends MycoMaterialPlugin {
  /** Set each frame by the draw. */
  current: KernelTextures | null = null;
  private readonly config: PluginConfig;

  constructor(material: PBRMaterial, kernel: KernelSystem, output: number, opts: { sorted: boolean; interleaved: boolean }) {
    super(material, "MycoKernelParticles", 100, new KernelParticleDefines());
    this.config = { kernel, output, opts, trail: materialTrails(kernel, output) };
    this.register();
  }

  override getClassName(): string {
    return "MycoKernelParticlePlugin";
  }

  private hash = 0;
  override prepareDefines(defines: KernelParticleDefines): void {
    if (!this.hash) {
      const { kernel, output, opts } = this.config;
      this.hash = hashCode(materialVertexCode(kernel, output, "wgsl", opts).definitions);
    }
    defines.MYCO_KERNEL_PARTICLES = this.hash;
  }

  override getSamplers(samplers: string[]): void {
    const o = this.config.opts;
    samplers.push(...(o.interleaved ? ["kpst"] : ["kps0", "kps1", "kps2", "kps3"]), "kpu", "kpl", ...(o.sorted ? ["kpidx"] : []), ...(this.config.trail ? ["kphist"] : []));
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string } {
    return {
      ubo: [
        { name: "kpdraw", size: 4, type: "vec4" },
        { name: "kpdraw3", size: 4, type: "vec4" },
        { name: "kpcam", size: 4, type: "vec4" },
        { name: "kptrail", size: 4, type: "vec4" },
      ],
      vertex: "",
    };
  }

  override bindForSubMesh(ubo: UniformBuffer, scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const t = this.current;
    if (!t) return;
    const { kernel, output, opts } = this.config;
    const out = kernel.outputs[output];
    const cam = scene.activeCamera?.globalPosition;
    ubo.updateFloat4("kpdraw", DRAW_MODE[out.type] ?? 0, out.settings.speedScale, out.settings.lengthScale, out.tiles[0]);
    ubo.updateFloat4("kpdraw3", out.tiles[1], t.width, t.pairsWidth, 0);
    ubo.updateFloat4("kpcam", cam?.x ?? 0, cam?.y ?? 0, cam?.z ?? 0, 1);
    ubo.updateFloat4("kptrail", t.frame, kernel.trail ?? 0, 0, out.trail?.widthRow ?? 0);
    if (this.config.trail && t.history) ubo.setTexture("kphist", t.history);
    if (t.interleaved) ubo.setTexture("kpst", t.state[0]);
    else t.state.forEach((s, i) => ubo.setTexture(`kps${i}`, s));
    ubo.setTexture("kpu", t.uniforms);
    ubo.setTexture("kpl", t.lut);
    if (opts.sorted && t.pairs) ubo.setTexture("kpidx", t.pairs);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    if (shaderType !== "vertex") return null;
    const { kernel, output, opts } = this.config;
    const code = materialVertexCode(kernel, output, shaderLanguage === ShaderLanguage.WGSL ? "wgsl" : "glsl", opts);
    return { CUSTOM_VERTEX_DEFINITIONS: code.definitions, CUSTOM_VERTEX_UPDATE_POSITION: code.update, CUSTOM_VERTEX_UPDATE_WORLDPOS: code.worldPos };
  }
}

/** Whether a material asset can draw kernel particles (a PBR material: built-in assets and shader graphs). */
export function drawsKernelParticles(material: Material | null): material is PBRMaterial {
  return material instanceof PBRMaterial;
}

/** One kernel output drawn with a material asset's copy. */
export class KernelMaterialDraw implements Draw {
  readonly kind = "kernelMaterial";
  readonly mesh: Mesh;
  readonly meshes: readonly Mesh[];
  readonly material: PBRMaterial;
  private readonly plugin: MycoKernelParticlePlugin;
  readonly sorted: boolean;
  /** A trail output: a ribbon through each particle's history. */
  readonly trail: boolean;

  constructor(
    scene: Scene,
    readonly name: string,
    readonly kernel: KernelSystem,
    readonly output: number,
    private readonly source: KernelTextureSource & { sortFor?(): void },
    /** An unshared copy of the material asset (disposed with the draw). */
    private readonly copy: { material: PBRMaterial; dispose(): void },
    opts: { mesh?: ModelMesh; interleaved: boolean },
  ) {
    const out = kernel.outputs[output];
    this.sorted = outputSorts(out.settings);
    this.trail = materialTrails(kernel, output);
    this.mesh = new Mesh(name, scene);
    this.meshes = [this.mesh];
    const vd = new VertexData();
    const m = out.type === "mesh" ? opts.mesh?.data : undefined;
    if (this.trail) {
      // The strip `KernelDraw` draws: a pair of vertices (side ±0.5) per history point (y its index).
      const points = kernel.trail!;
      const positions: number[] = [];
      const indices: number[] = [];
      for (let k = 0; k < points; k++) {
        positions.push(-0.5, k, 0, 0.5, k, 0);
        if (k + 1 < points) indices.push(k * 2, k * 2 + 1, k * 2 + 3, k * 2, k * 2 + 3, k * 2 + 2);
      }
      vd.positions = positions;
      vd.indices = indices;
      vd.uvs = positions.flatMap((_, i) => (i % 3 === 0 ? [0, 0] : []));
      vd.normals = positions.map((_, i) => (i % 3 === 2 ? -1 : 0));
    } else if (m) {
      vd.positions = Array.from(m.positions);
      vd.indices = Array.from(m.indices);
      vd.uvs = m.uvs ? Array.from(m.uvs) : new Array((m.positions.length / 3) * 2).fill(0);
      if (m.normals) vd.normals = Array.from(m.normals);
      else {
        const normals: number[] = [];
        VertexData.ComputeNormals(vd.positions, vd.indices, normals);
        vd.normals = normals;
      }
    } else if (out.type === "mesh") {
      const box = VertexData.CreateBox({ size: 1 });
      Object.assign(vd, { positions: box.positions, indices: box.indices, uvs: box.uvs, normals: box.normals });
    } else {
      vd.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
      vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      vd.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
      vd.indices = [0, 1, 2, 0, 2, 3];
    }
    // White vertex colours switch on the material's vertex colour, which the plugin sets to the particle's.
    vd.colors = new Array(((vd.positions as number[]).length / 3) * 4).fill(1);
    vd.applyToMesh(this.mesh);
    this.mesh.hasVertexAlpha = true;
    this.mesh.useVertexColors = true;
    this.material = copy.material;
    this.material.backFaceCulling = false;
    this.plugin = new MycoKernelParticlePlugin(this.material, kernel, output, { sorted: this.sorted, interleaved: opts.interleaved });
    this.mesh.material = this.material;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.isPickable = false;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.freezeWorldMatrix(); // the plugin writes world positions
    this.mesh.forcedInstanceCount = kernel.capacity;
    // Textures from the start: readiness can't wait on them (Babylon settles a material's defines the
    // first time it asks, so a plugin that says "not ready" then is never asked to compile again).
    this.plugin.current = source.textures(false, this.trail);
  }

  isReady(): boolean {
    return this.mesh.isReady(true);
  }

  /** This frame's textures (after the run stepped). */
  update(): void {
    if (this.sorted) this.source.sortFor?.();
    this.plugin.current = this.source.textures(this.sorted, this.trail);
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.copy.dispose();
  }
}
