/**
 * CSS filters on UI elements (ADR 0426): the filter fields every element has, as the steps that draw them. Pure and
 * renderer-neutral; not public API.
 *
 * Each filter function is a field, so transitions and keyframes animate them (ADR 0418 wave 4). They apply in one fixed
 * order, the order 0426 lists them: `blur`, `brightness`, `contrast`, `grayscale`, `hue-rotate`, `invert`, `opacity`,
 * `saturate`, `sepia`, then `drop-shadow`. A function at its initial value (blur 0, brightness 1…) is left out. As in
 * CSS, an element's filter applies to it and its descendants: the UI core composes an element's own steps with its
 * ancestors' (its own first, then its parent's), with lengths in canvas UI pixels through each filtering element's
 * transform, and the drawing layer draws that chain.
 */
import { Color } from "../core/math";

/** The filter fields (every `UIElement` has them). */
export interface UIFilterFields {
  /** Gaussian blur, its standard deviation in UI pixels. */
  readonly filterBlur: number;
  readonly filterBrightness: number;
  readonly filterContrast: number;
  readonly filterGrayscale: number;
  /** Degrees. */
  readonly filterHueRotate: number;
  readonly filterInvert: number;
  readonly filterOpacity: number;
  readonly filterSaturate: number;
  readonly filterSepia: number;
  /** Null: no drop shadow. */
  readonly filterDropShadowColor: Color | null;
  readonly filterDropShadowOffsetX: number;
  readonly filterDropShadowOffsetY: number;
  readonly filterDropShadowBlur: number;
}

/** A filter function with a factor. */
export type UIFilterAmountKind = "brightness" | "contrast" | "grayscale" | "invert" | "opacity" | "saturate" | "sepia";

/** One step of a filter chain. Lengths are in the units of whoever holds it (UI pixels from the core; texture pixels in drawing). */
export type UIFilterStep =
  | { readonly kind: "blur"; readonly radius: number }
  | { readonly kind: UIFilterAmountKind; readonly amount: number }
  | { readonly kind: "hue-rotate"; readonly degrees: number }
  | { readonly kind: "drop-shadow"; readonly x: number; readonly y: number; readonly blur: number; readonly color: Color };

/** Each filter field's initial value (no effect). */
export const FILTER_DEFAULTS: Readonly<Record<keyof UIFilterFields, number | null>> = {
  filterBlur: 0,
  filterBrightness: 1,
  filterContrast: 1,
  filterGrayscale: 0,
  filterHueRotate: 0,
  filterInvert: 0,
  filterOpacity: 1,
  filterSaturate: 1,
  filterSepia: 0,
  filterDropShadowColor: null,
  filterDropShadowOffsetX: 0,
  filterDropShadowOffsetY: 0,
  filterDropShadowBlur: 0,
};

const AMOUNTS: readonly [UIFilterAmountKind, keyof UIFilterFields, number][] = [
  ["brightness", "filterBrightness", 1],
  ["contrast", "filterContrast", 1],
  ["grayscale", "filterGrayscale", 0],
];
const AMOUNTS_AFTER_HUE: readonly [UIFilterAmountKind, keyof UIFilterFields, number][] = [
  ["invert", "filterInvert", 0],
  ["opacity", "filterOpacity", 1],
  ["saturate", "filterSaturate", 1],
  ["sepia", "filterSepia", 0],
];

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** An element's own filter as steps, in the fixed order, leaving out functions at their initial values. Empty: none. */
export function filterStepsOf(f: Partial<UIFilterFields>): UIFilterStep[] {
  const out: UIFilterStep[] = [];
  const blur = Math.max(0, num(f.filterBlur, 0));
  if (blur > 0) out.push({ kind: "blur", radius: blur });
  const amount = (list: typeof AMOUNTS) => {
    for (const [kind, field, initial] of list) {
      const v = Math.max(0, num(f[field], initial));
      if (v !== initial) out.push({ kind, amount: v });
    }
  };
  amount(AMOUNTS);
  const hue = num(f.filterHueRotate, 0);
  if (hue % 360 !== 0) out.push({ kind: "hue-rotate", degrees: hue });
  amount(AMOUNTS_AFTER_HUE);
  const color = f.filterDropShadowColor;
  if (color instanceof Color) out.push({ kind: "drop-shadow", x: num(f.filterDropShadowOffsetX, 0), y: num(f.filterDropShadowOffsetY, 0), blur: Math.max(0, num(f.filterDropShadowBlur, 0)), color });
  return out;
}

/**
 * Steps with their lengths taken through a transform's linear part `[a, b, c, d]` (null: none) and multiplied by `k`, as
 * shadows are (ADR 0418 wave 3): a drop shadow's offset turns and scales with the element, and blurs scale by the
 * square root of its area factor.
 */
export function transformFilterSteps(steps: readonly UIFilterStep[], linear: readonly number[] | null, k = 1): UIFilterStep[] {
  const [a, b, c, d] = linear ?? [1, 0, 0, 1];
  const s = Math.sqrt(Math.abs(a * d - b * c)) * k;
  return steps.map((step) => {
    if (step.kind === "blur") return { kind: "blur", radius: step.radius * s };
    if (step.kind === "drop-shadow") return { kind: "drop-shadow", x: (a * step.x + c * step.y) * k, y: (b * step.x + d * step.y) * k, blur: step.blur * s, color: step.color };
    return step;
  });
}

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;
const rgba = (c: Color) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${Math.round(c.a * 1000) / 1000})`;

/** Steps as CSS `filter` text (what `CanvasRenderingContext2D.filter` takes); "none" when empty. */
export function filterText(steps: readonly UIFilterStep[]): string {
  if (!steps.length) return "none";
  return steps
    .map((s) => {
      switch (s.kind) {
        case "blur":
          return `blur(${px(s.radius)})`;
        case "hue-rotate":
          return `hue-rotate(${Math.round(s.degrees * 1000) / 1000}deg)`;
        case "drop-shadow":
          return `drop-shadow(${px(s.x)} ${px(s.y)} ${px(s.blur)} ${rgba(s.color)})`;
        default:
          return `${s.kind}(${Math.round(s.amount * 1e4) / 1e4})`;
      }
    })
    .join(" ");
}

/** How far a chain draws past what it filters (blur and drop shadows), in its length units: what a redraw must cover. */
export function filterReach(steps: readonly UIFilterStep[]): number {
  let reach = 0;
  for (const s of steps) {
    // A Gaussian is visible to about three standard deviations; a drop shadow reaches its offset plus its blur.
    if (s.kind === "blur") reach += 3 * s.radius;
    else if (s.kind === "drop-shadow") reach += Math.max(Math.abs(s.x), Math.abs(s.y)) + 3 * s.blur;
  }
  return Math.ceil(reach);
}
