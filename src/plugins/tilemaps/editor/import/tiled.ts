/**
 * Tiled importer, parsing half (ADR 0436): TMX/TMJ maps and TSX/TSJ tilesets into the neutral model of `model.ts`.
 *
 * Both encodings go through one path: TMX (XML, read with `fast-xml-parser`, the only importer of it) is first turned
 * into the shapes TMJ uses, then a single converter builds the model. Pure over text: files the map names (external
 * tilesets, object templates) come through `read`.
 */

import { XMLParser } from "fast-xml-parser";
import type {
  ImportAnimationFrame,
  ImportCell,
  ImportGrid,
  ImportImage,
  ImportLayer,
  ImportObject,
  ImportObjectTile,
  ImportProperties,
  ImportReader,
  ImportTerrain,
  ImportTiledMap,
  ImportTiledTilesetFile,
  ImportTileset,
  ImportValue,
} from "./model";
import type { TilePolygon } from "../../runtime/tileset";
import { baseName, cssColor, gridTileRect, resolvePath } from "./shared";

// ---------------------------------------------------------------------------------------------------------------
// Raw shapes (TMJ's, which TMX is converted into)

type Json = Record<string, unknown>;

interface RawProp {
  name: string;
  type: string;
  propertytype?: string;
  /** For `class`, the members as RawProps. */
  value: unknown;
}

const FLIP_X = 0x80000000;
const FLIP_Y = 0x40000000;
const FLIP_D = 0x20000000;
const HEX_ROT = 0x10000000;
const GID_MASK = 0x0fffffff;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const bool = (v: unknown, d: boolean): boolean => (v === undefined || v === null || v === "" ? d : v === true || v === 1 || v === "1" || v === "true");
const isXml = (text: string): boolean => /^\s*(<\?xml|<)/.test(text.replace(/^﻿/, ""));

// ---------------------------------------------------------------------------------------------------------------
// XML → TMJ shapes

interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

function parseXml(text: string, path: string): XNode {
  let raw: unknown;
  try {
    raw = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, parseTagValue: false, trimValues: false }).parse(text);
  } catch (err) {
    throw new Error(`${path}: not valid XML (${(err as Error).message}).`);
  }
  const convert = (entry: Json): XNode | null => {
    const tag = Object.keys(entry).find((k) => k !== ":@");
    if (!tag || tag === "#text" || tag.startsWith("?")) return null;
    const kids = Array.isArray(entry[tag]) ? (entry[tag] as Json[]) : [];
    const attrs: Record<string, string> = {};
    const a = entry[":@"];
    if (isObj(a)) for (const [k, v] of Object.entries(a)) attrs[k] = String(v);
    const children: XNode[] = [];
    let txt = "";
    for (const k of kids) {
      if ("#text" in k) txt += String(k["#text"]);
      else {
        const c = convert(k);
        if (c) children.push(c);
      }
    }
    return { tag, attrs, children, text: txt };
  };
  const roots = Array.isArray(raw) ? (raw as Json[]).map(convert).filter((n): n is XNode => !!n) : [];
  if (!roots.length) throw new Error(`${path}: no XML root element.`);
  return roots[0]!;
}

const child = (n: XNode, tag: string): XNode | undefined => n.children.find((c) => c.tag === tag);
const kids = (n: XNode, tag: string): XNode[] => n.children.filter((c) => c.tag === tag);

/** Copies the attributes present, numeric ones as numbers. */
function attrsOf(n: XNode, numeric: string[]): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(n.attrs)) out[k] = numeric.includes(k) ? num(v) : v;
  return out;
}

function xmlProps(n: XNode): RawProp[] | undefined {
  const ps = child(n, "properties");
  if (!ps) return undefined;
  return kids(ps, "property").map((p) => {
    const type = p.attrs.type ?? "string";
    const value = type === "class" ? (xmlProps(p) ?? []) : (p.attrs.value ?? p.text);
    const prop: RawProp = { name: p.attrs.name ?? "", type, value };
    if (p.attrs.propertytype) prop.propertytype = p.attrs.propertytype;
    return prop;
  });
}

