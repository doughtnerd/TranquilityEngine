/**
 * Quad batches on Babylon (ADR 0136, 0418): the backend half of `QuadBatchHost`. Each batch is one mesh. Like sprites,
 * quads are layered 2D quads: `layeredQuads.ts` gives them their place in the draw order (ADR 0014, 0186), and the 2D
 * materials (`materials2D.ts`) their material, from the batch's texture, material asset, sorting layer, blend, mask and
 * tint: shared by batches asking for the same, lit by the sorting layer's 2D lights or not, replaced in place when the
 * 2D lighting changes. Knows nothing of tiles or bones: the features (tiles, 2D lines and decals, skinned sprites with
 * `setTriangles`, updated in place each frame, light volumes) decide what the geometry is.
 *
 * A deforming mesh (`setTriangles`) whose material has a normal map gets a 2D tangent per vertex, worked out here from
 * its positions and UVs (`tangents2D`) each time it moves, so the normals follow its bones or its line; quads
 * (`setQuads`) turn their normal map by the batch's matrix.
 */
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { authoredSize } from "../../scene/importSettings";
import { tangents2D } from "../lights2D/tangents";
import type { QuadBatch, QuadBatchHost, QuadBlend, QuadMask } from "../quadBatches";
import { placeInLayer, withinOrder } from "./layeredQuads";
import { TANGENT_2D_ATTRIBUTE } from "./lights2DMaterial";
import type { BabylonMaterials2D, Material2D, Material2DRequest, Tint2D } from "./materials2D";

/** What the quad batches borrow from the renderer. */
export interface BabylonQuadBatchDeps {
  readonly scene: Scene;
  /** The 2D materials (ADR 0418): every batch's material. */
  readonly materials2D: BabylonMaterials2D;
  /** A loaded colour texture, or null (and it starts loading): `onReady` runs once it has (the material library's `texture`). */
  texture(path: string, onReady: () => void): Texture | null;
  /** Draw order for a sorting layer and order in layer (`sortingOrder`, warning once about an unknown layer). */
  sortOrder(sortingLayer: string, orderInLayer: number): number;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** @internal */
export class BabylonQuadBatches implements QuadBatchHost {
  private readonly batches = new Set<BabylonQuadBatch>();

  constructor(private readonly deps: BabylonQuadBatchDeps) {}

  createBatch(name: string): QuadBatch {
    const b = new BabylonQuadBatch(this, name);
    this.batches.add(b);
    return b;
  }

  textureSize(path: string, onLoad: () => void): readonly [number, number] | null {
    const tex = this.deps.texture(path, onLoad);
    if (!tex) return null;
    const base = tex.getBaseSize();
    return authoredSize(Assets.importSettings(path), base.width, base.height);
  }

  /** @internal The mesh a batch of these draws (ADR 0276: what a feature drew through them), or null while it has no quads or isn't one of these. */
  meshOf(batch: QuadBatch): Mesh | null {
    return batch instanceof BabylonQuadBatch && this.batches.has(batch) ? batch.mesh : null;
  }

  /** @internal */
  get scene(): Scene {
    return this.deps.scene;
  }

  /** @internal */
  get materials2D(): BabylonMaterials2D {
    return this.deps.materials2D;
  }

  /** @internal */
  sortOrder(sortingLayer: string, orderInLayer: number): number {
    return this.deps.sortOrder(sortingLayer, orderInLayer);
  }

  /** @internal */
  forget(b: BabylonQuadBatch): void {
    this.batches.delete(b);
  }

  dispose(): void {
    for (const b of [...this.batches]) b.dispose();
  }
}

class BabylonQuadBatch implements QuadBatch {
  mesh: Mesh | null = null;
  private texture = "";
  /** What the mesh was built from (`setTriangles` only moves the vertices of an updatable mesh with the same indices). */
  private indices: Uint32Array | null = null;
  private positions: Float32Array | null = null;
  private uvs: Float32Array | null = null;
  private vertexFloats = 0;
  private updatable = false;
  private tint: Tint2D = { r: 1, g: 1, b: 1, a: 1 };
  private color = "#ffffff";
  private opacity = 1;
  private blend: QuadBlend = "alpha";
  private mask: QuadMask | null = null;
  /** Its 2D material asset, or null: plain and unlit. */
  private materialAsset: string | null = null;
  private sortingLayer = "";
  /** Its material (ADR 0418) while it has a mesh. */
  private look: Material2D | null = null;
  /** The per-vertex tangents the mesh has, reused while the vertex count holds; null: none (the matrix turns the normal map). */
  private tangents: Float32Array | null = null;
  private readonly matrix = Matrix.Identity();
  private order = 0;
  private visible = false;
  private disposed = false;

  constructor(
    private readonly owner: BabylonQuadBatches,
    private readonly name: string,
  ) {}

  setQuads(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, colors?: Float32Array | null): void {
    this.build(texture, positions, uvs, indices, colors ?? null, false);
  }

  setTriangles(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, colors?: Float32Array | null): void {
    const mesh = this.mesh;
    if (mesh && this.updatable && texture === this.texture && indices === this.indices && positions.length === this.vertexFloats) {
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
      mesh.updateVerticesData(VertexBuffer.UVKind, uvs); // a 2D ribbon's texture moves along it (ADR 0396)
      this.positions = positions;
      this.uvs = uvs;
      this.applyColors(mesh, colors ?? null);
      this.applyTangents();
      return;
    }
    this.build(texture, positions, uvs, indices, colors ?? null, true);
  }

