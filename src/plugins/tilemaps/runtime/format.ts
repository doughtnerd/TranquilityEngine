/**
 * Tilemap data in scene files (ADR 0103). Pure and renderer-free so it can be tested headless.
 *
 * A Tilemap's `layers` field is a list of layer objects. Each layer keeps its cells in sparse
 * 16 × 16 chunks keyed `"cx,cy"`, and each chunk is a run-length string of 256 cell values, row by
 * row from the chunk's bottom-left cell: `"0*200,3,3,4*2,0*50"` (a value, or `value*count`). Cell
 * values are the layer's own small tile numbers with flip flags in the high bits (`cellValue`), and the
 * layer's `palette` says which tileset tile each number is, by the tile's uuid (ADR 0392): deleting a
 * tile from the tileset leaves its cells missing instead of repainting them with whatever tile takes
 * its id. Layers carry a version `v`; a layer without one is version 1, and `migrateLayer` upgrades
 * older versions (version 1 had no palette: its cell values were tileset ids).
 */
import { legacyTileUuid } from "./tileset";

/** Cells per chunk side. Changing it would need a layer migration. */
export const CHUNK_SIZE = 16;
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;
/** The layer format version this engine writes. */
export const TILEMAP_LAYER_VERSION = 2;

/** Tile numbers (a layer's palette keys) are the low 24 bits of a cell value; 0 is an empty cell. */
export const TILE_ID_MASK = 0x00ff_ffff;
/** Mirror the tile left to right. */
export const FLIP_X = 1 << 24;
/** Mirror the tile top to bottom. */
export const FLIP_Y = 1 << 25;
/** Swap the tile's axes (with the flips, this gives the four 90° turns). */
export const FLIP_DIAGONAL = 1 << 26;
export const FLIP_MASK = FLIP_X | FLIP_Y | FLIP_DIAGONAL;

/** A cell value: a tile id plus flip flags. */
export const cellValue = (id: number, flags = 0): number => (id & TILE_ID_MASK) | (flags & FLIP_MASK);
export const tileIdOf = (value: number): number => value & TILE_ID_MASK;
export const flagsOf = (value: number): number => value & FLIP_MASK;

/** One layer of a Tilemap as stored in scene files. */
export interface TilemapLayerData {
  /** Format version; absent means 1. */
  v?: number;
  name: string;
  /** Sorting layer name from project settings (back to front). */
  sortingLayer: string;
  orderInLayer: number;
  visible: boolean;
  /** Whether this layer's tiles make colliders (with a TilemapCollider2D). */
  collision: boolean;
  /** Tint as `#rrggbb`, multiplied with the tiles. */
  tint: string;
  /** 0..1, multiplied with the tiles' alpha. */
  opacity: number;
  /** The layer's tile numbers (the cell values' low bits, as strings) → the tileset tiles' uuids (ADR 0392). */
  palette: Record<string, string>;
  /** `"cx,cy"` → run-length string of the chunk's 256 cell values. */
  chunks: Record<string, string>;
  /** ADR 0425: shifts the layer's drawing and collision, in local units. Absent: `[0, 0]`. */
  offset?: [number, number];
  /** ADR 0425: how much the layer moves with the view camera (Tiled's parallax factor), visual only. Absent: `[1, 1]`. */
  parallax?: [number, number];
  /** ADR 0425: the editor's brushes skip it. Absent: false. */
  locked?: boolean;
}

/** A new, empty layer. */
export function newLayer(name = "Layer", sortingLayer = "Default"): TilemapLayerData {
  return { v: TILEMAP_LAYER_VERSION, name, sortingLayer, orderInLayer: 0, visible: true, collision: true, tint: "#ffffff", opacity: 1, palette: {}, chunks: {} };
}

type LayerMigration = (layer: Record<string, unknown>) => Record<string, unknown>;
/** Upgrades of a layer from version `n` (the key) to `n + 1`. */
const layerMigrations = new Map<number, LayerMigration>([
  // 1 → 2 (ADR 0392): cell values were tileset ids. Each id becomes its own palette number, naming the tile by the
  // uuid a tile from before uuids has (`legacyTileUuid`), so the cells keep their values and draw the same tiles.
  [
    1,
    (layer) => {
      const palette: Record<string, string> = {};
      if (typeof layer.chunks === "object" && layer.chunks !== null) {
        for (const [key, text] of Object.entries(layer.chunks as Record<string, unknown>)) {
          if (typeof text !== "string" || !parseChunkKey(key)) continue;
          for (const v of decodeChunk(text)) {
            const id = tileIdOf(v);
            if (id) palette[id] = legacyTileUuid(id);
          }
        }
      }
      return { ...layer, v: 2, palette };
    },
  ],
]);