function xmlData(n: XNode): Json {
  const out: Json = {};
  const encoding = n.attrs.encoding ?? "";
  if (n.attrs.compression) out.compression = n.attrs.compression;
  const cells = (node: XNode): unknown => {
    if (encoding === "base64") return node.text.trim();
    if (encoding === "csv") return node.text.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => num(s));
    return kids(node, "tile").map((t) => num(t.attrs.gid));
  };
  out.encoding = encoding === "base64" ? "base64" : "csv";
  const chunks = kids(n, "chunk");
  if (chunks.length) out.chunks = chunks.map((c) => ({ ...attrsOf(c, ["x", "y", "width", "height"]), data: cells(c) }));
  else out.data = cells(n);
  return out;
}

function xmlImage(layer: Json, n: XNode | undefined, prefix: string): void {
  if (!n) return;
  layer[prefix] = n.attrs.source ?? "";
  if (n.attrs.width) layer[`${prefix}width`] = num(n.attrs.width);
  if (n.attrs.height) layer[`${prefix}height`] = num(n.attrs.height);
}

const OBJECT_NUMERIC = ["id", "x", "y", "width", "height", "rotation", "gid"];

function xmlObject(n: XNode): Json {
  const o = attrsOf(n, OBJECT_NUMERIC);
  if (n.attrs.visible !== undefined) o.visible = n.attrs.visible !== "0";
  const pts = (s: string | undefined) =>
    (s ?? "").trim().split(/\s+/).filter(Boolean).map((p) => {
      const [x, y] = p.split(",");
      return { x: num(x), y: num(y) };
    });
  if (child(n, "point")) o.point = true;
  if (child(n, "ellipse")) o.ellipse = true;
  const poly = child(n, "polygon");
  if (poly) o.polygon = pts(poly.attrs.points);
  const line = child(n, "polyline");
  if (line) o.polyline = pts(line.attrs.points);
  if (child(n, "text")) o.text = { text: child(n, "text")!.text };
  const props = xmlProps(n);
  if (props) o.properties = props;
  return o;
}

function xmlLayer(n: XNode): Json | null {
  const common = ["id", "width", "height", "opacity", "offsetx", "offsety", "parallaxx", "parallaxy", "startx", "starty", "x", "y"];
  const l = attrsOf(n, common);
  if (n.attrs.visible !== undefined) l.visible = n.attrs.visible !== "0";
  if (n.attrs.locked !== undefined) l.locked = n.attrs.locked === "1";
  const props = xmlProps(n);
  if (props) l.properties = props;
  switch (n.tag) {
    case "layer": {
      l.type = "tilelayer";
      const d = child(n, "data");
      if (d) Object.assign(l, xmlData(d));
      return l;
    }
    case "objectgroup":
      l.type = "objectgroup";
      l.objects = kids(n, "object").map(xmlObject);
      return l;
    case "imagelayer":
      l.type = "imagelayer";
      xmlImage(l, child(n, "image"), "image");
      l.repeatx = n.attrs.repeatx === "1";
      l.repeaty = n.attrs.repeaty === "1";
      return l;
    case "group":
      l.type = "group";
      l.layers = n.children.map(xmlLayer).filter((c): c is Json => !!c);
      return l;
    default:
      return null;
  }
}

function xmlTileset(n: XNode): Json {
  const t = attrsOf(n, ["firstgid", "tilewidth", "tileheight", "spacing", "margin", "tilecount", "columns"]);
  const off = child(n, "tileoffset");
  if (off) t.tileoffset = { x: num(off.attrs.x), y: num(off.attrs.y) };
  const grid = child(n, "grid");
  if (grid) t.grid = { orientation: grid.attrs.orientation ?? "orthogonal" };
  xmlImage(t, child(n, "image"), "image");
  const props = xmlProps(n);
  if (props) t.properties = props;
  t.tiles = kids(n, "tile").map((tn) => {
    const tile = attrsOf(tn, ["id", "probability", "x", "y", "width", "height"]);
    xmlImage(tile, child(tn, "image"), "image");
    const p = xmlProps(tn);
    if (p) tile.properties = p;
    const og = child(tn, "objectgroup");
    if (og) tile.objectgroup = { objects: kids(og, "object").map(xmlObject) };
    const anim = child(tn, "animation");
    if (anim) tile.animation = kids(anim, "frame").map((f) => ({ tileid: num(f.attrs.tileid), duration: num(f.attrs.duration) }));
    return tile;
  });
  const ws = child(n, "wangsets");
  if (ws) {
    t.wangsets = kids(ws, "wangset").map((w) => ({
      name: w.attrs.name ?? "",
      type: w.attrs.type ?? "mixed",
      colors: kids(w, "wangcolor").map((c) => ({ name: c.attrs.name ?? "", color: c.attrs.color ?? "" })),
      wangtiles: kids(w, "wangtile").map((wt) => ({ tileid: num(wt.attrs.tileid), wangid: wt.attrs.wangid ?? "" })),
    }));
  }
  if (child(n, "terraintypes")) t.terrains = [{}];
  return t;
}

