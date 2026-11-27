/**
 * LDtk importer, parsing half (ADR 0438): an `.ldtk` project (with its `.ldtkl` external levels) into the neutral model
 * of `model.ts`. Pure over text: external level files come through `read`.
 */

import type {
  ImportCell,
  ImportEntity,
  ImportEntityRef,
  ImportGrid,
  ImportIntGridValue,
  ImportLayer,
  ImportLayerBase,
  ImportLdtkProject,
  ImportLevel,
  ImportProperties,
  ImportReader,
  ImportTileRect,
  ImportTileset,
  ImportValue,
  ImportWorld,
} from "./model";
import { baseName, cssColor, gridTileRect, resolvePath } from "./shared";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);

interface Ctx {
  path: string;
  file: string;
  warnings: string[];
  /** Tileset uid → index in `tilesets`. */
  tilesetIndex: Map<number, number>;
  /** Layer definition uid → definition. */
  layerDefs: Map<number, Json>;
}

function warn(ctx: Ctx, msg: string): void {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}

/** `"1.5.3"` → [1, 5, 3]. */
const versionParts = (v: string): number[] => v.split(/[.-]/).map((p) => parseInt(p, 10) || 0);

function tileRect(raw: unknown, ctx: Ctx): ImportTileRect | null {
  if (!isObj(raw)) return null;
  return { kind: "tile", tilesetIndex: ctx.tilesetIndex.get(num(raw.tilesetUid)) ?? -1, x: num(raw.x), y: num(raw.y), w: num(raw.w), h: num(raw.h) };
}

/** One field value by its LDtk type (`Int`, `Color`, `Point`, `EntityRef`, `Enum(X)`, `Array<…>`, …). */
function fieldValue(type: string, v: unknown, ctx: Ctx): ImportValue {
  const inner = /^Array<(.*)>$/.exec(type);
  if (inner) return Array.isArray(v) ? v.map((x) => fieldValue(inner[1]!, x, ctx)) : [];
  if (v === null || v === undefined) return null;
  switch (type) {
    case "Int":
    case "Float":
      return num(v);
    case "Bool":
      return v === true;
    case "Color":
      return cssColor(v);
    case "Point":
      return isObj(v) ? { kind: "point", cx: num(v.cx), cy: num(v.cy) } : null;
    case "EntityRef":
      return isObj(v) ? { kind: "entity", entityIid: str(v.entityIid), layerIid: str(v.layerIid), levelIid: str(v.levelIid), worldIid: str(v.worldIid) } : null;
    case "FilePath":
      return typeof v === "string" && v ? { kind: "file", path: resolvePath(ctx.path, v) } : null;
    case "Tile":
      return tileRect(v, ctx);
    default:
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
  }
}

function fields(raw: unknown, ctx: Ctx): ImportProperties {
  const out: ImportProperties = {};
  for (const f of arr(raw)) out[str(f.__identifier)] = fieldValue(str(f.__type), f.__value, ctx);
  return out;
}

function collectRefs(field: string, v: ImportValue, out: { field: string; ref: ImportEntityRef }[]): void {
  if (Array.isArray(v)) for (const x of v) collectRefs(field, x, out);
  else if (v && typeof v === "object" && v.kind === "entity") out.push({ field, ref: v });
}

function buildTileset(t: Json, ctx: Ctx): ImportTileset {
  const name = str(t.identifier);
  const gs = num(t.tileGridSize);
  const rel = str(t.relPath);
  const columns = num(t.__cWid);
  const rows = num(t.__cHei);
  const margin = num(t.padding), spacing = num(t.spacing);
  if (!rel) warn(ctx, `${ctx.file}: tileset "${name}" has no image (LDtk's embedded atlas isn't imported).`);
  const ts: ImportTileset = {
    name,
    path: null,
    tileWidth: gs,
    tileHeight: gs,
    image: rel ? { path: resolvePath(ctx.path, rel), width: num(t.pxWid), height: num(t.pxHei) } : null,
    margin,
    spacing,
    columns: rel ? columns : 0,
    tileCount: 0,
    offset: [0, 0],
    tiles: [],
    terrains: [],
    properties: {},
  };
  if (rel) for (let i = 0; i < columns * rows; i++) ts.tiles.push({ index: i, rect: gridTileRect(i, columns, gs, gs, margin, spacing), shapes: [] });
  ts.tileCount = ts.tiles.length;
  const data = (id: number): Record<string, unknown> | null => {
    const tile = ts.tiles[id];
    if (!tile) return null;
    return (tile.data ??= {});
  };
  for (const cd of arr(t.customData)) {
    const d = data(num(cd.tileId));
    if (!d) continue;
    const s = str(cd.data);
    let v: unknown = s;
    try {
      v = JSON.parse(s);
    } catch {
      /* not JSON: kept as the string */
    }
    d.customData = v;
  }
  for (const et of arr(t.enumTags)) {
    for (const id of Array.isArray(et.tileIds) ? et.tileIds : []) {
      const d = data(num(id));
      if (!d) continue;
      ((d.tags ??= []) as string[]).push(str(et.enumValueId));
    }
  }
  return ts;
}

