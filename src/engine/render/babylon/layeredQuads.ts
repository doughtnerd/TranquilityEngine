/**
 * Layered 2D quads (ADR 0014, 0108, 0136, 0186): the one owner of how 2D content draws on Babylon.
 * Lone sprites (`sprites.ts`), sprite batches (`SpriteBatcher` below), quad batches (tilemaps,
 * `quadBatches.ts`) and particle meshes (`particleDraw.ts`) are its callers. It owns:
 *
 * - the material: unlit PBR, two-sided (flipped sprites mirror their quad), alpha-blended, no depth
 *   write and depth test ALWAYS, so 2D content draws in layer order, not by depth (`layeredQuadMaterial`);
 * - the draw order. Babylon sorts transparent meshes by `alphaIndex` (lowest first), then back to front,
 *   so a 2D draw's place is its `alphaIndex`, which is set only here:
 *   - 2D content (a lone sprite, a quad batch, the first sprite run of an order) sits at its draw order,
 *     `sortingOrder`'s sorting layer index × 10000 + order in layer (`placeInLayer`);
 *   - each further sprite run of the same order (another texture) sits `RUN_STEP` past the run before,
 *     so runs of one order sort deterministically and stay below the next order (whole or fractional,
 *     as long as the orders are further apart than their runs' steps);
 *   - in a y-sorted sorting layer (ADR 0440) a draw's order also carries its height (`drawPlace`, `sortOrder.ts`):
 *     higher draws sit lower within their order in layer. Sprites there each sit at their own place, so they batch
 *     only with sprites of the same material at the same height (further runs at one place step by `Y_SORTED_RUN_STEP`);
 *   - a 3D decal volume (`placeDecal`, ADR 0395) sits in a band below every 2D draw order and particle value, by
 *     its decal order: decals draw first among transparent meshes, right after the opaque scene they land on;
 *   - a particle mesh (`placeParticles`) sits by its emitter's `renderOrder`: 0 at Babylon's default
 *     (`Number.MAX_VALUE`, sorted by distance with the scene's other transparent meshes, after all 2D
 *     content), a negative one at that value (among the 2D content of the first sorting layer), a
 *     positive one at +Infinity, after everything (two positive orders then sort by distance, not order);
 * - the lit variant (ADR 0399, `lightLayeredQuads`): the same material with the 2D light plugin
 *   (`lights2DMaterial.ts`), reading its layer batch's light textures; lit and unlit draws sort alike;
 * - sprite batching (ADR 0108): sprites are sorted by draw order and, within one order, grouped by
 *   material (the 2D materials share one per texture and lighting, `materials2D.ts`, ADR 0418, made with
 *   `batchedSpriteMaterial`); each run is one mesh of thin instances and one draw. Per instance: the world
 *   matrix (size, pivot, flips and the node), the tint (Babylon's instance colour, which multiplies the
 *   PBR albedo and alpha) and the slice's UV rectangle (`SpriteUvPlugin`, GLSL and WGSL).
 */
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstance*
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer.js";
import { pbr } from "./materials";
import { MycoMaterialPlugin } from "./mycoMaterialPlugin";
import { Light2DPlugin, type LitQuadSetup } from "./lights2DMaterial";

// --- the material ----------------------------------------------------------------------------------

/** A new material for 2D quads showing `texture` with its alpha (null: plain white), drawn in layer order, not by depth. */
export function layeredQuadMaterial(name: string, scene: Scene, texture: Texture | null): PBRMaterial {
  const m = pbr(name, scene);
  m.unlit = true;
  m.backFaceCulling = false; // flipped sprites mirror their quad
  m.disableDepthWrite = true;
  m.depthFunction = Constants.ALWAYS; // 2D content draws in layer order, not by depth (ADR 0014)
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  m.useAlphaFromAlbedoTexture = true;
  m.albedoTexture = texture;
  return m;
}

