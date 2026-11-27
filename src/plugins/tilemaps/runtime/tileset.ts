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
 *   "anchor": [0.5, 0],                   // optional (ADR 0119): the sprite's point lands on the same point of the cell; tiles may set their own
 *   "terrains": [{ "name": "Ground", "color": "#7cb342" }],
 *   "tiles": [
 *     { "id": 1, "uuid": "3f0c9b1e-…", "sprite": "asset:images/tiles.png#ground_0", "collision": "full",
 *       "terrain": "Ground", "pattern": "*1*1*0*1", "weight": 1, "data": { "surface": "grass" } },
 *     { "id": 2, "sprite": "asset:images/tiles.png#plank", "collision": "oneWay" },
 *     { "id": 3, "sprite": "asset:images/tiles.png#slope", "collision": { "polygon": [[0, 0], [1, 0], [1, 1]] } }
 *   ]
 * }
 * ```
 *
 * Each tile has a `uuid` that never changes and is never given to another tile (ADR 0392): Tilemap layers refer to
 * tiles by it, through their palettes, so deleting a tile can't make maps paint another one in its place. A tile
 * without one (a file from before ADR 0392) gets `legacyTileUuid(id)`, the same on every load, and keeps it once the
 * file is saved. The integer `id` is the scripting handle (`Tilemap.setTile`, `getTile`).
 */

export const TILESET_FORMAT = "myco.tileset@1";
export const TILESET_SUFFIX = ".tileset.json";

/** A polygon in cell units: `[0, 0]` is the cell's bottom-left corner, `[1, 1]` its top-right. */
export interface TilePolygon {
  polygon: [number, number][];
  /** Collide only from above (bodies pass up through it). */
  oneWay?: boolean;
}

/** ADR 0439: several polygons, each optionally one-way, in the tile's box units. */
export interface TileShapes {
  shapes: TilePolygon[];
}

/**
 * How a tile collides: not at all, as the whole cell, as a one-way platform the size of the cell, as a polygon, or as
 * several polygons (ADR 0439). Polygons are in the tile's cell box units (ADR 0437): `[0, 0]` bottom-left, `[1, 1]`
 * top-right of the box its sprite is drawn in; `"full"` and `"oneWay"` mean the cell's own outline on any grid.
 */
export type TileCollision = "none" | "full" | "oneWay" | TilePolygon | TileShapes;

/** ADR 0439: what a tile casts 2D shadows with. `"collision"` (the default): its collision shapes. */
export type TileOccluder = "collision" | "none" | "full" | TileShapes;

/** ADR 0437: one frame of a tile's animation. Every frame comes from the tile sprite's image. */
export interface TileFrameDef {
  sprite: string;
  /** Seconds, > 0. */
  duration: number;
}

/** ADR 0437: a tile's frame animation. */
export interface TileAnimation {
  frames: TileFrameDef[];
  /** `"together"` (default): every cell shows the same frame. `"random"`: each cell starts at an offset from `cellRandom`. */
  start?: "together" | "random";
}

/** ADR 0439: which cell outline the tileset editor draws over tiles. Editor-only. */
export type TilesetPreviewGrid = "square" | "isometric" | "hexagonal";

/** ADR 0442: one layer of a saved stamp, in the layer encoding (palette numbers to tile uuids, run-length cells). */
export interface TileStampLayer {
  name: string;
  palette: Record<string, string>;
  /** Run-length cell values, `size[0] × size[1]` of them, row by row from the bottom-left; 0 leaves the map's cell alone. */
  cells: string;
}

/** ADR 0442: a named multi-cell stamp saved in the tileset. */
export interface TileStamp {
  name: string;
  size: [number, number];
  layers: TileStampLayer[];
  /**
   * ADR 0444: where the stamp was copied on a staggered or hexagonal map: the map's stagger axis, and whether the
   * stamp's bottom-left row (axis y) or column (axis x) is a shifted one. With it the stamp keeps its shape wherever it
   * is placed (its cells move by the grid's lattice); without it (stamps from square and isometric maps, and stamps
   * saved before ADR 0444) its cells land cell for cell in offset coordinates.
   */
  stagger?: { axis: "x" | "y"; shifted: boolean };
}

/** A neighbour pattern for auto-tiling: 8 characters, N NE E SE S SW W NW, each `1` (same terrain), `0` (not) or `*` (either). */
export type TilePattern = string;

export interface TileDef {
  /** Unique within the tileset, 1 to 16777215: what scripts name the tile by (`Tilemap.setTile`, `getTile`). */
  id: number;
  /** Unique within the tileset, never changed and never reused: what Tilemap layers' palettes name the tile by (ADR 0392). */
  uuid: string;
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
  /** Where the tile's sprite sits in its cell, `[x, y]` 0..1: the sprite's point lands on the same point of the cell (ADR 0119). Default: the tileset's, else `[0, 0]`. */
  anchor?: [number, number];
  /** Anything the game wants, read with `Tilemap.getTileData`. */
  data?: Record<string, unknown>;
  /** ADR 0437: frame animation. */
  animation?: TileAnimation;
  /** ADR 0439: shadow shapes; absent means `"collision"`. */
  occluder?: TileOccluder;
  /** ADR 0440: in a y-sorted layer, the tile sorts this many cells above its cell's bottom. Absent: 0. */
  sortOffset?: number;
}

export interface TerrainDef {
  name: string;
  /** Colour the editor marks the terrain with. */
  color?: string;
}

export interface TilesetData {
  format: string;
  tileSize: [number, number];
  /** Default anchor of the tiles' sprites in their cells (ADR 0119); tiles may set their own. Written only when not `[0, 0]`. */
  anchor?: [number, number];
  terrains: TerrainDef[];
  tiles: TileDef[];
  /** ADR 0439: the cell outline the editor draws over tiles. Editor-only. */
  previewGrid?: TilesetPreviewGrid;
  /** ADR 0442: saved stamps. */
  stamps?: TileStamp[];
  /** ADR 0442: prefabs offered by the prefab brush (`asset:` references). */
  prefabs?: string[];
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

/** A tile anchor `[x, y]` (each 0..1), or null if `raw` isn't one. */
export function parseAnchor(raw: unknown): [number, number] | null {
  if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === "number" && n >= 0 && n <= 1)) return [raw[0], raw[1]];
  return null;
}

/** The anchor of `tile`'s sprite in its cell: its own, else the tileset's, else `[0, 0]`. */
export function tileAnchor(data: TilesetData, tile: TileDef): [number, number] {
  return tile.anchor ?? data.anchor ?? [0, 0];
}

/**
 * The uuid a tile from before ADR 0392 (a file without `uuid`s) has: derived from its id, so the same on every load,
 * and the uuid a layer without a palette names each of its cell ids by. New tiles get random uuids instead, so a new
 * tile never takes a deleted old tile's place.
 */
export function legacyTileUuid(id: number): string {
  return `00000000-0000-4000-8000-${(id >>> 0).toString(16).padStart(12, "0")}`;
}

/** True for a valid neighbour pattern. */
export const isPattern = (p: unknown): p is string => typeof p === "string" && /^([01*]{8}|[01*]{6})$/.test(p); // 6 on hexagonal grids (ADR 0437)

function parsePolygon(raw: unknown): TilePolygon | null {
  if (!isObject(raw) || !Array.isArray(raw.polygon)) return null;
  const pts = raw.polygon.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length < 3) return null;
  return raw.oneWay === true ? { polygon: pts, oneWay: true } : { polygon: pts };
}

/** ADR 0439: `{ shapes: [...] }`, or null. A single shape reads as the single-polygon form. */
function parseShapes(raw: unknown): TilePolygon | TileShapes | null {
  if (!isObject(raw) || !Array.isArray(raw.shapes)) return null;
  const shapes = raw.shapes.map(parsePolygon).filter((p): p is TilePolygon => !!p);
  if (!shapes.length) return null;
  return shapes.length === 1 ? shapes[0]! : { shapes };
}

function parseCollision(raw: unknown): TileCollision | null {
  if (raw === undefined || raw === "none") return "none";
  if (raw === "full" || raw === "oneWay") return raw;
  return parsePolygon(raw) ?? parseShapes(raw);
}

/** The polygons of a tile's collision (or occluder) shapes; empty for the string forms. */
export function tilePolygons(c: TileCollision | TileOccluder | undefined): TilePolygon[] {
  if (!c || typeof c === "string") return [];
  return "shapes" in c ? c.shapes : [c];
}

function parseOccluder(raw: unknown): TileOccluder | null {
  if (raw === undefined || raw === "collision") return "collision";
  if (raw === "none" || raw === "full") return raw;
  const p = parsePolygon(raw);
  if (p) return { shapes: [p] };
  const s = parseShapes(raw);
  return s ? ("shapes" in s ? s : { shapes: [s] }) : null;
}

function parseAnimation(raw: unknown): TileAnimation | null {
  if (!isObject(raw) || !Array.isArray(raw.frames)) return null;
  const frames = raw.frames.filter((f): f is { sprite: string; duration: number } => isObject(f) && typeof f.sprite === "string" && !!f.sprite && typeof f.duration === "number" && f.duration > 0).map((f) => ({ sprite: f.sprite, duration: f.duration }));
  if (!frames.length) return null;
  return raw.start === "random" ? { frames, start: "random" } : { frames };
}

function parseStamp(raw: unknown): TileStamp | null {
  if (!isObject(raw) || typeof raw.name !== "string" || !Array.isArray(raw.size) || raw.size.length !== 2 || !raw.size.every((n) => Number.isInteger(n) && n > 0) || !Array.isArray(raw.layers)) return null;
  const layers: TileStampLayer[] = [];
  for (const l of raw.layers) {
    if (!isObject(l) || typeof l.name !== "string" || typeof l.cells !== "string" || !isObject(l.palette)) return null;
    const palette: Record<string, string> = {};
    for (const [k, v] of Object.entries(l.palette)) if (typeof v === "string") palette[k] = v;
    layers.push({ name: l.name, palette, cells: l.cells });
  }
  const stamp: TileStamp = { name: raw.name, size: [raw.size[0] as number, raw.size[1] as number], layers };
  const st = raw.stagger;
  if (isObject(st) && (st.axis === "x" || st.axis === "y") && typeof st.shifted === "boolean") stamp.stagger = { axis: st.axis, shifted: st.shifted };
  return stamp;
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
  if (raw.anchor !== undefined) {
    const a = parseAnchor(raw.anchor);
    if (a) ts.anchor = a;
    else problems.push(`${where}: "anchor" should be [x, y] from 0 to 1; using [0, 0].`);
  }
  if (Array.isArray(raw.terrains)) {
    for (const t of raw.terrains) {
      if (isObject(t) && typeof t.name === "string" && t.name && !ts.terrains.some((o) => o.name === t.name)) ts.terrains.push(typeof t.color === "string" ? { name: t.name, color: t.color } : { name: t.name });
      else problems.push(`${where}: skipped a terrain without a unique name.`);
    }
  }
  const ids = new Set<number>();
  const uuids = new Set<string>();
  if (Array.isArray(raw.tiles)) {
    raw.tiles.forEach((t, i) => {
      if (!isObject(t) || !Number.isInteger(t.id) || (t.id as number) < 1 || (t.id as number) > 0xffffff) return problems.push(`${where}: tile ${i} needs an integer "id" from 1 to 16777215; skipped.`);
      const id = t.id as number;
      if (ids.has(id)) return problems.push(`${where}: tile id ${id} is used twice; skipped the second.`);
      let uuid = typeof t.uuid === "string" && t.uuid ? t.uuid : legacyTileUuid(id);
      if (uuids.has(uuid)) {
        if (uuids.has(legacyTileUuid(id))) return problems.push(`${where}: tile ${id}'s uuid is another tile's; skipped.`);
        problems.push(`${where}: tile ${id}'s uuid is another tile's; it gets ${legacyTileUuid(id)}.`);
        uuid = legacyTileUuid(id);
      }
      const collision = parseCollision(t.collision);
      if (!collision) problems.push(`${where}: tile ${id} has a bad "collision"; it won't collide.`);
      const def: TileDef = { id, uuid, sprite: typeof t.sprite === "string" ? t.sprite : "", collision: collision ?? "none" };
      if (typeof t.name === "string") def.name = t.name;
      if (typeof t.terrain === "string" && t.terrain) def.terrain = t.terrain;
      if (t.pattern !== undefined) {
        if (isPattern(t.pattern)) def.pattern = t.pattern;
        else problems.push(`${where}: tile ${id} "pattern" should be 8 (6 on hexagonal grids) of 0, 1 or *; ignored.`);
      }
      if (typeof t.weight === "number" && t.weight >= 0) def.weight = t.weight;
      if (t.anchor !== undefined) {
        const a = parseAnchor(t.anchor);
        if (a) def.anchor = a;
        else problems.push(`${where}: tile ${id} "anchor" should be [x, y] from 0 to 1; ignored.`);
      }
      if (isObject(t.data)) def.data = structuredClone(t.data);
      if (t.animation !== undefined) {
        const a = parseAnimation(t.animation);
        if (a) def.animation = a;
        else problems.push(`${where}: tile ${id} "animation" needs frames of { sprite, duration > 0 }; ignored.`);
      }
      if (t.occluder !== undefined) {
        const o = parseOccluder(t.occluder);
        if (o && o !== "collision") def.occluder = o;
        else if (!o) problems.push(`${where}: tile ${id} has a bad "occluder"; it casts shadows with its collision.`);
      }
      if (typeof t.sortOffset === "number" && Number.isFinite(t.sortOffset) && t.sortOffset !== 0) def.sortOffset = t.sortOffset;
      ids.add(id);
      uuids.add(uuid);
      ts.tiles.push(def);
    });
  }
  if (raw.previewGrid === "square" || raw.previewGrid === "isometric" || raw.previewGrid === "hexagonal") ts.previewGrid = raw.previewGrid;
  if (Array.isArray(raw.stamps)) {
    const stamps = raw.stamps.map(parseStamp);
    if (stamps.some((s) => !s)) problems.push(`${where}: skipped a stamp without a name, size and layers.`);
    const ok = stamps.filter((s): s is TileStamp => !!s);
    if (ok.length) ts.stamps = ok;
  }
  if (Array.isArray(raw.prefabs)) {
    const prefabs = raw.prefabs.filter((p): p is string => typeof p === "string" && !!p);
    if (prefabs.length) ts.prefabs = prefabs;
  }
  return { tileset: ts, problems };
}

/** A tileset ready for lookups. */
export class Tileset {
  readonly tiles = new Map<number, TileDef>();
  /** Tiles by uuid (ADR 0392). */
  readonly byUuid = new Map<string, TileDef>();
  /** Tiles of each terrain. */
  readonly byTerrain = new Map<string, TileDef[]>();

  constructor(readonly data: TilesetData) {
    for (const t of data.tiles) {
      this.tiles.set(t.id, t);
      this.byUuid.set(t.uuid, t);
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

  /** The tile a layer palette's uuid names, or undefined when the tileset has none (it was deleted). */
  tileByUuid(uuid: string): TileDef | undefined {
    return this.byUuid.get(uuid);
  }

  /** The next unused id (one past the largest). Maps name tiles by uuid, so a reused id doesn't repaint them (ADR 0392). */
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