function xmlMap(n: XNode, path: string): Json {
  if (n.tag !== "map") throw new Error(`${path}: not a Tiled map (the root element is <${n.tag}>).`);
  const m = attrsOf(n, ["width", "height", "tilewidth", "tileheight", "hexsidelength", "parallaxoriginx", "parallaxoriginy"]);
  m.infinite = n.attrs.infinite === "1";
  const props = xmlProps(n);
  if (props) m.properties = props;
  m.tilesets = kids(n, "tileset").map(xmlTileset);
  m.layers = n.children.map(xmlLayer).filter((c): c is Json => !!c);
  return m;
}

function xmlTemplate(n: XNode, path: string): Json {
  if (n.tag !== "template") throw new Error(`${path}: not a Tiled object template (the root element is <${n.tag}>).`);
  const out: Json = {};
  const ts = child(n, "tileset");
  if (ts) out.tileset = attrsOf(ts, ["firstgid"]);
  const o = child(n, "object");
  if (o) out.object = xmlObject(o);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Properties

/** TMJ class values are plain JSON without member types; infer what JSON can tell. */
function jsonProps(raw: unknown): RawProp[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isObj).map((p) => {
    const type = str(p.type, "string");
    const prop: RawProp = { name: str(p.name), type, value: type === "class" ? inferMembers(p.value) : p.value };
    if (typeof p.propertytype === "string") prop.propertytype = p.propertytype;
    return prop;
  });
}

function inferMembers(v: unknown): RawProp[] {
  if (!isObj(v)) return [];
  return Object.entries(v).map(([name, value]) =>
    isObj(value)
      ? { name, type: "class", value: inferMembers(value) }
      : { name, type: typeof value === "boolean" ? "bool" : typeof value === "number" ? "float" : "string", value },
  );
}

function propValue(p: RawProp, base: string): ImportValue {
  switch (p.type) {
    case "bool":
      return bool(p.value, false);
    case "int":
    case "float":
      return num(p.value);
    case "color":
      return cssColor(p.value);
    case "file": {
      const s = str(p.value);
      return s ? { kind: "file", path: resolvePath(base, s) } : null;
    }
    case "object": {
      const id = num(p.value);
      return id ? { kind: "object", id: String(id) } : null;
    }
    case "class":
      return { kind: "class", type: p.propertytype ?? "", fields: toProps(p.value as RawProp[] | undefined, base) };
    default:
      return str(p.value);
  }
}

function toProps(raw: RawProp[] | undefined, base: string): ImportProperties {
  const out: ImportProperties = {};
  for (const p of raw ?? []) if (p.name) out[p.name] = propValue(p, base);
  return out;
}

/** A property value as plain JSON for a tile's `data`. */
function toJson(v: ImportValue): unknown {
  if (Array.isArray(v)) return v.map(toJson);
  if (v === null || typeof v !== "object") return v;
  switch (v.kind) {
    case "object":
      return Number(v.id);
    case "file":
      return v.path;
    case "class":
      return Object.fromEntries(Object.entries(v.fields).map(([k, f]) => [k, toJson(f)]));
    default:
      return v;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tilesets

interface Ctx {
  path: string;
  read: ImportReader;
  warnings: string[];
}

function warn(ctx: Ctx, msg: string): void {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;

/** A tile collision object's outline in tile pixels (y down), rotation applied; null for points and polylines. */
function objectOutline(o: Json): [number, number][] | null {
  const x = num(o.x), y = num(o.y), w = num(o.width), h = num(o.height);
  let pts: [number, number][];
  if (o.point || o.polyline) return null;
  if (Array.isArray(o.polygon)) pts = o.polygon.filter(isObj).map((p) => [x + num(p.x), y + num(p.y)]);
  else if (o.ellipse) {
    pts = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      pts.push([x + w / 2 + (w / 2) * Math.cos(a), y + h / 2 + (h / 2) * Math.sin(a)]);
    }
  } else pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const rot = (num(o.rotation) * Math.PI) / 180;
  if (rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    pts = pts.map(([px, py]) => [x + (px - x) * c - (py - y) * s, y + (px - x) * s + (py - y) * c]);
  }
  return pts;
}

function tileShapes(objects: unknown, boxW: number, boxH: number, where: string, ctx: Ctx): TilePolygon[] {
  const out: TilePolygon[] = [];
  if (!Array.isArray(objects)) return out;
  for (const o of objects.filter(isObj)) {
    const pts = objectOutline(o);
    if (!pts) {
      warn(ctx, `${where}: collision points and polylines aren't imported (only rectangles, ellipses and polygons).`);
      continue;
    }
    if (pts.length < 3 || !boxW || !boxH) continue;
    let poly = pts.map(([px, py]) => [r6(px / boxW), r6(1 - py / boxH)] as [number, number]);
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i]!, [bx, by] = poly[(i + 1) % poly.length]!;
      area += ax * by - bx * ay;
    }
    if (area < 0) poly = poly.reverse();
    const props = toProps(toPropList(o.properties), "");
    out.push(props.oneWay === true ? { polygon: poly, oneWay: true } : { polygon: poly });
  }
  return out;
}

