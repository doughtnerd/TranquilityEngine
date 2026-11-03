// The Sprite Editor's logic (ADR 0040): slicing an image into named rectangles by a grid (cell
// size or cell count) or automatically (islands of opaque pixels), and moving and resizing
// rectangles by hand. Rectangles are [x, y, width, height] in whole pixels from the image's
// top-left corner, as sidecars store them. Pure functions; ui/SpriteEditor.tsx draws them.

export type Rect = [number, number, number, number];

/** Pixels as the canvas API gives them: RGBA, 4 bytes per pixel, row by row from the top. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** Named pivot positions, 0..1 from the bottom-left (y up), as in the sidecar. */
export const PIVOT_PRESETS: readonly { label: string; pivot: [number, number] }[] = [
  { label: "Center", pivot: [0.5, 0.5] },
  { label: "Top Left", pivot: [0, 1] },
  { label: "Top", pivot: [0.5, 1] },
  { label: "Top Right", pivot: [1, 1] },
  { label: "Left", pivot: [0, 0.5] },
  { label: "Right", pivot: [1, 0.5] },
  { label: "Bottom Left", pivot: [0, 0] },
  { label: "Bottom", pivot: [0.5, 0] },
  { label: "Bottom Right", pivot: [1, 0] },
];

/** The preset's label for `pivot`, or "Custom". */
export const pivotLabel = (pivot: readonly number[]) => PIVOT_PRESETS.find((p) => p.pivot[0] === pivot[0] && p.pivot[1] === pivot[1])?.label ?? "Custom";

/**
 * Cells of `cellWidth` × `cellHeight` across a `width` × `height` image, row by row, starting at
 * `offset` with `padding` pixels between cells. Cells that don't fit whole are left out.
 */
export function gridByCellSize(width: number, height: number, cellWidth: number, cellHeight: number, offset: readonly [number, number] = [0, 0], padding: readonly [number, number] = [0, 0]): Rect[] {
  const out: Rect[] = [];
  const cw = Math.floor(cellWidth), ch = Math.floor(cellHeight);
  if (cw < 1 || ch < 1) return out;
  const px = Math.max(0, Math.floor(padding[0])), py = Math.max(0, Math.floor(padding[1]));
  for (let y = Math.max(0, Math.floor(offset[1])); y + ch <= height; y += ch + py) {
    for (let x = Math.max(0, Math.floor(offset[0])); x + cw <= width; x += cw + px) out.push([x, y, cw, ch]);
  }
  return out;
}

/** `columns` × `rows` equal cells over the image (sizes rounded down), row by row. */
export function gridByCount(width: number, height: number, columns: number, rows: number): Rect[] {
  const cols = Math.floor(columns), rs = Math.floor(rows);
  if (cols < 1 || rs < 1) return [];
  return gridByCellSize(width, height, Math.floor(width / cols), Math.floor(height / rs));
}

const alphaAt = (p: Pixels, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3];

/** True if every pixel of `rect` has alpha ≤ `threshold`. */
export function isEmptyRect(pixels: Pixels, rect: Rect, threshold = 0): boolean {
  const [x0, y0, w, h] = rect;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (alphaAt(pixels, x, y) > threshold) return false;
  return true;
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};

/**
 * Automatic slicing: the bounding box of each island of pixels with alpha above `threshold`
 * (touching diagonally counts), with boxes that overlap merged, and boxes smaller than `minSize`
 * pixels on either side dropped. Sorted in reading order: rows top to bottom (boxes whose tops are
 * within one box height share a row), then left to right.
 */
