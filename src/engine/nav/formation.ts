/**
 * Formation assets (ADR 0065; Foxfire's `NavFormation` ScriptableObject): `*.formation.json` files a `NavGroup`
 * references through `formationAsset`. A preset shape, or a mask painted on a grid of up to 128 × 128 cells (row 0
 * is the front). Members take the painted cells in {@link formationFillOrder}: front row first, each row from the
 * middle of the painted columns out, right before left (`nav-crowd`'s `formations::create_mask`), so a group of n
 * takes the first n cells. Cells are the group's `spacing` apart.
 *
 * File format `myco.formation@1`:
 * `{ format, shape, layers, layerSpacing, width, height, cells }`, `cells` being `height` strings of `width`
 * characters (`#` painted, `.` empty), front row first. A single string of `0`/`1` (row by row) is read too.
 *
 * Every edit function returns a new formation, so editors can keep snapshots for undo.
 */

export const FORMATION_FORMAT = "myco.formation@1";
export const FORMATION_SUFFIX = ".formation.json";
/** `NavFormations.MaxMaskSize`: the largest mask side. */
export const MAX_FORMATION_SIZE = 128;
export const MAX_FORMATION_LAYERS = 8;

export type FormationShape = "box" | "line" | "column" | "wedge" | "circle" | "mask";
export const FORMATION_SHAPES: readonly FormationShape[] = ["box", "line", "column", "wedge", "circle", "mask"];

/** A formation asset's contents. */
export interface NavFormationAsset {
  /** A preset shape, or `"mask"` to use the painted cells. */
  shape: FormationShape;
  /** Flyer groups: layers stacked vertically (1-8). Walking groups ignore it. */
  layers: number;
  /** Flyer groups: height between layers; 0 = the group's spacing. */
  layerSpacing: number;
  /** Mask columns (1-128). */
  width: number;
  /** Mask rows (1-128); row 0 is the front. */
  height: number;
  /** Row by row from the front: cell (x, row) is `cells[row * width + x]`. */
  cells: boolean[];
}

/** True for a formation asset's path. */
export const isFormationPath = (path: string): boolean => path.toLowerCase().replace(/^asset:/, "").endsWith(FORMATION_SUFFIX);

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** Foxfire's defaults: a 16 × 16 mask with nothing painted. */
export function defaultFormation(): NavFormationAsset {
  return { shape: "mask", layers: 1, layerSpacing: 0, width: 16, height: 16, cells: new Array<boolean>(256).fill(false) };
}

export interface ParsedFormation {
  formation: NavFormationAsset;
  /** What's wrong with the file (bad values read as the defaults). */
  problems: string[];
}

/** Read a formation asset's JSON (the parsed object or its text). Throws only if it isn't a JSON object at all. */
export function parseFormation(raw: unknown, where = "formation"): ParsedFormation {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: not a formation (expected a JSON object).`);
  const o = value as Record<string, unknown>;
  const problems: string[] = [];
  const d = defaultFormation();
  if (o.format !== undefined && o.format !== FORMATION_FORMAT) problems.push(`${where}: unknown format "${String(o.format)}"; reading it as ${FORMATION_FORMAT}.`);
  let shape = d.shape;
  if (o.shape !== undefined) {
    if (FORMATION_SHAPES.includes(o.shape as FormationShape)) shape = o.shape as FormationShape;
    else problems.push(`${where}: unknown shape "${String(o.shape)}"; using "mask".`);
  }
  const width = clampInt(o.width, 1, MAX_FORMATION_SIZE, d.width);
  const height = clampInt(o.height, 1, MAX_FORMATION_SIZE, d.height);
  if (o.width !== undefined && o.width !== width) problems.push(`${where}: width ${String(o.width)} isn't 1-${MAX_FORMATION_SIZE}; using ${width}.`);
  if (o.height !== undefined && o.height !== height) problems.push(`${where}: height ${String(o.height)} isn't 1-${MAX_FORMATION_SIZE}; using ${height}.`);
  const layers = clampInt(o.layers, 1, MAX_FORMATION_LAYERS, 1);
  const layerSpacing = typeof o.layerSpacing === "number" && Number.isFinite(o.layerSpacing) ? Math.max(0, o.layerSpacing) : 0;
  const cells = new Array<boolean>(width * height).fill(false);
  const c = o.cells;
  if (Array.isArray(c)) {
    for (let row = 0; row < Math.min(height, c.length); row++) {
      const line = typeof c[row] === "string" ? (c[row] as string) : "";
      for (let x = 0; x < Math.min(width, line.length); x++) cells[row * width + x] = line[x] === "#" || line[x] === "1" || line[x] === "x" || line[x] === "X";
    }
    if (c.some((r) => typeof r !== "string")) problems.push(`${where}: cells must be strings; the others read as empty rows.`);
  } else if (typeof c === "string") {
    for (let i = 0; i < Math.min(cells.length, c.length); i++) cells[i] = c[i] === "1" || c[i] === "#";
  } else if (c !== undefined) problems.push(`${where}: cells must be row strings or a bit string.`);
  return { formation: { shape, layers, layerSpacing, width, height, cells }, problems };
}

