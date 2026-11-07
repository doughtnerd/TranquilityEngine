/**
 * Sprite batching (ADR 0108): sprites draw as thin instances of one quad per run of sprites sharing a
 * texture (an atlas) in draw order. Sprites are sorted by sorting layer and order (ADR 0014), sprites
 * of equal order grouped by texture, and each run of one texture is one mesh and one draw. Runs take
 * consecutive `alphaIndex` values, so layer order is exactly as before; within a run, instances draw in
 * sort order.
 *
 * Per instance: the world matrix (size, pivot, flips and the node), the tint (Babylon's instance colour,
 * which multiplies the PBR albedo and alpha) and the slice's UV rectangle (`SpriteUvPlugin`, GLSL and WGSL).
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstance*
import type { Scene } from "@babylonjs/core/scene.js";
import { pbr } from "./materials";

/** One sprite to draw this frame. */
export interface SpriteItem {
  texture: Texture | null;
  /** Draw order: sorting layer index × 10000 + order in layer. */
  order: number;
  /** World matrix, column-major (Babylon's layout). */
  matrix: Float32Array;
  /** Linear tint and alpha. */
  color: [number, number, number, number];
  /** UV rectangle: u0, v0, width, height. */
  uvRect: [number, number, number, number];
}

/** The per-instance UV rectangle's attribute. */
export const UV_RECT_ATTRIBUTE = "mycoUvRect";

/** @internal Where the UV rectangle goes in Babylon's PBR vertex shader (GLSL and WGSL). */
export function spriteUvCode(shaderType: string, language: ShaderLanguage): { [point: string]: string } | null {
  if (shaderType !== "vertex") return null;
  const wgsl = language === ShaderLanguage.WGSL;
  return {
    CUSTOM_VERTEX_DEFINITIONS: wgsl ? `attribute ${UV_RECT_ATTRIBUTE}: vec4f;` : `attribute vec4 ${UV_RECT_ATTRIBUTE};`,
    // After the UV is read and before it's passed on (both languages declare `uvUpdated` with UV1).
    CUSTOM_VERTEX_UPDATE_POSITION: ["#ifdef UV1", wgsl ? `uvUpdated = vertexInputs.${UV_RECT_ATTRIBUTE}.xy + uvUpdated * vertexInputs.${UV_RECT_ATTRIBUTE}.zw;` : `uvUpdated = ${UV_RECT_ATTRIBUTE}.xy + uvUpdated * ${UV_RECT_ATTRIBUTE}.zw;`, "#endif"].join("\n"),
  };
}

/** Reads each instance's UV rectangle: a sprite's slice of its atlas. */
class SpriteUvPlugin extends MaterialPluginBase {
  constructor(material: PBRMaterial) {
    super(material, "MycoSpriteUv", 210, { MYCO_SPRITE_UV: true }, false);
    (this._pluginManager as unknown as { _addPlugin(p: MaterialPluginBase): boolean })._addPlugin(this);
    this._enable(true);
  }
  override getClassName(): string {
    return "MycoSpriteUvPlugin";
  }
  override isCompatible(): boolean {
    return true;
  }
  override prepareDefines(defines: MaterialDefines): void {
    defines.MYCO_SPRITE_UV = true;
  }
  override getAttributes(attributes: string[]): void {
    attributes.push(UV_RECT_ATTRIBUTE);
  }
  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    return spriteUvCode(shaderType, shaderLanguage ?? ShaderLanguage.GLSL);
  }
  override bindForSubMesh(_ubo: unknown, _scene: Scene, _engine: AbstractEngine): void {}
}

/** One run's mesh, reused frame to frame by run index. */
interface Run {
  mesh: Mesh;
  capacity: number;
  matrices: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
}

const QUAD = (() => {
  const d = new VertexData();
  d.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
  d.normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  d.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  d.indices = [0, 1, 2, 0, 2, 3];
  return d;
})();

const IDENTITY = Matrix.Identity();

/** Draws sprites batched per texture run (see the file comment). */
export class SpriteBatcher {
  private readonly runs: Run[] = [];
  private readonly materials = new Map<Texture | null, PBRMaterial>();
  private used = 0;
  private drawn = 0;
  private readonly order: SpriteItem[] = [];
  private readonly textureIds = new WeakMap<Texture, number>();
  private nextTextureId = 1;