function layerBase(li: Json, name: string): ImportLayerBase {
  return {
    id: str(li.iid),
    name,
    visible: li.visible !== false,
    opacity: num(li.__opacity, 1),
    offset: [num(li.__pxTotalOffsetX), num(li.__pxTotalOffsetY)],
    parallax: [1, 1],
    locked: false,
    properties: {},
  };
}

/** A layer instance's tiles, split so each cell holds one tile: stacked tiles go to `Name#2`, `Name#3`, … */
function tileLayers(li: Json, tiles: Json[], name: string, ctx: Ctx): ImportLayer[] {
  const gs = num(li.__gridSize, 1);
  const tsIndex = ctx.tilesetIndex.get(num(li.__tilesetDefUid));
  if (tiles.length && tsIndex === undefined) {
    warn(ctx, `${ctx.file}: layer "${name}" has tiles but no tileset; skipped.`);
    return [];
  }
  const stacks: ImportCell[][] = [];
  const seen = new Map<string, number>();
  let offGrid = 0;
  for (const t of tiles) {
    const px = Array.isArray(t.px) ? t.px : [0, 0];
    const fx = num(px[0]) / gs, fy = num(px[1]) / gs;
    const x = Math.round(fx), y = Math.round(fy);
    if (x !== fx || y !== fy) offGrid++;
    const key = `${x},${y}`;
    const depth = seen.get(key) ?? 0;
    seen.set(key, depth + 1);
    const f = num(t.f);
    (stacks[depth] ??= []).push({ x, y, tilesetIndex: tsIndex!, tileIndex: num(t.t), flipX: (f & 1) !== 0, flipY: (f & 2) !== 0, flipDiagonal: false });
  }
  if (offGrid) warn(ctx, `${ctx.file}: layer "${name}": ${offGrid} tile(s) off the layer's grid were snapped to it.`);
  if (!stacks.length) stacks.push([]);
  return stacks.map((cells, i) => {
    cells.sort((p, q) => p.y - q.y || p.x - q.x);
    const base = layerBase(li, i ? `${name}#${i + 1}` : name);
    if (i) base.id = `${base.id}#${i + 1}`;
    return { ...base, kind: "tiles" as const, cellWidth: gs, cellHeight: gs, width: num(li.__cWid), height: num(li.__cHei), cells };
  });
}

function buildEntity(e: Json, ctx: Ctx): ImportEntity {
  const px = Array.isArray(e.px) ? e.px : [0, 0];
  const pivot = Array.isArray(e.__pivot) ? e.__pivot : [0, 0];
  const f = fields(e.fieldInstances, ctx);
  const refs: ImportEntity["refs"] = [];
  for (const [k, v] of Object.entries(f)) collectRefs(k, v, refs);
  const ent: ImportEntity = {
    identifier: str(e.__identifier),
    iid: str(e.iid),
    x: num(px[0]),
    y: num(px[1]),
    width: num(e.width),
    height: num(e.height),
    pivot: [num(pivot[0]), num(pivot[1])],
    tags: Array.isArray(e.__tags) ? e.__tags.map((t) => String(t)) : [],
    fields: f,
    refs,
  };
  if (typeof e.__worldX === "number") ent.worldX = e.__worldX;
  if (typeof e.__worldY === "number") ent.worldY = e.__worldY;
  const tile = tileRect(e.__tile, ctx);
  if (tile) ent.tile = tile;
  return ent;
}

function buildLayer(li: Json, ctx: Ctx): ImportLayer[] {
  const name = str(li.__identifier);
  const type = str(li.__type);
  const gs = num(li.__gridSize, 1);
  const w = num(li.__cWid), h = num(li.__cHei);
  switch (type) {
    case "Tiles":
      return tileLayers(li, arr(li.gridTiles), name, ctx);
    case "AutoLayer":
      return tileLayers(li, arr(li.autoLayerTiles), name, ctx);
    case "IntGrid": {
      const def = ctx.layerDefs.get(num(li.layerDefUid));
      const values: ImportIntGridValue[] = arr(def?.intGridValues).map((v) => ({
        value: num(v.value),
        identifier: typeof v.identifier === "string" && v.identifier ? v.identifier : null,
        color: cssColor(v.color) ?? "#000000",
      }));
      const csv = Array.isArray(li.intGridCsv) ? li.intGridCsv : [];
      const cells: { x: number; y: number; value: number }[] = [];
      csv.forEach((v, i) => {
        if (num(v)) cells.push({ x: i % (w || 1), y: Math.floor(i / (w || 1)), value: num(v) });
      });
      const out: ImportLayer[] = [{ ...layerBase(li, name), kind: "intGrid", cellWidth: gs, cellHeight: gs, width: w, height: h, values, cells }];
      const auto = arr(li.autoLayerTiles);
      if (auto.length) out.push(...tileLayers(li, auto, name, ctx));
      return out;
    }
    case "Entities":
      return [{ ...layerBase(li, name), kind: "entities", cellWidth: gs, cellHeight: gs, entities: arr(li.entityInstances).map((e) => buildEntity(e, ctx)) }];
    default:
      warn(ctx, `${ctx.file}: layer "${name}" has an unknown type "${type}"; skipped.`);
      return [];
  }
}

