/**
 * Tilemap drawing (ADR 0103, 0136), renderer-neutral: each layer's chunk becomes one quad batch per
 * texture (usually one), rebuilt only when the chunk's cells, the map's grid (cell size and shape), the tileset, a
 * texture or an image's slices change. The renderer core draws the batches (`QuadBatchHost`); this module knows tiles,
 * the renderer knows quads. Like sprites, tiles draw in sorting-layer order without depth testing (ADR 0014). It is the
 * Tilemaps plugin's render feature (ADR 0130, 0418), built by the factory below from the renderer's quad batches.
 * No Babylon here (ADR 0075): it's unit-tested against a fake host.
 *
 * - **Painter's order** (ADR 0421). On non-square grids a layer's batches carry a place among themselves
 *   (`QuadBatch.setOrder`'s `within`): back chunks (higher on screen) first, and a chunk's batches of several
 *   textures in consecutive sub-steps after one another. Inside one chunk, then, the textures don't interleave
 *   row by row: a tall tile of a later texture draws over the tiles of an earlier texture in front of it. That is
 *   approximate, and exact for the usual one texture per layer; a y-sorted layer (below) splits by row and is exact.
 * - **Animated tiles** (ADR 0421). A tile's frames are resolved like its sprite and must come from the same image
 *   (another image's frame draws the tile's own sprite, with a warning). Each chunk keeps its animated quads and the
 *   animation time of its next frame change; when a frame changes, those quads are rewritten in the same arrays and the
 *   batch is called again, which the backend takes as an in-place vertex update. On square grids a chunk's animated
 *   tiles have their own batch per texture, so static tiles are never uploaded again; on other grids they stay in the
 *   chunk's batch, where painter's order spans both. Time is the World's scaled time × `Tilemap.animationSpeed`; the
 *   editor's edit World (`World.kind` "editor") shows every tile's first frame.
 * - **Offset and parallax** (ADR 0425) are in each layer's batch matrix: the node's world matrix, shifted by the layer's
 *   offset (in local units), plus `(1 − parallax) × (view camera − node)` in world units, so neither rebuilds a chunk.
 *   The view camera is the one that draws the view (`BabylonFeatureHost.viewCamera`), read through `ViewPosition`.
 * - **Y-sorted layers** (ADR 0424). On a y-sorted sorting layer each chunk draws one batch per row and texture (split
 *   further by the tiles' `sortOffset`), each at its sort point's world height (`ySortWithin`): the bottom of the row's
 *   cell boxes on square grids, the row's bottom corner on the others, raised by `sortOffset` cells.
 * - **Dim inactive layers** (ADR 0425): a layer's opacity is multiplied by the Tilemap's view-only factor
 *   (`Tilemap._setViewOpacity`, the editor's).
 */
import type { Component } from "../../../engine/core/Component";
import type { World } from "../../../engine/core/World";
import type { BabylonFeature, BabylonFeatureFactory, DrawnNode } from "../../../engine/render/babylon/feature";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { isYSorted, sortingOrder, ySortWithin } from "../../../engine/render/sortOrder";
import { Assets, sidecarValue } from "../../../engine/scene/Assets";
import { findSlice, splitSpriteRef } from "../../../engine/scene/importSettings";
import { ANIMATION_STREAM, cellRandom } from "./cellHash";
import { CHUNK_SIZE, flagsOf, parseChunkKey, tileIdOf } from "./format";
import type { TileGrid } from "./grids";
import { buildChunkMeshes, writeTileQuad, type ChunkMesh, type TileFrame } from "./mesh";
import { Tilemap } from "./Tilemap";
import { tileAnchor, type TileDef, type Tileset } from "./tileset";

/** @internal The world position (x, y) of the camera that draws the view, or null when there is none (ADR 0425 parallax). */
export type ViewPosition = (world: World) => readonly [number, number] | null;

/** A tile's resolved frames (ADR 0421). */
interface TileAnim {
  frames: TileFrame[];
  /** Each frame's end time within one loop (seconds, increasing); the last is `total`. */
  ends: number[];
  total: number;
  random: boolean;
}

/** What a tile draws: its sprite, and its animation if it has one. */
interface TileLook {
  base: TileFrame;
  anim: TileAnim | null;
}

