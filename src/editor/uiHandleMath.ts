// The maths of the scene view's UI handles (ADR 0077 §4, wave B part 3): pure, no DOM or editor
// state, so it's tested on its own (`uiHandleMath.test.ts`); `uiHandles.ts` wires it to the viewport.
//
// Everything works in an element's own frame, in UI pixels: a box's four corners on the canvas (CSS
// pixels; a world canvas's are projected, so the quad can be any perspective view of a rectangle)
// and its size in UI pixels give a homography between the two. The pointer is mapped through the
// box's homography *at the start of the drag*, so the change in UI pixels is exact on screen canvases
// (where it's the canvas scale) and on world canvases seen at any angle, and doesn't drift as the
// element's own box changes under the pointer.
//
// Decisions (documented in the 0077 row):
// - Sizes: a percentage stays a percentage, scaled by how much the box changed (`50%` of a box
//   200 px wide resized to 300 px becomes `75%`); a box 0 wide uses the parent's size instead.
//   `auto` and pixel sizes are written in pixels. Whole UI pixels when snapping (the default), and
//   percentages to two decimals.
// - The west and north handles move the left and top edges: on an absolutely positioned element
//   placed by `left` (`top`) that offset moves with the edge; otherwise only the size changes and
//   the layout decides where the box sits (a left-aligned flex item grows to the right).
// - Shift keeps the box's starting aspect ratio: a corner follows whichever side changed more, an
//   edge handle scales the other side with it.
// - Moving an absolutely positioned element changes `left`/`top`, or `right`/`bottom` when those
//   place it (and `left`/`top` don't). With neither, `left`/`top` are written from where it is now,
//   measured from the parent's padding box (inside its border), as Yoga places absolute children.
//   Percent offsets stay percentages of the parent's padding box.
// - In flex flow, dragging reorders: the drop goes before the first sibling (in flow, shown, in
//   visual order) whose middle is past the pointer along the parent's main axis.

export type Point = readonly [number, number];

/** A box on the canvas: its corners (top-left, top-right, bottom-right, bottom-left), CSS pixels, and its size in UI pixels. */
export interface BoxOnCanvas {
  readonly points: readonly Point[];
  readonly size: readonly [number, number];
}

/** A homography between an element's frame (UI pixels, origin top-left) and the canvas. */
export interface BoxMap {
  /** UI pixels in the element's frame → canvas CSS pixels. */
  toCanvas(p: Point): [number, number];
  /** Canvas CSS pixels → UI pixels in the element's frame (null when degenerate or at the horizon). */
  toLocal(p: Point): [number, number] | null;
}

type M3 = [number, number, number, number, number, number, number, number, number];