const PATTERN_SIDES: [number, number, number][] = [
  [0, 7, 1],
  [2, 1, 3],
  [4, 3, 5],
  [6, 5, 7],
];

/** Wang sets → terrains and patterns (ADR 0436): tiles labelled with one colour against empty get that terrain. */
function applyWangSets(ts: ImportTileset, sets: unknown, where: string, ctx: Ctx): void {
  if (!Array.isArray(sets)) return;
  const byIndex = new Map(ts.tiles.map((t) => [t.index, t]));
  for (const set of sets.filter(isObj)) {
    const type = str(set.type, "mixed");
    const colors = Array.isArray(set.colors) ? set.colors.filter(isObj) : [];
    for (const wt of Array.isArray(set.wangtiles) ? set.wangtiles.filter(isObj) : []) {
      const raw = wt.wangid;
      const ids = Array.isArray(raw) ? raw.map((v) => num(v)) : str(raw).includes(",") ? str(raw).split(",").map((v) => num(v)) : [];
      if (ids.length !== 8) {
        warn(ctx, `${where}: Wang set "${str(set.name)}" uses an old Wang id format; re-save the tileset in Tiled 1.5 or later to import its terrains.`);
        break;
      }
      const used = type === "edge" ? [0, 2, 4, 6] : type === "corner" ? [1, 3, 5, 7] : [0, 1, 2, 3, 4, 5, 6, 7];
      const colours = new Set(used.map((i) => ids[i]!).filter((c) => c > 0));
      const tile = byIndex.get(num(wt.tileid));
      if (!tile || colours.size === 0) continue;
      if (colours.size > 1) {
        warn(ctx, `${where}: tile ${tile.index} is a transition between several Wang colours of "${str(set.name)}"; it was imported without a terrain.`);
        continue;
      }
      const colour = [...colours][0]!;
      const def = colors[colour - 1];
      const name = def ? str(def.name) || `${str(set.name)} ${colour}` : `${str(set.name)} ${colour}`;
      const is = (i: number) => ids[i] === colour;
      const chars: string[] = [];
      for (let i = 0; i < 8; i++) chars.push(type === "edge" && i % 2 ? "*" : is(i) ? "1" : "0");
      if (type === "corner") for (const [side, a, b] of PATTERN_SIDES) chars[side] = is(a) && is(b) ? "1" : "0";
      if (tile.terrain && tile.terrain !== name) {
        warn(ctx, `${where}: tile ${tile.index} is in more than one Wang set; it keeps terrain "${tile.terrain}".`);
        continue;
      }
      tile.terrain = name;
      tile.pattern = chars.join("");
      if (!ts.terrains.some((t) => t.name === name)) {
        const terrain: ImportTerrain = { name };
        const c = def ? cssColor(def.color) : null;
        if (c) terrain.color = c.slice(0, 7);
        ts.terrains.push(terrain);
      }
    }
  }
}