  constructor(private readonly scene: Scene) {}

  /** Draw these sprites from now on (call when any sprite changed). */
  update(items: readonly SpriteItem[]): void {
    const sorted = this.order;
    sorted.length = 0;
    for (const it of items) sorted.push(it);
    const id = (t: Texture | null) => (t ? (this.textureIds.get(t) ?? this.textureIds.set(t, this.nextTextureId++).get(t)!) : 0);
    sorted.sort((a, b) => a.order - b.order || id(a.texture) - id(b.texture));
    let run = -1;
    let start = 0;
    const flushRun = (end: number) => {
      if (run < 0) return;
      this.fill(run, sorted, start, end);
    };
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 || sorted[i].texture !== sorted[i - 1].texture) {
        flushRun(i);
        run++;
        start = i;
      }
    }
    flushRun(sorted.length);
    this.used = run + 1;
    this.drawn = sorted.length;
    for (let i = this.used; i < this.runs.length; i++) this.runs[i].mesh.setEnabled(false);
  }

  /** Draw calls and sprites last drawn (benchmarks, tests). */
  stats(): { batches: number; sprites: number } {
    return { batches: this.used, sprites: this.drawn };
  }

  /** The run meshes in use (tests). */
  meshes(): Mesh[] {
    return this.runs.slice(0, this.used).map((r) => r.mesh);
  }

  dispose(): void {
    for (const r of this.runs) r.mesh.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.runs.length = 0;
    this.materials.clear();
  }

  private material(texture: Texture | null): PBRMaterial {
    let m = this.materials.get(texture);
    if (m) return m;
    m = pbr(`sprites:${texture?.name ?? "plain"}`, this.scene);
    m.unlit = true;
    m.backFaceCulling = false; // flipped sprites mirror their quad
    m.disableDepthWrite = true;
    m.depthFunction = Constants.ALWAYS; // sprites draw in layer order, not by depth (ADR 0014)
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    m.useAlphaFromAlbedoTexture = true;
    m.albedoTexture = texture;
    new SpriteUvPlugin(m);
    this.materials.set(texture, m);
    return m;
  }

  private fill(index: number, sorted: SpriteItem[], start: number, end: number): void {
    const n = end - start;
    let run = this.runs[index];
    if (!run) {
      const mesh = new Mesh(`sprites:${index}`, this.scene);
      QUAD.applyToMesh(mesh, false);
      mesh.freezeWorldMatrix(IDENTITY.clone());
      mesh.alwaysSelectAsActiveMesh = true; // culled per sprite by no one: sprite batches are cheap to draw
      mesh.isPickable = false;
      run = { mesh, capacity: 0, matrices: new Float32Array(0), colors: new Float32Array(0), uvs: new Float32Array(0) };
      this.runs[index] = run;
    }
    if (n > run.capacity) {
      run.capacity = Math.max(16, n * 2);
      run.matrices = new Float32Array(run.capacity * 16);
      run.colors = new Float32Array(run.capacity * 4);
      run.uvs = new Float32Array(run.capacity * 4);
      run.mesh.thinInstanceSetBuffer("matrix", run.matrices, 16, false);
      run.mesh.thinInstanceSetBuffer("instanceColor", run.colors, 4, false);
      run.mesh.thinInstanceSetBuffer(UV_RECT_ATTRIBUTE, run.uvs, 4, false);
    }
    for (let i = 0; i < n; i++) {
      const it = sorted[start + i];
      run.matrices.set(it.matrix, i * 16);
      run.colors.set(it.color, i * 4);
      run.uvs.set(it.uvRect, i * 4);
    }
    const texture = sorted[start].texture;
    const material = this.material(texture);
    if (run.mesh.material !== material) run.mesh.material = material;
    run.mesh.alphaIndex = index; // runs draw in order
    run.mesh.thinInstanceCount = n;
    run.mesh.thinInstanceBufferUpdated("matrix");
    run.mesh.thinInstanceBufferUpdated("instanceColor");
    run.mesh.thinInstanceBufferUpdated(UV_RECT_ATTRIBUTE);
    run.mesh.setEnabled(true);
  }
}
