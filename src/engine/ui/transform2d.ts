/**
 * UI transforms (ADR 0418 wave 3): the one place an element's 2D affine transform is worked out. The UI core composes
 * each element's with its ancestors' (a transform applies to the element and its descendants, as in CSS) after layout,
 * and everything that has to agree with what's drawn reads the result: drawing (Babylon GUI), hit-testing, editor
 * picking, the outline and handles, and navigation. Layout ignores transforms (siblings don't move).
 *
 * Coordinates are a canvas's UI pixels, y down. An element's transform maps a point of its laid-out box (where layout
 * put it) to where it's drawn. Its own part is, as CSS composes the individual `translate`, `rotate` and `scale`
 * properties with `transform`: move to the origin, translate, rotate (clockwise, degrees), scale, apply the full matrix
 * (ADR 0426: a `transform` list that doesn't fold into the three, such as one with `skew()` or `matrix()`), move back:
 * `T(origin) · T(translate) · R(rotate) · S(scaleX, scaleY) · M · T(−origin)`. Its whole transform is its parent's times its own.
 *
 * Pure and renderer-neutral: numbers in, numbers out. Not public API.
 */
import type { UIRect } from "./layout";

/**
 * A 2D affine map `[a, b, c, d, e, f]`, as Canvas2D's `setTransform` takes it: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 */
export type UIAffine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** The identity map. */
export const IDENTITY: UIAffine = [1, 0, 0, 1, 0, 0];

/** A length as the transform fields hold it: pixels (`12`, `"12"`, `"12px"`) or a percentage of the element's own box (`"50%"`). */
export type UITransformLength = number | string;

/** An element's transform fields (every `UIElement` has them). */
export interface UITransformFields {
  readonly translateX: UITransformLength;
  readonly translateY: UITransformLength;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Degrees, clockwise. */
  readonly rotate: number;
  readonly transformOriginX: UITransformLength;
  readonly transformOriginY: UITransformLength;
  /**
   * ADR 0426: the full 2D matrix applied after translate, rotate and scale, as `matrix(a, b, c, d, e, f)` text (lengths
   * in px); "" (or absent) for none.
   */
  readonly transformMatrix?: string;
}

/** `m · n`: apply `n`, then `m`. */
export function multiply(m: UIAffine, n: UIAffine): UIAffine {
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = n;
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}

/** The inverse map, or null when it has none (a scale of 0 flattens the element). */
export function invert(m: UIAffine): UIAffine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [d * k, -b * k, -c * k, a * k, (c * f - d * e) * k, (b * e - a * f) * k];
}

/** Where `m` takes the point (x, y). */
export function applyAffine(m: UIAffine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** True when `m` is the identity (within rounding). */
export function isIdentity(m: UIAffine | null): boolean {
  if (!m) return true;
  const eps = 1e-9;
  return Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps && Math.abs(m[4]) < eps && Math.abs(m[5]) < eps;
}

/** A length in pixels: a percentage of `size`, or pixels; 0 when unreadable. */
export function resolveTransformLength(v: UITransformLength | null | undefined, size: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const s = v.trim();
  const pct = /^(-?(?:\d+\.?\d*|\.\d+))%$/.exec(s);
  if (pct) return (parseFloat(pct[1]) / 100) * size;
  const n = Number(s.replace(/px$/, ""));
  return s !== "" && Number.isFinite(n) ? n : 0;
}

const finiteOr = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * ADR 0426: a matrix field's value as a map: `matrix(a, b, c, d, e, f)` (commas or spaces), or six bare numbers. Null for
 * "", `none`, the identity, or text that isn't one.
 */
export function parseMatrixText(text: string | null | undefined): UIAffine | null {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (s === "" || s.toLowerCase() === "none") return null;
  const inner = /^matrix\(([^()]*)\)$/i.exec(s)?.[1] ?? s;
  const parts = inner.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length !== 6) return null;
  const n = parts.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const m = n as unknown as UIAffine;
  return isIdentity(m) ? null : m;
}

/** A map as the matrix field stores it: `matrix(a, b, c, d, e, f)`, rounded past float noise; "" for the identity. */
export function matrixText(m: UIAffine | null): string {
  if (!m || isIdentity(m)) return "";
  const r = (v: number) => {
    const x = Math.round(v * 1e6) / 1e6;
    return Object.is(x, -0) ? 0 : x;
  };
  return `matrix(${m.map(r).join(", ")})`;
}

/** True when the fields move, turn, scale or skew the element (its own part isn't the identity). */
export function hasTransform(f: UITransformFields): boolean {
  return resolveTransformLength(f.translateX, 1) !== 0 || resolveTransformLength(f.translateY, 1) !== 0 || finiteOr(f.scaleX, 1) !== 1 || finiteOr(f.scaleY, 1) !== 1 || finiteOr(f.rotate, 0) % 360 !== 0 || parseMatrixText(f.transformMatrix) !== null;
}

/**
 * An element's own transform for its laid-out border box `box` (a canvas's UI pixels): translate, rotate and scale
 * about its origin, with percentages of the box's own size. Null when it's the identity.
 */