/**
 * A layer read from a scene file, upgraded to the current version with defaults for missing
 * values. Throws for a newer version than this engine knows.
 */
export function migrateLayer(raw: unknown, where = "tilemap layer"): TilemapLayerData {
  let layer: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  let v = typeof layer.v === "number" ? layer.v : 1;
  if (v > TILEMAP_LAYER_VERSION) throw new Error(`${where}: layer version ${v} is newer than this engine supports (${TILEMAP_LAYER_VERSION}).`);
  while (v < TILEMAP_LAYER_VERSION) {
    const m = layerMigrations.get(v);
    if (!m) throw new Error(`${where}: no migration from layer version ${v}.`);
    layer = m(layer);
    v++;
  }
  const d = newLayer();
  const str = (k: string, def: string) => (typeof layer[k] === "string" ? (layer[k] as string) : def);
  const num = (k: string, def: number) => (typeof layer[k] === "number" && Number.isFinite(layer[k]) ? (layer[k] as number) : def);
  const bool = (k: string, def: boolean) => (typeof layer[k] === "boolean" ? (layer[k] as boolean) : def);
  const pair = (k: string): [number, number] | undefined => {
    const a = layer[k];
    return Array.isArray(a) && a.length === 2 && a.every((n) => typeof n === "number" && Number.isFinite(n)) ? [a[0] as number, a[1] as number] : undefined;
  };
  const chunks: Record<string, string> = {};
  if (typeof layer.chunks === "object" && layer.chunks !== null) {
    for (const [k, s] of Object.entries(layer.chunks as Record<string, unknown>)) if (typeof s === "string" && parseChunkKey(k)) chunks[k] = s;
  }
  const palette: Record<string, string> = {};
  if (typeof layer.palette === "object" && layer.palette !== null) {
    for (const [k, uuid] of Object.entries(layer.palette as Record<string, unknown>)) {
      const n = Number(k);
      if (typeof uuid === "string" && uuid && Number.isInteger(n) && n >= 1 && n <= TILE_ID_MASK && String(n) === k) palette[k] = uuid;
    }
  }
  return {
    v: TILEMAP_LAYER_VERSION,
    name: str("name", d.name),
    sortingLayer: str("sortingLayer", d.sortingLayer),
    orderInLayer: num("orderInLayer", 0),
    visible: bool("visible", true),
    collision: bool("collision", true),
    tint: str("tint", d.tint),
    opacity: num("opacity", 1),
    palette,
    chunks,
    // ADR 0425: additive, written only when not the default.
    ...((o) => (o && (o[0] !== 0 || o[1] !== 0) ? { offset: o } : {}))(pair("offset")),
    ...((p) => (p && (p[0] !== 1 || p[1] !== 1) ? { parallax: p } : {}))(pair("parallax")),
    ...(layer.locked === true ? { locked: true } : {}),
  };
}

export const chunkKey = (cx: number, cy: number): string => `${cx},${cy}`;

/** `"3,-2"` → `[3, -2]`, or null if it isn't a chunk key. */
export function parseChunkKey(key: string): [number, number] | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The chunk holding a cell, and the cell's index inside it. */
export function cellToChunk(x: number, y: number): { cx: number; cy: number; index: number } {
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
  return { cx, cy, index: (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE) };
}

/** Run-length encode a chunk's cells. */
export function encodeChunk(cells: ArrayLike<number>): string {
  const out: string[] = [];
  for (let i = 0; i < cells.length; ) {
    const v = cells[i];
    let n = 1;
    while (i + n < cells.length && cells[i + n] === v) n++;
    out.push(n === 1 ? String(v) : `${v}*${n}`);
    i += n;
  }
  return out.join(",");
}

/**
 * Decode a chunk string into 256 cells. Bad tokens read as empty cells and a short string leaves
 * the rest empty; `problems` (if given) notes either.
 */
export function decodeChunk(text: string, problems?: string[]): Int32Array {
  const cells = new Int32Array(CHUNK_CELLS);
  if (!text) return cells;
  let i = 0;
  for (const token of text.split(",")) {
    const m = /^(\d+)(?:\*(\d+))?$/.exec(token.trim());
    if (!m) {
      problems?.push(`bad chunk token "${token}"`);
      i++;
      continue;
    }
    const v = Number(m[1]) | 0, n = m[2] ? Number(m[2]) : 1;
    for (let k = 0; k < n && i < CHUNK_CELLS; k++) cells[i++] = v;
    if (i >= CHUNK_CELLS) break;
  }
  return cells;
}

/** True if every cell is empty. */
export function chunkIsEmpty(cells: ArrayLike<number>): boolean {
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) return false;
  return true;
}