/** The asset's JSON object. */
export function formationJSON(f: NavFormationAsset): Record<string, unknown> {
  const rows: string[] = [];
  for (let row = 0; row < f.height; row++) {
    let line = "";
    for (let x = 0; x < f.width; x++) line += f.cells[row * f.width + x] ? "#" : ".";
    rows.push(line);
  }
  return { format: FORMATION_FORMAT, shape: f.shape, layers: f.layers, layerSpacing: f.layerSpacing, width: f.width, height: f.height, cells: rows };
}

/** The asset's file text. */
export const formatFormation = (f: NavFormationAsset): string => `${JSON.stringify(formationJSON(f), null, 2)}\n`;

/** Whether cell (x, row) is painted (false outside the grid). */
export function formationCell(f: NavFormationAsset, x: number, row: number): boolean {
  return x >= 0 && x < f.width && row >= 0 && row < f.height && f.cells[row * f.width + x] === true;
}

/** The formation with cell (x, row) painted or cleared (itself if nothing changes or the cell is outside). */
export function setFormationCell(f: NavFormationAsset, x: number, row: number, on: boolean): NavFormationAsset {
  if (x < 0 || x >= f.width || row < 0 || row >= f.height || formationCell(f, x, row) === on) return f;
  const cells = f.cells.slice();
  cells[row * f.width + x] = on;
  return { ...f, cells };
}

/** `Resize`: a new grid size (clamped to 1-128), keeping the cells that still fit (anchored at the front left). */
export function resizeFormation(f: NavFormationAsset, width: number, height: number): NavFormationAsset {
  const w = clampInt(width, 1, MAX_FORMATION_SIZE, f.width);
  const h = clampInt(height, 1, MAX_FORMATION_SIZE, f.height);
  const cells = new Array<boolean>(w * h).fill(false);
  for (let row = 0; row < Math.min(h, f.height); row++) for (let x = 0; x < Math.min(w, f.width); x++) cells[row * w + x] = formationCell(f, x, row);
  return { ...f, width: w, height: h, cells };
}

/** Every cell cleared. */
export const clearFormation = (f: NavFormationAsset): NavFormationAsset => ({ ...f, cells: new Array<boolean>(f.width * f.height).fill(false) });
/** Every cell painted ("Fill all"). */
export const fillFormation = (f: NavFormationAsset): NavFormationAsset => ({ ...f, cells: new Array<boolean>(f.width * f.height).fill(true) });
/** Painted cells cleared and empty ones painted. */
export const invertFormation = (f: NavFormationAsset): NavFormationAsset => ({ ...f, cells: f.cells.map((c) => !c) });

/** Foxfire's Mirror: the left half copied onto the right half, mirrored (a symmetric shape from one side's painting). */
export function mirrorFormation(f: NavFormationAsset): NavFormationAsset {
  const cells = f.cells.slice();
  for (let row = 0; row < f.height; row++) for (let x = 0; x < Math.floor(f.width / 2); x++) cells[row * f.width + (f.width - 1 - x)] = cells[row * f.width + x];
  return { ...f, cells };
}

