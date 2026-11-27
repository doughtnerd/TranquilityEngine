/**
 * Form elements' parts (ADR 0428): what a checkbox, radio, slider, select, option, progress bar or meter draws over its
 * own box, worked out from its fields and size so every drawing layer draws the same thing from plain rectangles
 * (`UIPart`, in `uiCoreTypes.ts`). The box itself is the element's, styled by the cascade as a panel; the parts take
 * `accentColor` (CSS's `accent-color`), as browsers draw their controls' checked fill, mark, slider fill and bar.
 * ADR 0432: part pseudo-elements (`::-webkit-slider-thumb`, `::checkmark`…) style them further: the UI host resolves
 * their rules into a `UIPartStyle` per part (`setUIPartStyles`), which overrides the defaults here.
 * Renderer-neutral; not public API.
 */
import type { Color } from "../core/math";
import type { UIPseudoElement } from "./document/types";
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

/**
 * ADR 0432: what a part pseudo-element's rules declare, in UI pixels: each absent property keeps the part's default.
 * `background` null is transparent; `color` is a check mark's, a radio's dot's or a select arrow's; `width`/`height` size
 * a slider's thumb (and `height` its track's thickness); `opacity` fades the part.
 */
export interface UIPartStyle {
  readonly background?: Color | null;
  readonly color?: Color;
  readonly radius?: number;
  readonly borderWidth?: number;
  readonly borderColor?: Color;
  readonly width?: number;
  readonly height?: number;
  readonly shadow?: { readonly color: Color; readonly x: number; readonly y: number; readonly blur: number } | null;
  readonly opacity?: number;
}

type PartStyles = Partial<Record<UIPseudoElement, UIPartStyle>>;
const partStyles = new WeakMap<UIComponentType, PartStyles>();

/** ADR 0432: set (null: clear) the part styles a control's part pseudo-elements resolved to; the UI host calls it. */
export function setUIPartStyles(c: UIComponentType, styles: PartStyles | null): void {
  if (styles) partStyles.set(c, styles);
  else partStyles.delete(c);
}

/** A part with a style's paint over it: fill, radius, border, shadow and opacity (absent ones keep the part's). */
function styled(part: UIPart, s: UIPartStyle | undefined): UIPart {
  if (!s) return part;
  let color: RGBA = s.background === undefined ? part.color : s.background ? rgba(s.background) : [0, 0, 0, 0];
  const k = s.opacity === undefined ? 1 : Math.min(1, Math.max(0, s.opacity));
  if (k !== 1) color = [color[0], color[1], color[2], color[3] * k];
  const out: { -readonly [K in keyof UIPart]: UIPart[K] } = { ...part, color };
  if (s.radius !== undefined) out.radius = Math.min(s.radius, Math.min(part.width, part.height) / 2);
  if (s.borderWidth !== undefined && s.borderWidth > 0) {
    const bc = s.borderColor ? rgba(s.borderColor) : ([0, 0, 0, 1] as RGBA);
    out.border = { width: s.borderWidth, color: [bc[0], bc[1], bc[2], bc[3] * k] };
  }
  if (s.shadow) out.shadow = { color: rgba(s.shadow.color), x: s.shadow.x, y: s.shadow.y, blur: s.shadow.blur };
  return out;
}

/** A mark's colour from a style's `color` (faded by its `opacity`), else `fallback`. */
function markColor(s: UIPartStyle | undefined, fallback: RGBA): RGBA {
  const c = s?.color ? rgba(s.color) : fallback;
  const k = s?.opacity === undefined ? 1 : Math.min(1, Math.max(0, s.opacity));
  return k === 1 ? c : [c[0], c[1], c[2], c[3] * k];
}

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

/** The meter's region for its value, by HTML's regions: optimum, suboptimal, even less good (its colour and part pseudo-element). */
function meterRegion(m: UIMeter): "-webkit-meter-optimum-value" | "-webkit-meter-suboptimum-value" | "-webkit-meter-even-less-good-value" {
  const c = meterColor(m);
  return c === GOOD ? "-webkit-meter-optimum-value" : c === FAIR ? "-webkit-meter-suboptimum-value" : "-webkit-meter-even-less-good-value";
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
  if ("interactable" in c && c.interactable === false) return parts.map((p) => ({ ...p, color: [p.color[0], p.color[1], p.color[2], p.color[3] * 0.45] as RGBA, ...(p.border ? { border: { width: p.border.width, color: [p.border.color[0], p.border.color[1], p.border.color[2], p.border.color[3] * 0.45] as RGBA } } : {}) }));
  return parts;
}