export function autoSlice(pixels: Pixels, options: { threshold?: number; minSize?: number } = {}): Rect[] {
  const { width: W, height: H } = pixels;
  const threshold = options.threshold ?? 0, minSize = options.minSize ?? 1;
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  let boxes: Rect[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || pixels.data[start * 4 + 3] <= threshold) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const j = ny * W + nx;
          if (seen[j] || pixels.data[j * 4 + 3] <= threshold) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
  }
  // Merge overlapping boxes until none overlap.
  for (let merged = true; merged; ) {
    merged = false;
    const out: Rect[] = [];
    for (const b of boxes) {
      const i = out.findIndex((o) => overlaps(o, b));
      if (i >= 0) {
        out[i] = union(out[i], b);
        merged = true;
      } else out.push(b);
    }
    boxes = out;
  }
  return readingOrder(boxes.filter((b) => b[2] >= minSize && b[3] >= minSize));
}

/** Rectangles in reading order: rows top to bottom, then left to right within a row. */
export function readingOrder(rects: readonly Rect[]): Rect[] {
  const byTop = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const rows: Rect[][] = [];
  for (const r of byTop) {
    const row = rows[rows.length - 1];
    // Same row while its top is above the bottom of the row's first box.
    if (row && r[1] < row[0][1] + row[0][3]) row.push(r);
    else rows.push([r]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a[0] - b[0]));
}

/** `count` names `<base>_0`, `<base>_1`… skipping any in `taken`. */
export function sliceNames(base: string, count: number, taken: readonly string[] = []): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  for (let n = 0; out.length < count; n++) {
    const name = `${base}_${n}`;
    if (used.has(name)) continue;
    used.add(name);
    out.push(name);
  }
  return out;
}

/** The base for slice names from an image path: `images/hero sheet.png` → `hero sheet`. */
export const sliceBase = (imagePath: string) => imagePath.slice(imagePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") || "sprite";

/** `rect` kept inside a `width` × `height` image, at least 1 × 1, in whole pixels. */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const w = Math.max(1, Math.min(Math.round(rect[2]), width));
  const h = Math.max(1, Math.min(Math.round(rect[3]), height));
  const x = Math.max(0, Math.min(Math.round(rect[0]), width - w));
  const y = Math.max(0, Math.min(Math.round(rect[1]), height - h));
  return [x, y, w, h];
}

/** The rectangle between two pixel corners dragged out (either order), inside the image. Null if it has no area. */
export function rectBetween(a: readonly [number, number], b: readonly [number, number], width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.min(a[0], b[0])), y0 = Math.max(0, Math.min(a[1], b[1]));
  const x1 = Math.min(width, Math.max(a[0], b[0])), y1 = Math.min(height, Math.max(a[1], b[1]));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** `rect` moved by whole pixels, kept inside the image. */
export function moveRect(rect: Rect, dx: number, dy: number, width: number, height: number): Rect {
  return clampRect([rect[0] + dx, rect[1] + dy, rect[2], rect[3]], width, height);
}

/** A resize handle: which edges it moves (n = top, s = bottom, w = left, e = right). */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * `rect` with the edges `handle` names moved by whole pixels, the opposite edges staying put.
 * Edges stop at the image's border and one pixel short of the opposite edge.
 */
export function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number, width: number, height: number): Rect {
  let [x0, y0] = rect;
  let x1 = rect[0] + rect[2], y1 = rect[1] + rect[3];
  if (handle.includes("w")) x0 = Math.max(0, Math.min(x1 - 1, x0 + Math.round(dx)));
  if (handle.includes("e")) x1 = Math.min(width, Math.max(x0 + 1, x1 + Math.round(dx)));
  if (handle.includes("n")) y0 = Math.max(0, Math.min(y1 - 1, y0 + Math.round(dy)));
  if (handle.includes("s")) y1 = Math.min(height, Math.max(y0 + 1, y1 + Math.round(dy)));
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Renamed slices: for each slice that existed when editing began (`original` name) and still
 * exists under another name, the pair [old, new].
 */
export function sliceRenames(slices: readonly { name: string; original?: string | null }[]): [string, string][] {
  return slices.filter((s) => s.original && s.original !== s.name).map((s) => [s.original!, s.name]);
}
