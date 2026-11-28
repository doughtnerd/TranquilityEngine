/**
 * The engine's colour gradient (ADR 0396), shared by particles (`ParticleGradient` is this type) and line and
 * trail renderers: colour keys and alpha keys, each at `t` from 0 to 1, the same JSON particle files hold:
 *
 * ```jsonc
 * { "colors": [[0, "#ffffff"], [1, "#ff8000"]], "alphas": [[0, 1], [1, 0]] }
 * ```
 *
 * - Colours are hex text (sRGB, `#rrggbb` or the short form; any alpha digits are ignored, ADR 0461) and blend linearly in sRGB between keys, as particles always have; alphas are 0..1.
 * - Before the first key a channel holds the first key's value, after the last the last's (as `Curve` does).
 * - No colour keys read as white; no alpha keys as opaque.
 */
import { parseHex } from "./colorSpace";
import { evalCurve, type CurveKey } from "./curve";

/** A gradient: colour keys (`#rrggbb`) and alpha keys, each at `t` from 0 to 1. */
export interface Gradient {
  colors: [number, string][];
  alphas: [number, number][];
}

const parsed = new Map<string, readonly [number, number, number]>();

/** A hex colour as 0–1 sRGB components (its alpha ignored: alpha keys hold opacity); anything else reads as white. */
function rgbOf(hex: string): readonly [number, number, number] {
  let c = parsed.get(hex);
  if (c) return c;
  const p = parseHex(hex);
  c = p ? [p[0], p[1], p[2]] : [1, 1, 1];
  if (parsed.size > 4096) parsed.clear();
  parsed.set(hex, c);
  return c;
}

/** The value of sorted `[t, v]` keys at `t` (linear between keys, held outside them). */
function channel<T>(keys: readonly (readonly [number, T])[], t: number, value: (k: T) => number, fallback: number): number {
  const n = keys.length;
  if (n === 0) return fallback;
  if (t <= keys[0]![0]) return value(keys[0]![1]);
  if (t >= keys[n - 1]![0]) return value(keys[n - 1]![1]);
  let i = 1;
  while (i < n - 1 && keys[i]![0] < t) i++;
  const [t0, a] = keys[i - 1]!;
  const [t1, b] = keys[i]!;
  const span = t1 - t0;
  const f = span > 0 ? (t - t0) / span : 1;
  const va = value(a);
  return va + (value(b) - va) * f;
}

/**
 * The gradient's colour and alpha at `t` as 0–1 sRGB components and alpha, written into `out` (a new array when
 * none is given). Allocation-free with `out`, for code that evaluates it per vertex.
 */
export function evaluateGradient(g: Gradient, t: number, out: number[] | Float32Array = [0, 0, 0, 0]): number[] | Float32Array {
  out[0] = channel(g.colors, t, (h) => rgbOf(h)[0], 1);
  out[1] = channel(g.colors, t, (h) => rgbOf(h)[1], 1);
  out[2] = channel(g.colors, t, (h) => rgbOf(h)[2], 1);
  out[3] = g.alphas.length ? evalCurve(g.alphas as unknown as CurveKey[], t) : 1;
  return out;
}

/** Whether `v` has a gradient's shape (colour and alpha key lists). */
export function isGradient(v: unknown): v is Gradient {
  if (!v || typeof v !== "object") return false;
  const g = v as Partial<Gradient>;
  return Array.isArray(g.colors) && Array.isArray(g.alphas);
}

/** A white, opaque gradient. */
export const whiteGradient = (): Gradient => ({ colors: [[0, "#ffffff"]], alphas: [[0, 1]] });