/** One animated tile's quad in a batch. */
interface AnimatedQuad {
  q: number;
  x: number;
  y: number;
  flags: number;
  anim: TileAnim;
  /** Its start offset into the loop (seconds; `start: "random"`). */
  offset: number;
  /** The frame its quad shows now. */
  frame: number;
}

interface BatchEntry {
  batch: QuadBatch;
  mesh: ChunkMesh;
  /** A y-sorted layer's batch: its sort point in local units, before the layer's offset. */
  sortPoint: readonly [number, number] | null;
  animated: AnimatedQuad[];
}

interface ChunkEntry {
  version: number;
  framesVersion: number;
  /** The grid its vertices were laid out on (`Tilemap._gridKey()`: cell size and shape). */
  grid: string;
  /** Whether it was built split by rows (a y-sorted layer, ADR 0424). */
  ySorted: boolean;
  /** The `variantSeed` its random animation offsets came from, when it has any. */
  seed: number | null;
  batches: BatchEntry[];
  /** The animation time its next frame changes at (Infinity: never), and the time it was last brought up to. */
  next: number;
  last: number;
}

interface LayerEntry {
  chunks: Map<string, ChunkEntry>;
  /** Whether the last sync drew it, and in what draw order. */
  visible: boolean;
  order: number;
  /** The batches' matrix when last applied: the node's, with the layer's offset and parallax. */
  matrix: Float32Array | null;
}