/** The unit square → quad homography (Heckbert's), row-major with m[8] = 1. Null for a degenerate quad. */
function squareToQuad(q: readonly Point[]): M3 | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function invert3(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

function apply(m: M3, x: number, y: number): [number, number] | null {
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-12) return null;
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** The map between a box's frame and the canvas, or null for a degenerate box (zero area on screen or a zero size). */
export function boxMap(box: BoxOnCanvas): BoxMap | null {
  const [w, h] = box.size;
  if (box.points.length !== 4 || !(w > 0) || !(h > 0)) return null;
  const m = squareToQuad(box.points);
  const inv = m && invert3(m);
  if (!m || !inv) return null;
  return {
    toCanvas: ([x, y]) => apply(m, x / w, y / h) ?? [NaN, NaN],
    toLocal: (p) => {
      const uv = apply(inv, p[0], p[1]);
      return uv ? [uv[0] * w, uv[1] * h] : null;
    },
  };
}

// --- Handles --------------------------------------------------------------------------------------

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** A handle's place in the element's frame: fractions of its width and height. */
export function handleFraction(id: HandleId): [number, number] {
  const fx = id.includes("w") ? 0 : id.includes("e") ? 1 : 0.5;
  const fy = id.startsWith("n") ? 0 : id.startsWith("s") ? 1 : 0.5;
  return [fx, fy];
}

/** Each handle's place on the canvas. */
export function handlePoints(map: BoxMap, size: readonly [number, number]): { id: HandleId; at: [number, number] }[] {
  return HANDLES.map((id) => {
    const [fx, fy] = handleFraction(id);
    return { id, at: map.toCanvas([fx * size[0], fy * size[1]]) };
  });
}

/** The CSS cursor for a handle on an upright box. */
export const handleCursor = (id: HandleId): string => (id === "n" || id === "s" ? "ns-resize" : id === "e" || id === "w" ? "ew-resize" : id === "nw" || id === "se" ? "nwse-resize" : "nesw-resize");

// --- Lengths --------------------------------------------------------------------------------------

/** A length field's value read: pixels, a percentage, or auto (`auto`, empty or unreadable). */
export type Length = { readonly kind: "px"; readonly value: number } | { readonly kind: "%"; readonly value: number } | { readonly kind: "auto" };

export function parseLength(v: unknown): Length {
  if (typeof v === "number") return Number.isFinite(v) ? { kind: "px", value: v } : { kind: "auto" };
  if (typeof v !== "string") return { kind: "auto" };
  const s = v.trim();
  const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  if (pct) return { kind: "%", value: Number(pct[1]) };
  const px = s.replace(/px$/, "");
  const n = Number(px);
  return px !== "" && s !== "auto" && Number.isFinite(n) ? { kind: "px", value: n } : { kind: "auto" };
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
};
/** Pixels as an attribute value (`120`, `12.5` without snapping). */
export const pxText = (v: number, snap: boolean): string => String(snap ? round(v, 0) : round(v, 2));
/** A percentage as an attribute value (`37.5%`). */
export const pctText = (v: number): string => `${round(v, 2)}%`;

// --- Resizing -------------------------------------------------------------------------------------

/** What a resize needs to know about the element when the drag starts. */
export interface ResizeStart {
  /** Its box's size in UI pixels. */
  readonly width: number;
  readonly height: number;
  /** The field values now (`120`, `"50%"`, `"auto"`). */
  readonly widthValue: unknown;
  readonly heightValue: unknown;
  readonly absolute: boolean;
  readonly left: unknown;
  readonly top: unknown;
  /** The parent's padding box in UI pixels (for percentages when the box is 0, and percent offsets). */
  readonly parentWidth: number;
  readonly parentHeight: number;
}

export interface DragOptions {
  /** Shift: keep the starting aspect ratio. */
  readonly keepAspect?: boolean;
  /** Round to whole UI pixels (default true). */
  readonly snap?: boolean;
}

/** A size or offset written in the unit the field uses now. */
function lengthText(was: Length, px: number, startPx: number, parentPx: number, snap: boolean): string {
  if (was.kind === "%") {
    if (startPx > 0) return pctText((was.value * px) / startPx);
    return pctText(parentPx > 0 ? (px / parentPx) * 100 : 0);
  }
  return pxText(px, snap);
}

/** An offset (left, top) moved by `delta` UI pixels, in the unit it uses now. */
function offsetText(was: Length, delta: number, parentPx: number, snap: boolean): string {
  if (was.kind === "%") return pctText(parentPx > 0 ? was.value + (delta / parentPx) * 100 : was.value);
  return pxText((was.kind === "px" ? was.value : 0) + delta, snap);
}

/**
 * The attributes dragging handle `id` by `(dx, dy)` UI pixels (in the element's frame, from where the
 * drag started) writes: `width` and/or `height`, and `left`/`top` when the west or north edge of an
 * element placed by them moves. See the decisions at the top of this file.
 */
export function resizeAttributes(start: ResizeStart, id: HandleId, dx: number, dy: number, options: DragOptions = {}): Record<string, string> {
  const snap = options.snap ?? true;
  const sx = id.includes("e") ? 1 : id.includes("w") ? -1 : 0;
  const sy = id.startsWith("s") ? 1 : id.startsWith("n") ? -1 : 0;
  const w0 = start.width, h0 = start.height;
  let w = Math.max(0, w0 + sx * dx), h = Math.max(0, h0 + sy * dy);
  let setW = sx !== 0, setH = sy !== 0;
  if (options.keepAspect && w0 > 0 && h0 > 0) {
    const ratio = w0 / h0;
    if (sx !== 0 && sy !== 0) {
      if (Math.abs(w / w0 - 1) >= Math.abs(h / h0 - 1)) h = w / ratio;
      else w = h * ratio;
    } else if (sx !== 0) h = w / ratio;
    else w = h * ratio;
    setW = setH = true;
  }
  if (snap) {
    w = Math.round(w);
    h = Math.round(h);
  }
  const out: Record<string, string> = {};
  if (setW) out.width = lengthText(parseLength(start.widthValue), w, w0, start.parentWidth, snap);
  if (setH) out.height = lengthText(parseLength(start.heightValue), h, h0, start.parentHeight, snap);
  if (start.absolute) {
    const left = parseLength(start.left), top = parseLength(start.top);
    if (sx < 0 && left.kind !== "auto") out.left = offsetText(left, w0 - w, start.parentWidth, snap);
    if (sy < 0 && top.kind !== "auto") out.top = offsetText(top, h0 - h, start.parentHeight, snap);
  }
  return out;
}

// --- Moving ---------------------------------------------------------------------------------------

/** What moving an absolutely positioned element needs to know when the drag starts. */
export interface MoveStart {
  readonly left: unknown;
  readonly top: unknown;
  readonly right: unknown;
  readonly bottom: unknown;
  /** Where its box is now, from the parent's padding box's top-left, in UI pixels. */
  readonly x: number;
  readonly y: number;
  readonly parentWidth: number;
  readonly parentHeight: number;
}

/** The offsets moving an absolutely positioned element by `(dx, dy)` UI pixels writes. */
export function moveAttributes(start: MoveStart, dx: number, dy: number, options: DragOptions = {}): Record<string, string> {
  const snap = options.snap ?? true;
  const out: Record<string, string> = {};
  const axis = (near: "left" | "top", far: "right" | "bottom", delta: number, at: number, parentPx: number) => {
    const n = parseLength(start[near]), f = parseLength(start[far]);
    if (n.kind !== "auto") out[near] = offsetText(n, delta, parentPx, snap);
    else if (f.kind !== "auto") out[far] = offsetText(f, -delta, parentPx, snap);
    else out[near] = pxText(at + delta, snap);
  };
  if (dx !== 0) axis("left", "right", dx, start.x, start.parentWidth);
  if (dy !== 0) axis("top", "bottom", dy, start.y, start.parentHeight);
  return out;
}

// --- Reordering in flex flow ----------------------------------------------------------------------

/** A sibling in flow, along the parent's main axis (UI pixels in the parent's frame). */
export interface FlowSibling {
  /** Its index among the parent's markup children. */
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/** Where a reorder drops: the markup index to move to (as `moveUIElement` takes it) and where the marker goes along the main axis. */
export interface ReorderTarget {
  readonly index: number;
  readonly marker: number;
  /** True when it would land where it is. */
  readonly same: boolean;
}

/**
 * Where dropping at `pointer` (along the parent's main axis) puts the dragged element, at markup
 * index `self` among its parent's children: before the first sibling in visual order whose middle is
 * past the pointer, else after the last. `siblings` excludes the dragged element; `reverse` for
 * `row-reverse`/`column-reverse`, where visual order runs against markup order. Null without siblings.
 */
export function reorderTarget(siblings: readonly FlowSibling[], pointer: number, self: number, reverse: boolean): ReorderTarget | null {
  if (siblings.length === 0) return null;
  const visual = [...siblings].sort((a, b) => a.start - b.start);
  const k = visual.findIndex((s) => (s.start + s.end) / 2 > pointer);
  let index: number, marker: number;
  if (k >= 0) {
    const t = visual[k], prev = visual[k - 1];
    index = reverse ? t.index + 1 : t.index;
    marker = prev ? (prev.end + t.start) / 2 : t.start;
  } else {
    const last = visual[visual.length - 1];
    index = reverse ? last.index : last.index + 1;
    marker = last.end;
  }
  return { index, marker, same: index === self || index === self + 1 };
}

/** True for a main axis along y. */
export const isColumn = (flexDirection: string): boolean => flexDirection.startsWith("column");
/** True for a reversed main axis. */
export const isReverse = (flexDirection: string): boolean => flexDirection.endsWith("reverse");