/** A raw (TMJ-shaped) tileset → the model. `base` is the file it's in (for its image and file properties). */
function buildTileset(t: Json, base: string, external: boolean, ctx: Ctx): ImportTileset {
  const name = str(t.name) || baseName(base);
  const where = `${base.split("/").pop()}: tileset "${name}"`;
  const tw = num(t.tilewidth), th = num(t.tileheight);
  const columns = num(t.columns);
  const margin = num(t.margin), spacing = num(t.spacing);
  const image: ImportImage | null = typeof t.image === "string" && t.image ? { path: resolvePath(base, t.image), width: num(t.imagewidth), height: num(t.imageheight) } : null;
  const off = isObj(t.tileoffset) ? t.tileoffset : {};
  const ts: ImportTileset = {
    name,
    path: external ? base : null,
    tileWidth: tw,
    tileHeight: th,
    image,
    margin,
    spacing,
    columns: image ? columns : 0,
    tileCount: 0,
    offset: [num(off.x), num(off.y)],
    tiles: [],
    terrains: [],
    properties: toProps(toPropList(t.properties), base),
  };
  if (isObj(t.grid) && (t.grid.orientation === "isometric" || t.grid.orientation === "orthogonal")) ts.previewGrid = t.grid.orientation === "isometric" ? "isometric" : "square";
  const rawTiles = new Map<number, Json>();
  for (const rt of Array.isArray(t.tiles) ? t.tiles.filter(isObj) : []) rawTiles.set(num(rt.id), rt);
  if (image) {
    const count = num(t.tilecount) || (columns ? columns * Math.floor((image.height - 2 * margin + spacing) / (th + spacing)) : 0);
    for (let i = 0; i < count; i++) ts.tiles.push({ index: i, rect: gridTileRect(i, columns, tw, th, margin, spacing), shapes: [] });
  } else {
    for (const [id, rt] of rawTiles) {
      if (typeof rt.image !== "string" || !rt.image) {
        warn(ctx, `${where}: tile ${id} has no image; skipped.`);
        continue;
      }
      const img: ImportImage = { path: resolvePath(base, rt.image), width: num(rt.imagewidth), height: num(rt.imageheight) };
      const rect = { x: num(rt.x), y: num(rt.y), w: num(rt.width) || img.width, h: num(rt.height) || img.height };
      ts.tiles.push({ index: id, image: img, rect, shapes: [] });
    }
  }
  ts.tileCount = ts.tiles.length;
  const byIndex = new Map(ts.tiles.map((x) => [x.index, x]));
  for (const [id, rt] of rawTiles) {
    const tile = byIndex.get(id);
    if (!tile) continue;
    const props = toProps(toPropList(rt.properties), base);
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) data[k] = toJson(v);
    const cls = str(rt.class) || str(rt.type);
    if (cls) data.class = cls;
    if (Object.keys(data).length) tile.data = data;
    if (isObj(rt.objectgroup)) tile.shapes = tileShapes(rt.objectgroup.objects, tile.rect.w, tile.rect.h, `${where}, tile ${id}`, ctx);
    if (Array.isArray(rt.animation)) {
      const frames: ImportAnimationFrame[] = rt.animation.filter(isObj).map((f) => ({ tileIndex: num(f.tileid), durationSeconds: num(f.duration) / 1000 }));
      if (frames.length) tile.animation = frames;
    }
    const p = num(rt.probability, 1);
    if (p !== 1) tile.weight = p;
  }
  applyWangSets(ts, t.wangsets, where, ctx);
  if (Array.isArray(t.terrains) && t.terrains.length) warn(ctx, `${where}: uses Tiled's old terrain format; re-save it in Tiled 1.5 or later to import its terrains.`);
  return ts;
}

