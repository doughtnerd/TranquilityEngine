/**
 * Dynamic meshes on Babylon (ADR 0396): the backend half of `DynamicMeshHost`. Each mesh is one Babylon `Mesh` with
 * updatable buffers (vertex colours on); with ribbon data its material carries `MycoRibbonPlugin`, which turns the
 * vertices to each camera in the vertex shader. Materials are shared per look: the built-in line material (unlit,
 * alpha-blended, two-sided, the texture's colour and alpha) per texture, or one copy of a material asset or shader
 * graph per asset (the material library's `copy`, ADR 0127), never the asset itself. Depth-tested and sorted by Babylon
 * with the scene's other meshes. Knows nothing of lines or trails.
 */
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { DynamicGeometry, DynamicMesh, DynamicMeshHost } from "../dynamicMeshes";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import { pbr } from "./materials";
import { MycoRibbonPlugin, RIBBON_EXTENT, RIBBON_TANGENT } from "./ribbonPlugin";

/** What the dynamic meshes borrow from the renderer. */
export interface BabylonDynamicMeshDeps {
  readonly scene: Scene;
  readonly materials: BabylonMaterialLibrary;
  warnOnce(key: string, message: string): void;
}

interface SharedLook {
  material: Material | null;
  /** The material asset copy's own disposal, or the built-in material's. */
  dispose: (() => void) | null;
  /** Whether its material (and texture) has loaded. */
  ready: boolean;
  users: number;
}

/** @internal */
export class BabylonDynamicMeshes implements DynamicMeshHost {
  private readonly looks = new Map<string, SharedLook>();
  private readonly meshes = new Set<BabylonDynamicMesh>();

  constructor(private readonly deps: BabylonDynamicMeshDeps) {}

  createMesh(name: string): DynamicMesh {
    const m = new BabylonDynamicMesh(this, name);
    this.meshes.add(m);
    return m;
  }

  /** @internal The Babylon mesh a dynamic mesh of these draws, or null while it has no geometry or isn't one of these. */
  meshOf(mesh: DynamicMesh): Mesh | null {
    return mesh instanceof BabylonDynamicMesh && this.meshes.has(mesh) ? mesh.mesh : null;
  }

  /** Add the visible meshes that cast shadows (ADR 0276 casters; the renderer collects them after `content`). */
  casters(out: AbstractMesh[]): void {
    for (const m of this.meshes) if (m.casts()) out.push(m.mesh!);
  }

  /** @internal */
  get scene(): Scene {
    return this.deps.scene;
  }

  /** @internal The shared look for `key`, made (or retried, while its asset loads) now. */
  acquire(key: string, material: string, texture: string, ribbon: boolean): SharedLook {
    let look = this.looks.get(key);
    if (!look) {
      look = { material: null, dispose: null, ready: false, users: 0 };
      this.looks.set(key, look);
    }
    look.users++;
    this.build(look, material, texture, ribbon);
    return look;
  }

  /** Build a look's material if it isn't yet: an asset's copy once the asset has loaded, else the built-in line material. */
  build(look: SharedLook, material: string, texture: string, ribbon: boolean): void {
    if (look.material) {
      if (!look.ready) look.ready = look.material.isReady() !== false && this.textureReady(texture, material);
      return;
    }
    if (material) {
      const copy = this.deps.materials.copy(material, `line:${material}${ribbon ? ":ribbon" : ""}`);
      if (!copy) {
        if (!this.deps.materials.loading()) this.deps.warnOnce(`line-material|${material}`, `line material "${material}" couldn't be loaded; the line draws with the built-in line material.`);
        return;
      }
      if (ribbon) new MycoRibbonPlugin(copy.material);
      copy.material.backFaceCulling = false; // a ribbon is seen from both sides
      look.material = copy.material;
      look.dispose = () => copy.dispose();
      look.ready = true;
      return;
    }
    const m = pbr(`line:${texture || "plain"}${ribbon ? ":ribbon" : ""}`, this.deps.scene);
    m.unlit = true;
    m.backFaceCulling = false;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    m.useAlphaFromAlbedoTexture = true;
    m.metallic = 0;
    m.roughness = 1;
    if (ribbon) new MycoRibbonPlugin(m);
    look.material = m;
    let gone = false;
    look.dispose = () => {
      gone = true;
      m.dispose(false, false);
    };
    look.ready = !texture;
    if (texture) {
      const apply = (t: Texture | null): void => {
        if (!t || gone) return;
        t.hasAlpha = true;
        m.albedoTexture = t;
        look.ready = true;
      };
      apply(this.deps.materials.texture(texture, "color", apply));
    }
  }

