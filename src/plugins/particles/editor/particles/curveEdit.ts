/**
 * Pure helpers behind the particle curve and gradient editors (ADR 0057): key lists stay sorted by
 * `t` (0 to 1), and values convert between a number's or colour's kinds without losing what they
 * show. No DOM here, so they're tested headless.
 */
import { colorKind, evalCurve, evalGradient, hexColor, numberKind, parseHexColor, type CurveKey, type ParticleColor, type ParticleColorKind, type ParticleGradient, type ParticleNumber, type ParticleNumberKind } from "../../../../engine/scene/particles";

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** A key list entry: `[t, value]`, for curve keys (value a number), colour keys (a hex) or alpha keys. */
export type Key<T> = [number, T];

const copyKeys = <T>(keys: readonly Key<T>[]): Key<T>[] => keys.map((k) => [k[0], k[1]]);

/** `keys` with a key at `t` (clamped to 0-1) inserted in order. `index` is where it landed. */
export function addKey<T>(keys: readonly Key<T>[], t: number, value: T): { keys: Key<T>[]; index: number } {
  const at = clamp01(t);
  let index = keys.findIndex((k) => k[0] > at);
  if (index < 0) index = keys.length;
  const next = copyKeys(keys);
  next.splice(index, 0, [at, value]);
  return { keys: next, index };
}

/** Key `index` moved to `t` and `value`; `t` is clamped to 0-1 and can't pass the neighbouring keys. */
export function moveKey<T>(keys: readonly Key<T>[], index: number, t: number, value: T): Key<T>[] {
  if (index < 0 || index >= keys.length) return copyKeys(keys);
  const lo = index > 0 ? keys[index - 1][0] : 0;
  const hi = index < keys.length - 1 ? keys[index + 1][0] : 1;
  return keys.map((k, i) => (i === index ? ([Math.min(hi, Math.max(lo, clamp01(t))), value] as Key<T>) : ([k[0], k[1]] as Key<T>)));
}

/** `keys` without key `index`; the last key is never removed. */
export function removeKey<T>(keys: readonly Key<T>[], index: number): Key<T>[] {
  const next = copyKeys(keys);
  if (next.length <= 1 || index < 0 || index >= next.length) return next;
  next.splice(index, 1);
  return next;
}

/** The value range a curve editor shows: the keys' min and max with some padding; flat curves get a window around them. */
export function curveRange(keys: readonly CurveKey[], min?: number, max?: number): [number, number] {
  if (min !== undefined && max !== undefined && max > min) return [min, max];
  let lo = keys.length ? Math.min(...keys.map((k) => k[1])) : 0;
  let hi = keys.length ? Math.max(...keys.map((k) => k[1])) : 1;
  if (hi - lo < 1e-6) {
    const half = Math.max(0.5, Math.abs(lo) / 2);
    lo -= half;
    hi += half;
  } else {
    const pad = (hi - lo) * 0.1;
    lo -= pad;
    hi += pad;
  }
  return [min ?? lo, max ?? hi];
}

const flat = (v: number): CurveKey[] => [[0, v], [1, v]];
const first = (c: readonly CurveKey[]) => (c.length ? c[0][1] : 0);
const last = (c: readonly CurveKey[]) => (c.length ? c[c.length - 1][1] : 0);

/** A number as another kind: constants become flat ranges and curves; back by taking firsts or averages. */
export function convertNumber(value: ParticleNumber, kind: ParticleNumberKind): ParticleNumber {
  const from = numberKind(value);
  if (from === kind) return value;
  const random = (value as { random: [number, number] }).random;
  const curve = (value as { curve: CurveKey[] }).curve;
  const curves = (value as { randomCurves: [CurveKey[], CurveKey[]] }).randomCurves;
  switch (kind) {
    case "constant":
      if (from === "random") return (random[0] + random[1]) / 2;
      if (from === "curve") return first(curve);
      return first(curves[0]);
    case "random":
      if (from === "constant") return { random: [value as number, value as number] };
      if (from === "curve") return { random: [first(curve), last(curve)] };
      return { random: [first(curves[0]), first(curves[1])] };
    case "curve":
      if (from === "constant") return { curve: flat(value as number) };
      if (from === "random") return { curve: flat((random[0] + random[1]) / 2) };
      return { curve: copyKeys(curves[0]) };
    case "randomCurves":
      if (from === "constant") return { randomCurves: [flat(value as number), flat(value as number)] };
      if (from === "random") return { randomCurves: [flat(random[0]), flat(random[1])] };
      return { randomCurves: [copyKeys(curve), copyKeys(curve)] };
  }
}