/** Light a 2D quad material by 2D lights (ADR 0399): its layer batch's light textures, and the sprite's normal and mask maps. */
export function lightLayeredQuads(material: PBRMaterial, setup: LitQuadSetup): void {
  new Light2DPlugin(material, setup);
}

// --- the draw order --------------------------------------------------------------------------------

/** How far apart runs of one draw order sit in `alphaIndex`. */
const RUN_STEP = 1e-4;
/**
 * How far apart runs at one place of a y-sorted layer sit (ADR 0440): far below the step between two heights a
 * thousandth of a unit apart (`withinOrder(ySortFraction(y))` moves 2.5e-6 per unit), so they stay below the next height.
 */
const Y_SORTED_RUN_STEP = 1e-9;

// How far into its draw order a 2D draw sits (ADR 0437, 0440): renderer-neutral, in `sortOrder.ts` so picking ranks
// by the same places. Sprite runs of one order step by `RUN_STEP` on top of it.
export { WITHIN_SPAN, withinOrder } from "../sortOrder";

/** Put a mesh drawing 2D content (a lone sprite, a quad batch) at draw order `order` (`sortingOrder`'s value). */
export function placeInLayer(mesh: AbstractMesh, order: number): void {
  mesh.alphaIndex = order;
}

/** Where the decal band starts: far below any sorting layer's order (layer index × 10000 + order in layer) or negative particle order. */
const DECAL_BAND = -1e15;
/** How far apart decal orders sit (decal orders are whole or fractional numbers well inside ±1e9). */
const DECAL_STEP = 1e3;

/** Put a 3D decal volume at decal order `order` (ADR 0395: below every 2D layer and particle, higher orders on top). */
export function placeDecal(mesh: AbstractMesh, order: number): void {
  const o = Number.isFinite(order) ? Math.max(-1e9, Math.min(1e9, order)) : 0;
  mesh.alphaIndex = DECAL_BAND + o * DECAL_STEP;
}

/** Put a mesh drawing particles at its emitter's `renderOrder` (see the file comment). */
export function placeParticles(mesh: AbstractMesh, renderOrder: number): void {
  if (renderOrder === 0 || !Number.isFinite(renderOrder)) mesh.alphaIndex = Number.MAX_VALUE;
  else mesh.alphaIndex = renderOrder > 0 ? Number.POSITIVE_INFINITY : renderOrder;
}

// --- masks (ADR 0395) ------------------------------------------------------------------------------

/** The texture and map a quad mask samples (`QuadBatch.setMask`): u = a·x + b·y + c, v = d·x + e·y + f in the mesh's local space. */
export interface QuadMaskBinding {
  texture: Texture | null;
  /** `[a, b, c, d, e, f]`. */
  uv: readonly number[];
}

/** Where the mask goes in Babylon's PBR shaders: the local position as a varying, then the alpha multiplied by the mask's. */
function quadMaskCode(shaderType: string, language: ShaderLanguage): { [point: string]: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  if (shaderType === "vertex") {
    return wgsl
      ? { CUSTOM_VERTEX_DEFINITIONS: "varying vMycoMaskLocal: vec2f;", CUSTOM_VERTEX_MAIN_END: "vertexOutputs.vMycoMaskLocal = vertexInputs.position.xy;" }
      : { CUSTOM_VERTEX_DEFINITIONS: "varying vec2 vMycoMaskLocal;", CUSTOM_VERTEX_MAIN_END: "vMycoMaskLocal = position.xy;" };
  }
  return wgsl
    ? {
        CUSTOM_FRAGMENT_DEFINITIONS: "varying vMycoMaskLocal: vec2f;\nvar mycoQuadMask: texture_2d<f32>;\nvar mycoQuadMaskSampler: sampler;",
        CUSTOM_FRAGMENT_UPDATE_ALPHA: [
          "{",
          "  let mycoP = vec3f(fragmentInputs.vMycoMaskLocal, 1.0);",
          "  let mycoUv = vec2f(dot(uniforms.mycoQuadMaskU.xyz, mycoP), dot(uniforms.mycoQuadMaskV.xyz, mycoP));",
          "  let mycoIn = step(0.0, mycoUv.x) * step(mycoUv.x, 1.0) * step(0.0, mycoUv.y) * step(mycoUv.y, 1.0);",
          "  alpha = alpha * mycoIn * textureSample(mycoQuadMask, mycoQuadMaskSampler, clamp(mycoUv, vec2f(0.0), vec2f(1.0))).a;",
          "}",
        ].join("\n"),
      }
    : {
        CUSTOM_FRAGMENT_DEFINITIONS: "varying vec2 vMycoMaskLocal;\nuniform sampler2D mycoQuadMask;",
        CUSTOM_FRAGMENT_UPDATE_ALPHA: [
          "{",
          "  vec3 mycoP = vec3(vMycoMaskLocal, 1.0);",
          "  vec2 mycoUv = vec2(dot(mycoQuadMaskU.xyz, mycoP), dot(mycoQuadMaskV.xyz, mycoP));",
          "  float mycoIn = step(0.0, mycoUv.x) * step(mycoUv.x, 1.0) * step(0.0, mycoUv.y) * step(mycoUv.y, 1.0);",
          "  alpha *= mycoIn * texture2D(mycoQuadMask, clamp(mycoUv, vec2(0.0), vec2(1.0))).a;",
          "}",
        ].join("\n"),
      };
}

