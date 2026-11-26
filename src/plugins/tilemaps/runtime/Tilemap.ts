/**
 * The Tilemap component (ADR 0103): a grid of tiles from one tileset asset, in several layers
 * drawn in chunks. Cell (x, y) covers local x·cellSize.x .. (x+1)·cellSize.x (and the same in y),
 * on the node's XY plane, y up.
 *
 * The `layers` field is the scene data (run-length chunk strings, `format.ts`). At runtime the
 * component decodes it into typed arrays; scripts edit those through `setTile` and friends, and
 * the renderer and colliders rebuild only the chunks that changed. Script edits don't rewrite the
 * `layers` field; `toLayerData()` encodes the current cells when they need saving.
 *
 * Cells hold each layer's own tile numbers, and the layer's palette names the tileset tile behind each
 * number by uuid (ADR 0392). Everything this component offers speaks tileset ids (`TileDef.id`): a read
 * looks the number's uuid up in the tileset (a tile the tileset no longer has reads as empty, with a
 * warning, and is kept as it was), and a write finds or adds the tile's palette number.
 */
import { Component } from "../../../engine/core/Component";
import { defineBuffer } from "../../../engine/core/data";
import { Vector2, Vector3, type Vec2Like, type Vec3Like } from "../../../engine/core/math";
import { AssetRef, PlainObject, component, field } from "../../../engine/core/registry";
import type { CollisionShapes2D, CollisionShapeSource2D, ShapeMerge2D } from "../../../engine/physics/shapeSource2D";
import { Assets } from "../../../engine/scene/Assets";
import { buildTileShapes } from "./collision";
import { paintTerrain, retileTerrain, type CellAccess } from "./autotile";
import { cellRandom, RANDOM_BRUSH_STREAM } from "./cellHash";
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
  /** The cells' tile numbers (`RuntimeChunk.cells`), not tileset ids: `palette` names each one's tile (ADR 0392). */
  chunks: Map<string, RuntimeChunk>;
  /** Goes up whenever any chunk is added, removed or changed. */
  version: number;
  /** Tile number → tile uuid. */
  palette: Map<number, string>;
  /** Tile uuid → tile number. */
  numbers: Map<string, number>;
  /** The number the next new palette entry gets. */
  nextNumber: number;
  /** Tile number → tileset id (0: no such tile), for the tileset `resolvedFor`. */
  resolved: Map<number, number>;
  resolvedFor: Tileset | null | undefined;
}

function runtimeLayer(meta: TilemapLayerData, version: number): RuntimeLayer {
  const palette = new Map<number, string>();
  const numbers = new Map<string, number>();
  let nextNumber = 1;
  for (const [k, uuid] of Object.entries(meta.palette)) {
    const n = Number(k);
    palette.set(n, uuid);
    if (!numbers.has(uuid)) numbers.set(uuid, n);
    nextNumber = Math.max(nextNumber, n + 1);
  }
  return { meta, chunks: new Map(), version, palette, numbers, nextNumber, resolved: new Map(), resolvedFor: undefined };
}

/** True if `prev` names every number of `next` the same tile (a saved palette is the runtime's, pruned to the used numbers). */
function paletteAgrees(prev: ReadonlyMap<number, string>, next: ReadonlyMap<number, string>): boolean {
  for (const [n, uuid] of next) if (prev.get(n) !== uuid) return false;
  return true;
}

