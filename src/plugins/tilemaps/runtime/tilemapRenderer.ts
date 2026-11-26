/**
 * Tilemap drawing (ADR 0103, 0136), renderer-neutral: each layer's chunk becomes one quad batch per
 * texture (usually one), rebuilt only when the chunk's cells, the map's grid (cell size and shape), the tileset, a
 * texture or an image's slices change. On non-square grids (ADR 0421) a layer's chunks also carry a painter's order
 * among themselves (`QuadBatch.setOrder`'s `within`): back chunks (higher on screen) first. The renderer core draws the batches (`QuadBatchHost`); this module knows tiles, the renderer
 * knows quads. Like sprites, tiles draw in sorting-layer order without depth testing (ADR 0014). It is the Tilemaps
 * plugin's render feature (ADR 0130, 0418), built by the factory below from the renderer's quad batches.
 * No Babylon here (ADR 0075): it's unit-tested against a fake host.
 */
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import type { BabylonFeature, BabylonFeatureFactory, DrawnNode } from "../../../engine/render/babylon/feature";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { sortingOrder } from "../../../engine/render/sortOrder";
import { Assets, sidecarValue } from "../../../engine/scene/Assets";
import { findSlice, splitSpriteRef } from "../../../engine/scene/importSettings";
import { CHUNK_SIZE, parseChunkKey } from "./format";
import type { TileGrid } from "./grids";
import { buildChunkMeshes, type TileFrame } from "./mesh";
import { Tilemap } from "./Tilemap";
import { tileAnchor, type Tileset } from "./tileset";

interface ChunkEntry {
  version: number;
  framesVersion: number;
  /** The grid its vertices were laid out on (`Tilemap._gridKey()`: cell size and shape). */
  grid: string;
  batches: QuadBatch[];
}

interface LayerEntry {
  chunks: Map<string, ChunkEntry>;
  /** Whether the last sync drew it, and in what draw order. */
  visible: boolean;
  order: number;
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

/** @internal Tilemaps: the Tilemaps plugin's render feature. Syncs after sprites and before meshes (`after` constraints, ADR 0135). */
export class TilemapRenderer implements BabylonFeature {
  private readonly maps = new Map<Tilemap, MapEntry>();

  constructor(private readonly host: QuadBatchHost) {}

  sync(world: World): void {
    for (const map of world._componentsOfType(Tilemap)) this.syncMap(world, map);
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

    const grid = map._grid();
    const gridKey = map._gridKey();
    layers.forEach((layer, li) => {
      let le = entry!.layers[li];
      const visible = active && layer.meta.visible && !!tileset;
      const { sortingLayer, orderInLayer } = layer.meta;
      const order = sortingOrder(world.settings.render.sortingLayers, sortingLayer, orderInLayer); // the batches warn about an unknown layer
      if (!le) entry!.layers[li] = le = { chunks: new Map(), visible, order };
      le.visible = visible;
      le.order = order;
      for (const [key, ce] of le.chunks) {
        if (!layer.chunks.has(key)) {
          for (const b of ce.batches) b.dispose();
          le.chunks.delete(key);
        }
      }
      if (visible) {
        for (const [key, chunk] of layer.chunks) {
          let ce = le.chunks.get(key);
          if (ce && ce.version === chunk.version && ce.framesVersion === entry!.framesVersion && ce.grid === gridKey) continue;
          if (ce) for (const b of ce.batches) b.dispose();
          ce = { version: chunk.version, framesVersion: entry!.framesVersion, grid: gridKey, batches: [] };
          le.chunks.set(key, ce);
          const built = buildChunkMeshes(chunk.cells, chunk.cx, chunk.cy, grid, (n) => this.frame(entry!, map, map._tileIdAt(li, n)));
          for (const m of built) {
            const batch = this.host.createBatch(`tilemap:${map.node.name}:${li}:${key}`);
            batch.setMaterial(map.material); // ADR 0399
            batch.setMatrix(entry!.matrix!);
            batch.setTint(layer.meta.tint, layer.meta.opacity);
            batch.setVisible(visible);
            batch.setQuads(m.texture, m.positions, m.uvs, m.indices);
            ce.batches.push(batch);
          }
        }
      }
      const within = grid.shape === "square" ? null : paintersOrder(le.chunks, grid);
      for (const [key, ce] of le.chunks) {
        const w = within?.get(key);
        for (const b of ce.batches) {
          b.setVisible(visible);
          if (w === undefined) b.setOrder(sortingLayer, orderInLayer);
          else b.setOrder(sortingLayer, orderInLayer, w);
          b.setTint(layer.meta.tint, layer.meta.opacity);
          b.setMaterial(map.material);
          if (moved) b.setMatrix(entry!.matrix!);
        }
      }
    });
  }

  /**
   * ADR 0276: each tile layer drawn now (visible, with tiles), in map then layer order, as its quad batches in its draw
   * order (tiles are picked like sprites: by layer, not depth).
   */
  *drawn(): Iterable<DrawnNode> {
    for (const [map, entry] of this.maps) {
      for (const le of entry.layers) {
        if (!le.visible) continue;
        const batches: QuadBatch[] = [];
        for (const ce of le.chunks.values()) batches.push(...ce.batches);
        if (batches.length) yield { component: map, shape: { kind: "quads", batches }, order: le.order };
      }
    }
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

  release(c: Component): void {
    const e = c instanceof Tilemap ? this.maps.get(c) : undefined;
    if (!e) return;
    for (const l of e.layers) disposeLayer(l);
    this.maps.delete(c as Tilemap);
  }

  dispose(): void {
    for (const map of [...this.maps.keys()]) this.release(map);
  }
}

/**
 * A non-square layer's chunks in painter's order (ADR 0421): each chunk's place in [0, 1), back chunks (the higher
 * `drawKey` of their first cell is lower: higher on screen) first. Ties keep a fixed order by chunk position.
 */
function paintersOrder(chunks: Map<string, ChunkEntry>, grid: TileGrid): Map<string, number> {
  const keyed = [...chunks.keys()].map((key) => {
    const [cx, cy] = parseChunkKey(key)!;
    return { key, cx, cy, draw: grid.drawKey(cx * CHUNK_SIZE, cy * CHUNK_SIZE) };
  });
  keyed.sort((a, b) => a.draw - b.draw || a.cy - b.cy || a.cx - b.cx);
  return new Map(keyed.map((k, i) => [k.key, i / keyed.length]));
}

function disposeLayer(le: LayerEntry): void {
  for (const ce of le.chunks.values()) for (const b of ce.batches) b.dispose();
  le.chunks.clear();
}

/** @internal Builds the feature from the renderer's shared services: only the quad batches. */
export const createTilemapsFeature: BabylonFeatureFactory = (host) => new TilemapRenderer(host.quads);
