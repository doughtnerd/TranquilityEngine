/**
 * The Tilemap component (ADR 0103): a grid of tiles from one tileset asset, in several layers
 * drawn in chunks. Cell (x, y) covers local x·cellSize.x .. (x+1)·cellSize.x (and the same in y),
 * on the node's XY plane, y up.
 *
 * The `layers` field is the scene data (run-length chunk strings, `format.ts`). At runtime the
 * component decodes it into typed arrays; scripts edit those through `setTile` and friends, and
 * the renderer and colliders rebuild only the chunks that changed. Script edits don't rewrite the
 * `layers` field; `toLayerData()` encodes the current cells when they need saving.
 */
import { Component } from "../../../engine/core/Component";
import { defineBuffer } from "../../../engine/core/data";
import { Vector2, Vector3, type Vec2Like, type Vec3Like } from "../../../engine/core/math";
import { AssetRef, PlainObject, component, field } from "../../../engine/core/registry";
import type { CollisionShapes2D, CollisionShapeSource2D, ShapeMerge2D } from "../../../engine/physics/shapeSource2D";
import { Assets } from "../../../engine/scene/Assets";
import { buildTileShapes } from "./collision";
import { paintTerrain } from "./autotile";
import {
  CHUNK_CELLS,
  CHUNK_SIZE,
  cellToChunk,
  cellValue,
  chunkIsEmpty,
  chunkKey,
  decodeChunk,
  encodeChunk,
  flagsOf,
  migrateLayer,
  newLayer,
  parseChunkKey,
  tileIdOf,
  type TilemapLayerData,
} from "./format";
import { Tileset, parseTileset, pickWeighted, type TileDef } from "./tileset";

/** One changed cell, in `TilemapChanges` and `onTileChanged` listeners. */
export interface TileChange {
  readonly tilemap: Tilemap;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  /** The cell's previous value (tile id plus flip flags; 0 empty). */
  readonly previous: number;
  readonly value: number;
}

/** Cells changed by scripts this frame, for systems (ADR 0017). Cleared at the end of the frame. */
export const TilemapChanges = defineBuffer<TileChange>("engine.TilemapChanges");

/** @internal A decoded chunk. `version` goes up on every change, so the renderer and colliders know what to rebuild. */
export interface RuntimeChunk {
  cx: number;
  cy: number;
  cells: Int32Array;
  version: number;
}

/** @internal A decoded layer. */
export interface RuntimeLayer {
  meta: TilemapLayerData;
  chunks: Map<string, RuntimeChunk>;
  /** Goes up whenever any chunk is added, removed or changed. */
  version: number;
}

