/**
 * Quad batches on Babylon (ADR 0136): the backend half of `QuadBatchHost`. Each batch is one mesh; its
 * material is shared by every batch with the same texture, tint and opacity. Like sprites, quads are
 * layered 2D quads: `layeredQuads.ts` gives them their material and their place in the draw order
 * (ADR 0014, 0186). Knows nothing of tiles or bones: the Tilemaps plugin's tile renderer and the Animation plugin's
 * skinned sprites (`setTriangles`, updated in place each frame) decide what the quads are.
 *
 * A lit batch (`setLighting`, ADR 0399) draws with the lit layered-quad material of its sorting layer's layer batch;
 * materials are shared per texture, tint, opacity and lighting (layer batch, the rig's version, normal and mask maps),
 * and every lit batch picks its material again when the 2D lighting's batching changes (`refreshLighting`).
 */
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { authoredSize } from "../../scene/importSettings";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { QuadBatch, QuadBatchHost, QuadBlend, QuadLighting, QuadMask } from "../quadBatches";
import { layeredQuadMaterial, lightLayeredQuads, placeInLayer, QuadMaskPlugin } from "./layeredQuads";
import { lights2DOf } from "./lights2D";
import { TANGENT_2D_ATTRIBUTE, type LitQuadSetup } from "./lights2DMaterial";
import type { SpriteGraph } from "./materialLibrary";
import { spriteGraphKey, spriteGraphMaterial, type SpriteGraphFactory } from "./spriteGraphMaterial";
import type { BabylonGraphMaterial } from "./graphMaterial";

/** What the quad batches borrow from the renderer. */
export interface BabylonQuadBatchDeps {
  readonly scene: Scene;
  /** A loaded texture, or null (and it starts loading): `onReady` runs once it has (the material library's `texture`). */
  texture(path: string, onReady: (texture: Texture) => void): Texture | null;
  /** A loaded data texture (a normal or mask map, read linear, ADR 0414), or null (and it starts loading). */
  dataTexture(path: string, onReady: (texture: Texture) => void): Texture | null;
  sortOrder(layer: string, order: number): number;
  /** A 2D material's sprite shader graph (ADR 0415), or null (the material library's `spriteGraph`). */
  spriteGraph?(material: string): SpriteGraph | null;
  /** A new graph material for a 2D draw (the material library's `spriteGraphMaterial`). */
  spriteGraphMaterial?: SpriteGraphFactory;
}

interface SharedMaterial {
  material: PBRMaterial;
  users: number;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** @internal */
export class BabylonQuadBatches implements QuadBatchHost {
  private readonly materials = new Map<string, SharedMaterial>();
  private readonly batches = new Set<BabylonQuadBatch>();

  constructor(private readonly deps: BabylonQuadBatchDeps) {}

  createBatch(name: string): QuadBatch {
    const b = new BabylonQuadBatch(this, name);
    this.batches.add(b);
    return b;
  }

  textureSize(path: string, onLoad: () => void): readonly [number, number] | null {
    const tex = this.deps.texture(path, () => onLoad());
    if (!tex) return null;
    const base = tex.getBaseSize();
    return authoredSize(Assets.importSettings(path), base.width, base.height);
  }

  sortOrder(sortingLayer: string, orderInLayer: number): number {
    return this.deps.sortOrder(sortingLayer, orderInLayer);
  }

  /** @internal The mesh a batch of these draws (ADR 0276: what a feature drew through them), or null while it has no quads or isn't one of these. */
  meshOf(batch: QuadBatch): Mesh | null {
    return batch instanceof BabylonQuadBatch && this.batches.has(batch) ? batch.mesh : null;
  }

  /** @internal */
  get scene(): Scene {
    return this.deps.scene;
  }

  /**
   * @internal This frame's lit setup for a batch lit as `lighting` (its layer batch and maps; null: unlit, as when its
   * layer has no 2D light), with a key for sharing materials. `onLoad` runs when a map finishes loading.
   */
  litSetup(lighting: QuadLighting | null, onLoad: () => void): { key: string; setup: LitQuadSetup } | null {
    if (!lighting || lighting.lit === false) return null;
    const rig = lights2DOf(this.deps.scene);
    const batch = rig?.batchOfLayer(lighting.sortingLayer) ?? -1;
    if (!rig || batch < 0) return null;
    const normal = lighting.normalMap ? this.deps.dataTexture(lighting.normalMap.replace(/^asset:/, ""), () => onLoad()) : null;
    const mask = lighting.maskMap ? this.deps.dataTexture(lighting.maskMap.replace(/^asset:/, ""), () => onLoad()) : null;
    const greenDown = !!lighting.normalMapGreenDown;
    return { key: `lit${batch}@${rig.version}|${normal ? lighting.normalMap : ""}|${mask ? lighting.maskMap : ""}|${greenDown}`, setup: { batch, normal, mask, greenDown } };
  }