async function buildLevel(raw: Json, grid: ImportGrid, read: ImportReader, ctx: Ctx): Promise<ImportLevel> {
  let lv = raw;
  const ident = str(raw.identifier);
  if (!Array.isArray(raw.layerInstances) && typeof raw.externalRelPath === "string" && raw.externalRelPath) {
    const p = resolvePath(ctx.path, raw.externalRelPath);
    const text = await read(p);
    if (text === null) throw new Error(`${ctx.path}: couldn't read level "${ident}" from ${p}.`);
    try {
      const j: unknown = JSON.parse(text);
      if (!isObj(j)) throw new Error("not an object");
      lv = j;
    } catch (err) {
      throw new Error(`${p}: not a valid LDtk level (${(err as Error).message}).`);
    }
  }
  if (str(lv.bgRelPath)) warn(ctx, `${ctx.file}: level "${ident}" has a background image; level backgrounds aren't imported.`);
  const layers: ImportLayer[] = [];
  // LDtk lists layers top first; the model's stack is bottom first.
  for (const li of arr(lv.layerInstances).reverse()) layers.push(...buildLayer(li, ctx));
  const level: ImportLevel = {
    identifier: ident,
    iid: str(raw.iid),
    uid: num(raw.uid),
    worldX: num(raw.worldX),
    worldY: num(raw.worldY),
    worldDepth: num(raw.worldDepth),
    pxWidth: num(raw.pxWid),
    pxHeight: num(raw.pxHei),
    grid,
    fields: fields(lv.fieldInstances ?? raw.fieldInstances, ctx),
    layers,
  };
  const bg = cssColor(lv.__bgColor ?? raw.__bgColor);
  if (bg) level.backgroundColor = bg;
  return level;
}

const LAYOUTS = ["Free", "GridVania", "LinearHorizontal", "LinearVertical"] as const;

/**
 * Parses an LDtk project (`.ldtk`, JSON) into the neutral model. `path` is the project's own path (what tilesets'
 * images and external levels resolve against); `read` loads `.ldtkl` level files. Throws with a message for the user
 * when the project can't be imported (not LDtk, older than 1.0, a level file missing).
 */
export async function parseLdtkProject(text: string, path: string, read: ImportReader): Promise<ImportLdtkProject> {
  let p: unknown;
  try {
    p = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${(err as Error).message}).`);
  }
  if (!isObj(p) || typeof p.jsonVersion !== "string" || !isObj(p.defs)) throw new Error(`${path}: not an LDtk project.`);
  if ((versionParts(p.jsonVersion)[0] ?? 0) < 1) throw new Error(`${path}: made with LDtk ${p.jsonVersion}; only projects saved by LDtk 1.0 or later can be imported. Open and save it in a current LDtk first.`);
  const defs = p.defs;
  const ctx: Ctx = { path, file: path.split("/").pop() ?? path, warnings: [], tilesetIndex: new Map(), layerDefs: new Map() };
  const tilesets: ImportTileset[] = [];
  for (const t of arr(defs.tilesets)) {
    ctx.tilesetIndex.set(num(t.uid), tilesets.length);
    tilesets.push(buildTileset(t, ctx));
  }
  for (const l of arr(defs.layers)) ctx.layerDefs.set(num(l.uid), l);
  const gs = num(p.defaultGridSize, 16);
  const grid: ImportGrid = { shape: "square", staggerAxis: "y", staggerIndex: "odd", hexSide: 0.5, tileWidth: gs, tileHeight: gs };
  const rawWorlds = arr(p.worlds).length ? arr(p.worlds) : [{ identifier: "World", iid: str(p.iid), worldLayout: p.worldLayout, worldGridWidth: p.worldGridWidth, worldGridHeight: p.worldGridHeight, levels: p.levels }];
  const worlds: ImportWorld[] = [];
  for (const w of rawWorlds) {
    const layout = LAYOUTS.find((l) => l === w.worldLayout) ?? "Free";
    const levels: ImportLevel[] = [];
    for (const lv of arr(w.levels)) levels.push(await buildLevel(lv, grid, read, ctx));
    worlds.push({ identifier: str(w.identifier), iid: str(w.iid), layout, gridWidth: num(w.worldGridWidth), gridHeight: num(w.worldGridHeight), levels });
  }
  return { format: "ldtk", path, name: baseName(path), jsonVersion: p.jsonVersion, tilesets, worlds, warnings: ctx.warnings };
}