/** A mask on one (unshared) layered quad material: the mask texture's alpha clips the quads (a 2D decal on its sprite). */
export class QuadMaskPlugin extends MycoMaterialPlugin {
  constructor(
    material: PBRMaterial,
    public mask: QuadMaskBinding,
  ) {
    super(material, "MycoQuadMask", 215, { MYCO_QUAD_MASK: true });
    this.register();
  }
  override getClassName(): string {
    return "MycoQuadMaskPlugin";
  }
  override prepareDefines(defines: MaterialDefines): void {
    defines.MYCO_QUAD_MASK = true;
  }
  override getSamplers(samplers: string[]): void {
    samplers.push("mycoQuadMask");
  }
  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return { ubo: [{ name: "mycoQuadMaskU", size: 4, type: "vec4" }, { name: "mycoQuadMaskV", size: 4, type: "vec4" }], fragment: "" };
  }
  override isReadyForSubMesh(): boolean {
    return !!this.mask.texture && this.mask.texture.isReady(); // nothing draws until the mask can clip it
  }
  override bindForSubMesh(ubo: UniformBuffer): void {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = this.mask.uv;
    ubo.updateFloat4("mycoQuadMaskU", a, b, c, 0);
    ubo.updateFloat4("mycoQuadMaskV", d, e, f, 0);
    if (this.mask.texture) ubo.setTexture("mycoQuadMask", this.mask.texture);
  }
  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): { [point: string]: string } | null {
    return quadMaskCode(shaderType, shaderLanguage ?? ShaderLanguage.GLSL);
  }
}

// --- sprite batching -------------------------------------------------------------------------------

/** One sprite to draw this frame. */
export interface SpriteItem {
  /** Its batch material (`batchedSpriteMaterial`: the instances' UV rectangles and colours); sprites sharing it share runs. */
  material: Material;
  /**
   * Draw order: sorting layer index × 10000 + order in layer; in a y-sorted layer (ADR 0440) plus its height's offset into
   * that order (`drawPlace`), so each sprite sits at its own place and only sprites at the same place share runs.
   */
  order: number;
  /** In a y-sorted layer (ADR 0440): runs at one place step by a far smaller amount, so they stay below the next height. */
  ySorted?: boolean;
  /** World matrix, column-major (Babylon's layout). */
  matrix: Float32Array;
  /** Linear tint and alpha. */
  color: [number, number, number, number];
  /** UV rectangle: u0, v0, width, height. */
  uvRect: [number, number, number, number];
}

/** The per-instance UV rectangle's attribute. */
const UV_RECT_ATTRIBUTE = "mycoUvRect";

