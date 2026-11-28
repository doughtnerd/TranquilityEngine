/**
 * The neutral model the Tiled and LDtk parsers produce (ADR 0438), read by the native writer that turns it into Myco
 * tilesets, sidecar slices and prefabs. It is shaped like Myco's own data where the two agree (grid fields of ADR 0437,
 * collision polygons of ADR 0439, animations of ADR 0437, terrains and patterns of ADR 0103, layer offset, parallax
 * and lock of ADR 0441), and keeps the source's own spaces where they differ:
 *
 * - **Cell coordinates** are the source's: column `x` to the right, row `y` *down*, as Tiled and LDtk store them (on
 *   isometric, staggered and hexagonal maps, Tiled's own cell addressing). The writer converts them to Myco's y-up
 *   cells through `runtime/grids.ts`.
 * - **Pixel positions and sizes** (layer offsets, object and entity positions, image rectangles) are source pixels,
 *   y down, as stored.
 * - **Collision polygons** are already in Myco's tile box units: `[0, 0]` the bottom-left and `[1, 1]` the top-right
 *   of the box the tile's image is drawn in, counter-clockwise.
 * - **Paths** (tileset files, images, templates, `.ldtkl` levels, file properties) are resolved against the file that
 *   names them, so they are in the same space as the path given to the parser (normally project-relative, `/`
 *   separated).
 *
 * Every parse returns `warnings`: one line per thing it couldn't carry over, for the import dialog to list.
 */

import type { TileGridShape } from "../../runtime/Tilemap";
import type { TilePolygon } from "../../runtime/tileset";

// ---------------------------------------------------------------------------------------------------------------
// Values

/** A Tiled object reference property (`type="object"`): the referenced object's id, as a string. */
export interface ImportObjectRef {
  kind: "object";
  id: string;
}

/** A Tiled `file` property or LDtk `FilePath` field: the path resolved against the file that names it. */
export interface ImportFileRef {
  kind: "file";
  path: string;
}

/** A Tiled custom class property: its class name and members (members the map leaves at their defaults are absent). */
export interface ImportClassValue {
  kind: "class";
  type: string;
  fields: Record<string, ImportValue>;
}

/** An LDtk `Point` field: a cell of the level's layer grid, column `cx` right and row `cy` down (LDtk's own). */
export interface ImportPointValue {
  kind: "point";
  cx: number;
  cy: number;
}

/** An LDtk `EntityRef` field: the target entity's iid and where it lives. */
export interface ImportEntityRef {
  kind: "entity";
  entityIid: string;
  layerIid: string;
  levelIid: string;
  worldIid: string;
}

