/**
 * Form elements' parts (ADR 0424): what a checkbox, radio, slider, select, option, progress bar or meter draws over its
 * own box, worked out from its fields and size so every drawing layer draws the same thing from plain rectangles
 * (`UIPart`, in `uiCoreTypes.ts`). The box itself is the element's, styled by the cascade as a panel; the parts take
 * `accentColor` (CSS's `accent-color`), as browsers draw their controls' checked fill, mark, slider fill and bar.
 * Renderer-neutral; not public API.
 */
import type { Color } from "../core/math";
import { UI_DEFAULT_ACCENT, UIMeter, UIOption, UIProgress, UIRadio, UISelect, UISlider, UIToggle, type UIComponentType } from "./components";
import { sliderFraction } from "./formControls";
import type { UIPart } from "./uiCoreTypes";

type RGBA = readonly [number, number, number, number];

const TRACK: RGBA = [0.4, 0.42, 0.48, 1];
const GOOD: RGBA = [0.26, 0.72, 0.37, 1];
const FAIR: RGBA = [0.93, 0.75, 0.2, 1];
const POOR: RGBA = [0.89, 0.3, 0.27, 1];
/** How long an indeterminate progress bar's segment takes to cross it, in seconds. */
const SWEEP_SECONDS = 1.4;

const rgba = (c: Color): RGBA => [c.r, c.g, c.b, c.a];

/** White on a dark accent, black on a light one (a check mark's colour). */
function contrast(c: RGBA): RGBA {
  const luminance = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return luminance > 0.6 ? [0, 0, 0, 1] : [1, 1, 1, 1];
}

function rect(x: number, y: number, width: number, height: number, color: RGBA, radius = 0): UIPart {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height), color, radius, rotate: 0 };
}

/** A stroke from (x1, y1) to (x2, y2), `t` thick, with round ends: a thin rectangle turned about its centre. */
function stroke(x1: number, y1: number, x2: number, y2: number, t: number, color: RGBA): UIPart {
  const length = Math.hypot(x2 - x1, y2 - y1) + t * 0.5;
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  return { x: cx - length / 2, y: cy - t / 2, width: length, height: t, color, radius: t / 2, rotate: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI };
}

/** The meter's colour for its value, by HTML's regions (optimum, suboptimal, even less good). */
function meterColor(m: UIMeter): RGBA {
  const min = m.min, max = Math.max(m.max, m.min);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const low = clamp(m.low ?? min, min, max);
  const high = clamp(m.high ?? max, low, max);
  const optimum = clamp(m.optimum ?? (min + max) / 2, min, max);
  const v = clamp(m.value, min, max);
  if (optimum < low) return v < low ? GOOD : v <= high ? FAIR : POOR;
  if (optimum > high) return v > high ? GOOD : v >= low ? FAIR : POOR;
  return v >= low && v <= high ? GOOD : FAIR;
}

/**
 * The parts `c` draws over its `width` x `height` box (UI pixels), or null when it draws none. `time` (seconds) moves an
 * indeterminate progress bar's segment.
 */
export function formPartsOf(c: UIComponentType, width: number, height: number, time: number): UIPart[] | null {
  const parts = partsOf(c, width, height, time);
  if (!parts?.length) return null;
  // A control that isn't interactable (HTML's disabled) draws its parts faded.
  if ("interactable" in c && c.interactable === false) return parts.map((p) => ({ ...p, color: [p.color[0], p.color[1], p.color[2], p.color[3] * 0.45] as RGBA }));
  return parts;
}

function partsOf(c: UIComponentType, w: number, h: number, time: number): UIPart[] | null {
  const accent = (c: { accentColor: Color | null }) => rgba(c.accentColor ?? UI_DEFAULT_ACCENT);
  const side = Math.min(w, h);
  if (c instanceof UIToggle) {
    if (!c.checked && !c.indeterminate) return null;
    const a = accent(c);
    const mark = contrast(a);
    const t = Math.max(1.5, side * 0.13);
    const fill = rect(0, 0, w, h, a, Math.min(c.borderRadius, side / 2));
    if (c.indeterminate) return [fill, rect(w * 0.25, h / 2 - t / 2, w * 0.5, t, mark, t / 2)];
    return [fill, stroke(w * 0.24, h * 0.52, w * 0.43, h * 0.71, t, mark), stroke(w * 0.43, h * 0.71, w * 0.77, h * 0.31, t, mark)];
  }
  if (c instanceof UIRadio) {
    if (!c.checked) return null;
    const a = accent(c);
    const dot = side * 0.42;
    return [rect((w - side) / 2, (h - side) / 2, side, side, a, side / 2), rect((w - dot) / 2, (h - dot) / 2, dot, dot, contrast(a), dot / 2)];
  }
  if (c instanceof UISlider) {
    const a = accent(c);
    const d = h; // the thumb is as tall as the slider
    const t = Math.max(2, h / 4);
    const room = Math.max(0, w - d);
    const cx = d / 2 + room * sliderFraction(c);
    return [rect(d / 2, h / 2 - t / 2, room, t, TRACK, t / 2), rect(d / 2, h / 2 - t / 2, cx - d / 2, t, a, t / 2), rect(cx - d / 2, 0, d, d, a, d / 2)];
  }
  if (c instanceof UIProgress) {
    const a = accent(c);
    const r = Math.min(c.borderRadius, h / 2);
    if (c.value === null || !Number.isFinite(c.value)) {
      // Indeterminate: a segment a third as wide sweeping across, cut to the bar.
      const seg = w * 0.3;
      const at = ((time % SWEEP_SECONDS) / SWEEP_SECONDS) * (w + seg) - seg;
      const x0 = Math.max(0, at), x1 = Math.min(w, at + seg);
      return x1 > x0 ? [rect(x0, 0, x1 - x0, h, a, r)] : null;
    }
    const f = c.max > 0 ? Math.min(1, Math.max(0, c.value / c.max)) : 0;
    return f > 0 ? [rect(0, 0, w * f, h, a, r)] : null;
  }
  if (c instanceof UIMeter) {
    const range = c.max - c.min;
    const f = range > 0 ? Math.min(1, Math.max(0, (c.value - c.min) / range)) : 0;
    return f > 0 ? [rect(0, 0, w * f, h, meterColor(c), Math.min(c.borderRadius, h / 2))] : null;
  }
  if (c instanceof UISelect) {
    const color = rgba(c.color);
    const cx = w - 14, cy = h / 2;
    const s = Math.min(4, h / 5);
    return [stroke(cx - s, cy - s / 2, cx, cy + s / 2, 1.5, color), stroke(cx, cy + s / 2, cx + s, cy - s / 2, 1.5, color)];
  }
  if (c instanceof UIOption) {
    if (!c.selected) return null;
    const a = rgba(UI_DEFAULT_ACCENT);
    return [rect(0, 0, w, h, [a[0], a[1], a[2], 0.35])];
  }
  return null;
}

/** A short key for a list of parts, to tell when they changed. */
export function partsKey(parts: readonly UIPart[] | null): string {
  if (!parts) return "";
  return parts.map((p) => `${p.x},${p.y},${p.width},${p.height},${p.color.join(",")},${p.radius},${p.rotate}`).join("|");
}