/** Where the UV rectangle goes in Babylon's PBR vertex shader (GLSL and WGSL). */
function spriteUvCode(shaderType: string, language: ShaderLanguage): { [point: string]: string } | null {
  if (shaderType !== "vertex") return null;
  const wgsl = language === ShaderLanguage.WGSL;
  return {
    CUSTOM_VERTEX_DEFINITIONS: wgsl ? `attribute ${UV_RECT_ATTRIBUTE}: vec4f;` : `attribute vec4 ${UV_RECT_ATTRIBUTE};`,
    // After the UV is read and before it's passed on (both languages declare `uvUpdated` with UV1).
    CUSTOM_VERTEX_UPDATE_POSITION: ["#ifdef UV1", wgsl ? `uvUpdated = vertexInputs.${UV_RECT_ATTRIBUTE}.xy + uvUpdated * vertexInputs.${UV_RECT_ATTRIBUTE}.zw;` : `uvUpdated = ${UV_RECT_ATTRIBUTE}.xy + uvUpdated * ${UV_RECT_ATTRIBUTE}.zw;`, "#endif"].join("\n"),
  };
}

/** Make a layered quad material a sprite batch's: it reads each instance's UV rectangle (a slice of its atlas). */
export function batchedSpriteMaterial(material: PBRMaterial): void {
  new SpriteUvPlugin(material);
}

/** Reads each instance's UV rectangle: a sprite's slice of its atlas. */
class SpriteUvPlugin extends MycoMaterialPlugin {
  constructor(material: PBRMaterial) {
    super(material, "MycoSpriteUv", 210, { MYCO_SPRITE_UV: true });
    this.register();
  }
  override getClassName(): string {
    return "MycoSpriteUvPlugin";
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

/** Draws sprites batched per texture run, in draw order (see the file comment). */
export class SpriteBatcher {
  private readonly runs: Run[] = [];
  private used = 0;
  private readonly order: SpriteItem[] = [];
  private readonly materialIds = new WeakMap<Material, number>();
  private nextMaterialId = 1;

  constructor(private readonly scene: Scene) {}

  /** Draw these sprites from now on (call when any sprite changed). */
  update(items: readonly SpriteItem[]): void {
    const sorted = this.order;
    sorted.length = 0;
    for (const it of items) sorted.push(it);
    const id = (m: Material) => this.materialIds.get(m) ?? this.materialIds.set(m, this.nextMaterialId++).get(m)!;
    sorted.sort((a, b) => a.order - b.order || id(a.material) - id(b.material));
    let run = -1;
    let start = 0;
    const flushRun = (end: number) => {
      if (run < 0) return;
      this.fill(run, sorted, start, end);
    };
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 || sorted[i].material !== sorted[i - 1].material || sorted[i].order !== sorted[i - 1].order) {
        flushRun(i);
        run++;
        start = i;
      }
    }
    flushRun(sorted.length);
    this.used = run + 1;
    for (let i = this.used; i < this.runs.length; i++) this.runs[i].mesh.setEnabled(false);
  }

  /** Its meshes go; the materials are the caller's (the 2D materials'). */
  dispose(): void {
    for (const r of this.runs) r.mesh.dispose();
    this.runs.length = 0;
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
    const material = sorted[start].material;
    if (run.mesh.material !== material) run.mesh.material = material;
    // Its order, or a step past the previous run when that has the same order (any number: orders aren't
    // only whole ones). The last item of the previous run is the one before this run's first.
    const order = sorted[start].order;
    const step = sorted[start].ySorted ? Y_SORTED_RUN_STEP : RUN_STEP;
    run.mesh.alphaIndex = start > 0 && sorted[start - 1].order === order ? this.runs[index - 1].mesh.alphaIndex + step : order;
    run.mesh.thinInstanceCount = n;
    run.mesh.thinInstanceBufferUpdated("matrix");
    run.mesh.thinInstanceBufferUpdated("instanceColor");
    run.mesh.thinInstanceBufferUpdated(UV_RECT_ATTRIBUTE);
    run.mesh.setEnabled(true);
  }
}
