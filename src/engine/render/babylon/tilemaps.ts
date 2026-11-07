/**
 * Tilemap drawing on Babylon (ADR 0103). Each layer's chunk becomes one mesh per texture (usually
 * one), rebuilt only when the chunk's cells, the tileset, a texture or an image's slices change.
 * Like sprites, tile meshes draw in sorting-layer order without depth testing (ADR 0014).
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { Assets, sidecarValue } from "../../scene/Assets";
import { authoredSize, findSlice, splitSpriteRef } from "../../scene/importSettings";
import { buildChunkMeshes, type TileFrame } from "../../tilemap/mesh";
import { Tilemap } from "../../tilemap/Tilemap";
import { tileAnchor, type Tileset } from "../../tilemap/tileset";
import { pbr } from "./materials";

/** What the tilemap drawing borrows from the renderer. */
export interface TilemapHost {
  readonly scene: Scene;
  /** A loaded texture, or null (and it starts loading) — `onLoad` runs once it has. */
  texture(path: string, onLoad: () => void): Texture | null;
  sortOrder(layer: string, order: number): number;
}

interface ChunkEntry {
  version: number;
  framesVersion: number;
  meshes: Mesh[];
}

interface LayerEntry {
  chunks: Map<string, ChunkEntry>;
  materials: Map<string, PBRMaterial>;
}

interface MapEntry {
  layers: LayerEntry[];
  tileset: Tileset | null;
  /** Goes up when frames may have changed: a texture loaded, the tileset or an image's slices changed. */
  framesVersion: number;
  /** Each image's sidecar when frames were last resolved. */
  sidecars: Map<string, object | undefined>;
  frames: Map<number, TileFrame | null>;
  matrix: Matrix | null;
}

const tmp = new Matrix();

/** @internal */
export class BabylonTilemaps {
  private readonly maps = new Map<Tilemap, MapEntry>();

  constructor(private readonly host: TilemapHost) {}

  sync(world: World): void {
    for (const map of world._componentsOfType(Tilemap)) this.syncMap(world, map);
  }

  /** @internal Meshes drawn for a tilemap (tests and editor picking). */
  meshesOf(map: Tilemap): Mesh[] {
    const e = this.maps.get(map);
    if (!e) return [];
    return e.layers.flatMap((l) => [...l.chunks.values()].flatMap((c) => c.meshes));
  }

  private syncMap(world: World, map: Tilemap): void {
    let entry = this.maps.get(map);
    if (!entry) {
      entry = { layers: [], tileset: null, framesVersion: 1, sidecars: new Map(), frames: new Map(), matrix: null };
      this.maps.set(map, entry);
    }
    const layers = map._layers();
    const active = map.isActiveAndEnabled;
    const tileset = map.tilesetAsset;
    if (tileset !== entry.tileset) {
      entry.tileset = tileset;
      this.invalidateFrames(entry);
    }
    for (const [image, value] of entry.sidecars) {
      if (sidecarValue(image) !== value) {
        this.invalidateFrames(entry);
        break;
      }
    }
    // Drop layers that went away.
    while (entry.layers.length > layers.length) this.disposeLayer(entry.layers.pop()!);

    const e = map.node.entity;
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as number[], e * 16, tmp);
    const moved = !entry.matrix || !entry.matrix.equals(tmp);
    if (moved) (entry.matrix ??= new Matrix()).copyFrom(tmp);