/** How many cells are painted: the slots the mask has. */
export const formationSlotCount = (f: NavFormationAsset): number => f.cells.reduce((n, c) => (c ? n + 1 : n), 0);

/**
 * The painted cells (indices `row * width + x`) in the order members take them (`create_mask`): front row first; in
 * a row the cells nearest the middle of the painted columns first, right of it before left.
 */
export function formationFillOrder(f: NavFormationAsset): number[] {
  const { width } = f;
  const cells: number[] = [];
  let minX = Infinity, maxX = -Infinity;
  for (let row = 0; row < f.height; row++) {
    for (let x = 0; x < width; x++) {
      if (!f.cells[row * width + x]) continue;
      cells.push(row * width + x);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  const centre2 = minX + maxX;
  return cells.sort((a, b) => {
    const rowA = Math.floor(a / width), rowB = Math.floor(b / width);
    if (rowA !== rowB) return rowA - rowB;
    const dA = 2 * (a - rowA * width) - centre2, dB = 2 * (b - rowB * width) - centre2;
    const byDistance = Math.abs(dA) - Math.abs(dB);
    return byDistance !== 0 ? byDistance : dB - dA; // right (positive) first
  });
}

/** The mask `NavGroup.setMask` takes (the runtime's bit grid), or null for a preset shape. */
export function formationMask(f: NavFormationAsset): { bits: boolean[]; width: number; height: number } | null {
  return f.shape === "mask" ? { bits: f.cells.slice(), width: f.width, height: f.height } : null;
}

/** The grid size an image import gives: the formation's own, or with `sizeToImage` the image's, scaled to fit 128. */
export function formationImportSize(f: NavFormationAsset, imageWidth: number, imageHeight: number, sizeToImage: boolean): [number, number] {
  if (!sizeToImage || imageWidth <= 0 || imageHeight <= 0) return [f.width, f.height];
  const scale = Math.min(1, MAX_FORMATION_SIZE / Math.max(imageWidth, imageHeight));
  return [clampInt(imageWidth * scale, 1, MAX_FORMATION_SIZE, 1), clampInt(imageHeight * scale, 1, MAX_FORMATION_SIZE, 1)];
}

/**
 * Import from an image whose pixels (RGBA bytes, rows top to bottom) are already scaled to `width` × `height`: the
 * grid is resized to that (keeping nothing: every cell is set from the image) and a cell is painted where the pixel's
 * alpha (`useAlpha`) or luminance is at least `threshold` (0-1). The image's top row is the front.
 */
export function formationFromPixels(f: NavFormationAsset, pixels: ArrayLike<number>, width: number, height: number, threshold: number, useAlpha: boolean): NavFormationAsset {
  const sized = width === f.width && height === f.height ? f : resizeFormation(f, width, height);
  const cells = new Array<boolean>(sized.width * sized.height).fill(false);
  for (let row = 0; row < sized.height; row++) {
    for (let x = 0; x < sized.width; x++) {
      const p = (row * width + x) * 4;
      const value = useAlpha ? (pixels[p + 3] ?? 0) / 255 : (0.299 * (pixels[p] ?? 0) + 0.587 * (pixels[p + 1] ?? 0) + 0.114 * (pixels[p + 2] ?? 0)) / 255;
      cells[row * sized.width + x] = value >= threshold;
    }
  }
  return { ...sized, cells };
}

// ------------------------------------------------------------------------------------------- runtime reads

/** Parsed assets by their JSON value, so an asset rewritten in the editor is parsed again. */
const parsed = new WeakMap<object, NavFormationAsset | null>();

/** @internal A loaded formation asset's contents, or null if `raw` isn't one (reported once per value). */
export function readFormationValue(raw: unknown, where: string): NavFormationAsset | null {
  if (!raw || typeof raw !== "object") return null;
  if (parsed.has(raw)) return parsed.get(raw)!;
  let out: NavFormationAsset | null = null;
  try {
    const r = parseFormation(raw, where);
    for (const p of r.problems) console.warn(`[myco] ${p}`);
    out = r.formation;
  } catch (err) {
    console.warn(`[myco] ${(err as Error).message}`);
  }
  parsed.set(raw, out);
  return out;
}
