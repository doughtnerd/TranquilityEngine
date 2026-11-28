/**
 * The native writer (ADR 0438): turns a parsed Tiled map, Tiled tileset or LDtk project (`model.ts`) into Myco files.
 * Pure: it takes the parsed model, the import options and a reader for the project files it would merge with (image
 * sidecars, the tilesets a previous import wrote), and returns the files to write and every warning. The editor's
 * import job (`importJob.ts`) reads the sources and writes the result.
 *
 * - **Tilesets** → `<folder>/<tileset>.tileset.json`. A grid image's tiles become slices `<tileset>_<index>` in the
 *   image's sidecar (ADR 0040), reusing a slice with the same rectangle; a collection's tiles name their whole images.
 *   Tile ids are the source index + 1; re-importing matches tiles by sprite (image and slice) to the tileset already
 *   there and keeps their `uuid` and `id` (ADR 0392).
 * - **Tiled maps** → `<folder>/<map>.prefab.json`: one Tilemap child per tileset the map's tile layers use, every
 *   layer's order in layer its place in Tiled's stack; object layers and image layers as nodes.
 * - **LDtk projects** → `<folder>/<project>/<level>.prefab.json` per level, `<folder>/<project>/<world>.world.prefab.json`
 *   per world instancing its levels, and `<folder>/<project>.intgrid.tileset.json` for the IntGrid layers.
 *
 * Positions: source pixels are y down, Myco's local units y up, `pixelsPerUnit` source pixels to a unit. Tile cells
 * convert through `grids.ts` (`tiledCellToCell`); every other source point maps by the same flip, anchored on cell
 * (0, 0), so objects land on the tiles they sat on.
 */

import { formatHex, parseHex } from "../../../../engine/core/colorSpace";
import { randomUuid } from "../../../../engine/core/uuid";
import { formatImportSettings, parseImportSettings, defaultImportSettings, sidecarPath, type ImportSettings } from "../../../../engine/scene/importSettings";
import { CURRENT_FORMAT_VERSION, SCENE_FORMAT, type ComponentEntry, type NodeEntry, type SceneFile } from "../../../../engine/scene/SceneLoader";
import { CHUNK_CELLS, FLIP_DIAGONAL, FLIP_X, FLIP_Y, TILEMAP_LAYER_VERSION, cellToChunk, cellValue, chunkKey, encodeChunk, type TilemapLayerData } from "../../runtime/format";
import { tiledCellToCell, tileGrid, type GridParams, type GridPoint } from "../../runtime/grids";
import { TILESET_FORMAT, TILESET_SUFFIX, parseTileset, type TileCollision, type TileDef, type TilePolygon, type TilesetData, type TilesetPreviewGrid } from "../../runtime/tileset";
import type {
  ImportCell,
  ImportEntityLayer,
  ImportImage,
  ImportImageLayer,
  ImportIntGridLayer,
  ImportLayer,
  ImportLdtkProject,
  ImportLevel,
  ImportObject,
  ImportObjectLayer,
  ImportProperties,
  ImportRect,
  ImportTiledMap,
  ImportTiledTilesetFile,
  ImportTileset,
  ImportValue,
} from "./model";
import { baseName } from "./shared";

// ---------------------------------------------------------------------------------------------------------------
// Options and results

/** How an IntGrid value collides (ADR 0438: chosen in the import dialog, default none). */
export type IntGridCollision = "none" | "full" | "oneWay";

export interface NativeImportOptions {
  /** The project folder the files go in ("" for the project root). */
  folder: string;
  /** Source pixels per Myco unit. Default: the map's tile width (LDtk: the project's default grid size). */
  pixelsPerUnit?: number;
  /** Tiled objects and LDtk entities become nodes with a `MapObject`. Default true. */
  objectsAsNodes?: boolean;
  /** Their shapes become trigger colliders. Default false. */
  shapesAsTriggers?: boolean;
  /** LDtk: each IntGrid value's collision, keyed by `intGridKey(layer, value)`. Absent: none. */
  intGridCollision?: Record<string, IntGridCollision>;
}

/** The key of one IntGrid layer's value in `NativeImportOptions.intGridCollision`. */
export const intGridKey = (layer: string, value: number): string => `${layer}:${value}`;

/** One file to write: its project path and text. */
export interface NativeFile {
  path: string;
  text: string;
}

export interface NativeImportResult {
  /** Tilesets, then changed image sidecars, then prefabs. */
  files: NativeFile[];
  warnings: string[];
}