  private textureReady(texture: string, material: string): boolean {
    return !!material || !texture || !!this.deps.materials.loadedTexture(texture);
  }

  /** @internal */
  release(key: string): void {
    const look = this.looks.get(key);
    if (!look || --look.users > 0) return;
    look.dispose?.();
    this.looks.delete(key);
  }

  /** @internal */
  forget(m: BabylonDynamicMesh): void {
    this.meshes.delete(m);
  }

  dispose(): void {
    for (const m of [...this.meshes]) m.dispose();
    for (const look of this.looks.values()) look.dispose?.();
    this.looks.clear();
  }
}

class BabylonDynamicMesh implements DynamicMesh {
  mesh: Mesh | null = null;
  private material = "";
  private texture = "";
  private lookKey: string | null = null;
  private look: SharedLook | null = null;
  private ribbon = false;
  /** What the buffers were made for: vertex count, index array, and which kinds of data. */
  private shape: { vertices: number; indices: Uint32Array; colors: boolean; ribbon: boolean } | null = null;
  private readonly matrix = Matrix.Identity();
  private castShadows = false;
  private receiveShadows = true;
  private visible = false;
  private disposed = false;

  constructor(
    private readonly owner: BabylonDynamicMeshes,
    private readonly name: string,
  ) {}

  setGeometry(g: DynamicGeometry): void {
    if (this.disposed) return;
    const vertices = g.positions.length / 3;
    const ribbon = !!g.ribbon;
    const colors = !!g.colors;
    const s = this.shape;
    if (this.mesh && s && s.vertices === vertices && s.indices === g.indices && s.colors === colors && s.ribbon === ribbon) {
      const mesh = this.mesh;
      mesh.updateVerticesData(VertexBuffer.PositionKind, g.positions);
      mesh.updateVerticesData(VertexBuffer.UVKind, g.uvs);
      mesh.updateVerticesData(VertexBuffer.NormalKind, g.normals ?? flatNormals(vertices));
      if (g.colors) mesh.updateVerticesData(VertexBuffer.ColorKind, linear(g.colors));
      if (g.ribbon) {
        mesh.updateVerticesData(RIBBON_TANGENT, g.ribbon.tangents);
        mesh.updateVerticesData(RIBBON_EXTENT, g.ribbon.extents);
      }
      this.refreshBounds(g);
      return;
    }
    this.mesh?.dispose(false, false);
    this.mesh = null;
    this.shape = null;
    if (g.indices.length < 3) return;
    const mesh = new Mesh(this.name, this.owner.scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, g.positions, true, 3);
    mesh.setVerticesData(VertexBuffer.UVKind, g.uvs, true, 2);
    mesh.setVerticesData(VertexBuffer.NormalKind, g.normals ?? flatNormals(vertices), true, 3);
    if (g.colors) {
      mesh.setVerticesData(VertexBuffer.ColorKind, linear(g.colors), true, 4);
      mesh.hasVertexAlpha = true;
    }
    if (g.ribbon) {
      mesh.setVerticesData(RIBBON_TANGENT, g.ribbon.tangents, true, 4);
      mesh.setVerticesData(RIBBON_EXTENT, g.ribbon.extents, true, 2);
    }
    mesh.setIndices(g.indices, null, true);
    mesh.freezeWorldMatrix(this.matrix);
    mesh.receiveShadows = this.receiveShadows;
    mesh.setEnabled(this.visible);
    this.mesh = mesh;
    this.shape = { vertices, indices: g.indices, colors, ribbon };
    this.refreshBounds(g);
    if (ribbon !== this.ribbon) {
      this.ribbon = ribbon;
      this.releaseLook();
    }
    this.applyLook();
  }