const parsedTilesets = new WeakMap<object, Tileset>();
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${message}`);
}

/** @internal The tileset asset at `path`, parsed once per version of its JSON, or null (warning once) if missing or bad. */
export function loadTileset(path: string): Tileset | null {
  if (!path) return null;
  if (!Assets.has(path)) {
    warnOnce(`missing|${path}`, `tileset "${path}" not found.`);
    return null;
  }
  const raw = Assets.json<object>(path);
  let ts = parsedTilesets.get(raw);
  if (!ts) {
    try {
      const { tileset, problems } = parseTileset(raw, path);
      for (const p of problems) warnOnce(p, p);
      ts = new Tileset(tileset);
    } catch (err) {
      warnOnce(`bad|${path}`, (err as Error).message);
      return null;
    }
    parsedTilesets.set(raw, ts);
  }
  return ts;
}

let nextVersion = 1;

@component("engine.Tilemap")
export class Tilemap extends Component implements CollisionShapeSource2D {
  /** The tileset asset (`*.tileset.json`) the cells' tile ids refer to. */
  @field(AssetRef, { kind: "tileset" }) tileset = "";
  /** One cell's width and height in local units. */
  @field(Vector2) cellSize = new Vector2(1, 1);
  /** The layers, back to front within the same sorting layer and order. Scene data; see `format.ts`. */
  @field(PlainObject, { hidden: true }) layers: TilemapLayerData[] = [newLayer("Ground")];

  private source: unknown = null;
  private runtime: RuntimeLayer[] = [];
  private listeners: ((change: TileChange) => void)[] = [];
  /** @internal Goes up when anything about the cells or layers changes. */
  _version = 0;

  // --- runtime model -------------------------------------------------------------------------

  /** @internal The decoded layers, refreshed from `layers` when that field was replaced (scene load, editor edits). */
  _layers(): RuntimeLayer[] {
    if (this.source !== this.layers) this.decode();
    return this.runtime;
  }

  private decode(): void {
    const raw = Array.isArray(this.layers) ? this.layers : [];
    const old = this.runtime;
    const next: RuntimeLayer[] = [];
    raw.forEach((r, i) => {
      let meta: TilemapLayerData;
      try {
        meta = migrateLayer(r, `${this.node.name}: Tilemap layer ${i}`);
      } catch (err) {
        warnOnce(`layer|${(err as Error).message}`, (err as Error).message);
        meta = newLayer(`Layer ${i}`);
      }
      const prev = old[i];
      const layer: RuntimeLayer = { meta, chunks: new Map(), version: prev?.version ?? nextVersion++ };
      let changed = !prev;
      for (const [key, text] of Object.entries(meta.chunks)) {
        const [cx, cy] = parseChunkKey(key)!;
        const cells = decodeChunk(text);
        if (chunkIsEmpty(cells)) continue;
        const p = prev?.chunks.get(key);
        if (p && sameCells(p.cells, cells)) layer.chunks.set(key, p);
        else {
          layer.chunks.set(key, { cx, cy, cells, version: nextVersion++ });
          changed = true;
        }
      }
      if (prev) for (const key of prev.chunks.keys()) if (!layer.chunks.has(key)) changed = true;
      if (changed) layer.version = nextVersion++;
      meta.chunks = {}; // the runtime arrays hold the cells now
      next.push(layer);
    });
    if (old.length !== next.length || next.some((l, i) => l !== old[i])) this._version = nextVersion++;
    this.runtime = next;
    this.source = this.layers;
  }

  /** The layers' current cells as scene data (what the `layers` field would hold to reproduce them). */
  toLayerData(): TilemapLayerData[] {
    return this._layers().map((l) => {
      const chunks: Record<string, string> = {};
      const keys = [...l.chunks.keys()].sort(compareChunkKeys);
      for (const k of keys) {
        const c = l.chunks.get(k)!;
        if (!chunkIsEmpty(c.cells)) chunks[k] = encodeChunk(c.cells);
      }
      return { ...l.meta, chunks };
    });
  }

  /** The tileset asset, or null while it's missing. */
  get tilesetAsset(): Tileset | null {
    return loadTileset(this.tileset);
  }

  // --- 2D collision shapes (ADR 0105, 0136) ---------------------------------------------------

  /** @internal The 2D shape source signature: changes with the cell size, the tileset and the colliding layers' cells. */
  collisionSignature(): string {
    const layers = this._layers().map((l) => `${l.version}:${l.meta.collision}`).join(",");
    return [this.cellSize.x, this.cellSize.y, this.tileset, this.tilesetAsset ? "ts" : "", layers].join("|");
  }

  /**
   * @internal The tiles' collision shapes (each tile's from the tileset; layers with `collision: false`
   * skipped), for whatever 2D collider sits on this node. Null while the tileset is missing.
   */
  collisionShapes(merge: ShapeMerge2D): CollisionShapes2D | null {
    const ts = this.tilesetAsset;
    if (!ts) return null;
    const cells: { x: number; y: number; value: number }[] = [];
    this._layers().forEach((l, i) => {
      if (!l.meta.collision) return;
      for (const cell of this.tiles(i)) cells.push(cell);
    });
    return { unit: { x: this.cellSize.x, y: this.cellSize.y }, ...buildTileShapes(cells, (id) => ts.tile(id)?.collision, merge) };
  }

  // --- layers --------------------------------------------------------------------------------

  /** How many layers there are. */
  get layerCount(): number {
    return this._layers().length;
  }

  /** A layer's index by name, or -1. */
  layerIndex(name: string): number {
    return this._layers().findIndex((l) => l.meta.name === name);
  }

  private layerAt(layer: number | string): RuntimeLayer | null {
    const layers = this._layers();
    const i = typeof layer === "string" ? this.layerIndex(layer) : layer;
    return layers[i] ?? null;
  }

  private indexOf(layer: number | string): number {
    return typeof layer === "string" ? this.layerIndex(layer) : layer;
  }

  // --- cells ---------------------------------------------------------------------------------

  /** The tile id at a cell (0 when empty or the layer doesn't exist). */
  getTile(x: number, y: number, layer: number | string = 0): number {
    return tileIdOf(this.getCell(x, y, layer));
  }

  /** The cell's raw value: tile id plus flip flags (`FLIP_X`, `FLIP_Y`, `FLIP_DIAGONAL`). */
  getCell(x: number, y: number, layer: number | string = 0): number {
    const l = this.layerAt(layer);
    if (!l) return 0;
    const { cx, cy, index } = cellToChunk(Math.floor(x), Math.floor(y));
    return l.chunks.get(chunkKey(cx, cy))?.cells[index] ?? 0;
  }

  /** The tileset's definition of the tile at a cell. */
  getTileDef(x: number, y: number, layer: number | string = 0): Readonly<TileDef> | undefined {
    const id = this.getTile(x, y, layer);
    return id ? this.tilesetAsset?.tile(id) : undefined;
  }

  /** The custom data of the tile at a cell (from the tileset), or undefined. */
  getTileData<T = Record<string, unknown>>(x: number, y: number, layer: number | string = 0): T | undefined {
    return this.getTileDef(x, y, layer)?.data as T | undefined;
  }

  /** True if the cell has a tile. */
  hasTile(x: number, y: number, layer: number | string = 0): boolean {
    return this.getCell(x, y, layer) !== 0;
  }

  /** Put tile `id` (0 clears) in a cell, with optional flip flags. Returns whether the cell changed. */
  setTile(x: number, y: number, id: number, layer: number | string = 0, flags = 0): boolean {
    return this.setCell(x, y, id ? cellValue(id, flags) : 0, layer);
  }

  /** Empty a cell. */
  clearTile(x: number, y: number, layer: number | string = 0): boolean {
    return this.setCell(x, y, 0, layer);
  }

  /** Set a cell's raw value (tile id plus flip flags). Returns whether the cell changed. */
  setCell(x: number, y: number, value: number, layer: number | string = 0): boolean {
    const li = this.indexOf(layer);
    const l = this._layers()[li];
    if (!l) throw new Error(`Tilemap "${this.node.name}" has no layer ${JSON.stringify(layer)}.`);
    x = Math.floor(x);
    y = Math.floor(y);
    const { cx, cy, index } = cellToChunk(x, y);
    const key = chunkKey(cx, cy);
    let chunk = l.chunks.get(key);
    const previous = chunk?.cells[index] ?? 0;
    if (previous === value) return false;
    if (!chunk) l.chunks.set(key, (chunk = { cx, cy, cells: new Int32Array(CHUNK_CELLS), version: 0 }));
    chunk.cells[index] = value;
    chunk.version = nextVersion++;
    l.version = nextVersion++;
    this._version = nextVersion++;
    const change: TileChange = { tilemap: this, layer: li, x, y, previous, value };
    this._world._buffer(TilemapChanges).push(change);
    for (const f of [...this.listeners]) {
      try {
        f(change);
      } catch (err) {
        console.error(`[myco] Tilemap onTileChanged listener threw:`, err);
      }
    }
    return true;
  }

  /** Fill a rectangle of cells with tile `id` (0 clears). With several ids, each cell picks one at random by the tiles' weights. */
  fillRect(x: number, y: number, width: number, height: number, id: number | readonly number[], layer: number | string = 0): void {
    const ids = typeof id === "number" ? [id] : id;
    const defs: { id: number; weight?: number }[] = ids.map((i) => this.tilesetAsset?.tile(i) ?? { id: i });
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) this.setTile(x + i, y + j, pickWeighted(defs)?.id ?? 0, layer);
  }

  /** Remove every tile from a layer (or every layer). */
  clearAll(layer?: number | string): void {
    const layers = layer === undefined ? this._layers().map((_, i) => i) : [this.indexOf(layer)];
    for (const li of layers) for (const { x, y } of this.tiles(li)) this.setCell(x, y, 0, li);
  }

  /**
   * Paint a terrain into cells and re-pick the terrain tiles around them to fit (auto-tiling), or
   * erase the terrain with `terrain` null. Returns the cells that changed.
   */
  paintTerrain(cells: readonly (readonly [number, number])[], terrain: string | null, layer: number | string = 0): [number, number][] {
    const ts = this.tilesetAsset;
    if (!ts) return [];
    return paintTerrain(ts, { get: (x, y) => this.getCell(x, y, layer), set: (x, y, id) => this.setTile(x, y, id, layer) }, cells, terrain);
  }

  /** Every non-empty cell of a layer. */
  *tiles(layer: number | string = 0): Generator<{ x: number; y: number; value: number; id: number; flags: number }> {
    const l = this.layerAt(layer);
    if (!l) return;
    for (const c of [...l.chunks.values()]) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const v = c.cells[i];
        if (v) yield { x: c.cx * CHUNK_SIZE + (i % CHUNK_SIZE), y: c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE), value: v, id: tileIdOf(v), flags: flagsOf(v) };
      }
    }
  }

  /** The smallest rectangle of cells holding every tile of a layer (or all layers), or null if empty. */
  cellBounds(layer?: number | string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    const layers = layer === undefined ? this._layers().map((_, i) => i) : [this.indexOf(layer)];
    for (const li of layers) {
      for (const { x, y } of this.tiles(li)) {
        if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
        else {
          b.minX = Math.min(b.minX, x);
          b.minY = Math.min(b.minY, y);
          b.maxX = Math.max(b.maxX, x);
          b.maxY = Math.max(b.maxY, y);
        }
      }
    }
    return b;
  }

  /** Call `listener` for every changed cell (script edits); returns a function that stops it. */
  onTileChanged(listener: (change: TileChange) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  // --- coordinates ---------------------------------------------------------------------------

  /** The cell holding a point in the node's local space. */
  localToCell(p: Vec2Like): Vector2 {
    return new Vector2(Math.floor(p.x / this.cellSize.x), Math.floor(p.y / this.cellSize.y));
  }

  /** A cell's centre in the node's local space. */
  cellToLocal(x: number, y: number): Vector2 {
    return new Vector2((Math.floor(x) + 0.5) * this.cellSize.x, (Math.floor(y) + 0.5) * this.cellSize.y);
  }

  /** The cell holding a world point. */
  worldToCell(p: Vec2Like | Vec3Like): Vector2 {
    const t = this.node.transform;
    const local = t ? t.worldToLocal({ x: p.x, y: p.y, z: (p as Vec3Like).z ?? 0 }) : p;
    return this.localToCell(local);
  }

  /** A cell's centre in world space. */
  cellToWorld(x: number, y: number): Vector3 {
    const l = this.cellToLocal(x, y);
    const t = this.node.transform;
    return t ? t.localToWorld({ x: l.x, y: l.y, z: 0 }) : new Vector3(l.x, l.y, 0);
  }

  override _onDetach(): void {
    this._world.render?.release(this);
    this.listeners.length = 0;
  }
}

function sameCells(a: Int32Array, b: Int32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function compareChunkKeys(a: string, b: string): number {
  const [ax, ay] = parseChunkKey(a)!, [bx, by] = parseChunkKey(b)!;
  return ay - by || ax - bx;
}