/** A project file's current text (a previous import's tileset, an image's sidecar), or null when there's none. */
export type ExistingText = (path: string) => string | null;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const isAbsoluteOrOutside = (path: string) => path.startsWith("/") || path.startsWith("../") || path === ".." || /^[A-Za-z]:\//.test(path);
const join = (folder: string, name: string) => (folder ? `${folder.replace(/\/+$/, "")}/${name}` : name);
/** A number without float noise or a negative zero, for stable files. */
const r = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
/** A name usable in a file name and a slice name. */
const fileSafe = (name: string) => name.replace(/[#/\\"':*?<>|]+/g, "_").trim() || "unnamed";
/** A name usable in a node id. */
const idSafe = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "_";

/** A short stable hash (FNV-1a, base 36) of a path, to keep node ids of different maps apart. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** A node id not yet used in `nodes` (`id`, else `id-2`…). */
function uniqueId(id: string, nodes: readonly NodeEntry[]): string {
  const ids = new Set(nodes.map((n) => n.id));
  let out = id;
  for (let i = 2; ids.has(out); i++) out = `${id}-${i}`;
  return out;
}

/** `name` made unique among `taken` (adds " 2", " 3"…), and taken. */
function unique(name: string, taken: Set<string>): string {
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name} ${i}`;
  taken.add(out.toLowerCase());
  return out;
}

/** Split a hex colour (ADR 0461) into its `#rrggbb` and its alpha 0..1; anything else is opaque white. */
function splitColor(c: string | undefined): { rgb: string; alpha: number } {
  const p = c ? parseHex(c) : null;
  return p ? { rgb: formatHex(p), alpha: p[3] } : { rgb: "#ffffff", alpha: 1 };
}

function transform(position: GridPoint, angle = 0): ComponentEntry {
  const data: Record<string, unknown> = { position: [r(position[0]), r(position[1]), 0] };
  if (Math.abs(angle) > 1e-9) data.rotation = [0, 0, r(Math.sin(angle / 2)), r(Math.cos(angle / 2))];
  return { type: "engine.Transform", data };
}

function prefabText(nodes: NodeEntry[]): string {
  const file: SceneFile = { format: `${SCENE_FORMAT}@${CURRENT_FORMAT_VERSION}`, nodes };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Points of an ellipse inscribed in a box, counter-clockwise from the right, in the box's own frame. */
function ellipsePoints(cx: number, cy: number, rx: number, ry: number, n = 16): GridPoint[] {
  const out: GridPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Neighbour patterns (Wang sets → the grid's neighbour order)

/**
 * A Tiled Wang pattern (8 characters in Tiled's Wang id order: top, top-right, right, bottom-right, bottom,
 * bottom-left, left, top-left) in the neighbour order of the grid it paints on (`grids.ts` `neighbours`):
 *
 * - square: the same (Tiled's top is the cell above, Myco's N).
 * - isometric and staggered: Tiled's top is the neighbour up-right on screen, which is Myco's E (`tiledCellToCell`
 *   swaps and negates the axes), so the order turns by two. Tiled's staggered maps take its Wang neighbours from the
 *   hexagonal renderer (top up-right, top-right the cell to the right, …), the same screen directions as isometric
 *   maps, on either stagger axis.
 * - hexagonal: Tiled's edge indices name the diagonal neighbours (up-right, down-right, down-left, up-left) and two of
 *   its corner indices the cells straight across the remaining sides (right and left on pointy-top maps, below and
 *   above on flat-top ones); Myco's 6 neighbours are clockwise from the first side at or after north. The other two
 *   corner indices name cells two rows (columns) away, which aren't neighbours, so corner sets lose those corners.
 *
 * Checked against maps painted by Tiled (ADR 0444): its isometric and staggered grass-and-water examples and its
 * orthogonal desert, where every tile shares its corners with its neighbours in this order and no other. No Tiled map
 * with a hexagonal Wang set was at hand; that order follows Tiled's `WangFiller`.
 */
function patternForGrid(pattern: string, grid: Pick<GridParams, "shape" | "staggerAxis">): string {
  if (pattern.length !== 8) return pattern;
  const pick = (order: number[]) => order.map((i) => pattern[i]).join("");
  switch (grid.shape) {
    case "isometric":
    case "staggered":
      return pick([6, 7, 0, 1, 2, 3, 4, 5]);
    case "hexagonal":
      return (grid.staggerAxis ?? "y") === "x" ? pick([7, 0, 2, 3, 4, 6]) : pick([0, 1, 2, 4, 5, 6]);
    default:
      return pattern;
  }
}

const previewGridOf = (shape: GridParams["shape"]): TilesetPreviewGrid => (shape === "hexagonal" ? "hexagonal" : shape === "square" ? "square" : "isometric");

// ---------------------------------------------------------------------------------------------------------------
// The shared writer: sidecars, tilesets, files

/** A tileset as written: where, and each source tile's uuid and sprite. */
interface WrittenTileset {
  path: string;
  source: ImportTileset;
  uuidOf: Map<number, string>;
  spriteOf: Map<number, string>;
  collides: Set<number>;
}

class Writer {
  readonly warnings: string[];
  private readonly files = new Map<string, string>();
  /** Each image's settings as this import leaves them; `broken` when its sidecar can't be read (left alone). */
  private readonly sidecars = new Map<string, { settings: ImportSettings; changed: boolean; broken: boolean }>();
  private readonly tilesetNames = new Set<string>();
  readonly folder: string;

  constructor(
    readonly options: NativeImportOptions,
    readonly existing: ExistingText,
    readonly newUuid: () => string,
    warnings: readonly string[],
  ) {
    this.warnings = [...warnings];
    this.folder = options.folder.replace(/^\/+|\/+$/g, "");
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  add(path: string, text: string): void {
    this.files.set(path, text);
  }

  /** An image's import settings: as this import left them, else its sidecar's, else the defaults. */
  private sidecar(image: string): { settings: ImportSettings; changed: boolean; broken: boolean } {
    let s = this.sidecars.get(image);
    if (s) return s;
    const text = this.existing(sidecarPath(image));
    s = { settings: defaultImportSettings(), changed: false, broken: false };
    if (text !== null) {
      try {
        s.settings = parseImportSettings(JSON.parse(text), sidecarPath(image)).settings;
      } catch (err) {
        this.warn(`${sidecarPath(image)} couldn't be read (${(err as Error).message}); it isn't changed, so the tiles of ${image} have no sprites.`);
        s.broken = true;
      }
    }
    this.sidecars.set(image, s);
    return s;
  }

  /**
   * The slice of `image` covering `rect` (ADR 0040): an existing slice with the same rectangle, else a new one named
   * `name` (made unique). Null when the image is outside the project or its sidecar can't be read.
   */
  slice(image: string, rect: ImportRect, name: string): string | null {
    const s = this.sidecar(image);
    if (s.broken) return null;
    const same = s.settings.sprites.find((sp) => sp.rect[0] === rect.x && sp.rect[1] === rect.y && sp.rect[2] === rect.w && sp.rect[3] === rect.h);
    if (same) return same.name;
    const names = new Set(s.settings.sprites.map((sp) => sp.name));
    let n = name;
    for (let i = 2; names.has(n); i++) n = `${name}_${i}`;
    s.settings.sprites.push({ name: n, rect: [rect.x, rect.y, rect.w, rect.h], pivot: [0.5, 0.5] });
    s.changed = true;
    return n;
  }

  /** The sprite reference of a tile's rectangle of `image`: the whole image when it covers it, else a slice. */
  sprite(image: ImportImage, rect: ImportRect, sliceName: string, whole: boolean): string | null {
    if (isAbsoluteOrOutside(image.path)) {
      this.warn(`${image.path} is outside the project; copy it into the project and import again to use its tiles.`);
      return null;
    }
    const covers = rect.x === 0 && rect.y === 0 && (!image.width || rect.w === image.width) && (!image.height || rect.h === image.height);
    if (whole && covers) return `asset:${image.path}`;
    const slice = this.slice(image.path, rect, sliceName);
    return slice === null ? null : `asset:${image.path}#${slice}`;
  }

  /** A free tileset path in the output folder for a tileset named `name`. */
  tilesetPath(name: string): string {
    return join(this.folder, `${unique(fileSafe(name), this.tilesetNames)}${TILESET_SUFFIX}`);
  }

  /** The tiles of the tileset a previous import wrote at `path`, by sprite (ADR 0392: their uuids and ids are kept). */
  private previous(path: string): Map<string, TileDef> {
    const out = new Map<string, TileDef>();
    const text = this.existing(path);
    if (text === null) return out;
    try {
      for (const t of parseTileset(JSON.parse(text), path).tileset.tiles) if (t.sprite && !out.has(t.sprite)) out.set(t.sprite, t);
    } catch (err) {
      this.warn(`${path} couldn't be read (${(err as Error).message}); its tiles get new uuids, so maps painted with it lose their cells.`);
    }
    return out;
  }

  /**
   * Write `ts` as a Myco tileset at `path`: `cell` is one cell's size in pixels (the map's tile size, else the
   * tileset's), `grid` the grid its Wang patterns are for.
   */
  tileset(ts: ImportTileset, path: string, cell: [number, number], grid: Pick<GridParams, "shape" | "staggerAxis">, previewGrid: TilesetPreviewGrid | undefined): WrittenTileset {
    const where = `Tileset "${ts.name}"`;
    const sliceBase = fileSafe(ts.name);
    const spriteOf = new Map<number, string>();
    for (const tile of ts.tiles) {
      const image = tile.image ?? ts.image;
      if (!image) continue;
      const sprite = this.sprite(image, tile.rect, `${sliceBase}_${tile.index}`, !!tile.image);
      if (sprite) spriteOf.set(tile.index, sprite);
    }
    const prev = this.previous(path);
    // Kept tiles keep their ids; new ones take index + 1 where free, else the next free id.
    const kept = new Map<number, TileDef>();
    const used = new Set<number>();
    for (const tile of ts.tiles) {
      const old = prev.get(spriteOf.get(tile.index) ?? "");
      if (old && !used.has(old.id)) {
        kept.set(tile.index, old);
        used.add(old.id);
      }
    }
    let next = 1;
    for (const id of used) next = Math.max(next, id + 1);
    for (const t of ts.tiles) next = Math.max(next, t.index + 2);
    const uuidOf = new Map<number, string>();
    const collides = new Set<number>();
    const tiles: TileDef[] = [];
    for (const tile of ts.tiles) {
      const sprite = spriteOf.get(tile.index) ?? "";
      const old = kept.get(tile.index);
      let id = old?.id ?? tile.index + 1;
      if (!old && used.has(id)) id = next++;
      used.add(id);
      const uuid = old?.uuid ?? this.newUuid();
      uuidOf.set(tile.index, uuid);
      const def: TileDef = { id, uuid, sprite, collision: collisionOf(tile.shapes) };
      if (tile.shapes.length) collides.add(tile.index);
      if (tile.terrain) {
        def.terrain = tile.terrain;
        if (tile.pattern) def.pattern = patternForGrid(tile.pattern, grid);
      }
      if (tile.weight !== undefined) def.weight = tile.weight;
      if (tile.data) def.data = structuredClone(tile.data);
      if (tile.animation?.length) {
        const frames = tile.animation.flatMap((f) => {
          const s = spriteOf.get(f.tileIndex);
          return s && f.durationSeconds > 0 ? [{ sprite: s, duration: r(f.durationSeconds) }] : [];
        });
        if (frames.length === tile.animation.length) def.animation = { frames };
        else this.warn(`${where}: tile ${tile.index}'s animation names a tile it doesn't have or a zero duration; it isn't animated.`);
      }
      tiles.push(def);
    }
    const data: TilesetData = { format: TILESET_FORMAT, tileSize: [cell[0], cell[1]], terrains: ts.terrains.map((t) => (t.color ? { name: t.name, color: t.color } : { name: t.name })), tiles };
    const anchor = anchorOf(ts, cell);
    if (anchor === null) this.warn(`${where}: its tile offset (${ts.offset[0]}, ${ts.offset[1]}) can't be expressed as an anchor; tiles sit at the cell's corner.`);
    else if (anchor[0] !== 0 || anchor[1] !== 0) data.anchor = anchor;
    if (previewGrid) data.previewGrid = previewGrid;
    this.add(path, tilesetText(data));
    return { path, source: ts, uuidOf, spriteOf, collides };
  }

  /** The files: tilesets and prefabs as added, with the sidecars this import changed after the tilesets. */
  result(): NativeImportResult {
    const files: NativeFile[] = [];
    const sidecars: NativeFile[] = [];
    for (const [image, s] of this.sidecars) if (s.changed) sidecars.push({ path: sidecarPath(image), text: formatImportSettings(s.settings) });
    const entries = [...this.files].map(([path, text]) => ({ path, text }));
    files.push(...entries.filter((f) => f.path.endsWith(TILESET_SUFFIX)), ...sidecars, ...entries.filter((f) => !f.path.endsWith(TILESET_SUFFIX)));
    return { files, warnings: this.warnings };
  }
}

/** Tileset text as the tileset format writes it (pretty JSON). */
const tilesetText = (data: TilesetData) => `${JSON.stringify(data, null, 2)}\n`;

/** A tile's collision from its polygons (ADR 0439): none, one polygon, or several. */
function collisionOf(shapes: readonly TilePolygon[]): TileCollision {
  if (!shapes.length) return "none";
  const copy = shapes.map((s) => (s.oneWay ? { polygon: s.polygon.map(([x, y]) => [r(x), r(y)] as [number, number]), oneWay: true } : { polygon: s.polygon.map(([x, y]) => [r(x), r(y)] as [number, number]) }));
  return copy.length === 1 ? copy[0]! : { shapes: copy };
}

/**
 * The anchor (ADR 0119) that draws a tile where Tiled's `tileoffset` puts it: the sprite's point (a·w, a·h) lands on the
 * cell's (a·cw, a·ch), so the sprite moves a·(cw − w) right and a·(ch − h) up. Null when no anchor in 0..1 does it.
 */
function anchorOf(ts: ImportTileset, cell: [number, number]): [number, number] | null {
  const axis = (offset: number, cellSize: number, tileSize: number): number | null => {
    if (Math.abs(offset) < 1e-9) return 0;
    const room = cellSize - tileSize;
    if (Math.abs(room) < 1e-9) return null;
    const a = offset / room;
    return a >= -1e-9 && a <= 1 + 1e-9 ? r(Math.max(0, Math.min(1, a))) : null;
  };
  const ax = axis(ts.offset[0], cell[0], ts.tileWidth);
  const ay = axis(-ts.offset[1], cell[1], ts.tileHeight);
  return ax === null || ay === null ? null : [ax, ay];
}

// ---------------------------------------------------------------------------------------------------------------
// Layers

/** A Tilemap layer of `cells` (Myco cells and flip flags → tile uuids), with its meta from `layer`. */
function encodeLayer(
  name: string,
  meta: { visible: boolean; opacity: number; tint?: string; offset: GridPoint; parallax: [number, number]; locked: boolean },
  order: number,
  cells: { x: number; y: number; uuid: string; flags: number }[],
): TilemapLayerData {
  const palette: Record<string, string> = {};
  const numbers = new Map<string, number>();
  const chunks = new Map<string, Int32Array>();
  for (const c of cells) {
    let n = numbers.get(c.uuid);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(c.uuid, n);
      palette[n] = c.uuid;
    }
    const { cx, cy, index } = cellToChunk(c.x, c.y);
    const key = chunkKey(cx, cy);
    let chunk = chunks.get(key);
    if (!chunk) chunks.set(key, (chunk = new Int32Array(CHUNK_CELLS)));
    chunk[index] = cellValue(n, c.flags);
  }
  const sorted = [...chunks.keys()].sort((a, b) => {
    const [ax, ay] = a.split(",").map(Number) as [number, number];
    const [bx, by] = b.split(",").map(Number) as [number, number];
    return ay - by || ax - bx;
  });
  const { rgb, alpha } = splitColor(meta.tint);
  const layer: TilemapLayerData = {
    v: TILEMAP_LAYER_VERSION,
    name,
    sortingLayer: "Default",
    orderInLayer: order,
    visible: meta.visible,
    collision: true,
    tint: rgb,
    opacity: r(meta.opacity * alpha),
    palette,
    chunks: Object.fromEntries(sorted.map((k) => [k, encodeChunk(chunks.get(k)!)])),
  };
  if (Math.abs(meta.offset[0]) > 1e-9 || Math.abs(meta.offset[1]) > 1e-9) layer.offset = [r(meta.offset[0]), r(meta.offset[1])];
  if (meta.parallax[0] !== 1 || meta.parallax[1] !== 1) layer.parallax = [meta.parallax[0], meta.parallax[1]];
  if (meta.locked) layer.locked = true;
  return layer;
}

const flagsOfCell = (c: { flipX: boolean; flipY: boolean; flipDiagonal: boolean }) => (c.flipX ? FLIP_X : 0) | (c.flipY ? FLIP_Y : 0) | (c.flipDiagonal ? FLIP_DIAGONAL : 0);

/** The Tilemap component's data for a grid, its tileset and layers. */
function tilemapComponent(tileset: string, grid: GridParams, layers: TilemapLayerData[]): ComponentEntry {
  const data: Record<string, unknown> = { tileset: `asset:${tileset}`, cellSize: [r(grid.cellSize.x), r(grid.cellSize.y)], gridShape: grid.shape };
  if (grid.shape === "staggered" || grid.shape === "hexagonal") {
    data.staggerAxis = grid.staggerAxis ?? "y";
    data.staggerIndex = grid.staggerIndex ?? "odd";
  }
  if (grid.shape === "hexagonal") data.hexSide = r(grid.hexSide ?? 0.5);
  data.layers = layers;
  return { type: "engine.Tilemap", data };
}

/** ADR 0439: the tile collider every Tilemap whose tiles collide gets. */
const SHAPE_COLLIDER: ComponentEntry = { type: "engine.ShapeCollider2D", data: {} };

const mapObject = (type: string, properties: Record<string, unknown>): ComponentEntry => ({ type: "engine.MapObject", data: { type, properties } });

// ---------------------------------------------------------------------------------------------------------------
// Values

interface ValueContext {
  /** A Tiled object reference's node id (null for no object). */
  object(id: string): string | null;
  /** An LDtk point (layer cell) in local units. */
  point(cx: number, cy: number): GridPoint;
  /** An LDtk tile rectangle as a sprite reference, or its plain description. */
  tile(tilesetIndex: number, rect: ImportRect): unknown;
}

function jsonValue(v: ImportValue, ctx: ValueContext): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => jsonValue(x, ctx));
  switch (v.kind) {
    case "object":
      return ctx.object(v.id);
    case "file":
      return v.path;
    case "class":
      return jsonProps(v.fields, ctx);
    case "point": {
      const [x, y] = ctx.point(v.cx, v.cy);
      return [r(x), r(y)];
    }
    case "entity":
      return v.entityIid;
    case "tile":
      return ctx.tile(v.tilesetIndex, v);
  }
}

function jsonProps(props: ImportProperties, ctx: ValueContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = jsonValue(v, ctx);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tiled maps

/** Where Tiled's pixels land in a map's local space (y up, in pixels; divide by pixels per unit for units). */
interface TiledSpace {
  /** A screen pixel of the map (y down) in local pixels. */
  screen(px: number, py: number): GridPoint;
  /** An object position (Tiled's object space: screen pixels, or on isometric maps its projected space) in local pixels. */
  object(px: number, py: number): GridPoint;
}

function tiledSpace(map: ImportTiledMap, grid: GridParams): TiledSpace {
  const { tileWidth: tw, tileHeight: th } = map.grid;
  const W = map.width, H = map.height;
  const shift0 = map.grid.staggerIndex === "even";
  // Tiled's centre of cell (0, 0) in screen pixels, and Myco's centre of the cell it converts to: the rest is a flip.
  let t0: GridPoint;
  switch (map.grid.shape) {
    case "isometric":
      t0 = [(H * tw) / 2, th / 2];
      break;
    case "staggered":
    case "hexagonal":
      t0 = map.grid.staggerAxis === "x" ? [tw / 2, th / 2 + (shift0 ? th / 2 : 0)] : [tw / 2 + (shift0 ? tw / 2 : 0), th / 2];
      break;
    default:
      t0 = [tw / 2, th / 2];
  }
  const pixelGrid = tileGrid({ ...grid, cellSize: { x: tw, y: th } });
  const [c0x, c0y] = tiledCellToCell(grid, 0, 0, W, H);
  const m0 = pixelGrid.cellToLocal(c0x, c0y);
  const screen = (px: number, py: number): GridPoint => [m0[0] + px - t0[0], m0[1] - (py - t0[1])];
  const object =
    map.grid.shape === "isometric"
      ? (px: number, py: number): GridPoint => {
          // Tiled's isometric object space: both axes in tile-height units along the map's axes.
          const a = px / th, b = py / th;
          return screen((a - b) * (tw / 2) + (H * tw) / 2, (a + b) * (th / 2));
        }
      : screen;
  return { screen, object };
}

/** Write a parsed Tiled map: its tilesets, the sidecar slices they need, and its prefab. */
export function writeTiledMap(map: ImportTiledMap, options: NativeImportOptions, existing: ExistingText, newUuid: () => string = randomUuid): NativeImportResult {
  const w = new Writer(options, existing, newUuid, map.warnings);
  const ppu = options.pixelsPerUnit && options.pixelsPerUnit > 0 ? options.pixelsPerUnit : map.grid.tileWidth;
  const grid: GridParams = { shape: map.grid.shape, cellSize: { x: map.grid.tileWidth / ppu, y: map.grid.tileHeight / ppu }, staggerAxis: map.grid.staggerAxis, staggerIndex: map.grid.staggerIndex, hexSide: map.grid.hexSide };
  const space = tiledSpace(map, grid);
  const units = (p: GridPoint): GridPoint => [p[0] / ppu, p[1] / ppu];
  const preview = previewGridOf(map.grid.shape);
  const written = map.tilesets.map((ts) => w.tileset(ts, w.tilesetPath(ts.path ? baseName(ts.path) : ts.name), [map.grid.tileWidth, map.grid.tileHeight], grid, preview));

  const h = shortHash(map.path);
  const rootId = `${h}-map`;
  const objectId = (id: string) => `${h}-o${id}`;
  const nodes: NodeEntry[] = [];
  const rootComponents: ComponentEntry[] = [transform([0, 0])];
  const ctx: ValueContext = {
    object: (id) => (id && id !== "0" ? objectId(id) : null),
    point: (cx, cy) => [cx, cy],
    tile: (_i, rect) => rect,
  };
  if (map.class || Object.keys(map.properties).length) rootComponents.push(mapObject(map.class ?? "", jsonProps(map.properties, ctx)));
  nodes.push({ id: rootId, name: map.name, components: rootComponents });

  if (map.layers.some((l) => l.parallax[0] !== 1 || l.parallax[1] !== 1) && (map.parallaxOrigin[0] !== 0 || map.parallaxOrigin[1] !== 0)) {
    w.warn(`${map.name}: the parallax origin (${map.parallaxOrigin[0]}, ${map.parallaxOrigin[1]}) isn't imported; parallax layers move about the camera's view as Myco's do.`);
  }

  // Tile layers: one Tilemap per tileset, each with every layer's cells from it.
  const byTileset = new Map<number, TilemapLayerData[]>();
  map.layers.forEach((layer, order) => {
    if (layer.kind !== "tiles") return;
    const groups = new Map<number, ImportCell[]>();
    for (const c of layer.cells) {
      let g = groups.get(c.tilesetIndex);
      if (!g) groups.set(c.tilesetIndex, (g = []));
      g.push(c);
    }
    for (const [ti, cells] of [...groups].sort((a, b) => a[0] - b[0])) {
      const ts = written[ti];
      if (!ts) continue;
      const myco = cells.flatMap((c) => {
        const uuid = ts.uuidOf.get(c.tileIndex);
        if (!uuid) return [];
        const [x, y] = tiledCellToCell(grid, c.x, c.y, map.width, map.height);
        return [{ x, y, uuid, flags: flagsOfCell(c) }];
      });
      if (myco.length < cells.length) w.warn(`Layer "${layer.name}": ${cells.length - myco.length} cell(s) name a tile tileset "${ts.source.name}" doesn't have; they were left empty.`);
      const meta = { ...layer, offset: units([layer.offset[0], -layer.offset[1]]) };
      let list = byTileset.get(ti);
      if (!list) byTileset.set(ti, (list = []));
      list.push(encodeLayer(layer.name, meta, order, myco));
    }
  });
  for (const [ti, layers] of [...byTileset].sort((a, b) => a[0] - b[0])) {
    const ts = written[ti]!;
    const collides = map.layers.some((l) => l.kind === "tiles" && l.cells.some((c) => c.tilesetIndex === ti && ts.collides.has(c.tileIndex)));
    const components: ComponentEntry[] = [transform([0, 0]), tilemapComponent(ts.path, grid, layers)];
    if (collides) components.push(SHAPE_COLLIDER);
    nodes.push({ id: uniqueId(`${h}-ts-${idSafe(ts.source.path ?? ts.source.name)}`, nodes), name: ts.source.name, parent: rootId, components });
  }

  // Object layers and image layers, as nodes.
  map.layers.forEach((layer, order) => {
    if (layer.kind === "objects" && options.objectsAsNodes !== false) nodes.push(...tiledObjectLayer(layer, order, { w, h, rootId, ppu, space, ctx, written, iso: map.grid.shape === "isometric", options }));
    else if (layer.kind === "image") {
      const n = tiledImageLayer(layer, order, `${h}-l${layer.id}`, rootId, ppu, space);
      if (n) nodes.push(n);
      if (layer.repeatX || layer.repeatY) w.warn(`Image layer "${layer.name}": repeating isn't imported; the image is drawn once.`);
      if (layer.parallax[0] !== 1 || layer.parallax[1] !== 1) w.warn(`Image layer "${layer.name}": parallax isn't imported for images (only for tile layers); it moves with the map.`);
    }
  });

  w.add(join(w.folder, `${fileSafe(map.name)}.prefab.json`), prefabText(nodes));
  return w.result();
}

interface ObjectLayerContext {
  w: Writer;
  h: string;
  rootId: string;
  ppu: number;
  space: TiledSpace;
  ctx: ValueContext;
  written: WrittenTileset[];
  iso: boolean;
  options: NativeImportOptions;
}

/** A Tiled object layer → a node, with a node per object. */
function tiledObjectLayer(layer: ImportObjectLayer, order: number, c: ObjectLayerContext): NodeEntry[] {
  const { ppu, space } = c;
  const layerId = `${c.h}-l${layer.id}`;
  const layerComponents: ComponentEntry[] = [transform([layer.offset[0] / ppu, -layer.offset[1] / ppu])];
  if (layer.class || Object.keys(layer.properties).length) layerComponents.push(mapObject(layer.class ?? "", jsonProps(layer.properties, c.ctx)));
  const out: NodeEntry[] = [{ id: layerId, name: layer.name, parent: c.rootId, ...(layer.visible ? {} : { active: false }), components: layerComponents }];
  // The layer node sits at the layer's offset; objects are placed relative to the map's origin.
  const local = (px: number, py: number): GridPoint => {
    const [x, y] = space.object(px, py);
    return [x / ppu, y / ppu];
  };
  for (const o of layer.objects) {
    const origin = local(o.x, o.y);
    const angle = (-o.rotation * Math.PI) / 180;
    const components: ComponentEntry[] = [];
    let position = origin;
    const nodeAngle = c.iso ? 0 : angle;
    if (c.iso && Math.abs(o.rotation) > 1e-9) c.w.warn(`Object ${o.id}${o.name ? ` "${o.name}"` : ""}: rotation on isometric maps isn't imported.`);
    if (o.shape === "tile" && o.tile) {
      const ts = c.written[o.tile.tilesetIndex];
      const sprite = ts?.spriteOf.get(o.tile.tileIndex);
      // The sprite is drawn about its centre: bottom-left (orthogonal) or bottom-centre (isometric) origin, rotated.
      if (c.iso) position = [origin[0], origin[1] + o.height / 2 / ppu];
      else {
        const hx = o.width / 2 / ppu, hy = o.height / 2 / ppu;
        position = [origin[0] + hx * Math.cos(angle) - hy * Math.sin(angle), origin[1] + hx * Math.sin(angle) + hy * Math.cos(angle)];
      }
      if (sprite) {
        const data: Record<string, unknown> = { sprite, size: [r(o.width / ppu), r(o.height / ppu)], orderInLayer: order };
        if (o.tile.flipX) data.flipX = true;
        if (o.tile.flipY) data.flipY = true;
        components.push({ type: "engine.SpriteRenderer", data });
        if (o.tile.flipDiagonal) c.w.warn(`Object ${o.id}: its tile's diagonal flip isn't imported.`);
      } else c.w.warn(`Object ${o.id}${o.name ? ` "${o.name}"` : ""}: its tile isn't in a written tileset; it has no sprite.`);
    }
    if (c.options.shapesAsTriggers) {
      const collider = c.iso ? isoCollider(o, origin, local) : objectCollider(o, ppu);
      if (collider) components.push(collider);
    }
    components.unshift(transform(position, nodeAngle));
    components.push(mapObject(o.class, jsonProps(o.properties, c.ctx)));
    out.push({ id: `${c.h}-o${o.id}`, name: o.name || o.class || `Object ${o.id}`, parent: layerId, ...(o.visible ? {} : { active: false }), components });
  }
  return out;
}

/** A trigger collider for an object on a non-isometric map, in the node's frame (origin at the object's, y up). */
function objectCollider(o: ImportObject, ppu: number): ComponentEntry | null {
  const w = o.width / ppu, h = o.height / ppu;
  const pts = (list: [number, number][]) => list.map(([x, y]) => [r(x / ppu), r(-y / ppu)]);
  switch (o.shape) {
    case "rect":
      return { type: "engine.BoxCollider2D", data: { size: [r(w), r(h)], center: [r(w / 2), r(-h / 2)], isTrigger: true } };
    case "ellipse":
      if (Math.abs(w - h) < 1e-9) return { type: "engine.CircleCollider2D", data: { radius: r(w / 2), center: [r(w / 2), r(-h / 2)], isTrigger: true } };
      return { type: "engine.PolygonCollider2D", data: { points: ellipsePoints(w / 2, -h / 2, w / 2, h / 2).map(([x, y]) => [r(x), r(y)]), isTrigger: true } };
    case "polygon":
      return o.points && o.points.length >= 3 ? { type: "engine.PolygonCollider2D", data: { points: pts(o.points), isTrigger: true } } : null;
    case "polyline":
      return o.points && o.points.length >= 2 ? { type: "engine.EdgeCollider2D", data: { points: pts(o.points), isTrigger: true } } : null;
    default:
      return null;
  }
}

/** A trigger collider for an object on an isometric map: its outline through the projection, relative to its origin. */
function isoCollider(o: ImportObject, origin: GridPoint, local: (px: number, py: number) => GridPoint): ComponentEntry | null {
  const rel = (px: number, py: number) => {
    const [x, y] = local(o.x + px, o.y + py);
    return [r(x - origin[0]), r(y - origin[1])];
  };
  switch (o.shape) {
    case "rect": {
      // Counter-clockwise once projected and flipped.
      const pts = [rel(0, 0), rel(0, o.height), rel(o.width, o.height), rel(o.width, 0)];
      return { type: "engine.PolygonCollider2D", data: { points: pts, isTrigger: true } };
    }
    case "ellipse":
      return { type: "engine.PolygonCollider2D", data: { points: ellipsePoints(o.width / 2, o.height / 2, o.width / 2, o.height / 2).map(([x, y]) => rel(x, y)), isTrigger: true } };
    case "polygon":
      return o.points && o.points.length >= 3 ? { type: "engine.PolygonCollider2D", data: { points: o.points.map(([x, y]) => rel(x, y)), isTrigger: true } } : null;
    case "polyline":
      return o.points && o.points.length >= 2 ? { type: "engine.EdgeCollider2D", data: { points: o.points.map(([x, y]) => rel(x, y)), isTrigger: true } } : null;
    default:
      return null;
  }
}

/** A Tiled image layer → a node with a SpriteRenderer of its image, centred where Tiled draws it. */
function tiledImageLayer(layer: ImportImageLayer, order: number, id: string, parent: string, ppu: number, space: TiledSpace): NodeEntry | null {
  if (!layer.image) return null;
  const { rgb, alpha } = splitColor(layer.tint);
  const a = layer.opacity * alpha;
  const data: Record<string, unknown> = { sprite: `asset:${layer.image.path}`, orderInLayer: order };
  let centre: GridPoint;
  if (layer.image.width && layer.image.height) {
    data.size = [r(layer.image.width / ppu), r(layer.image.height / ppu)];
    centre = space.screen(layer.offset[0] + layer.image.width / 2, layer.offset[1] + layer.image.height / 2);
  } else {
    data.pixelsPerUnit = ppu;
    centre = space.screen(layer.offset[0], layer.offset[1]);
  }
  if (rgb !== "#ffffff" || a < 1) data.color = formatHex(parseHex(rgb)!, a);
  const components: ComponentEntry[] = [transform([centre[0] / ppu, centre[1] / ppu]), { type: "engine.SpriteRenderer", data }];
  if (layer.class || Object.keys(layer.properties).length) components.push(mapObject(layer.class ?? "", jsonProps(layer.properties, { object: () => null, point: (x, y) => [x, y], tile: (_i, rr) => rr })));
  return { id, name: layer.name, parent, ...(layer.visible ? {} : { active: false }), components };
}

// ---------------------------------------------------------------------------------------------------------------
// Tiled tilesets

/** Write a standalone Tiled tileset (TSX or TSJ): the tileset and its sidecar slices. */
export function writeTiledTileset(file: ImportTiledTilesetFile, options: NativeImportOptions, existing: ExistingText, newUuid: () => string = randomUuid): NativeImportResult {
  const w = new Writer(options, existing, newUuid, file.warnings);
  const ts = file.tileset;
  const shape = ts.previewGrid === "isometric" ? "isometric" : "square";
  w.tileset(ts, w.tilesetPath(ts.path ? baseName(ts.path) : ts.name), [ts.tileWidth, ts.tileHeight], { shape }, ts.previewGrid);
  return w.result();
}

// ---------------------------------------------------------------------------------------------------------------
// LDtk projects

/** Every IntGrid layer of a project's levels with its values, by layer name (for the import dialog's collision choices). */
export function ldtkIntGridLayers(project: ImportLdtkProject): { layer: string; values: ImportIntGridLayer["values"] }[] {
  const out = new Map<string, ImportIntGridLayer["values"]>();
  for (const world of project.worlds) for (const level of world.levels) for (const l of level.layers) if (l.kind === "intGrid" && !out.has(l.name)) out.set(l.name, l.values);
  return [...out].map(([layer, values]) => ({ layer, values }));
}

/** The pixels per unit an import uses by default: the map's tile width, or the LDtk project's default grid size. */
export function defaultPixelsPerUnit(source: ImportTiledMap | ImportTiledTilesetFile | ImportLdtkProject): number {
  if (source.format === "tiled") return source.grid.tileWidth;
  if (source.format === "tiledTileset") return source.tileset.tileWidth;
  return source.worlds.flatMap((w) => w.levels)[0]?.grid.tileWidth ?? 16;
}

/** Write a parsed LDtk project: its tilesets, the IntGrid tileset, a prefab per level and per world. */
export function writeLdtkProject(project: ImportLdtkProject, options: NativeImportOptions, existing: ExistingText, newUuid: () => string = randomUuid): NativeImportResult {
  const w = new Writer(options, existing, newUuid, project.warnings);
  const ppu = options.pixelsPerUnit && options.pixelsPerUnit > 0 ? options.pixelsPerUnit : defaultPixelsPerUnit(project);
  const written = project.tilesets.map((ts) => (ts.tiles.length ? w.tileset(ts, w.tilesetPath(ts.name), [ts.tileWidth, ts.tileHeight], { shape: "square" }, "square") : null));
  const intGrid = ldtkIntGridTileset(project, w, ppu);
  const levelFolder = join(w.folder, fileSafe(project.name));
  const levelPath = (level: ImportLevel) => join(levelFolder, `${fileSafe(level.identifier)}.prefab.json`);

  for (const world of project.worlds) {
    for (const level of world.levels) w.add(levelPath(level), prefabText(ldtkLevel(level, ppu, w, written, intGrid, options, project)));
    // The world: an instance of each level at its world position (pixels y down → units y up, the level's bottom-left).
    const nodes: NodeEntry[] = [{ id: world.iid, name: world.identifier, components: [transform([0, 0])] }];
    let along = 0;
    for (const level of world.levels) {
      let x: number, yTop: number;
      if (world.layout === "LinearHorizontal") [x, yTop] = [along, 0];
      else if (world.layout === "LinearVertical") [x, yTop] = [0, along];
      else [x, yTop] = [level.worldX, level.worldY];
      along += world.layout === "LinearVertical" ? level.pxHeight : level.pxWidth;
      nodes.push({
        id: level.iid,
        name: level.identifier,
        parent: world.iid,
        prefab: levelPath(level),
        overrides: [{ component: "engine.Transform", field: "position", value: [r(x / ppu), r((-yTop - level.pxHeight) / ppu), 0] }],
      });
    }
    w.add(join(levelFolder, `${fileSafe(world.identifier)}.world.prefab.json`), prefabText(nodes));
  }
  return w.result();
}

/** The generated IntGrid tileset: one tile per (layer, value), no sprite, `data` naming the value. */
interface IntGridTileset {
  path: string;
  uuidOf: Map<string, string>;
  collides: Set<string>;
}

function ldtkIntGridTileset(project: ImportLdtkProject, w: Writer, ppu: number): IntGridTileset | null {
  const layers = ldtkIntGridLayers(project);
  if (!layers.length) return null;
  const path = join(w.folder, `${fileSafe(project.name)}.intgrid${TILESET_SUFFIX}`);
  // Re-import keeps each value's uuid and id (matched by layer and value).
  const prev = new Map<string, TileDef>();
  const text = w.existing(path);
  if (text !== null) {
    try {
      for (const t of parseTileset(JSON.parse(text), path).tileset.tiles) {
        const d = t.data;
        if (d && typeof d.intGrid === "number" && typeof d.layer === "string") prev.set(intGridKey(d.layer, d.intGrid), t);
      }
    } catch (err) {
      w.warn(`${path} couldn't be read (${(err as Error).message}); its tiles get new uuids.`);
    }
  }
  const uuidOf = new Map<string, string>();
  const collides = new Set<string>();
  const used = new Set([...prev.values()].map((t) => t.id));
  let next = 1;
  const tiles: TileDef[] = [];
  for (const { layer, values } of layers) {
    for (const v of values) {
      const key = intGridKey(layer, v.value);
      const old = prev.get(key);
      let id = old?.id;
      if (id === undefined) {
        while (used.has(next)) next++;
        id = next;
        used.add(id);
      }
      const uuid = old?.uuid ?? w.newUuid();
      uuidOf.set(key, uuid);
      const collision = w.options.intGridCollision?.[key] ?? "none";
      if (collision !== "none") collides.add(key);
      tiles.push({ id, uuid, ...(v.identifier ? { name: v.identifier } : {}), sprite: "", collision, data: { intGrid: v.value, name: v.identifier, layer } });
    }
  }
  tiles.sort((a, b) => a.id - b.id);
  const grid = project.worlds.flatMap((x) => x.levels)[0]?.grid.tileWidth ?? ppu;
  w.add(path, tilesetText({ format: TILESET_FORMAT, tileSize: [grid, grid], terrains: [], tiles, previewGrid: "square" }));
  return { path, uuidOf, collides };
}

/** An LDtk level → its prefab's nodes. */
function ldtkLevel(level: ImportLevel, ppu: number, w: Writer, written: (WrittenTileset | null)[], intGrid: IntGridTileset | null, options: NativeImportOptions, project: ImportLdtkProject): NodeEntry[] {
  const pxH = level.pxHeight;
  const rootId = level.iid;
  const nodes: NodeEntry[] = [];
  // Points of a layer (pixels from the level's top-left, y down) in the level's local units.
  const local = (layer: ImportLayer, px: number, py: number): GridPoint => [(px + layer.offset[0]) / ppu, (pxH - (py + layer.offset[1])) / ppu];
  const tileOf = (tilesetIndex: number, rect: ImportRect): unknown => {
    const ts = written[tilesetIndex];
    const tile = ts?.source.tiles.find((t) => t.rect.x === rect.x && t.rect.y === rect.y && t.rect.w === rect.w && t.rect.h === rect.h);
    const sprite = tile ? ts!.spriteOf.get(tile.index) : undefined;
    if (sprite) return sprite;
    const image = project.tilesets[tilesetIndex]?.image;
    return image ? { image: image.path, rect: [rect.x, rect.y, rect.w, rect.h] } : null;
  };
  const levelCtx: ValueContext = { object: () => null, point: (cx, cy) => [cx, cy], tile: tileOf };
  const rootComponents: ComponentEntry[] = [transform([0, 0])];
  if (Object.keys(level.fields).length) rootComponents.push(mapObject("", jsonProps(level.fields, levelCtx)));
  nodes.push({ id: rootId, name: level.identifier, components: rootComponents });

  // Tile layers grouped by tileset and cell size (a Tilemap has one of each); IntGrid layers on their own Tilemaps.
  const groups = new Map<string, { tileset: WrittenTileset; cw: number; ch: number; layers: TilemapLayerData[]; collides: boolean }>();
  level.layers.forEach((layer, order) => {
    if (layer.kind === "tiles") {
      const byTs = new Map<number, ImportCell[]>();
      for (const c of layer.cells) {
        let g = byTs.get(c.tilesetIndex);
        if (!g) byTs.set(c.tilesetIndex, (g = []));
        g.push(c);
      }
      for (const [ti, cells] of byTs) {
        const ts = written[ti];
        if (!ts) {
          w.warn(`Level "${level.identifier}", layer "${layer.name}": its tileset has no tiles; ${cells.length} cell(s) skipped.`);
          continue;
        }
        const key = `${ti}|${layer.cellWidth}x${layer.cellHeight}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { tileset: ts, cw: layer.cellWidth, ch: layer.cellHeight, layers: [], collides: false }));
        const myco = cells.flatMap((c) => {
          const uuid = ts.uuidOf.get(c.tileIndex);
          if (!uuid) return [];
          if (ts.collides.has(c.tileIndex)) g!.collides = true;
          return [{ x: c.x, y: layer.height - 1 - c.y, uuid, flags: flagsOfCell(c) }];
        });
        g.layers.push(encodeLayer(layer.name, { ...layer, offset: [layer.offset[0] / ppu, (-layer.offset[1] + pxH - layer.height * layer.cellHeight) / ppu] }, order, myco));
      }
    } else if (layer.kind === "intGrid" && intGrid) {
      const cells = layer.cells.flatMap((c) => {
        const uuid = intGrid.uuidOf.get(intGridKey(layer.name, c.value));
        return uuid ? [{ x: c.x, y: layer.height - 1 - c.y, uuid, flags: 0 }] : [];
      });
      const collides = layer.values.some((v) => intGrid.collides.has(intGridKey(layer.name, v.value)));
      const data = encodeLayer(layer.name, { ...layer, visible: false, offset: [layer.offset[0] / ppu, (-layer.offset[1] + pxH - layer.height * layer.cellHeight) / ppu] }, order, cells);
      const grid: GridParams = { shape: "square", cellSize: { x: layer.cellWidth / ppu, y: layer.cellHeight / ppu } };
      const components: ComponentEntry[] = [transform([0, 0]), tilemapComponent(intGrid.path, grid, [data])];
      if (collides) components.push(SHAPE_COLLIDER);
      nodes.push({ id: `${layer.id}-intgrid`, name: `${layer.name} (IntGrid)`, parent: rootId, components });
    } else if (layer.kind === "entities" && options.objectsAsNodes !== false) {
      nodes.push(...ldtkEntityLayer(layer, rootId, ppu, local, tileOf, options, w));
    }
  });
  const sizes = new Map<number, Set<string>>();
  for (const g of groups.values()) {
    const ti = written.indexOf(g.tileset);
    let s = sizes.get(ti);
    if (!s) sizes.set(ti, (s = new Set()));
    s.add(`${g.cw}x${g.ch}`);
  }
  for (const g of groups.values()) {
    const ti = written.indexOf(g.tileset);
    const several = (sizes.get(ti)?.size ?? 0) > 1;
    const grid: GridParams = { shape: "square", cellSize: { x: g.cw / ppu, y: g.ch / ppu } };
    const components: ComponentEntry[] = [transform([0, 0]), tilemapComponent(g.tileset.path, grid, g.layers)];
    if (g.collides) components.push(SHAPE_COLLIDER);
    const suffix = several ? ` ${g.cw}x${g.ch}` : "";
    nodes.push({ id: uniqueId(`${rootId}-ts-${idSafe(g.tileset.source.name)}${several ? `-${g.cw}x${g.ch}` : ""}`, nodes), name: `${g.tileset.source.name}${suffix}`, parent: rootId, components });
  }
  return nodes;
}

/** An LDtk Entities layer → a node, with a node per entity (its iid as its id, so references find it). */
function ldtkEntityLayer(
  layer: ImportEntityLayer,
  parent: string,
  ppu: number,
  local: (layer: ImportLayer, px: number, py: number) => GridPoint,
  tileOf: (tilesetIndex: number, rect: ImportRect) => unknown,
  options: NativeImportOptions,
  w: Writer,
): NodeEntry[] {
  const out: NodeEntry[] = [{ id: layer.id, name: layer.name, parent, ...(layer.visible ? {} : { active: false }), components: [transform([0, 0])] }];
  for (const e of layer.entities) {
    const ctx: ValueContext = {
      object: () => null,
      point: (cx, cy) => local(layer, (cx + 0.5) * layer.cellWidth, (cy + 0.5) * layer.cellHeight),
      tile: tileOf,
    };
    const position = local(layer, e.x, e.y);
    const components: ComponentEntry[] = [transform(position), mapObject(e.identifier, jsonProps(e.fields, ctx))];
    // The entity's box relative to its pivot, in units (y up).
    const centre: GridPoint = [((0.5 - e.pivot[0]) * e.width) / ppu, (-(0.5 - e.pivot[1]) * e.height) / ppu];
    if (options.shapesAsTriggers && e.width > 0 && e.height > 0) {
      components.push({ type: "engine.BoxCollider2D", data: { size: [r(e.width / ppu), r(e.height / ppu)], center: [r(centre[0]), r(centre[1])], isTrigger: true } });
    }
    out.push({ id: e.iid, name: e.identifier, parent: layer.id, components });
    if (e.tile) {
      const sprite = tileOf(e.tile.tilesetIndex, e.tile);
      if (typeof sprite === "string") {
        out.push({ id: `${e.iid}-sprite`, name: "Sprite", parent: e.iid, components: [transform(centre), { type: "engine.SpriteRenderer", data: { sprite, size: [r(e.width / ppu), r(e.height / ppu)] } }] });
      } else w.warn(`Entity "${e.identifier}" (${e.iid}): its tile isn't in a written tileset; it has no sprite.`);
    }
  }
  return out;
}

// Re-exported for the import job: which writer reads which parse.
export type ImportSource = ImportTiledMap | ImportTiledTilesetFile | ImportLdtkProject;

/** Write any parsed source. */
export function writeNative(source: ImportSource, options: NativeImportOptions, existing: ExistingText, newUuid: () => string = randomUuid): NativeImportResult {
  if (source.format === "tiled") return writeTiledMap(source, options, existing, newUuid);
  if (source.format === "tiledTileset") return writeTiledTileset(source, options, existing, newUuid);
  return writeLdtkProject(source, options, existing, newUuid);
}