  private build(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array, colors: Float32Array | null, updatable: boolean): void {
    if (this.disposed) return;
    this.mesh?.dispose();
    this.mesh = null;
    this.tangents = null;
    this.texture = texture;
    this.indices = indices;
    this.positions = positions;
    this.uvs = uvs;
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
      this.applyColors(mesh, colors);
      mesh.alwaysSelectAsActiveMesh = true;
      placeInLayer(mesh, this.order);
      mesh.freezeWorldMatrix(this.matrix);
      mesh.setEnabled(this.visible);
      this.mesh = mesh;
    }
    this.updateMaterial();
  }

  /** Vertex colours to the mesh (sRGB to linear, what the PBR albedo multiplies; alpha as it is), or none. */
  private applyColors(mesh: Mesh, rgba: Float32Array | null): void {
    const has = mesh.isVerticesDataPresent(VertexBuffer.ColorKind);
    if (!rgba || rgba.length !== (this.vertexFloats / 3) * 4) {
      if (has) {
        mesh.removeVerticesData(VertexBuffer.ColorKind);
        mesh.hasVertexAlpha = false;
      }
      return;
    }
    const linear = new Float32Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      linear[i] = Math.pow(rgba[i]!, 2.2);
      linear[i + 1] = Math.pow(rgba[i + 1]!, 2.2);
      linear[i + 2] = Math.pow(rgba[i + 2]!, 2.2);
      linear[i + 3] = rgba[i + 3]!;
    }
    if (has) mesh.updateVerticesData(VertexBuffer.ColorKind, linear);
    else mesh.setVerticesData(VertexBuffer.ColorKind, linear, true, 4);
    mesh.hasVertexAlpha = true;
  }

  /** A deforming mesh with a normal map: its tangents from where it is now (ADR 0399); otherwise none. */
  private applyTangents(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    if (!this.updatable || !this.look?.normalMapped || !this.positions || !this.uvs || !this.indices) {
      if (this.tangents) mesh.removeVerticesData(TANGENT_2D_ATTRIBUTE);
      this.tangents = null;
      return;
    }
    const had = this.tangents;
    this.tangents = tangents2D(this.positions, this.uvs, this.indices, had ?? undefined);
    if (had && had === this.tangents) mesh.updateVerticesData(TANGENT_2D_ATTRIBUTE, this.tangents);
    else mesh.setVerticesData(TANGENT_2D_ATTRIBUTE, this.tangents, true, 2);
  }

  setMatrix(m: ArrayLike<number>, offset = 0): void {
    Matrix.FromArrayToRef(m as unknown as number[], offset, tmp);
    if (tmp.equals(this.matrix)) return;
    this.matrix.copyFrom(tmp);
    this.mesh?.freezeWorldMatrix(this.matrix);
  }

  setOrder(sortingLayer: string, orderInLayer: number, within = 0): void {
    if (this.disposed) return;
    this.order = this.owner.sortOrder(sortingLayer, orderInLayer) + withinOrder(within);
    if (this.mesh) placeInLayer(this.mesh, this.order);
    if (sortingLayer === this.sortingLayer) return;
    this.sortingLayer = sortingLayer;
    if (this.materialAsset !== null) this.updateMaterial(); // lit by that layer's 2D lights
  }

  setMaterial(material: string | null): void {
    if (this.disposed) return;
    this.materialAsset = material;
    this.updateMaterial(); // asked again each time: a material or graph edited since, or a sidecar's maps, take effect
  }

  setTint(color: string, opacity: number): void {
    if (this.disposed || (color === this.color && opacity === this.opacity)) return;
    this.color = color;
    this.opacity = opacity;
    const c = parseHex(color);
    this.tint = { r: c[0], g: c[1], b: c[2], a: opacity };
    this.updateMaterial();
  }

  setMask(mask: QuadMask | null): void {
    if (this.disposed) return;
    this.mask = mask;
    this.updateMaterial(); // the same mask texture keeps its material, its map moved in place
  }

  setBlend(blend: QuadBlend): void {
    if (this.disposed || blend === this.blend) return;
    this.blend = blend;
    this.updateMaterial();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh?.setEnabled(visible);
  }

  private request(): Material2DRequest {
    return { texture: this.texture, material: this.materialAsset, sortingLayer: this.sortingLayer, blend: this.blend, mask: this.mask, tint: this.tint };
  }

  private updateMaterial(): void {
    if (!this.mesh) {
      this.look?.release();
      this.look = null;
      return;
    }
    if (this.look) this.look.update(this.request());
    else this.look = this.owner.materials2D.acquire(this.request(), () => this.applyMaterial());
    this.applyMaterial();
  }

  /** The mesh draws with its material now (and has tangents when that has a normal map). */
  private applyMaterial(): void {
    const mesh = this.mesh;
    if (!mesh || !this.look) return;
    if (mesh.material !== this.look.material) mesh.material = this.look.material;
    if (!!this.tangents !== (this.updatable && this.look.normalMapped)) this.applyTangents();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh?.dispose();
    this.mesh = null;
    this.look?.release();
    this.look = null;
    this.owner.forget(this);
  }
}

/** `#rrggbb` as sRGB 0..1 (anything else white). */
function parseHex(color: string): [number, number, number] {
  if (!HEX.test(color)) return [1, 1, 1];
  const n = parseInt(color.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const tmp = new Matrix();