function rawTileset(text: string, path: string): Json {
  if (isXml(text)) {
    const n = parseXml(text, path);
    if (n.tag !== "tileset") throw new Error(`${path}: not a Tiled tileset (the root element is <${n.tag}>).`);
    return xmlTileset(n);
  }
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${(err as Error).message}).`);
  }
  if (!isObj(j) || (j.type !== undefined && j.type !== "tileset")) throw new Error(`${path}: not a Tiled tileset.`);
  return j;
}

// ---------------------------------------------------------------------------------------------------------------
// Map

interface GidRange {
  firstgid: number;
  index: number;
}

class MapBuilder {
  readonly tilesets: ImportTileset[] = [];
  private readonly byPath = new Map<string, number>();
  private readonly templates = new Map<string, { object: Json; ranges: GidRange[] }>();
  private badGids = 0;

  constructor(readonly ctx: Ctx) {}

  /** Loads the tileset refs of a map or template into gid ranges (sharing tilesets loaded before by path). */
  async ranges(refs: unknown, base: string): Promise<GidRange[]> {
    const out: GidRange[] = [];
    for (const ref of Array.isArray(refs) ? refs.filter(isObj) : []) {
      const firstgid = num(ref.firstgid, 1);
      if (typeof ref.source === "string" && ref.source) {
        const p = resolvePath(base, ref.source);
        let index = this.byPath.get(p);
        if (index === undefined) {
          const text = await this.ctx.read(p);
          if (text === null) throw new Error(`${this.ctx.path}: couldn't read the tileset ${p}.`);
          index = this.tilesets.push(buildTileset(rawTileset(text, p), p, true, this.ctx)) - 1;
          this.byPath.set(p, index);
        }
        out.push({ firstgid, index });
      } else out.push({ firstgid, index: this.tilesets.push(buildTileset(ref, base, false, this.ctx)) - 1 });
    }
    return out.sort((a, b) => a.firstgid - b.firstgid);
  }

  resolve(gid: number, ranges: GidRange[]): ImportObjectTile | null {
    if (gid & HEX_ROT) warn(this.ctx, `${this.ctx.path.split("/").pop()}: hexagonal 120° rotations aren't supported; those tiles were imported unrotated.`);
    const id = gid & GID_MASK;
    let range: GidRange | undefined;
    for (const r of ranges) if (r.firstgid <= id) range = r;
    if (!range) {
      this.badGids++;
      return null;
    }
    return { tilesetIndex: range.index, tileIndex: id - range.firstgid, flipX: (gid & FLIP_X) !== 0, flipY: (gid & FLIP_Y) !== 0, flipDiagonal: (gid & FLIP_D) !== 0 };
  }

  async template(path: string): Promise<{ object: Json; ranges: GidRange[] }> {
    const cached = this.templates.get(path);
    if (cached) return cached;
    const text = await this.ctx.read(path);
    if (text === null) throw new Error(`${this.ctx.path}: couldn't read the object template ${path}.`);
    let t: Json;
    if (isXml(text)) t = xmlTemplate(parseXml(text, path), path);
    else {
      const j: unknown = JSON.parse(text);
      if (!isObj(j)) throw new Error(`${path}: not a Tiled object template.`);
      t = j;
    }
    const out = { object: isObj(t.object) ? t.object : {}, ranges: await this.ranges(t.tileset ? [t.tileset] : [], path) };
    this.templates.set(path, out);
    return out;
  }

  finish(): void {
    if (this.badGids) warn(this.ctx, `${this.ctx.path.split("/").pop()}: ${this.badGids} tile(s) name no tileset of the map; skipped.`);
  }
}

async function decodeGids(data: unknown, encoding: unknown, compression: unknown, where: string): Promise<number[]> {
  if (Array.isArray(data)) return data.map((v) => num(v));
  if (typeof data !== "string") return [];
  if (encoding !== "base64") return data.split(",").map((s) => s.trim()).filter(Boolean).map((s) => num(s));
  const bin = atob(data.replace(/\s+/g, ""));
  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const c = str(compression);
  if (c === "zstd") throw new Error(`${where} uses zstd compression, which Myco can't read. In Tiled, set the map's Tile Layer Format to CSV or uncompressed Base64, save, and import again.`);
  if (c === "zlib" || c === "gzip") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(c === "zlib" ? "deflate" : "gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (c) throw new Error(`${where} uses an unknown compression "${c}".`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(view.getUint32(i, true));
  return out;
}

interface Inherited {
  prefix: string;
  visible: boolean;
  opacity: number;
  offset: [number, number];
  parallax: [number, number];
  locked: boolean;
  tint: [number, number, number, number] | null;
}

function tintParts(c: string | null): [number, number, number, number] | null {
  if (!c) return null;
  const h = c.slice(1);
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}

function tintString(t: [number, number, number, number]): string {
  const hx = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${hx(t[0])}${hx(t[1])}${hx(t[2])}${t[3] < 1 ? hx(t[3]) : ""}`;
}

async function buildObject(o: Json, b: MapBuilder, ranges: GidRange[], base: string, where: string): Promise<ImportObject | null> {
  let raw = o;
  let gidRanges = ranges;
  let template: string | undefined;
  if (typeof o.template === "string" && o.template) {
    template = resolvePath(base, o.template);
    const t = await b.template(template);
    raw = { ...t.object, ...o };
    const tp = toPropList(t.object.properties);
    const op = toPropList(o.properties);
    raw.properties = [...tp.filter((p) => !op.some((q) => q.name === p.name)), ...op];
    if (o.gid === undefined && t.object.gid !== undefined) gidRanges = t.ranges;
  }
  if (raw.text) {
    warn(b.ctx, `${where}: text objects aren't imported.`);
    return null;
  }
  const obj: ImportObject = {
    id: String(num(raw.id)),
    name: str(raw.name),
    class: str(raw.class) || str(raw.type),
    shape: "rect",
    x: num(raw.x),
    y: num(raw.y),
    width: num(raw.width),
    height: num(raw.height),
    rotation: num(raw.rotation),
    visible: bool(raw.visible, true),
    properties: toProps(toPropList(raw.properties), base),
  };
  if (template) obj.template = template;
  const pts = (v: unknown) => (Array.isArray(v) ? v.filter(isObj).map((p) => [num(p.x), num(p.y)] as [number, number]) : []);
  if (raw.gid !== undefined && num(raw.gid)) {
    const tile = b.resolve(num(raw.gid), gidRanges);
    if (!tile) return null;
    obj.shape = "tile";
    obj.tile = tile;
  } else if (raw.point) obj.shape = "point";
  else if (raw.ellipse) obj.shape = "ellipse";
  else if (Array.isArray(raw.polygon)) {
    obj.shape = "polygon";
    obj.points = pts(raw.polygon);
  } else if (Array.isArray(raw.polyline)) {
    obj.shape = "polyline";
    obj.points = pts(raw.polyline);
  }
  if (obj.shape === "point" || obj.shape === "polygon" || obj.shape === "polyline") obj.width = obj.height = 0;
  return obj;
}