    layers.forEach((layer, li) => {
      let le = entry!.layers[li];
      if (!le) entry!.layers[li] = le = { chunks: new Map(), materials: new Map() };
      const visible = active && layer.meta.visible && !!tileset;
      const order = this.host.sortOrder(layer.meta.sortingLayer, layer.meta.orderInLayer);
      for (const [key, ce] of le.chunks) {
        if (!layer.chunks.has(key)) {
          for (const m of ce.meshes) m.dispose();
          le.chunks.delete(key);
        }
      }
      if (visible) {
        for (const [key, chunk] of layer.chunks) {
          let ce = le.chunks.get(key);
          if (ce && ce.version === chunk.version && ce.framesVersion === entry!.framesVersion) continue;
          if (ce) for (const m of ce.meshes) m.dispose();
          ce = { version: chunk.version, framesVersion: entry!.framesVersion, meshes: [] };
          le.chunks.set(key, ce);
          const built = buildChunkMeshes(chunk.cells, chunk.cx, chunk.cy, map.cellSize, (id) => this.frame(entry!, map, id));
          for (const b of built) {
            const mesh = new Mesh(`tilemap:${map.node.name}:${li}:${key}`, this.host.scene);
            const data = new VertexData();
            data.positions = b.positions;
            data.uvs = b.uvs;
            data.indices = b.indices;
            data.normals = new Float32Array(b.quads * 12).map((_, i) => (i % 3 === 2 ? 1 : 0));
            data.applyToMesh(mesh, false);
            mesh.material = this.material(le, b.texture, map);
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.freezeWorldMatrix(entry!.matrix!);
            ce.meshes.push(mesh);
          }
        }
      }
      for (const [texture, m] of le.materials) {
        const tex = this.host.texture(texture, () => {});
        if (tex && m.albedoTexture !== tex) {
          tex.hasAlpha = true;
          m.albedoTexture = tex;
        }
        const c = Color3.FromHexString(/^#[0-9a-f]{6}$/i.test(layer.meta.tint) ? layer.meta.tint : "#ffffff");
        c.toLinearSpaceToRef(m.albedoColor);
        m.alpha = Math.max(0, Math.min(1, layer.meta.opacity));
      }
      for (const ce of le.chunks.values()) {
        for (const m of ce.meshes) {
          m.setEnabled(visible);
          m.alphaIndex = order;
          if (moved) m.freezeWorldMatrix(entry!.matrix!);
        }
      }
    });
  }

  private invalidateFrames(entry: MapEntry): void {
    entry.framesVersion++;
    entry.frames.clear();
    entry.sidecars.clear();
  }

  /** A tile's texture, UVs and size in cells; null while its texture loads or if it has no sprite. */
  private frame(entry: MapEntry, map: Tilemap, id: number): TileFrame | null {
    if (entry.frames.has(id)) return entry.frames.get(id)!;
    const def = entry.tileset?.tile(id);
    if (!def?.sprite) return null;
    const { path, slice } = splitSpriteRef(def.sprite);
    if (!Assets.has(path)) return null;
    entry.sidecars.set(path, sidecarValue(path));
    const tex = this.host.texture(path, () => this.invalidateFrames(entry));
    if (!tex) return null; // loading; frames are resolved again once it has
    const base = tex.getBaseSize();
    const [width, height] = authoredSize(Assets.importSettings(path), base.width, base.height); // a build may have shrunk the image (ADR 0119)
    const [tw, th] = entry.tileset!.tileSize;
    let rect: [number, number, number, number] = [0, 0, width, height];
    if (slice !== null) {
      const s = findSlice(Assets.importSettings(path), slice);
      if (s) rect = s.rect;
      else console.warn(`[myco] ${map.node.name}: tile ${id}'s image ${path} has no slice "${slice}".`);
    }
    const [x, y, w, h] = rect;
    // Pull the UVs in by a hundredth of a texel so neighbouring tiles in the atlas don't bleed in.
    const ix = 0.01 / width, iy = 0.01 / height;
    const frame: TileFrame = { texture: path, uv: [x / width + ix, 1 - (y + h) / height + iy, (x + w) / width - ix, 1 - y / height - iy], size: [w / tw, h / th] };
    const anchor = tileAnchor(entry.tileset!.data, def); // ADR 0119
    if (anchor[0] !== 0 || anchor[1] !== 0) frame.anchor = anchor;
    entry.frames.set(id, frame);
    return frame;
  }

  private material(le: LayerEntry, texture: string, map: Tilemap): PBRMaterial {
    let m = le.materials.get(texture);
    if (m) return m;
    m = pbr(`tilemap:${map.node.name}:${texture}`, this.host.scene);
    m.unlit = true;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    m.depthFunction = Constants.ALWAYS;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    m.useAlphaFromAlbedoTexture = true;
    le.materials.set(texture, m);
    return m;
  }

  private disposeLayer(le: LayerEntry): void {
    for (const ce of le.chunks.values()) for (const m of ce.meshes) m.dispose();
    for (const m of le.materials.values()) m.dispose();
    le.chunks.clear();
    le.materials.clear();
  }

  release(map: Tilemap): void {
    const e = this.maps.get(map);
    if (!e) return;
    for (const l of e.layers) this.disposeLayer(l);
    this.maps.delete(map);
  }

  dispose(): void {
    for (const map of [...this.maps.keys()]) this.release(map);
  }
}