interface MapEntry {
  layers: LayerEntry[];
  tileset: Tileset | null;
  /** Goes up when frames may have changed: a texture loaded, the tileset or an image's slices changed. */
  framesVersion: number;
  /** Each image's sidecar when frames were last resolved. */
  sidecars: Map<string, object | undefined>;
  looks: Map<number, TileLook | null>;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${message}`);
}

/** @internal Tilemaps: the Tilemaps plugin's render feature. Syncs after sprites and before meshes (`after` constraints, ADR 0135). */
export class TilemapRenderer implements BabylonFeature {
  private readonly maps = new Map<Tilemap, MapEntry>();

  /** `viewPosition`: where the view camera is, for parallax layers (ADR 0425); without it they draw as if parallax were 1. */
  constructor(
    private readonly host: QuadBatchHost,
    private readonly viewPosition: ViewPosition = () => null,
  ) {}

  sync(world: World): void {
    let view: readonly [number, number] | null | undefined;
    const viewOf = () => (view === undefined ? (view = this.viewPosition(world)) : view);
    for (const map of world._componentsOfType(Tilemap)) this.syncMap(world, map, viewOf);
  }

  private syncMap(world: World, map: Tilemap, viewOf: () => readonly [number, number] | null): void {
    let entry = this.maps.get(map);
    if (!entry) {
      entry = { layers: [], tileset: null, framesVersion: 1, sidecars: new Map(), looks: new Map() };
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
    const wm = world.worldMatrix(e).subarray(e * 16, e * 16 + 16);
    const grid = map._grid();
    const gridKey = map._gridKey();
    const render = world.settings.render;
    // ADR 0421: animation time; the edit World shows first frames (null).
    const speed = Number.isFinite(map.animationSpeed) ? map.animationSpeed : 0;
    const time = world.kind === "editor" ? null : world.time.time * speed;
    const seed = map.variantSeed;
    layers.forEach((layer, li) => {
      let le = entry!.layers[li];
      const visible = active && layer.meta.visible && !!tileset;
      const { sortingLayer, orderInLayer } = layer.meta;
      const order = sortingOrder(render.sortingLayers, sortingLayer, orderInLayer); // the batches warn about an unknown layer
      if (!le) entry!.layers[li] = le = { chunks: new Map(), visible, order, matrix: null };
      le.visible = visible;
      le.order = order;
      const ySorted = isYSorted(render, sortingLayer);
      const matrix = layerMatrix(wm, layer.meta.offset, layer.meta.parallax, layer.meta.parallax ? viewOf() : null, scratchMatrix);
      const moved = !le.matrix || !sameMatrix(le.matrix, matrix);
      if (moved) (le.matrix ??= new Float32Array(16)).set(matrix);
      const opacity = layer.meta.opacity * map._viewOpacity(li);
      for (const [key, ce] of le.chunks) {
        if (!layer.chunks.has(key)) {
          disposeChunk(ce);
          le.chunks.delete(key);
        }
      }
      if (visible) {
        for (const [key, chunk] of layer.chunks) {
          let ce = le.chunks.get(key);
          if (ce && ce.version === chunk.version && ce.framesVersion === entry!.framesVersion && ce.grid === gridKey && ce.ySorted === ySorted && (ce.seed === null || ce.seed === seed)) {
            this.animate(ce, grid, time);
            continue;
          }
          if (ce) disposeChunk(ce);
          ce = this.buildChunk(entry!, map, li, chunk, key, grid, ySorted, time);
          ce.version = chunk.version;
          ce.grid = gridKey;
          le.chunks.set(key, ce);
          for (const be of ce.batches) {
            const batch = be.batch;
            batch.setMaterial(map.material); // ADR 0399
            batch.setMatrix(le.matrix!);
            batch.setTint(layer.meta.tint, opacity);
            batch.setVisible(visible);
            batch.setQuads(be.mesh.texture, be.mesh.positions, be.mesh.uvs, be.mesh.indices);
          }
        }
      }
      const painters = grid.shape === "square" || ySorted ? null : paintersOrder(le.chunks, grid);
      for (const [key, ce] of le.chunks) {
        const place = painters?.get(key);
        ce.batches.forEach((be, j) => {
          const b = be.batch;
          b.setVisible(visible);
          if (be.sortPoint) b.setOrder(sortingLayer, orderInLayer, ySortWithin(render, sortingLayer, worldY(le.matrix!, be.sortPoint)));
          else if (place === undefined) b.setOrder(sortingLayer, orderInLayer);
          else b.setOrder(sortingLayer, orderInLayer, place.start + (place.step * j) / ce.batches.length);
          b.setTint(layer.meta.tint, opacity);
          b.setMaterial(map.material);
          if (moved) b.setMatrix(le.matrix!);
        });
      }
    });
  }

  /** A chunk's batches, built from its cells now (their geometry is set by the caller). */
  private buildChunk(entry: MapEntry, map: Tilemap, li: number, chunk: { cx: number; cy: number; cells: Int32Array }, key: string, grid: TileGrid, ySorted: boolean, time: number | null): ChunkEntry {
    const { cx, cy, cells } = chunk;
    const cellX = (i: number) => cx * CHUNK_SIZE + (i % CHUNK_SIZE), cellY = (i: number) => cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
    const square = grid.shape === "square";
    const ts = entry.tileset;
    const idOf = (n: number) => map._tileIdAt(li, n);
    const sortOffsetOf = (id: number) => ts?.tile(id)?.sortOffset ?? 0;
    const seed = map.variantSeed;
    const offsetOf = (anim: TileAnim, i: number) => (anim.random && time !== null ? cellRandom(seed, cellX(i), cellY(i), ANIMATION_STREAM) * anim.total : 0);
    let random = false;
    const meshes = buildChunkMeshes(
      cells,
      cx,
      cy,
      grid,
      (n, i) => {
        const look = this.look(entry, map, idOf(n));
        if (!look?.anim) return look?.base ?? null;
        if (look.anim.random) random = true;
        return look.anim.frames[time === null ? 0 : frameAt(look.anim, time + offsetOf(look.anim, i))];
      },
      (i, n) => {
        const id = idOf(n);
        let group = "";
        if (ySorted) {
          const x = cellX(i), y = cellY(i);
          group = `r${square ? y : grid.drawKey(x, y)}`;
          const so = sortOffsetOf(id);
          if (so) group += `s${so}`;
        }
        if (square && this.look(entry, map, id)?.anim) group += "a"; // ADR 0421: static tiles are never uploaded again
        return group;
      },
    );
    const ce: ChunkEntry = { version: 0, framesVersion: entry.framesVersion, grid: "", ySorted, seed: random ? seed : null, batches: [], next: Infinity, last: time ?? 0 };
    for (const mesh of meshes) {
      const animated: AnimatedQuad[] = [];
      for (let q = 0; q < mesh.quads; q++) {
        const i = mesh.cells[q];
        const anim = this.look(entry, map, idOf(tileIdOf(cells[i])))?.anim;
        if (!anim) continue;
        const offset = offsetOf(anim, i);
        animated.push({ q, x: cellX(i), y: cellY(i), flags: flagsOf(cells[i]), anim, offset, frame: time === null ? 0 : frameAt(anim, time + offset) });
      }
      let sortPoint: [number, number] | null = null;
      if (ySorted) {
        const i = mesh.cells[0];
        const so = sortOffsetOf(idOf(tileIdOf(cells[i])));
        sortPoint = rowSortPoint(grid, cellX(i), cellY(i), so);
      }
      ce.batches.push({ batch: this.host.createBatch(`tilemap:${map.node.name}:${li}:${key}`), mesh, sortPoint, animated });
    }
    ce.next = time === null ? Infinity : nextChange(ce, time);
    return ce;
  }

  /** Bring a chunk's animated quads to animation time `time`: rewrite those whose frame changed, and re-send their batches. */
  private animate(ce: ChunkEntry, grid: TileGrid, time: number | null): void {
    if (time === null || ce.next === Infinity) return; // nothing animates
    if (time >= ce.last && time < ce.next) {
      // No frame changes yet (time going back, a lower or negative speed, recomputes).
      ce.last = time;
      return;
    }
    for (const be of ce.batches) {
      if (!be.animated.length) continue;
      let changed = false;
      for (const aq of be.animated) {
        const f = frameAt(aq.anim, time + aq.offset);
        if (f === aq.frame) continue;
        aq.frame = f;
        writeTileQuad(be.mesh.positions, be.mesh.uvs, aq.q, grid, aq.x, aq.y, aq.anim.frames[f], aq.flags);
        changed = true;
      }
      if (changed) be.batch.setQuads(be.mesh.texture, be.mesh.positions, be.mesh.uvs, be.mesh.indices); // the same arrays: updated in place
    }
    ce.last = time;
    ce.next = nextChange(ce, time);
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
        for (const ce of le.chunks.values()) for (const be of ce.batches) batches.push(be.batch);
        if (batches.length) yield { component: map, shape: { kind: "quads", batches }, order: le.order };
      }
    }
  }

  private invalidateFrames(entry: MapEntry): void {
    entry.framesVersion++;
    entry.looks.clear();
    entry.sidecars.clear();
  }

  /** A tile's sprite and frames; null while its texture loads or if it has no sprite. */
  private look(entry: MapEntry, map: Tilemap, id: number): TileLook | null {
    if (entry.looks.has(id)) return entry.looks.get(id)!;
    const def = entry.tileset?.tile(id);
    const base = def?.sprite ? this.frame(entry, map, id, def, def.sprite) : null;
    if (!def || !base) return null; // not cached while loading: asked again once it has
    let anim: TileAnim | null = null;
    if (def.animation) {
      const image = splitSpriteRef(def.sprite).path;
      const frames: TileFrame[] = [], ends: number[] = [];
      let total = 0;
      for (const f of def.animation.frames) {
        let frame: TileFrame | null = null;
        if (splitSpriteRef(f.sprite).path !== image) warnOnce(`frame|${map.tileset}|${id}|${f.sprite}`, `${map.node.name}: tile ${id}'s animation frame ${f.sprite} isn't from its sprite's image ${image}; the tile's sprite is drawn instead.`);
        else frame = this.frame(entry, map, id, def, f.sprite);
        frames.push(frame ?? base);
        total += f.duration;
        ends.push(total);
      }
      if (frames.length && total > 0) anim = { frames, ends, total, random: def.animation.start === "random" };
    }
    const look = { base, anim };
    entry.looks.set(id, look);
    return look;
  }

  /** A sprite of tile `id`'s image as a frame: texture, UVs and size in cells; null while its texture loads. */
  private frame(entry: MapEntry, map: Tilemap, id: number, def: TileDef, sprite: string): TileFrame | null {
    const { path, slice } = splitSpriteRef(sprite);
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

/** The frame an animation shows at loop time `t` (any real number; it loops). */
function frameAt(anim: TileAnim, t: number): number {
  const p = ((t % anim.total) + anim.total) % anim.total;
  const ends = anim.ends;
  for (let i = 0; i < ends.length; i++) if (p < ends[i]) return i;
  return ends.length - 1;
}

/** The animation time after `time` at which one of a chunk's animated quads next changes frame (Infinity: none has frames to change). */
function nextChange(ce: ChunkEntry, time: number): number {
  let next = Infinity;
  for (const be of ce.batches) {
    for (const aq of be.animated) {
      if (aq.anim.frames.length < 2) continue;
      const t = time + aq.offset;
      const p = ((t % aq.anim.total) + aq.anim.total) % aq.anim.total;
      next = Math.min(next, time + (aq.anim.ends[frameAt(aq.anim, t)] - p));
    }
  }
  return next;
}

/**
 * A y-sorted row's sort point in local units (ADR 0424): the bottom of cell (x, y)'s box on a square grid, the bottom
 * corner of its outline on the others, raised by `sortOffset` cells.
 */
function rowSortPoint(grid: TileGrid, x: number, y: number, sortOffset: number): [number, number] {
  const h = grid.params.cellSize.y;
  if (grid.shape === "square") {
    const box = grid.cellBox(x, y);
    return [box.x + box.w / 2, box.y + sortOffset * h];
  }
  const bottom = Math.min(...grid.cellOutline(x, y).map((p) => p[1]));
  return [grid.cellToLocal(x, y)[0], bottom + sortOffset * h];
}

/** The world height of local point `p` under the column-major matrix `m`. */
function worldY(m: ArrayLike<number>, p: readonly [number, number]): number {
  return m[1] * p[0] + m[5] * p[1] + m[13];
}

/**
 * A layer's batch matrix (ADR 0425): the node's world matrix `wm`, its origin moved by the layer's `offset` (local
 * units), then by `(1 − parallax) × (view − node)` in world x and y when the layer has a parallax factor and a view.
 * Written into `m`.
 */
function layerMatrix(wm: ArrayLike<number>, offset: readonly [number, number] | undefined, parallax: readonly [number, number] | undefined, view: readonly [number, number] | null, m: Float32Array): Float32Array {
  for (let i = 0; i < 16; i++) m[i] = wm[i];
  if (offset) {
    const [ox, oy] = offset;
    m[12] = wm[0] * ox + wm[4] * oy + wm[12];
    m[13] = wm[1] * ox + wm[5] * oy + wm[13];
    m[14] = wm[2] * ox + wm[6] * oy + wm[14];
  }
  if (parallax && view) {
    m[12] += (1 - parallax[0]) * (view[0] - wm[12]);
    m[13] += (1 - parallax[1]) * (view[1] - wm[13]);
  }
  return m;
}

const scratchMatrix = new Float32Array(16);

function sameMatrix(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A non-square layer's chunks in painter's order (ADR 0421): each chunk's place in [0, 1) and the step to the next
 * chunk's, back chunks (the higher `drawKey` of their first cell is lower: higher on screen) first; a chunk's batches
 * take consecutive sub-steps of its step. Ties keep a fixed order by chunk position.
 */
function paintersOrder(chunks: Map<string, ChunkEntry>, grid: TileGrid): Map<string, { start: number; step: number }> {
  const keyed = [...chunks.keys()].map((key) => {
    const [cx, cy] = parseChunkKey(key)!;
    return { key, cx, cy, draw: grid.drawKey(cx * CHUNK_SIZE, cy * CHUNK_SIZE) };
  });
  keyed.sort((a, b) => a.draw - b.draw || a.cy - b.cy || a.cx - b.cx);
  const step = 1 / keyed.length;
  return new Map(keyed.map((k, i) => [k.key, { start: i * step, step }]));
}

function disposeChunk(ce: ChunkEntry): void {
  for (const be of ce.batches) be.batch.dispose();
}

function disposeLayer(le: LayerEntry): void {
  for (const ce of le.chunks.values()) disposeChunk(ce);
  le.chunks.clear();
}

/**
 * @internal Builds the feature from the renderer's shared services: the quad batches, and the view camera's world
 * position for parallax layers (ADR 0425), read from the World so no renderer type reaches this plugin.
 */
export const createTilemapsFeature: BabylonFeatureFactory = (host) =>
  new TilemapRenderer(host.quads, (world) => {
    const camera = host.viewCamera();
    if (!camera?.node) return null;
    const e = camera.node.entity;
    const m = world.worldMatrix(e);
    return [m[e * 16 + 12], m[e * 16 + 13]];
  });