/** Properties from either encoding (TMX ones were already converted; TMJ ones still raw). */
function toPropList(raw: unknown): RawProp[] {
  if (!Array.isArray(raw)) return [];
  return raw.every((p) => isObj(p) && (p.type !== "class" || Array.isArray(p.value))) ? (raw as RawProp[]) : (jsonProps(raw) ?? []);
}

async function buildLayers(raws: unknown, parent: Inherited, b: MapBuilder, ranges: GidRange[], map: Json, out: ImportLayer[]): Promise<void> {
  const ctx = b.ctx;
  const file = ctx.path.split("/").pop();
  for (const l of Array.isArray(raws) ? raws.filter(isObj) : []) {
    const own = tintParts(cssColor(l.tintcolor));
    const tint = parent.tint && own ? (parent.tint.map((v, i) => v * own[i]!) as Inherited["tint"]) : (own ?? parent.tint);
    const inh: Inherited = {
      prefix: parent.prefix + str(l.name),
      visible: parent.visible && bool(l.visible, true),
      opacity: parent.opacity * num(l.opacity, 1),
      offset: [parent.offset[0] + num(l.offsetx), parent.offset[1] + num(l.offsety)],
      parallax: [parent.parallax[0] * num(l.parallaxx, 1), parent.parallax[1] * num(l.parallaxy, 1)],
      locked: parent.locked || bool(l.locked, false),
      tint,
    };
    if (l.type === "group") {
      await buildLayers(l.layers, { ...inh, prefix: inh.prefix + "/" }, b, ranges, map, out);
      continue;
    }
    const where = `${file}: layer "${inh.prefix}"`;
    const base = {
      id: String(num(l.id)),
      name: inh.prefix,
      visible: inh.visible,
      opacity: inh.opacity,
      offset: inh.offset,
      parallax: inh.parallax,
      locked: inh.locked,
      properties: toProps(toPropList(l.properties), ctx.path),
      ...(inh.tint ? { tint: tintString(inh.tint) } : {}),
      ...(str(l.class) ? { class: str(l.class) } : {}),
    };
    if (l.type === "tilelayer") {
      const cells: ImportCell[] = [];
      const put = (gids: number[], x0: number, y0: number, w: number) => {
        gids.forEach((gid, i) => {
          if (!(gid & GID_MASK)) return;
          const t = b.resolve(gid, ranges);
          if (t) cells.push({ x: x0 + (i % w), y: y0 + Math.floor(i / w), ...t });
        });
      };
      if (Array.isArray(l.chunks)) {
        for (const c of l.chunks.filter(isObj)) put(await decodeGids(c.data, l.encoding, l.compression, where), num(c.x), num(c.y), num(c.width) || 1);
      } else put(await decodeGids(l.data, l.encoding, l.compression, where), 0, 0, num(l.width) || num(map.width) || 1);
      cells.sort((p, q) => p.y - q.y || p.x - q.x);
      out.push({ ...base, kind: "tiles", cellWidth: num(map.tilewidth), cellHeight: num(map.tileheight), width: num(l.width), height: num(l.height), cells });
    } else if (l.type === "objectgroup") {
      const objects: ImportObject[] = [];
      for (const o of Array.isArray(l.objects) ? l.objects.filter(isObj) : []) {
        const obj = await buildObject(o, b, ranges, ctx.path, where);
        if (obj) objects.push(obj);
      }
      out.push({ ...base, kind: "objects", objects });
    } else if (l.type === "imagelayer") {
      const image = typeof l.image === "string" && l.image ? { path: resolvePath(ctx.path, l.image), width: num(l.imagewidth), height: num(l.imageheight) } : null;
      out.push({ ...base, kind: "image", image, repeatX: bool(l.repeatx, false), repeatY: bool(l.repeaty, false) });
    } else warn(ctx, `${where}: unknown layer type "${str(l.type)}"; skipped.`);
  }
}