export function localTransform(f: UITransformFields, box: UIRect): UIAffine | null {
  if (!hasTransform(f)) return null;
  const tx = resolveTransformLength(f.translateX, box.width), ty = resolveTransformLength(f.translateY, box.height);
  const ox = box.x + resolveTransformLength(f.transformOriginX ?? "50%", box.width);
  const oy = box.y + resolveTransformLength(f.transformOriginY ?? "50%", box.height);
  const sx = finiteOr(f.scaleX, 1), sy = finiteOr(f.scaleY, 1);
  const rad = (finiteOr(f.rotate, 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // R·S, then the translation that keeps the origin fixed and adds `translate`.
  let a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy, e = 0, g = 0;
  // ADR 0426: R·S·M.
  const m = parseMatrixText(f.transformMatrix);
  if (m) [a, b, c, d, e, g] = multiply([a, b, c, d, 0, 0], m);
  return [a, b, c, d, ox + tx + e - (a * ox + c * oy), oy + ty + g - (b * ox + d * oy)];
}

/** A child's whole transform from its parent's (null: identity) and its own (null: identity). Null when the result is the identity. */
export function compose(parent: UIAffine | null, own: UIAffine | null): UIAffine | null {
  if (!own) return parent;
  if (!parent) return own;
  const m = multiply(parent, own);
  return isIdentity(m) ? null : m;
}

/** A rectangle's corners through `m` (null: identity): top-left, top-right, bottom-right, bottom-left. */
export function transformRect(m: UIAffine | null, r: UIRect): [number, number][] {
  const pts: [number, number][] = [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x + r.width, r.y + r.height],
    [r.x, r.y + r.height],
  ];
  return m ? pts.map(([x, y]) => applyAffine(m, x, y)) : pts;
}

/** The smallest axis-aligned rectangle holding the points. */
export function boundsOf(points: readonly (readonly [number, number])[]): UIRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return points.length ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * The rotation (radians, clockwise) and scales of `m`'s linear part as `R(rotation) · S(scaleX, scaleY)`, and the
 * skew left over (0 for any map built from translate, rotate and scale alone; a rotation inside an unequal scale
 * leaves some, which `R · S` can't express).
 */
export function decompose(m: UIAffine): { rotation: number; scaleX: number; scaleY: number; skew: number } {
  const [a, b, c, d] = m;
  const scaleX = Math.hypot(a, b);
  if (scaleX < 1e-12) return { rotation: 0, scaleX: 0, scaleY: Math.hypot(c, d), skew: 0 };
  const rotation = Math.atan2(b, a);
  const scaleY = (a * d - b * c) / scaleX;
  // The second column against the first's perpendicular: 0 when they're at right angles.
  const skew = (a * c + b * d) / (scaleX * scaleX);
  return { rotation, scaleX, scaleY, skew };
}

/**
 * ADR 0426: a map decomposed as CSS Transforms 1 decomposes a 2D matrix for interpolation ("unmatrix"): a translation,
 * scales, a rotation (degrees) and a shear, recomposed as `T(translate) · R(rotate) · Shear(skew) · S(scale)`. A
 * reflection shows as a negative scale. Null for a map that flattens (no inverse).
 */
export interface UIDecomposed {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Degrees, clockwise. */
  readonly rotate: number;
  /** The shear factor (the tangent of the skew angle along x). */
  readonly skew: number;
}

/** `m` decomposed per CSS (see `UIDecomposed`); null when it has no inverse. */
export function decomposeCss(m: UIAffine): UIDecomposed | null {
  let [a, b, c, d] = m;
  if (Math.abs(a * d - b * c) < 1e-12) return null;
  let scaleX = Math.hypot(a, b);
  a /= scaleX;
  b /= scaleX;
  let skew = a * c + b * d;
  c -= a * skew;
  d -= b * skew;
  let scaleY = Math.hypot(c, d);
  c /= scaleY;
  d /= scaleY;
  skew /= scaleY;
  // A reflection: flip one axis (CSS flips x).
  if (a * d < b * c) {
    a = -a;
    b = -b;
    skew = -skew;
    scaleX = -scaleX;
  }
  return { translateX: m[4], translateY: m[5], scaleX, scaleY, rotate: (Math.atan2(b, a) * 180) / Math.PI, skew };
}

/** A decomposition put back together: `T · R · Shear · S`. */
export function recompose(p: UIDecomposed): UIAffine {
  const r = (p.rotate * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const rot: UIAffine = [cos, sin, -sin, cos, p.translateX, p.translateY];
  return multiply(multiply(rot, [1, 0, p.skew, 1, 0, 0]), [p.scaleX, 0, 0, p.scaleY, 0, 0]);
}

/**
 * ADR 0426: the map `t` of the way from `from` to `to` (null: identity), interpolated as CSS interpolates matrices:
 * decomposed, each part interpolated (the rotation the short way round, a reflection on one side flipping the other
 * side's axes as CSS does), and recomposed. A map without an inverse jumps at the midpoint.
 */
export function interpolateAffine(from: UIAffine | null, to: UIAffine | null, t: number): UIAffine {
  const A = from ?? IDENTITY, B = to ?? IDENTITY;
  const da = decomposeCss(A), db = decomposeCss(B);
  if (!da || !db) return t < 0.5 ? A : B;
  let a = { ...da }, b = { ...db };
  // CSS: one side reflected along x and the other along y → turn the reflection into a half turn.
  if ((a.scaleX < 0 && b.scaleY < 0) || (a.scaleY < 0 && b.scaleX < 0)) {
    a = { ...a, scaleX: -a.scaleX, scaleY: -a.scaleY, rotate: a.rotate + (a.rotate < 0 ? 180 : -180) };
  }
  // Not the long way round.
  let ra = a.rotate === 0 ? 360 : a.rotate, rb = b.rotate === 0 ? 360 : b.rotate;
  if (Math.abs(ra - rb) > 180) {
    if (ra > rb) ra -= 360;
    else rb -= 360;
  }
  const mix = (x: number, y: number) => x + (y - x) * t;
  return recompose({
    translateX: mix(a.translateX, b.translateX),
    translateY: mix(a.translateY, b.translateY),
    scaleX: mix(a.scaleX, b.scaleX),
    scaleY: mix(a.scaleY, b.scaleY),
    rotate: mix(ra, rb),
    skew: mix(a.skew, b.skew),
  });
}