/** An LDtk `Tile` field (or an entity's tile): a rectangle of a tileset's image, in image pixels (y down). */
export interface ImportTileRect {
  kind: "tile";
  /** Index into the project's `tilesets`; -1 when the tileset isn't in the project. */
  tilesetIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A typed property or field value. Plain values are JSON (`bool` → boolean, `int`/`float` → number, `string` and
 * enums → string, colours → `"#rrggbb"`, or `"#rrggbbaa"` when not opaque); arrays are LDtk `Array<…>` fields; the
 * tagged objects are the references and compound values that need converting when written.
 */
export type ImportValue =
  | null
  | boolean
  | number
  | string
  | ImportValue[]
  | ImportObjectRef
  | ImportFileRef
  | ImportClassValue
  | ImportPointValue
  | ImportEntityRef
  | ImportTileRect;

/** Named, typed properties (Tiled custom properties, LDtk field instances), in source order. */
export type ImportProperties = Record<string, ImportValue>;

// ---------------------------------------------------------------------------------------------------------------
// Grid

/** A map's (or LDtk level's) cell layout, in ADR 0437's terms. */
export interface ImportGrid {
  /** Tiled `orthogonal` → `"square"`; `isometric`, `staggered` and `hexagonal` as named. LDtk is always `"square"`. */
  shape: TileGridShape;
  /** Staggered and hexagonal: which rows (`"y"`) or columns (`"x"`) shift by half a cell (Tiled `staggeraxis`). */
  staggerAxis: "x" | "y";
  /** Staggered and hexagonal: whether the odd or even rows (columns) shift (Tiled `staggerindex`). */
  staggerIndex: "odd" | "even";
  /**
   * Hexagonal: the flat sides' length along the stagger axis as a fraction of the tile size on that axis (Tiled's
   * `hexsidelength` ÷ `tileheight` for stagger axis y, ÷ `tilewidth` for x). 0.5 (the Myco default) on other shapes.
   */
  hexSide: number;
  /** One cell's bounding box in pixels: Tiled `tilewidth`/`tileheight`, LDtk `defaultGridSize`. */
  tileWidth: number;
  tileHeight: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Tilesets

/** An image file, with its pixel size when the source states it (Tiled `<image width height>`, LDtk `pxWid`/`pxHei`). */
export interface ImportImage {
  path: string;
  width: number;
  height: number;
}

/** A rectangle of an image in pixels, from its top-left, y down. */
export interface ImportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One frame of a tile animation (ADR 0437). */
export interface ImportAnimationFrame {
  /** The frame's tile, an index into the same tileset's tiles (`ImportTile.index`). */
  tileIndex: number;
  durationSeconds: number;
}

/** One tile of a tileset. */
export interface ImportTile {
  /**
   * The source's tile index: Tiled's local tile id, LDtk's tile id. A grid-image tile's index is its position in the
   * image, row by row from the top-left. Myco's tile id is this + 1 (ADR 0438).
   */
  index: number;
  /** A collection-of-images tile's own image; absent for grid-image tiles (they use the tileset's `image`). */
  image?: ImportImage;
  /** The tile's rectangle of its image (the tileset's, or its own): the slice the writer makes. */
  rect: ImportRect;
  /**
   * The tile's custom data, already Myco-shaped JSON for `TileDef.data`: Tiled properties by name (object references
   * as their id number, files as their path, classes as nested objects) and the class as `class`; LDtk custom data as
   * `customData` (parsed when it is JSON) and enum tags as `tags`. Absent when there is none.
   */
  data?: Record<string, unknown>;
  /**
   * Collision polygons (ADR 0439), counter-clockwise, in box units where the box is the tile's `rect`: `[0, 0]` its
   * bottom-left, `[1, 1]` its top-right. Rectangles have four points, ellipses sixteen, rotations are applied, and a
   * shape whose object had the boolean property `oneWay` set is one-way. Empty when the tile doesn't collide.
   */
  shapes: TilePolygon[];
  /** Frame animation (Tiled `<animation>`), absent when the tile isn't animated. */
  animation?: ImportAnimationFrame[];
  /** The Myco terrain the tile belongs to, from a Wang set (ADR 0438's rules). */
  terrain?: string;
  /** The tile's 8-character neighbour pattern (N NE E SE S SW W NW; `1`, `0` or `*`) in `terrain`. */
  pattern?: string;
  /** Relative chance for random brushes (Tiled `probability`), when not 1. */
  weight?: number;
}

/** A Myco terrain made from a Wang colour. */
export interface ImportTerrain {
  name: string;
  /** `"#rrggbb"`. */
  color?: string;
}

/** A tileset: a Tiled tileset (embedded, TSX or TSJ) or an LDtk tileset definition. */
export interface ImportTileset {
  name: string;
  /** The tileset's own file (external TSX/TSJ), or null when it is embedded in a map or LDtk project. */
  path: string | null;
  /** One tile's size in pixels (Tiled `tilewidth`/`tileheight`, LDtk `tileGridSize`). */
  tileWidth: number;
  tileHeight: number;
  /** The grid image tiles are cut from, or null for a collection of images (each tile names its own). */
  image: ImportImage | null;
  /** Pixels around the grid image's tiles (Tiled `margin`, LDtk `padding`). */
  margin: number;
  /** Pixels between the grid image's tiles. */
  spacing: number;
  /** Tiles per row of the grid image; 0 for a collection. */
  columns: number;
  /** Tiles in the tileset (for a collection, the number of tiles listed). */
  tileCount: number;
  /** Tiled `tileoffset` in pixels (x right, y down); `[0, 0]` when absent. */
  offset: [number, number];
  /** Tiled `<grid orientation>`: which cell outline the tileset editor should draw (ADR 0439 `previewGrid`). */
  previewGrid?: "square" | "isometric";
  /**
   * Every tile: for a grid image all `tileCount` of them in index order, each with its rectangle; for a collection
   * the tiles listed, in source order.
   */
  tiles: ImportTile[];
  /** Terrains made from Wang colours, in the order first used. */
  terrains: ImportTerrain[];
  /** Tiled tileset custom properties. */
  properties: ImportProperties;
}

// ---------------------------------------------------------------------------------------------------------------
// Layers

/**
 * What every layer has. Tiled group layers are flattened (ADR 0438): names joined with `/`, opacity and visibility
 * multiplied, offsets added, parallax multiplied, `locked` if any group is, tints multiplied.
 */
export interface ImportLayerBase {
  /** The source's layer id as a string (Tiled layer `id`, LDtk layer instance `iid`), for stable node ids. */
  id: string;
  name: string;
  visible: boolean;
  /** 0..1. */
  opacity: number;
  /** Tiled `tintcolor` as `"#rrggbb"` (or `"#rrggbbaa"`), absent when untinted. */
  tint?: string;
  /** Pixels, x right and y down (Tiled `offsetx`/`offsety`, LDtk `__pxTotalOffsetX/Y`). */
  offset: [number, number];
  /** Tiled parallax factor (ADR 0441); `[1, 1]` when absent. */
  parallax: [number, number];
  locked: boolean;
  /** Tiled layer `class`. */
  class?: string;
  properties: ImportProperties;
}

/** One painted cell. */
export interface ImportCell {
  /** Column, right. */
  x: number;
  /** Row, *down* (as Tiled and LDtk store it). */
  y: number;
  /** Index into the map's (project's) `tilesets`. */
  tilesetIndex: number;
  /** The tile's `ImportTile.index` in that tileset. */
  tileIndex: number;
  /** Tiled gid bit 31, LDtk `f & 1`. */
  flipX: boolean;
  /** Tiled gid bit 30, LDtk `f & 2`. */
  flipY: boolean;
  /** Tiled gid bit 29 (anti-diagonal flip, applied first); always false from LDtk. */
  flipDiagonal: boolean;
}

/** A tile layer (Tiled tile layer; LDtk Tiles layer, auto-layer, or the auto tiles of an IntGrid layer). */
export interface ImportTileLayer extends ImportLayerBase {
  kind: "tiles";
  /** The layer's cell size in pixels (Tiled: the map's tile size; LDtk: the layer's `gridSize`). */
  cellWidth: number;
  cellHeight: number;
  /** The layer's size in cells (for infinite Tiled maps, the bounds of its chunks). */
  width: number;
  height: number;
  /** Painted cells only, at most one per (x, y), in row order. Tiles may come from several tilesets. */
  cells: ImportCell[];
}

/** A Tiled object's tile (tile objects), resolved like a cell's gid. */
export interface ImportObjectTile {
  tilesetIndex: number;
  tileIndex: number;
  flipX: boolean;
  flipY: boolean;
  flipDiagonal: boolean;
}

/** A Tiled object (templates already applied; text objects are skipped with a warning). */
export interface ImportObject {
  /** Tiled object id as a string. */
  id: string;
  name: string;
  /** Tiled `class` (or `type` before Tiled 1.9). */
  class: string;
  shape: "point" | "rect" | "ellipse" | "polygon" | "polyline" | "tile";
  /**
   * Position in map pixels, y down, as Tiled stores it: the top-left of a rectangle or ellipse, the origin of a
   * polygon's points, the bottom-left of a tile object (orthogonal maps; bottom-centre on isometric ones). On
   * isometric maps Tiled's object pixels are its projected space (both axes in tile-height units).
   */
  x: number;
  y: number;
  /** Pixels; 0 for points, polygons and polylines. */
  width: number;
  height: number;
  /** Degrees clockwise about (x, y). */
  rotation: number;
  visible: boolean;
  /** Polygon and polyline points in pixels relative to (x, y), y down. */
  points?: [number, number][];
  /** A tile object's tile. */
  tile?: ImportObjectTile;
  /** The template the object came from, resolved, when it used one. */
  template?: string;
  properties: ImportProperties;
}

/** A Tiled object layer. */
export interface ImportObjectLayer extends ImportLayerBase {
  kind: "objects";
  objects: ImportObject[];
}

/** A Tiled image layer. */
export interface ImportImageLayer extends ImportLayerBase {
  kind: "image";
  /** The image, or null when the layer has none. Width and height are 0 when Tiled didn't record them. */
  image: ImportImage | null;
  repeatX: boolean;
  repeatY: boolean;
}

/** One value an IntGrid layer can hold. */
export interface ImportIntGridValue {
  value: number;
  /** LDtk's identifier for the value, or null when it has none. */
  identifier: string | null;
  /** `"#rrggbb"`. */
  color: string;
}

/** An LDtk IntGrid layer's integers (its auto tiles, if any, follow it as an `ImportTileLayer` of the same name). */
export interface ImportIntGridLayer extends ImportLayerBase {
  kind: "intGrid";
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
  /** The values the layer definition declares. */
  values: ImportIntGridValue[];
  /** Non-zero cells, in row order. */
  cells: { x: number; y: number; value: number }[];
}

/** An LDtk entity instance. */
export interface ImportEntity {
  identifier: string;
  iid: string;
  /** The entity's pivot point in layer pixels, y down (LDtk `px`). */
  x: number;
  y: number;
  /** Pixels. */
  width: number;
  height: number;
  /** LDtk `__pivot`: where (x, y) sits in the entity's box, 0..1 from its top-left. */
  pivot: [number, number];
  /** LDtk `__worldX`/`__worldY` (pixels, y down) when the project records them. */
  worldX?: number;
  worldY?: number;
  tags: string[];
  /** Field instances by identifier: points in grid cells, colours `"#rrggbb"`, entity refs tagged. */
  fields: ImportProperties;
  /** Every entity reference among the fields (arrays included), for the writer to resolve to node ids. */
  refs: { field: string; ref: ImportEntityRef }[];
  /** The entity's tile (LDtk `__tile`), if any. */
  tile?: ImportTileRect;
}

/** An LDtk Entities layer. */
export interface ImportEntityLayer extends ImportLayerBase {
  kind: "entities";
  /** The layer's grid size in pixels (what `ImportPointValue` cells are in). */
  cellWidth: number;
  cellHeight: number;
  entities: ImportEntity[];
}

export type ImportLayer = ImportTileLayer | ImportObjectLayer | ImportImageLayer | ImportIntGridLayer | ImportEntityLayer;

// ---------------------------------------------------------------------------------------------------------------
// Files

/** A parsed Tiled map (TMX or TMJ). */
export interface ImportTiledMap {
  format: "tiled";
  /** The map file. */
  path: string;
  /** The map's base name without extension (the root node's name). */
  name: string;
  grid: ImportGrid;
  /** Size in cells (0 × 0 when infinite and empty; infinite maps' bounds otherwise). */
  width: number;
  height: number;
  infinite: boolean;
  /** Tiled `parallaxoriginx`/`parallaxoriginy` in pixels. */
  parallaxOrigin: [number, number];
  /** `"#rrggbb"` or `"#rrggbbaa"`, absent when unset. */
  backgroundColor?: string;
  class?: string;
  properties: ImportProperties;
  /** Every tileset the map uses (cells and tile objects refer to them by index), external ones loaded. */
  tilesets: ImportTileset[];
  /** Layers in stack order, bottom first. */
  layers: ImportLayer[];
  warnings: string[];
}

/** A parsed standalone Tiled tileset (TSX or TSJ). */
export interface ImportTiledTilesetFile {
  format: "tiledTileset";
  tileset: ImportTileset;
  warnings: string[];
}

/** An LDtk level. */
export interface ImportLevel {
  identifier: string;
  iid: string;
  uid: number;
  /** Position in the world, pixels, y down (meaningless, often -1, in linear layouts). */
  worldX: number;
  worldY: number;
  worldDepth: number;
  /** Size in pixels. */
  pxWidth: number;
  pxHeight: number;
  /** The project's default grid (square, `defaultGridSize`); each layer states its own cell size. */
  grid: ImportGrid;
  /** `"#rrggbb"`. */
  backgroundColor?: string;
  /** Level field instances. */
  fields: ImportProperties;
  /** Layers in stack order, bottom first (LDtk lists them top first). */
  layers: ImportLayer[];
}

/** An LDtk world (the project's single world when it doesn't use multi-worlds). */
export interface ImportWorld {
  identifier: string;
  iid: string;
  layout: "Free" | "GridVania" | "LinearHorizontal" | "LinearVertical";
  /** GridVania cell size in pixels. */
  gridWidth: number;
  gridHeight: number;
  levels: ImportLevel[];
}

/** A parsed LDtk project. */
export interface ImportLdtkProject {
  format: "ldtk";
  path: string;
  /** The project file's base name without extension. */
  name: string;
  jsonVersion: string;
  /** Every tileset definition (cells, entity tiles and tile fields refer to them by index). */
  tilesets: ImportTileset[];
  worlds: ImportWorld[];
  warnings: string[];
}

/** Loads a file a parsed file refers to (by its resolved path); null when it can't be read. */
export type ImportReader = (path: string) => Promise<string | null>;