  /** @internal The sprite graph a lighting's material is shaded by (ADR 0415), or null. */
  spriteGraph(lighting: QuadLighting | null): SpriteGraph | null {
    return lighting?.material && this.deps.spriteGraph ? this.deps.spriteGraph(lighting.material) : null;
  }

  /** @internal A batch's own material from a sprite graph (ADR 0415); the batch disposes it. */
  graphMaterial(name: string, graph: SpriteGraph, texture: string, lit: { key: string; setup: LitQuadSetup } | null): BabylonGraphMaterial | null {
    const make = this.deps.spriteGraphMaterial;
    return make ? spriteGraphMaterial(make, name, graph, texture, lit?.setup ?? null) : null;
  }

  /** @internal Every lit batch picks its material again (the 2D lighting's layer batches changed). */
  refreshLighting(): void {
    for (const b of this.batches) b.refreshLighting();
  }

  /** @internal A shared material for `texture` tinted `color` at `opacity` (lit by `lit`); give it back with `releaseMaterial`. */
  acquireMaterial(texture: string, color: string, opacity: number, lit: { key: string; setup: LitQuadSetup } | null = null, blend: QuadBlend = "alpha"): { key: string; material: PBRMaterial } {
    const hex = HEX.test(color) ? color.toLowerCase() : "#ffffff";
    const alpha = Math.max(0, Math.min(1, opacity));
    const key = `${texture}|${hex}|${alpha}${lit ? `|${lit.key}` : ""}${blend === "additive" ? "|add" : ""}`;
    let shared = this.materials.get(key);
    if (!shared) {
      const m = layeredQuadMaterial(`quads:${key}`, this.deps.scene, null);
      Color3.FromHexString(hex).toLinearSpaceToRef(m.albedoColor);
      m.alpha = alpha;
      if (blend === "additive") m.alphaMode = Constants.ALPHA_ADD;
      const apply = (tex: Texture | null): void => {
        if (!tex || m.albedoTexture === tex) return;
        tex.hasAlpha = true;
        m.albedoTexture = tex;
      };
      if (texture) apply(this.deps.texture(texture, apply)); // "": plain (a 2D line without a texture)
      if (lit) lightLayeredQuads(m, lit.setup);
      shared = { material: m, users: 0 };
      this.materials.set(key, shared);
    }
    shared.users++;
    return { key, material: shared.material };
  }

  /**
   * @internal An unshared material for a masked batch (ADR 0395): `texture` tinted, with the mask plugin; the caller
   * disposes it. The mask's texture is applied once it has loaded (nothing draws until then).
   */
  maskedMaterial(name: string, texture: string, color: string, opacity: number, mask: QuadMask, lit: { key: string; setup: LitQuadSetup } | null = null, blend: QuadBlend = "alpha"): { material: PBRMaterial; plugin: QuadMaskPlugin } {
    const hex = HEX.test(color) ? color.toLowerCase() : "#ffffff";
    const m = layeredQuadMaterial(`quads:mask:${name}`, this.deps.scene, null);
    Color3.FromHexString(hex).toLinearSpaceToRef(m.albedoColor);
    m.alpha = Math.max(0, Math.min(1, opacity));
    if (blend === "additive") m.alphaMode = Constants.ALPHA_ADD;
    const apply = (tex: Texture | null): void => {
      if (!tex || m.albedoTexture === tex) return;
      tex.hasAlpha = true;
      m.albedoTexture = tex;
    };
    if (texture) apply(this.deps.texture(texture, apply)); // "": plain (a 2D line without a texture)
    const plugin = new QuadMaskPlugin(m, { texture: null, uv: Array.from(mask.uv) });
    if (lit) lightLayeredQuads(m, lit.setup);
    const applyMask = (tex: Texture | null): void => {
      if (tex) plugin.mask.texture = tex;
    };
    applyMask(this.deps.texture(mask.texture, applyMask));
    return { material: m, plugin };
  }

  /** @internal */
  releaseMaterial(key: string): void {
    const shared = this.materials.get(key);
    if (!shared || --shared.users > 0) return;
    shared.material.dispose();
    this.materials.delete(key);
  }

  /** @internal */
  forget(b: BabylonQuadBatch): void {
    this.batches.delete(b);
  }

