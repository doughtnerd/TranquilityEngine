/**
 * How UI field values animate (ADR 0422 wave 4): a pair of values (a transition's ends, or two neighbouring keyframes)
 * as the floats a tween runs from and to, and the floats it outputs back as the field's value. Pure.
 *
 * - Numbers interpolate (`zIndex` rounds). A per-side edge left null takes its all-sides field, a corner left at -1
 *   takes `borderRadius`, so `padding-top: auto` → `12px` animates from the padding the element has.
 * - Lengths interpolate px with px and % with %; a mixed pair (or `auto`/`none`) jumps at the midpoint, as CSS does for
 *   values it can't interpolate. They write back as the fields store them (`"12.5"`, `"40%"`).
 * - Colours interpolate in linear RGB, alpha linearly. A colour that's none (a shadow's, a background's) animates as
 *   the other colour fully transparent.
 * - ADR 0430: the transform matrix (`transformMatrix`) interpolates as CSS interpolates matrices: decomposed into
 *   translation, rotation, shear and scales, each mixed, and recomposed (`transform2d.ts`). It tweens one float, the
 *   progress, and the mix is worked out as it's read back. "" (none) is the identity.
 * - Anything else (choices, booleans, strings, assets) is discrete: it jumps at the midpoint of the eased progress,
 *   except `display` to or from `none` (ADR 0432, as CSS animates it): the value that isn't `none` shows throughout.
 */
import { Color } from "../../core/math";
import { interpolateAffine, matrixText, parseMatrixText } from "../transform2d";

/** What kind of value a field holds, for animating it. */
export type AnimatedKind = "number" | "length" | "color" | "matrix" | "discrete";

/** String fields that hold a `UILength`. */
const LENGTH_FIELDS: ReadonlySet<string> = new Set([
  "width", "height", "top", "right", "bottom", "left", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexBasis",
  "translateX", "translateY", "transformOriginX", "transformOriginY",
]);

/** Number fields whose "not set here" value (null, or -1 for corners) means another field's value. */
const FALLBACK: Readonly<Record<string, { readonly field: string; readonly unset: null | -1 }>> = {
  paddingTop: { field: "padding", unset: null }, paddingRight: { field: "padding", unset: null }, paddingBottom: { field: "padding", unset: null }, paddingLeft: { field: "padding", unset: null },
  marginTop: { field: "margin", unset: null }, marginRight: { field: "margin", unset: null }, marginBottom: { field: "margin", unset: null }, marginLeft: { field: "margin", unset: null },
  borderTopWidth: { field: "borderWidth", unset: null }, borderRightWidth: { field: "borderWidth", unset: null }, borderBottomWidth: { field: "borderWidth", unset: null }, borderLeftWidth: { field: "borderWidth", unset: null },
  borderTopLeftRadius: { field: "borderRadius", unset: -1 }, borderTopRightRadius: { field: "borderRadius", unset: -1 }, borderBottomRightRadius: { field: "borderRadius", unset: -1 }, borderBottomLeftRadius: { field: "borderRadius", unset: -1 },
};

/** The kind of a field, from its name and declared type (`Number`, `String`, `Color`…). */
export function animatedKind(field: string, type: unknown): AnimatedKind {
  if (type === Number) return "number";
  if (type === Color) return "color";
  if (type === String && LENGTH_FIELDS.has(field)) return "length";
  if (type === String && field === "transformMatrix") return "matrix";
  return "discrete";
}

/** A pair of values ready to tween: floats from and to (1 to 4 of them) and how output floats read back. */
export interface AnimatedPair {
  readonly width: number;
  readonly from: readonly number[];
  readonly to: readonly number[];
  /** The field's value for output floats `f[at…at + width)`. */
  decode(f: ArrayLike<number>, at: number): unknown;
  /** Not interpolated: it jumps from `a` to `b` at the midpoint. */
  readonly discrete: boolean;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Lengths write back without float noise. */
const tidy = (n: number) => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
};

/** A matrix field's value as a map (null: none or the identity); undefined when it isn't one. */
function matrixOf(v: unknown): ReturnType<typeof parseMatrixText> | undefined {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "none") return null;
  const n = (/^matrix\(([^()]*)\)$/i.exec(s)?.[1] ?? s).split(/[\s,]+/).filter((p) => p !== "").map(Number);
  return n.length === 6 && n.every(Number.isFinite) ? parseMatrixText(s) : undefined;
}

function discrete(a: unknown, b: unknown, field = ""): AnimatedPair {
  // `display: none` ↔ another value: the other one shows for the whole of it (CSS Display 4), so a fade-out's element
  // stays drawn until its end and a fade-in's from its start.
  if (field === "display" && a !== b && (a === "none" || b === "none")) return { width: 1, from: [0], to: [1], discrete: true, decode: (f, at) => (a === "none" ? b : f[at] >= 1 ? b : a) };
  return { width: 1, from: [0], to: [1], discrete: true, decode: (f, at) => (f[at] >= 0.5 ? b : a) };
}

/** A length's number and unit, or null for `auto`, `none` or anything else. */
function lengthOf(v: unknown): { n: number; pct: boolean } | null {
  if (typeof v !== "string") return null;
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%)?$/i.exec(v.trim());
  return m ? { n: parseFloat(m[1]), pct: m[2] === "%" } : null;
}

/**
 * The tween pair for animating `field` (of `kind`) from `a` to `b`. `others` reads the element's other fields, for a
 * side or corner that takes its all-sides value.
 */
export function animatedPair(field: string, kind: AnimatedKind, a: unknown, b: unknown, others: (field: string) => unknown): AnimatedPair {
  switch (kind) {
    case "number": {
      const fb = FALLBACK[field];
      const num = (v: unknown) => (fb && v === fb.unset ? others(fb.field) : v);
      const x = num(a), y = num(b);
      if (typeof x !== "number" || typeof y !== "number") return discrete(a, b);
      const round = field === "zIndex";
      return { width: 1, from: [x], to: [y], discrete: false, decode: (f, at) => (round ? Math.round(f[at]) : f[at]) };
    }
    case "length": {
      const x = lengthOf(a), y = lengthOf(b);
      if (!x || !y || x.pct !== y.pct) return discrete(a, b);
      const pct = x.pct;
      return { width: 1, from: [x.n], to: [y.n], discrete: false, decode: (f, at) => (pct ? `${tidy(f[at])}%` : String(tidy(f[at]))) };
    }
    case "color": {
      const ca = a instanceof Color ? a : null, cb = b instanceof Color ? b : null;
      if (!ca && !cb) return discrete(a, b);
      const x = ca ?? new Color(cb!.r, cb!.g, cb!.b, 0);
      const y = cb ?? new Color(ca!.r, ca!.g, ca!.b, 0);
      const lin = (c: Color) => [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b), c.a];
      return {
        width: 4,
        from: lin(x),
        to: lin(y),
        discrete: false,
        decode: (f, at) => new Color(clamp01(linearToSrgb(f[at])), clamp01(linearToSrgb(f[at + 1])), clamp01(linearToSrgb(f[at + 2])), clamp01(f[at + 3])),
      };
    }
    case "matrix": {
      const ma = matrixOf(a), mb = matrixOf(b);
      if (ma === undefined || mb === undefined) return discrete(a, b);
      return { width: 1, from: [0], to: [1], discrete: false, decode: (f, at) => (f[at] === 0 ? a : f[at] === 1 ? b : matrixText(interpolateAffine(ma, mb, f[at]))) };
    }
    default:
      return discrete(a, b, field);
  }
}