function partsOf(c: UIComponentType, w: number, h: number, time: number): UIPart[] | null {
  const accent = (c: { accentColor: Color | null }) => rgba(c.accentColor ?? UI_DEFAULT_ACCENT);
  const side = Math.min(w, h);
  const ps = partStyles.get(c);
  if (c instanceof UIToggle) {
    if (!c.checked && !c.indeterminate) return null;
    const a = accent(c);
    const mark = markColor(ps?.checkmark, contrast(a));
    const t = Math.max(1.5, side * 0.13);
    const fill = rect(0, 0, w, h, a, Math.min(c.borderRadius, side / 2));
    if (c.indeterminate) return [fill, rect(w * 0.25, h / 2 - t / 2, w * 0.5, t, mark, t / 2)];
    return [fill, stroke(w * 0.24, h * 0.52, w * 0.43, h * 0.71, t, mark), stroke(w * 0.43, h * 0.71, w * 0.77, h * 0.31, t, mark)];
  }
  if (c instanceof UIRadio) {
    if (!c.checked) return null;
    const a = accent(c);
    const dot = side * 0.42;
    return [rect((w - side) / 2, (h - side) / 2, side, side, a, side / 2), rect((w - dot) / 2, (h - dot) / 2, dot, dot, markColor(ps?.checkmark, contrast(a)), dot / 2)];
  }
  if (c instanceof UISlider) {
    const a = accent(c);
    const thumb = ps?.["-webkit-slider-thumb"], track = ps?.["-webkit-slider-runnable-track"];
    const tw = thumb?.width ?? h, th = thumb?.height ?? h; // the thumb is as tall as the slider
    const t = track?.height ?? Math.max(2, h / 4);
    const room = Math.max(0, w - tw);
    const cx = tw / 2 + room * sliderFraction(c);
    const radius = Math.min(t / 2, track?.radius ?? t / 2);
    return [
      styled(rect(tw / 2, h / 2 - t / 2, room, t, TRACK, t / 2), track),
      rect(tw / 2, h / 2 - t / 2, cx - tw / 2, t, a, radius),
      styled(rect(cx - tw / 2, (h - th) / 2, tw, th, a, Math.min(tw, th) / 2), thumb),
    ];
  }
  if (c instanceof UIProgress) {
    const a = accent(c);
    const r = Math.min(c.borderRadius, h / 2);
    if (c.value === null || !Number.isFinite(c.value)) {
      // Indeterminate: a segment a third as wide sweeping across, cut to the bar.
      const seg = w * 0.3;
      const at = ((time % SWEEP_SECONDS) / SWEEP_SECONDS) * (w + seg) - seg;
      const x0 = Math.max(0, at), x1 = Math.min(w, at + seg);
      const bar = ps?.["-webkit-progress-bar"] ? [styled(rect(0, 0, w, h, [0, 0, 0, 0], r), ps["-webkit-progress-bar"])] : [];
      return x1 > x0 ? [...bar, styled(rect(x0, 0, x1 - x0, h, a, r), ps?.["-webkit-progress-value"])] : bar.length ? bar : null;
    }
    const f = c.max > 0 ? Math.min(1, Math.max(0, c.value / c.max)) : 0;
    const bar = ps?.["-webkit-progress-bar"] ? [styled(rect(0, 0, w, h, [0, 0, 0, 0], r), ps["-webkit-progress-bar"])] : [];
    const value = f > 0 ? [styled(rect(0, 0, w * f, h, a, r), ps?.["-webkit-progress-value"])] : [];
    return bar.length + value.length ? [...bar, ...value] : null;
  }
  if (c instanceof UIMeter) {
    const range = c.max - c.min;
    const f = range > 0 ? Math.min(1, Math.max(0, (c.value - c.min) / range)) : 0;
    return f > 0 ? [styled(rect(0, 0, w * f, h, meterColor(c), Math.min(c.borderRadius, h / 2)), ps?.[meterRegion(c)])] : null;
  }
  if (c instanceof UISelect) {
    const color = markColor(ps?.["picker-icon"], rgba(c.color));
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
  return parts.map((p) => `${p.x},${p.y},${p.width},${p.height},${p.color.join(",")},${p.radius},${p.rotate}${p.border ? `,b${p.border.width},${p.border.color.join(",")}` : ""}${p.shadow ? `,s${p.shadow.x},${p.shadow.y},${p.shadow.blur},${p.shadow.color.join(",")}` : ""}`).join("|");
}