  dispose(): void {
    for (const b of [...this.batches]) b.dispose();
    for (const s of this.materials.values()) s.material.dispose();
    this.materials.clear();
  }
}

class BabylonQuadBatch implements QuadBatch {
  mesh: Mesh | null = null;
  private texture = "";
  /** What the mesh was built from (`setTriangles` only moves the vertices of an updatable mesh with the same indices). */
  private indices: Uint32Array | null = null;
  private vertexFloats = 0;
  private updatable = false;
  private color = "#ffffff";
  private opacity = 1;
  private blend: QuadBlend = "alpha";
  private materialKey: string | null = null;
  /** Per-vertex RGBA (sRGB) as given, or null. */
  private colors: Float32Array | null = null;
  private mask: QuadMask | null = null;
  /** How 2D lights light it (ADR 0399), or null: unlit. */
  private lighting: QuadLighting | null = null;
  /** Per-vertex 2D tangents as given, or null. */
  private tangents: Float32Array | null = null;
  /** The masked batch's own material (`mask` set), else null. */
  private masked: { material: PBRMaterial; plugin: QuadMaskPlugin; key: string } | null = null;
  private readonly matrix = Matrix.Identity();
  private order = 0;
  private visible = false;
  private disposed = false;

  constructor(
    private readonly owner: BabylonQuadBatches,
    private readonly name: string,
  ) {}

  setQuads(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array): void {
    this.build(texture, positions, uvs, indices, false);
  }

  setTriangles(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array): void {
    if (this.mesh && this.updatable && texture === this.texture && indices === this.indices && positions.length === this.vertexFloats) {
      this.mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
      this.mesh.updateVerticesData(VertexBuffer.UVKind, uvs); // a 2D ribbon's texture moves along it (ADR 0396)
      return;
    }
    this.build(texture, positions, uvs, indices, true);
  }

  private build(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, updatable: boolean): void {
    if (this.disposed) return;
    this.mesh?.dispose();
    this.mesh = null;
    this.texture = texture;
    this.indices = indices;
    this.vertexFloats = positions.length;
    this.updatable = updatable;
    if (indices.length >= 3) {
      const mesh = new Mesh(this.name, this.owner.scene);
      const data = new VertexData();
      data.positions = positions;
      data.uvs = uvs;
      data.indices = indices;
      data.normals = new Float32Array(positions.length).map((_, i) => (i % 3 === 2 ? 1 : 0));
      data.applyToMesh(mesh, updatable);
      if (this.colors && this.colors.length === (positions.length / 3) * 4) this.applyColors(mesh, this.colors, false);
      else this.colors = null;
      if (this.tangents && this.tangents.length === (positions.length / 3) * 2) mesh.setVerticesData(TANGENT_2D_ATTRIBUTE, this.tangents, true, 2);
      else this.tangents = null;
      mesh.alwaysSelectAsActiveMesh = true;
      placeInLayer(mesh, this.order);
      mesh.freezeWorldMatrix(this.matrix);
      mesh.setEnabled(this.visible);
      this.mesh = mesh;
    }
    this.updateMaterial();
  }

  setMatrix(m: ArrayLike<number>, offset = 0): void {
    Matrix.FromArrayToRef(m as unknown as number[], offset, tmp);
    if (tmp.equals(this.matrix)) return;
    this.matrix.copyFrom(tmp);
    this.mesh?.freezeWorldMatrix(this.matrix);
  }

  setOrder(order: number): void {
    this.order = order;
    if (this.mesh) placeInLayer(this.mesh, order);
  }

  setTint(color: string, opacity: number): void {
    if (color === this.color && opacity === this.opacity) return;
    this.color = color;
    this.opacity = opacity;
    this.updateMaterial();
  }

  setColors(rgba: Float32Array | null): void {
    if (this.disposed) return;
    const mesh = this.mesh;
    if (!rgba) {
      if (this.colors && mesh) {
        mesh.removeVerticesData(VertexBuffer.ColorKind);
        mesh.hasVertexAlpha = false;
      }
      this.colors = null;
      return;
    }
    this.colors = rgba;
    if (mesh && rgba.length === (this.vertexFloats / 3) * 4) this.applyColors(mesh, rgba, mesh.isVerticesDataPresent(VertexBuffer.ColorKind));
  }

  /** Vertex colours to the mesh: sRGB to linear (what the PBR albedo multiplies), alpha as it is. */
  private applyColors(mesh: Mesh, rgba: Float32Array, update: boolean): void {
    const linear = new Float32Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      linear[i] = Math.pow(rgba[i]!, 2.2);
      linear[i + 1] = Math.pow(rgba[i + 1]!, 2.2);
      linear[i + 2] = Math.pow(rgba[i + 2]!, 2.2);
      linear[i + 3] = rgba[i + 3]!;
    }
    if (update) mesh.updateVerticesData(VertexBuffer.ColorKind, linear);
    else mesh.setVerticesData(VertexBuffer.ColorKind, linear, true, 4);
    mesh.hasVertexAlpha = true;
  }

  setMask(mask: QuadMask | null): void {
    if (this.disposed) return;
    const same = mask && this.mask && mask.texture === this.mask.texture;
    this.mask = mask;
    if (same && this.masked) {
      this.masked.plugin.mask.uv = Array.from(mask!.uv);
      return;
    }
    this.updateMaterial();
  }

