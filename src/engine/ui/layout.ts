/**
 * Layout helpers for the UI core (ADR 0076; the layout engine itself is `taffy/layoutTree.ts`, ADR 0433): reading length
 * fields, the canvas scale, and text measuring. No renderer is involved, so all of it runs in Node. Nothing here is public API.
 */
import type { UILength } from "./components";
import type { TextMeasureRequest } from "./uiCoreTypes";
import { linearLength } from "./document/cssMath";

/**
 * Canvas CSS pixels per UI pixel for a screen canvas, like Unity's Canvas Scaler in "scale with
 * screen size" mode: the width and height ratios blended in log space by `matchHeight` (0: width).
 */
export function canvasScale(canvasWidth: number, canvasHeight: number, refWidth: number, refHeight: number, matchHeight: number): number {
  if (!(canvasWidth > 0 && canvasHeight > 0 && refWidth > 0 && refHeight > 0)) return 1;
  const m = Math.min(Math.max(matchHeight, 0), 1);
  const lw = Math.log2(canvasWidth / refWidth), lh = Math.log2(canvasHeight / refHeight);
  return 2 ** (lw + (lh - lw) * m);
}

/** A `calc()` mixing a percentage and pixels (ADR 0422 wave 5), as the layout engine resolves it during layout (0433). */
export interface UICalcLength {
  readonly px: number;
  readonly percent: number;
}

/**
 * A length field as the layout engine takes it: pixels, a percentage, a `calc()` mixing % and px (`calc(50% + -12px)`,
 * ADR 0422 wave 5) as `{ px, percent }`, resolved against the property's CSS basis during layout (ADR 0433), `"auto"`,
 * or undefined when empty or unreadable.
 */
export function uiLength(v: UILength | null | undefined): number | `${number}%` | UICalcLength | "auto" | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (s === "auto") return "auto";
  if (/^-?\d+(\.\d+)?%$/.test(s)) return s as `${number}%`;
  const mixed = linearLength(s);
  if (mixed) return { px: mixed.px, percent: mixed.percent };
  const px = s.replace(/px$/, "");
  const n = Number(px);
  return px !== "" && Number.isFinite(n) ? n : undefined;
}

// 0422 wave 1: layout

/** A finite number, else 0. */
function finiteOr0(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** The four sides (top, right, bottom, left) of an edge property: each side's own value, else the all-sides value. */
export function uiEdges(all: number, top: number | null, right: number | null, bottom: number | null, left: number | null): [number, number, number, number] {
  const a = finiteOr0(all);
  const side = (v: number | null) => (v === null || v === undefined ? a : finiteOr0(v));
  return [side(top), side(right), side(bottom), side(left)];
}

/** A panel's border widths (top, right, bottom, left), never negative; zeros for an element without a border. */
export function uiBorderEdges(c: object): [number, number, number, number] {
  const p = c as { borderWidth?: number; borderTopWidth?: number | null; borderRightWidth?: number | null; borderBottomWidth?: number | null; borderLeftWidth?: number | null };
  if (typeof p.borderWidth !== "number") return [0, 0, 0, 0];
  return uiEdges(p.borderWidth, p.borderTopWidth ?? null, p.borderRightWidth ?? null, p.borderBottomWidth ?? null, p.borderLeftWidth ?? null).map((v) => Math.max(0, v)) as [number, number, number, number];
}

/** A min/max length as the layout engine takes it: pixels, a percentage or a `calc()`; `"auto"`, `"none"` and unreadable values are unset. */
export function uiLimit(v: UILength | null | undefined): number | `${number}%` | UICalcLength | undefined {
  const l = uiLength(v);
  return l === "auto" ? undefined : l;
}

/** A rectangle in a canvas's UI pixels. */
export interface UIRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The overlap of two rectangles (zero-sized, at the nearer edge, when they don't overlap); `a` when `b` is null. */
export function intersectRect(a: UIRect, b: UIRect | null): UIRect {
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, bottom - y) };
}

/** True when a point lies in a rectangle (edges included); always for a null rectangle (unclipped). */
export function inRect(x: number, y: number, r: UIRect | null): boolean {
  return !r || (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
}

/**
 * The Node fallback: 0.55 em per character, greedy wrapping to `maxWidth` at spaces (`wrap: "word"`,
 * a longer word overflows) or at any character (`"anywhere"`); `"none"` breaks only at line breaks.
 */
export function estimateText(req: TextMeasureRequest): { width: number; height: number } {
  const charW = 0.55 * req.fontSize;
  const lineH = req.fontSize * req.lineHeight;
  const maxWidth = req.wrap === "none" ? Infinity : req.maxWidth;
  const anywhere = req.wrap === "anywhere";
  const gap = anywhere ? 0 : charW;
  let lines = 0, widest = 0;
  for (const paragraph of req.text.split("\n")) {
    const words = anywhere ? [...paragraph] : paragraph.split(" ");
    let current = 0, any = false;
    for (const word of words) {
      const w = word.length * charW;
      if (!any) {
        current = w;
        any = true;
      } else if (current + gap + w <= maxWidth) current += gap + w;
      else {
        widest = Math.max(widest, current);
        lines++;
        current = w;
      }
    }
    widest = Math.max(widest, current);
    lines++;
  }
  return { width: widest, height: lines * lineH };
}
