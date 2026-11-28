/**
 * Pure key edits for a colour gradient (ADR 0396, moved from the Particles plugin, ADR 0057): add, move, recolour and remove
 * colour and alpha keys, never mutating the input. The generic key-list helpers are in `../curves/keyList.ts`. No DOM here.
 */
import { formatHex, parseHex } from "../../../engine/core/colorSpace";
import { evaluateGradient, type Gradient } from "../../../engine/core/gradient";
import { addKey, moveKey, removeKey, type Key } from "../curves/keyList";

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const copyKeys = <T,>(keys: readonly Key<T>[]): Key<T>[] => keys.map((k) => [k[0], k[1]]);
/** A colour key's `#rrggbb` (ADR 0461: short forms expanded, alpha dropped; text that isn't a colour kept as written). */
const rgb = (hex: string) => {
  const c = parseHex(hex);
  return c ? formatHex(c) : hex;
};

/** A colour key added at `t`, coloured as the gradient is there. */
export function addColorKey(g: Gradient, t: number): { gradient: Gradient; index: number } {
  const [r, gr, b] = evaluateGradient(g, clamp01(t));
  const { keys, index } = addKey(g.colors, t, formatHex([r, gr, b]));
  return { gradient: { ...g, colors: keys }, index };
}

/** An alpha key added at `t`, valued as the gradient is there. */
export function addAlphaKey(g: Gradient, t: number): { gradient: Gradient; index: number } {
  const { keys, index } = addKey(g.alphas, t, evaluateGradient(g, clamp01(t))[3]);
  return { gradient: { ...g, alphas: keys }, index };
}

export const moveColorKey = (g: Gradient, index: number, t: number): Gradient => ({ ...g, colors: moveKey(g.colors, index, t, g.colors[index]?.[1] ?? "#ffffff") });
export const moveAlphaKey = (g: Gradient, index: number, t: number, value?: number): Gradient => ({ ...g, alphas: moveKey(g.alphas, index, t, value ?? g.alphas[index]?.[1] ?? 1) });
export const setColorKey = (g: Gradient, index: number, hex: string): Gradient => ({ ...g, colors: g.colors.map((k, i) => (i === index ? ([k[0], rgb(hex)] as [number, string]) : [k[0], k[1]])) });
/** Removing a colour key never leaves fewer than one. */
export const removeColorKey = (g: Gradient, index: number): Gradient => ({ ...g, colors: removeKey(g.colors, index) });
/** Alpha keys can all go: no alpha keys reads as opaque. */
export const removeAlphaKey = (g: Gradient, index: number): Gradient => ({ ...g, alphas: copyKeys(g.alphas.filter((_, i) => i !== index)) });
