/**
 * Tileset assets (ADR 0103): `*.tileset.json` files listing the tiles a Tilemap can paint. Each
 * tile draws a sprite reference (`asset:images/tiles.png#grass_0`, a slice from the image's sidecar,
 * ADR 0040), and may carry a collision shape, custom data, a terrain and a neighbour pattern for
 * auto-tiling, and a weight for random brushes.
 *
 * ```jsonc
 * {
 *   "format": "myco.tileset@1",
 *   "tileSize": [16, 16],                 // pixels of one cell; a slice bigger than this overhangs up and right
 *   "terrains": [{ "name": "Ground", "color": "#7cb342" }],
 *   "tiles": [
 *     { "id": 1, "sprite": "asset:images/tiles.png#ground_0", "collision": "full",
 *       "terrain": "Ground", "pattern": "*1*1*0*1", "weight": 1, "data": { "surface": "grass" } },
 *     { "id": 2, "sprite": "asset:images/tiles.png#plank", "collision": "oneWay" },
 *     { "id": 3, "sprite": "asset:images/tiles.png#slope", "collision": { "polygon": [[0, 0], [1, 0], [1, 1]] } }
 *   ]
 * }
 * ```
 */

export const TILESET_FORMAT = "myco.tileset@1";
export const TILESET_SUFFIX = ".tileset.json";

/** A polygon in cell units: `[0, 0]` is the cell's bottom-left corner, `[1, 1]` its top-right. */
export interface TilePolygon {
  polygon: [number, number][];
  /** Collide only from above (bodies pass up through it). */
  oneWay?: boolean;
}

/** How a tile collides: not at all, as the whole cell, as a one-way platform the size of the cell, or as a polygon. */
export type TileCollision = "none" | "full" | "oneWay" | TilePolygon;

/** A neighbour pattern for auto-tiling: 8 characters, N NE E SE S SW W NW, each `1` (same terrain), `0` (not) or `*` (either). */
export type TilePattern = string;

export interface TileDef {
  /** Unique within the tileset, 1 to 16777215; cells store it, so it must never change. */
  id: number;
  /** Optional display name. */
  name?: string;
  /** Sprite reference, usually a slice: `asset:images/tiles.png#grass_0`. */
  sprite: string;
  collision: TileCollision;
  /** Terrain this tile belongs to, for auto-tiling. */
  terrain?: string;
  /** Where this tile fits in its terrain (default all `*`). */
  pattern?: TilePattern;
  /** Relative chance for random brushes and auto-tiling ties (default 1). */
  weight?: number;
  /** Anything the game wants, read with `Tilemap.getTileData`. */
  data?: Record<string, unknown>;
}

export interface TerrainDef {
  name: string;
  /** Colour the editor marks the terrain with. */
  color?: string;
}

export interface TilesetData {
  format: string;
  tileSize: [number, number];
  terrains: TerrainDef[];
  tiles: TileDef[];
}

export const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 1], // N
  [1, 1], // NE
  [1, 0], // E
  [1, -1], // SE
  [0, -1], // S
  [-1, -1], // SW
  [-1, 0], // W
  [-1, 1], // NW
];

export const ANY_PATTERN = "********";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A new, empty tileset. */
export function newTileset(tileSize: [number, number] = [16, 16]): TilesetData {
  return { format: TILESET_FORMAT, tileSize, terrains: [], tiles: [] };
}

/** True for a valid neighbour pattern. */
export const isPattern = (p: unknown): p is string => typeof p === "string" && /^[01*]{8}$/.test(p);

function parseCollision(raw: unknown): TileCollision | null {
  if (raw === undefined || raw === "none") return "none";
  if (raw === "full" || raw === "oneWay") return raw;
  if (isObject(raw) && Array.isArray(raw.polygon)) {
    const pts = raw.polygon.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
    if (pts.length < 3) return null;
    return raw.oneWay === true ? { polygon: pts, oneWay: true } : { polygon: pts };
  }
  return null;
}

/**
 * Read a tileset's parsed JSON, with defaults for missing values. Bad tiles are skipped and listed
 * in `problems`. Throws for another format.
 */
