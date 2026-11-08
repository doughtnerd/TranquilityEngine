/**
 * Quad batches on Babylon (ADR 0136): the backend half of `QuadBatchHost`. Each batch is one mesh; its
 * material is shared by every batch with the same texture, tint and opacity. Like sprites, quads draw in
 * sorting-layer order (`alphaIndex`) without depth testing (ADR 0014). Knows nothing of tiles: the
 * Tilemaps plugin's tile renderer decides what the quads are.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { authoredSize } from "../../scene/importSettings";
import type { QuadBatch, QuadBatchHost } from "../quadBatches";
import { pbr } from "./materials";

/** What the quad batches borrow from the renderer. */
export interface BabylonQuadBatchDeps {
  readonly scene: Scene;
  /** A loaded texture, or null (and it starts loading): `onLoad` runs once it has. */
  texture(path: string, onLoad: () => void): Texture | null;
  sortOrder(layer: string, order: number): number;
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
    const tex = this.deps.texture(path, onLoad);
    if (!tex) return null;
    const base = tex.getBaseSize();
    return authoredSize(Assets.importSettings(path), base.width, base.height);
  }

  sortOrder(sortingLayer: string, orderInLayer: number): number {
    return this.deps.sortOrder(sortingLayer, orderInLayer);
  }

  /** @internal The meshes of the live batches (tests and editor queries). */
  meshes(): Mesh[] {
    return [...this.batches].flatMap((b) => (b.mesh ? [b.mesh] : []));
  }

  /** @internal */
  get scene(): Scene {
    return this.deps.scene;
  }

  /** @internal A shared material for `texture` tinted `color` at `opacity`; give it back with `releaseMaterial`. */
  acquireMaterial(texture: string, color: string, opacity: number): { key: string; material: PBRMaterial } {
    const hex = HEX.test(color) ? color.toLowerCase() : "#ffffff";
    const alpha = Math.max(0, Math.min(1, opacity));
    const key = `${texture}|${hex}|${alpha}`;
    let shared = this.materials.get(key);
    if (!shared) {
      const m = pbr(`quads:${key}`, this.deps.scene);
      m.unlit = true;
      m.backFaceCulling = false;
      m.disableDepthWrite = true;
      m.depthFunction = Constants.ALWAYS;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      m.useAlphaFromAlbedoTexture = true;
      Color3.FromHexString(hex).toLinearSpaceToRef(m.albedoColor);
      m.alpha = alpha;
      const apply = (tex: Texture | null): void => {
        if (!tex || m.albedoTexture === tex) return;
        tex.hasAlpha = true;
        m.albedoTexture = tex;
      };
      apply(this.deps.texture(texture, () => apply(this.deps.texture(texture, () => {}))));
      shared = { material: m, users: 0 };
      this.materials.set(key, shared);
    }
    shared.users++;
    return { key, material: shared.material };
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
  private color = "#ffffff";
  private opacity = 1;
  private materialKey: string | null = null;
  private readonly matrix = Matrix.Identity();
  private order = 0;
  private visible = false;
  private disposed = false;

  constructor(
    private readonly owner: BabylonQuadBatches,
    private readonly name: string,
  ) {}

  setQuads(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array): void {
    if (this.disposed) return;
    this.mesh?.dispose();
    this.mesh = null;
    this.texture = texture;
    const quads = indices.length / 6;
    if (quads > 0) {
      const mesh = new Mesh(this.name, this.owner.scene);
      const data = new VertexData();
      data.positions = positions;
      data.uvs = uvs;
      data.indices = indices;
      data.normals = new Float32Array(quads * 12).map((_, i) => (i % 3 === 2 ? 1 : 0));
      data.applyToMesh(mesh, false);
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.alphaIndex = this.order;
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
    if (this.mesh) this.mesh.alphaIndex = order;
  }

  setTint(color: string, opacity: number): void {
    if (color === this.color && opacity === this.opacity) return;
    this.color = color;
    this.opacity = opacity;
    this.updateMaterial();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh?.setEnabled(visible);
  }

  private updateMaterial(): void {
    if (!this.mesh) {
      this.releaseMaterial();
      return;
    }
    const { key, material } = this.owner.acquireMaterial(this.texture, this.color, this.opacity);
    this.releaseMaterial(); // after acquiring, so an unchanged key keeps its material alive
    this.materialKey = key;
    this.mesh.material = material;
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
    this.owner.forget(this);
  }
}

const tmp = new Matrix();