const SHAPES: Record<string, ImportGrid["shape"]> = { orthogonal: "square", isometric: "isometric", staggered: "staggered", hexagonal: "hexagonal" };

/**
 * Parses a Tiled map, TMX (XML) or TMJ (JSON), into the neutral model. `path` is the map's own path (what referenced
 * files resolve against); `read` loads external tilesets (TSX/TSJ) and object templates (`.tx`/`.tj`). Throws with a
 * message for the user when the map can't be imported (not a map, a referenced file missing, zstd-compressed data).
 */
export async function parseTiledMap(text: string, path: string, read: ImportReader): Promise<ImportTiledMap> {
  let m: Json;
  if (isXml(text)) m = xmlMap(parseXml(text, path), path);
  else {
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path}: not valid JSON (${(err as Error).message}).`);
    }
    if (!isObj(j) || j.type !== "map") throw new Error(`${path}: not a Tiled map.`);
    m = j;
  }
  const ctx: Ctx = { path, read, warnings: [] };
  const orientation = str(m.orientation, "orthogonal");
  const shape = SHAPES[orientation];
  if (!shape) throw new Error(`${path}: unknown map orientation "${orientation}".`);
  const tw = num(m.tilewidth), th = num(m.tileheight);
  const staggerAxis = m.staggeraxis === "x" ? "x" : "y";
  const hexLen = num(m.hexsidelength);
  const grid: ImportGrid = {
    shape,
    staggerAxis,
    staggerIndex: m.staggerindex === "even" ? "even" : "odd",
    hexSide: shape === "hexagonal" ? r6(hexLen / ((staggerAxis === "y" ? th : tw) || 1)) : 0.5,
    tileWidth: tw,
    tileHeight: th,
  };
  const b = new MapBuilder(ctx);
  const ranges = await b.ranges(m.tilesets, path);
  const layers: ImportLayer[] = [];
  await buildLayers(m.layers, { prefix: "", visible: true, opacity: 1, offset: [0, 0], parallax: [1, 1], locked: false, tint: null }, b, ranges, m, layers);
  b.finish();
  const map: ImportTiledMap = {
    format: "tiled",
    path,
    name: baseName(path),
    grid,
    width: num(m.width),
    height: num(m.height),
    infinite: bool(m.infinite, false),
    parallaxOrigin: [num(m.parallaxoriginx), num(m.parallaxoriginy)],
    properties: toProps(toPropList(m.properties), path),
    tilesets: b.tilesets,
    layers,
    warnings: ctx.warnings,
  };
  const bg = cssColor(m.backgroundcolor);
  if (bg) map.backgroundColor = bg;
  if (str(m.class)) map.class = str(m.class);
  return map;
}

/**
 * Parses a standalone Tiled tileset, TSX (XML) or TSJ (JSON). `read` is accepted for symmetry with the map parser;
 * a tileset names no other text files.
 */
export async function parseTiledTileset(text: string, path: string, read: ImportReader): Promise<ImportTiledTilesetFile> {
  const ctx: Ctx = { path, read, warnings: [] };
  const tileset = buildTileset(rawTileset(text, path), path, true, ctx);
  return { format: "tiledTileset", tileset, warnings: ctx.warnings };
}