  /** Bounds around the centre line, grown by the widest half width (a camera-facing ribbon's vertices move by up to it). */
  private refreshBounds(g: DynamicGeometry): void {
    const mesh = this.mesh!;
    let grow = 0;
    if (g.ribbon) for (let i = 0; i < g.ribbon.extents.length; i += 2) grow = Math.max(grow, Math.abs(g.ribbon.extents[i]!) * (1 + Math.abs(g.ribbon.extents[i + 1]!)));
    mesh.refreshBoundingInfo();
    if (grow > 0) {
      const box = mesh.getBoundingInfo().boundingBox;
      const min = box.minimum.clone().subtractFromFloats(grow, grow, grow);
      const max = box.maximum.clone().addInPlaceFromFloats(grow, grow, grow);
      mesh.getBoundingInfo().reConstruct(min, max, mesh.getWorldMatrix());
    }
  }

  setLook(material: string, texture: string): void {
    if (this.disposed) return;
    if (material === this.material && texture === this.texture && this.look) {
      if (!this.look.ready || !this.look.material) {
        this.owner.build(this.look, material, texture, this.ribbon);
        if (this.mesh && this.look.material && this.mesh.material !== this.look.material) this.mesh.material = this.look.material;
      }
      return;
    }
    this.material = material;
    this.texture = texture;
    this.releaseLook();
    this.applyLook();
  }

  private applyLook(): void {
    if (!this.mesh) return;
    if (!this.look) {
      this.lookKey = `${this.material}|${this.texture}|${this.ribbon ? 1 : 0}`;
      this.look = this.owner.acquire(this.lookKey, this.material, this.texture, this.ribbon);
    }
    this.mesh.material = this.look.material;
  }

  private releaseLook(): void {
    if (this.lookKey !== null) this.owner.release(this.lookKey);
    this.lookKey = null;
    this.look = null;
  }

  setMatrix(m: ArrayLike<number>, offset = 0): void {
    Matrix.FromArrayToRef(m as unknown as number[], offset, tmp);
    if (tmp.equals(this.matrix)) return;
    this.matrix.copyFrom(tmp);
    this.mesh?.freezeWorldMatrix(this.matrix);
  }

  setShadows(cast: boolean, receive: boolean): void {
    this.castShadows = cast;
    this.receiveShadows = receive;
    if (this.mesh) this.mesh.receiveShadows = receive;
  }

  /** Whether it casts shadows now: visible, with geometry and a material. */
  casts(): boolean {
    return this.castShadows && this.visible && !!this.mesh && !!this.mesh.material;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.mesh?.setEnabled(visible);
  }

  loaded(): boolean {
    return !this.look || (this.look.ready && !!this.look.material);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh?.dispose(false, false);
    this.mesh = null;
    this.releaseLook();
    this.owner.forget(this);
  }
}

const tmp = new Matrix();

/** Normals for geometry that gave none: +Z (a ribbon's are set in the shader). */
function flatNormals(vertices: number): Float32Array {
  const n = new Float32Array(vertices * 3);
  for (let i = 2; i < n.length; i += 3) n[i] = 1;
  return n;
}

/** sRGB RGBA to linear RGB with alpha as it is (what the PBR albedo multiplies). */
function linear(rgba: Float32Array): Float32Array {
  const out = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = Math.pow(rgba[i]!, 2.2);
    out[i + 1] = Math.pow(rgba[i + 1]!, 2.2);
    out[i + 2] = Math.pow(rgba[i + 2]!, 2.2);
    out[i + 3] = rgba[i + 3]!;
  }
  return out;
}
