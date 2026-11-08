/**
 * Tilemap drawing (ADR 0103, 0136), renderer-neutral: each layer's chunk becomes one quad batch per
 * texture (usually one), rebuilt only when the chunk's cells, the tileset, a texture or an image's slices
 * change. The renderer core draws the batches (`QuadBatchHost`); this module knows tiles, the renderer
 * knows quads. Like sprites, tiles draw in sorting-layer order without depth testing (ADR 0014).
 * No Babylon here (ADR 0075): it's unit-tested against a fake host.
 */
import type { World } from "../../../engine/core/World";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { Assets, sidecarValue } from "../../../engine/scene/Assets";
import { findSlice, splitSpriteRef } from "../../../engine/scene/importSettings";
import { buildChunkMeshes, type TileFrame } from "./mesh";
import { Tilemap } from "./Tilemap";
import { tileAnchor, type Tileset } from "./tileset";

interface ChunkEntry {
  version: number;
  framesVersion: number;
  batches: QuadBatch[];
}

interface LayerEntry {
  chunks: Map<string, ChunkEntry>;
}

interface MapEntry {
  layers: LayerEntry[];
  tileset: Tileset | null;
  /** Goes up when frames may have changed: a texture loaded, the tileset or an image's slices changed. */
  framesVersion: number;
  /** Each image's sidecar when frames were last resolved. */
  sidecars: Map<string, object | undefined>;
  frames: Map<number, TileFrame | null>;
  /** The node's world matrix when last applied. */
  matrix: Float32Array | null;
}

/** @internal */
export class TilemapRenderer {
  private readonly maps = new Map<Tilemap, MapEntry>();

  constructor(private readonly host: QuadBatchHost) {}

  sync(world: World): void {
    for (const map of world._componentsOfType(Tilemap)) this.syncMap(world, map);
  }

  /** @internal The batches drawn for a tilemap (tests). */
  batchesOf(map: Tilemap): QuadBatch[] {
    const e = this.maps.get(map);
    if (!e) return [];
    return e.layers.flatMap((l) => [...l.chunks.values()].flatMap((c) => c.batches));
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
    while (entry.layers.length > layers.length) disposeLayer(entry.layers.pop()!);

    const e = map.node.entity;
    const wm = world.worldMatrix(e);
    let moved = !entry.matrix;
    if (entry.matrix) for (let i = 0; i < 16 && !moved; i++) moved = entry.matrix[i] !== wm[e * 16 + i];
    if (moved) entry.matrix = wm.slice(e * 16, e * 16 + 16);

    layers.forEach((layer, li) => {
      let le = entry!.layers[li];
      if (!le) entry!.layers[li] = le = { chunks: new Map() };
      const visible = active && layer.meta.visible && !!tileset;
      const order = this.host.sortOrder(layer.meta.sortingLayer, layer.meta.orderInLayer);
      for (const [key, ce] of le.chunks) {
        if (!layer.chunks.has(key)) {
          for (const b of ce.batches) b.dispose();
          le.chunks.delete(key);
        }
      }
      if (visible) {
        for (const [key, chunk] of layer.chunks) {
          let ce = le.chunks.get(key);
          if (ce && ce.version === chunk.version && ce.framesVersion === entry!.framesVersion) continue;
          if (ce) for (const b of ce.batches) b.dispose();
          ce = { version: chunk.version, framesVersion: entry!.framesVersion, batches: [] };
          le.chunks.set(key, ce);
          const built = buildChunkMeshes(chunk.cells, chunk.cx, chunk.cy, map.cellSize, (id) => this.frame(entry!, map, id));
          for (const m of built) {
            const batch = this.host.createBatch(`tilemap:${map.node.name}:${li}:${key}`);
            batch.setOrder(order);
            batch.setMatrix(entry!.matrix!);
            batch.setTint(layer.meta.tint, layer.meta.opacity);
            batch.setVisible(visible);
            batch.setQuads(m.texture, m.positions, m.uvs, m.indices);
            ce.batches.push(batch);
          }
        }
      }
      for (const ce of le.chunks.values()) {
        for (const b of ce.batches) {
          b.setVisible(visible);
          b.setOrder(order);
          b.setTint(layer.meta.tint, layer.meta.opacity);
          if (moved) b.setMatrix(entry!.matrix!);
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
    const size = this.host.textureSize(path, () => this.invalidateFrames(entry));
    if (!size) return null; // loading; frames are resolved again once it has
    const [width, height] = size; // authored size: a build may have shrunk the image (ADR 0119)
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

  release(map: Tilemap): void {
    const e = this.maps.get(map);
    if (!e) return;
    for (const l of e.layers) disposeLayer(l);
    this.maps.delete(map);
  }

  dispose(): void {
    for (const map of [...this.maps.keys()]) this.release(map);
  }
}

function disposeLayer(le: LayerEntry): void {
  for (const ce of le.chunks.values()) for (const b of ce.batches) b.dispose();
  le.chunks.clear();
}