const parsedTilesets = new WeakMap<object, Tileset>();
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${message}`);
}

/** The tileset asset at `path`, parsed once per version of its JSON, or null (warning once) if missing or bad. */
function loadTileset(path: string): Tileset | null {
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

/** ADR 0421: a Tilemap's cell layout. */
export type TileGridShape = "square" | "isometric" | "staggered" | "hexagonal";

let nextVersion = 1;

@component("engine.Tilemap")
export class Tilemap extends Component implements CollisionShapeSource2D {
  /** The tileset asset (`*.tileset.json`) the cells' tile ids refer to. */
  @field(AssetRef, { kind: "tileset" }) tileset = "";
  /** One cell's width and height in local units. */
  @field(Vector2) cellSize = new Vector2(1, 1);
  /** A sprite material asset for every layer (ADR 0399: Sprite Lit or Sprite Unlit). Empty: Sprite Lit, lit by 2D lights when the World has any. */
  @field(AssetRef, { kind: "material", description: "A Sprite Lit or Sprite Unlit material asset for every layer. Empty: Sprite Lit." }) material = "";
  /** The layers, back to front within the same sorting layer and order. Scene data; see `format.ts`. */
  @field(PlainObject, { hidden: true }) layers: TilemapLayerData[] = [newLayer("Ground")];
  /**
   * Chooses among equally fitting variants (ADR 0400): auto-tiling's pick between terrain tiles that fit a cell alike,
   * and `fillRect`'s pick among several tiles, are a hash of the cell and this seed, so the same strokes always paint
   * the same map. Changing it affects later painting; `retileTerrain()` re-picks the terrain cells already painted.
   * The editor's Re-roll button does both. Shown under the Tilemap's fields rather than as one.
   */
  @field(Number, { hidden: true }) variantSeed = 0;
  /** ADR 0421: the cell layout. `cellSize` is one cell's bounding box (a diamond's or hexagon's width and height). */
  @field(String, { choices: ["square", "isometric", "staggered", "hexagonal"], animatable: false }) gridShape: TileGridShape = "square";
  /** ADR 0421: staggered and hexagonal grids: which rows ("y") or columns ("x") shift by half a cell. */
  @field(String, { choices: ["y", "x"], animatable: false }) staggerAxis: "x" | "y" = "y";
  /** ADR 0421: staggered and hexagonal grids: whether the odd or the even rows (columns) shift. */
  @field(String, { choices: ["odd", "even"], animatable: false }) staggerIndex: "odd" | "even" = "odd";
  /** ADR 0421: hexagonal grids: the flat sides' length along the stagger axis, as a fraction of `cellSize` on that axis. */
  @field(Number, { animatable: false }) hexSide = 0.5;
  /** ADR 0421: how fast tile animations play (0 stops them). */
  @field(Number) animationSpeed = 1;

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
      const layer = runtimeLayer(meta, prev?.version ?? nextVersion++);
      // The same numbers may name other tiles under another palette, so no chunk is kept then.
      const keep = !!prev && paletteAgrees(prev.palette, layer.palette);
      let changed = !keep;
      for (const [key, text] of Object.entries(meta.chunks)) {
        const [cx, cy] = parseChunkKey(key)!;
        const cells = decodeChunk(text);
        if (chunkIsEmpty(cells)) continue;
        const p = keep ? prev.chunks.get(key) : undefined;
        if (p && sameCells(p.cells, cells)) layer.chunks.set(key, p);
        else {
          layer.chunks.set(key, { cx, cy, cells, version: nextVersion++ });
          changed = true;
        }
      }
      if (prev) for (const key of prev.chunks.keys()) if (!layer.chunks.has(key)) changed = true;
      if (changed) layer.version = nextVersion++;
      meta.chunks = {}; // the runtime arrays hold the cells now
      meta.palette = {}; // and the runtime maps the palette
      next.push(layer);
    });
    if (old.length !== next.length || next.some((l, i) => l !== old[i])) this._version = nextVersion++;
    this.runtime = next;
    this.source = this.layers;
  }

  /**
   * The layers' current cells as scene data (what the `layers` field would hold to reproduce them): each layer's
   * cells as its tile numbers, and its palette with the numbers its cells use (unused entries pruned).
   */
  toLayerData(): TilemapLayerData[] {
    return this._layers().map((l) => {
      const chunks: Record<string, string> = {};
      const used = new Set<number>();
      const keys = [...l.chunks.keys()].sort(compareChunkKeys);
      for (const k of keys) {
        const c = l.chunks.get(k)!;
        if (chunkIsEmpty(c.cells)) continue;
        chunks[k] = encodeChunk(c.cells);
        for (const v of c.cells) if (v) used.add(tileIdOf(v));
      }
      const palette: Record<string, string> = {};
      for (const n of [...used].sort((a, b) => a - b)) {
        const uuid = l.palette.get(n);
        if (uuid) palette[n] = uuid;
      }
      return { ...l.meta, palette, chunks };
    });
  }

  /** The tileset id tile number `n` of a layer names now: through the palette to a uuid, then the tileset (0 if none). */
  private resolve(l: RuntimeLayer, n: number): number {
    const ts = this.tilesetAsset;
    if (l.resolvedFor !== ts) {
      l.resolved.clear();
      l.resolvedFor = ts;
    }
    let id = l.resolved.get(n);
    if (id === undefined) {
      const uuid = l.palette.get(n);
      const tile = uuid !== undefined ? ts?.tileByUuid(uuid) : undefined;
      id = tile?.id ?? 0;
      if (!tile && ts) {
        const what = uuid !== undefined ? `tile ${uuid}, which the tileset ${this.tileset} no longer has` : `tile number ${n}, which isn't in the layer's palette`;
        warnOnce(`gone|${this.tileset}|${l.meta.name}|${uuid ?? n}`, `${this.node.name}: Tilemap layer "${l.meta.name}" has cells of ${what}; they draw nothing.`);
      }
      l.resolved.set(n, id);
    }
    return id;
  }

  /** A stored cell as a tileset cell value (tileset id plus flip flags), 0 when empty or its tile is gone. */
  private valueOf(l: RuntimeLayer, raw: number): number {
    if (!raw) return 0;
    const id = this.resolve(l, tileIdOf(raw));
    return id ? cellValue(id, flagsOf(raw)) : 0;
  }

  /** A tileset cell value as the layer stores it: the tile's palette number (added if new) plus the flip flags. */
  private storedValue(l: RuntimeLayer, value: number): number {
    const id = tileIdOf(value);
    if (!id) return 0;
    const ts = this.tilesetAsset;
    const tile = ts?.tile(id);
    if (!tile) throw new Error(ts ? `Tilemap "${this.node.name}": the tileset ${this.tileset} has no tile ${id}.` : `Tilemap "${this.node.name}": can't paint tile ${id} without its tileset (${this.tileset ? `"${this.tileset}" isn't loaded` : "none is set"}).`);
    let n = l.numbers.get(tile.uuid);
    if (n === undefined) {
      n = l.nextNumber++;
      l.palette.set(n, tile.uuid);
      l.numbers.set(tile.uuid, n);
      l.resolved.delete(n);
    }
    return cellValue(n, flagsOf(value));
  }

  /** @internal The tileset id a layer's stored tile number names (the renderer's lookup), 0 if none. */
  _tileIdAt(layer: number, n: number): number {
    const l = this._layers()[layer];
    return l ? this.resolve(l, n) : 0;
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
    return this.valueOf(l, l.chunks.get(chunkKey(cx, cy))?.cells[index] ?? 0);
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

  /** Set a cell's raw value (tile id plus flip flags). Returns whether the cell changed. Throws for a missing layer, a
   * coordinate that isn't a finite number, or a tile id the tileset doesn't have. */
  setCell(x: number, y: number, value: number, layer: number | string = 0): boolean {
    const li = this.indexOf(layer);
    const l = this._layers()[li];
    if (!l) throw new Error(`Tilemap "${this.node.name}" has no layer ${JSON.stringify(layer)}.`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`Tilemap "${this.node.name}": (${x}, ${y}) isn't a cell; cell coordinates are finite numbers.`);
    x = Math.floor(x);
    y = Math.floor(y);
    const stored = this.storedValue(l, value);
    const { cx, cy, index } = cellToChunk(x, y);
    const key = chunkKey(cx, cy);
    let chunk = l.chunks.get(key);
    const before = chunk?.cells[index] ?? 0;
    if (before === stored) return false;
    const previous = this.valueOf(l, before);
    value = this.valueOf(l, stored);
    if (!chunk) l.chunks.set(key, (chunk = { cx, cy, cells: new Int32Array(CHUNK_CELLS), version: 0 }));
    chunk.cells[index] = stored;
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

  /**
   * Fill a rectangle of cells with tile `id` (0 clears). With several ids, each cell picks one by the tiles' weights,
   * the pick drawn from the cell and `variantSeed` (ADR 0400), so the same call fills the same way; change the seed
   * for another arrangement.
   */
  fillRect(x: number, y: number, width: number, height: number, id: number | readonly number[], layer: number | string = 0): void {
    const ids = typeof id === "number" ? [id] : id;
    const defs: { id: number; weight?: number }[] = ids.map((i) => this.tilesetAsset?.tile(i) ?? { id: i });
    x = Math.floor(x);
    y = Math.floor(y);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const cx = x + i, cy = y + j;
        this.setTile(cx, cy, pickWeighted(defs, () => cellRandom(this.variantSeed, cx, cy, RANDOM_BRUSH_STREAM))?.id ?? 0, layer);
      }
    }
  }

  /** Remove every tile from a layer (or every layer). */
  clearAll(layer?: number | string): void {
    const layers = layer === undefined ? this._layers().map((_, i) => i) : [this.indexOf(layer)];
    // Every stored cell, those whose tile the tileset no longer has included.
    for (const li of layers) for (const { x, y } of this.storedCells(li)) this.setCell(x, y, 0, li);
  }

  /**
   * Paint a terrain into cells and re-pick the terrain tiles around them to fit (auto-tiling), or
   * erase the terrain with `terrain` null. Returns the cells that changed.
   */
  paintTerrain(cells: readonly (readonly [number, number])[], terrain: string | null, layer: number | string = 0): [number, number][] {
    const ts = this.tilesetAsset;
    if (!ts) return [];
    return paintTerrain(ts, this.cellAccess(layer), cells, terrain, this.variantSeed);
  }

  /**
   * Re-pick every terrain cell of a layer (or every layer) for its neighbours, with `variantSeed` choosing among
   * equally fitting variants (ADR 0400): after changing the seed, to re-roll the variants, or after the tileset's
   * terrain tiles changed. Cells of tiles without a terrain are left alone. Returns the cells that changed (of every
   * layer re-tiled).
   */
  retileTerrain(layer?: number | string): [number, number][] {
    const ts = this.tilesetAsset;
    if (!ts) return [];
    const layers = layer === undefined ? this._layers().map((_, i) => i) : [this.indexOf(layer)];
    const changed: [number, number][] = [];
    for (const li of layers) {
      const cells = [...this.tiles(li)].map(({ x, y }) => [x, y] as const);
      changed.push(...retileTerrain(ts, this.cellAccess(li), cells, this.variantSeed));
    }
    return changed;
  }

  /** A layer's cells as auto-tiling reads and writes them. */
  private cellAccess(layer: number | string): CellAccess {
    return { get: (x, y) => this.getCell(x, y, layer), set: (x, y, id) => void this.setTile(x, y, id, layer) };
  }

  /** Every non-empty cell of a layer (a cell whose tile the tileset no longer has reads as empty). */
  *tiles(layer: number | string = 0): Generator<{ x: number; y: number; value: number; id: number; flags: number }> {
    const l = this.layerAt(layer);
    if (!l) return;
    for (const { x, y, stored } of this.storedCells(layer)) {
      const v = this.valueOf(l, stored);
      if (v) yield { x, y, value: v, id: tileIdOf(v), flags: flagsOf(v) };
    }
  }

  /** Every cell of a layer holding something, as stored (palette numbers). */
  private *storedCells(layer: number | string): Generator<{ x: number; y: number; stored: number }> {
    const l = this.layerAt(layer);
    if (!l) return;
    for (const c of [...l.chunks.values()]) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const v = c.cells[i];
        if (v) yield { x: c.cx * CHUNK_SIZE + (i % CHUNK_SIZE), y: c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE), stored: v };
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
    const local = t ? t.localToWorld.inverseTransformPoint({ x: p.x, y: p.y, z: (p as Vec3Like).z ?? 0 }) : p;
    return this.localToCell(local);
  }

  /** A cell's centre in world space. */
  cellToWorld(x: number, y: number): Vector3 {
    const l = this.cellToLocal(x, y);
    const t = this.node.transform;
    return t ? t.localToWorld.transformPoint({ x: l.x, y: l.y, z: 0 }) : new Vector3(l.x, l.y, 0);
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