export function parseTileset(raw: unknown, where = "tileset"): { tileset: TilesetData; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error(`${where}: expected an object with "format": "${TILESET_FORMAT}".`);
  if (raw.format !== TILESET_FORMAT) throw new Error(`${where}: unknown format ${JSON.stringify(raw.format)}; expected "${TILESET_FORMAT}".`);
  const ts = newTileset();
  if (Array.isArray(raw.tileSize) && raw.tileSize.length === 2 && raw.tileSize.every((n) => typeof n === "number" && n > 0)) ts.tileSize = [raw.tileSize[0], raw.tileSize[1]];
  else if (raw.tileSize !== undefined) problems.push(`${where}: "tileSize" should be [width, height] in pixels; using 16 × 16.`);
  if (Array.isArray(raw.terrains)) {
    for (const t of raw.terrains) {
      if (isObject(t) && typeof t.name === "string" && t.name && !ts.terrains.some((o) => o.name === t.name)) ts.terrains.push(typeof t.color === "string" ? { name: t.name, color: t.color } : { name: t.name });
      else problems.push(`${where}: skipped a terrain without a unique name.`);
    }
  }
  const ids = new Set<number>();
  if (Array.isArray(raw.tiles)) {
    raw.tiles.forEach((t, i) => {
      if (!isObject(t) || !Number.isInteger(t.id) || (t.id as number) < 1 || (t.id as number) > 0xffffff) return problems.push(`${where}: tile ${i} needs an integer "id" from 1 to 16777215; skipped.`);
      const id = t.id as number;
      if (ids.has(id)) return problems.push(`${where}: tile id ${id} is used twice; skipped the second.`);
      const collision = parseCollision(t.collision);
      if (!collision) problems.push(`${where}: tile ${id} has a bad "collision"; it won't collide.`);
      const def: TileDef = { id, sprite: typeof t.sprite === "string" ? t.sprite : "", collision: collision ?? "none" };
      if (typeof t.name === "string") def.name = t.name;
      if (typeof t.terrain === "string" && t.terrain) def.terrain = t.terrain;
      if (t.pattern !== undefined) {
        if (isPattern(t.pattern)) def.pattern = t.pattern;
        else problems.push(`${where}: tile ${id} "pattern" should be 8 of 0, 1 or *; ignored.`);
      }
      if (typeof t.weight === "number" && t.weight >= 0) def.weight = t.weight;
      if (isObject(t.data)) def.data = structuredClone(t.data);
      ids.add(id);
      ts.tiles.push(def);
    });
  }
  return { tileset: ts, problems };
}

/** A tileset ready for lookups. */
export class Tileset {
  readonly tiles = new Map<number, TileDef>();
  /** Tiles of each terrain. */
  readonly byTerrain = new Map<string, TileDef[]>();

  constructor(readonly data: TilesetData) {
    for (const t of data.tiles) {
      this.tiles.set(t.id, t);
      if (t.terrain) {
        let list = this.byTerrain.get(t.terrain);
        if (!list) this.byTerrain.set(t.terrain, (list = []));
        list.push(t);
      }
    }
  }

  get tileSize(): [number, number] {
    return this.data.tileSize;
  }

  tile(id: number): TileDef | undefined {
    return this.tiles.get(id);
  }

  /** The next unused id. */
  nextId(): number {
    let max = 0;
    for (const id of this.tiles.keys()) max = Math.max(max, id);
    return max + 1;
  }
}

/** Pick one of `items` with chance proportional to `weight` (default 1), using `random` in [0, 1). */
export function pickWeighted<T extends { weight?: number }>(items: readonly T[], random: () => number = Math.random): T | undefined {
  if (items.length <= 1) return items[0];
  let total = 0;
  for (const t of items) total += t.weight ?? 1;
  if (total <= 0) return items[Math.floor(random() * items.length)];
  let r = random() * total;
  for (const t of items) {
    r -= t.weight ?? 1;
    if (r < 0) return t;
  }
  return items[items.length - 1];
}