  setLighting(lighting: QuadLighting | null): void {
    if (this.disposed) return;
    const same = lighting === this.lighting || (!!lighting && !!this.lighting && lighting.sortingLayer === this.lighting.sortingLayer && (lighting.normalMap ?? null) === (this.lighting.normalMap ?? null) && (lighting.maskMap ?? null) === (this.lighting.maskMap ?? null) && !!lighting.normalMapGreenDown === !!this.lighting.normalMapGreenDown && (lighting.material ?? null) === (this.lighting.material ?? null) && lighting.lit !== false === (this.lighting.lit !== false));
    this.lighting = lighting;
    if (!same) this.updateMaterial();
  }

  setBlend(blend: QuadBlend): void {
    if (this.disposed || blend === this.blend) return;
    this.blend = blend;
    this.updateMaterial();
  }

  setTangents(tangents: Float32Array | null): void {
    if (this.disposed) return;
    const mesh = this.mesh;
    if (!tangents) {
      if (this.tangents && mesh) mesh.removeVerticesData(TANGENT_2D_ATTRIBUTE);
      this.tangents = null;
      return;
    }
    const had = !!this.tangents && !!mesh?.isVerticesDataPresent(TANGENT_2D_ATTRIBUTE);
    this.tangents = tangents;
    if (mesh && tangents.length === (this.vertexFloats / 3) * 2) {
      if (had) mesh.updateVerticesData(TANGENT_2D_ATTRIBUTE, tangents);
      else mesh.setVerticesData(TANGENT_2D_ATTRIBUTE, tangents, true, 2);
    }
  }

  /** @internal Pick the lit material again (the layer batches changed). */
  refreshLighting(): void {
    if (this.lighting) this.updateMaterial();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh?.setEnabled(visible);
  }

  private updateMaterial(): void {
    if (!this.mesh) {
      this.releaseMaterial();
      this.releaseMasked();
      this.releaseGraphed();
      return;
    }
    const lit = this.owner.litSetup(this.lighting, () => this.updateMaterial());
    const litKey = lit?.key ?? "";
    // A sprite shader graph's material (ADR 0415), the batch's own; a masked batch (a clipped 2D decal) keeps the mask's.
    const graph = this.mask ? null : this.owner.spriteGraph(this.lighting);
    if (graph) {
      const key = `${spriteGraphKey(graph, this.texture, litKey)}|${this.blend}`;
      if (this.graphed?.key !== key) {
        this.releaseGraphed();
        const made = this.owner.graphMaterial(`quads:graph:${this.name}`, graph, this.texture, lit);
        if (made) {
          if (this.blend === "additive") made.material.alphaMode = Constants.ALPHA_ADD;
          this.graphed = { key, graph: made };
        }
      }
      if (this.graphed) {
        const m = this.graphed.graph.material as PBRMaterial;
        Color3.FromHexString(HEX.test(this.color) ? this.color.toLowerCase() : "#ffffff").toLinearSpaceToRef(m.albedoColor);
        m.alpha = Math.max(0, Math.min(1, this.opacity));
        this.releaseMasked();
        this.releaseMaterial();
        this.mesh.material = m;
        return;
      }
    }
    this.releaseGraphed();
    if (this.mask) {
      const key = `${this.texture}|${this.color}|${this.opacity}|${this.mask.texture}|${litKey}|${this.blend}`;
      if (this.masked?.key === key) {
        this.masked.plugin.mask.uv = Array.from(this.mask.uv);
      } else {
        this.releaseMasked();
        const made = this.owner.maskedMaterial(this.name, this.texture, this.color, this.opacity, this.mask, lit, this.blend);
        this.masked = { ...made, key };
      }
      this.releaseMaterial();
      this.mesh.material = this.masked.material;
      return;
    }
    this.releaseMasked();
    const { key, material } = this.owner.acquireMaterial(this.texture, this.color, this.opacity, lit, this.blend);
    this.releaseMaterial(); // after acquiring, so an unchanged key keeps its material alive
    this.materialKey = key;
    this.mesh.material = material;
  }

  private graphed: { key: string; graph: BabylonGraphMaterial } | null = null;

  private releaseGraphed(): void {
    if (!this.graphed) return;
    this.graphed.graph.dispose();
    this.graphed = null;
  }

  private releaseMasked(): void {
    if (!this.masked) return;
    this.masked.material.dispose();
    this.masked = null;
  }

  private releaseMaterial(): void {
    if (this.materialKey === null) return;
    this.owner.releaseMaterial(this.materialKey);
    this.materialKey = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh?.dispose();
    this.mesh = null;
    this.releaseMaterial();
    this.releaseMasked();
    this.releaseGraphed();
    this.owner.forget(this);
  }
}

const tmp = new Matrix();