const rgb = (hex: string) => hex.slice(0, 7).toLowerCase();
const flatGradient = (hex: string): ParticleGradient => ({ colors: [[0, rgb(hex)], [1, rgb(hex)]], alphas: [[0, parseHexColor(hex)[3]], [1, parseHexColor(hex)[3]]] });
const copyGradient = (g: ParticleGradient): ParticleGradient => ({ colors: copyKeys(g.colors), alphas: copyKeys(g.alphas) });
const gradientHex = (g: ParticleGradient, t: number) => hexColor(...evalGradient(g, t));

/** A colour as another kind; gradients to constants take the colour at the start of life. */
export function convertColor(value: ParticleColor, kind: ParticleColorKind): ParticleColor {
  const from = colorKind(value);
  if (from === kind) return value;
  const random = (value as { random: [string, string] }).random;
  const gradient = (value as { gradient: ParticleGradient }).gradient;
  const gradients = (value as { randomGradients: [ParticleGradient, ParticleGradient] }).randomGradients;
  switch (kind) {
    case "constant":
      if (from === "random") return random[0];
      if (from === "gradient") return gradientHex(gradient, 0);
      return gradientHex(gradients[0], 0);
    case "random":
      if (from === "constant") return { random: [value as string, value as string] };
      if (from === "gradient") return { random: [gradientHex(gradient, 0), gradientHex(gradient, 1)] };
      return { random: [gradientHex(gradients[0], 0), gradientHex(gradients[1], 0)] };
    case "gradient":
      if (from === "constant") return { gradient: flatGradient(value as string) };
      if (from === "random") {
        const [a, b] = random;
        return { gradient: { colors: [[0, rgb(a)], [1, rgb(b)]], alphas: [[0, parseHexColor(a)[3]], [1, parseHexColor(b)[3]]] } };
      }
      return { gradient: copyGradient(gradients[0]) };
    case "randomGradients":
      if (from === "constant") return { randomGradients: [flatGradient(value as string), flatGradient(value as string)] };
      if (from === "random") return { randomGradients: [flatGradient(random[0]), flatGradient(random[1])] };
      return { randomGradients: [copyGradient(gradient), copyGradient(gradient)] };
  }
}

// --- gradient keys ---------------------------------------------------------------------------------

/** A colour key added at `t`, coloured as the gradient is there. */
export function addColorKey(g: ParticleGradient, t: number): { gradient: ParticleGradient; index: number } {
  const [r, gr, b] = evalGradient(g, clamp01(t));
  const { keys, index } = addKey(g.colors, t, hexColor(r, gr, b));
  return { gradient: { ...g, colors: keys }, index };
}

/** An alpha key added at `t`, valued as the gradient is there. */
export function addAlphaKey(g: ParticleGradient, t: number): { gradient: ParticleGradient; index: number } {
  const { keys, index } = addKey(g.alphas, t, evalGradient(g, clamp01(t))[3]);
  return { gradient: { ...g, alphas: keys }, index };
}

export const moveColorKey = (g: ParticleGradient, index: number, t: number): ParticleGradient => ({ ...g, colors: moveKey(g.colors, index, t, g.colors[index]?.[1] ?? "#ffffff") });
export const moveAlphaKey = (g: ParticleGradient, index: number, t: number, value?: number): ParticleGradient => ({ ...g, alphas: moveKey(g.alphas, index, t, value ?? g.alphas[index]?.[1] ?? 1) });
export const setColorKey = (g: ParticleGradient, index: number, hex: string): ParticleGradient => ({ ...g, colors: g.colors.map((k, i) => (i === index ? ([k[0], rgb(hex)] as [number, string]) : [k[0], k[1]])) });
/** Removing a colour key never leaves fewer than one. */
export const removeColorKey = (g: ParticleGradient, index: number): ParticleGradient => ({ ...g, colors: removeKey(g.colors, index) });
/** Alpha keys can all go: no alpha keys reads as opaque. */
export const removeAlphaKey = (g: ParticleGradient, index: number): ParticleGradient => ({ ...g, alphas: copyKeys(g.alphas.filter((_, i) => i !== index)) });

/** A curve sampled at `n` evenly spaced points, for drawing. */
export const curveSamples = (keys: readonly CurveKey[], n: number): number[] => Array.from({ length: n }, (_, i) => evalCurve(keys, i / Math.max(1, n - 1)));
