// Colour maths on hex colours: parsing, mixing, WCAG luminance and contrast, and nudging a colour
// until it reads against another. The editor's theme (theme.ts) derives its tokens with it.

import { formatHex, parseHex as parseHexText, srgbToLinear } from "../engine/core/colorSpace";

export type RGB = [number, number, number];

/** A hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, ADR 0461; alpha dropped) to 0–255 channels (anything else: null). */
export function parseHex(hex: string): RGB | null {
  const c = parseHexText(hex);
  return c ? [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)] : null;
}

export const toHex = ([r, g, b]: RGB) => formatHex([r / 255, g / 255, b / 255]);

export const rgb = (hex: string): RGB => parseHex(hex) ?? [0, 0, 0];

/** `#rrggbb` with opacity `a` (0–1) appended as `aa` when below 1: the `#rrggbb[aa]` form asset files store. */
export function hexWithAlpha(hex: string, a: number): string {
  return formatHex(rgb(hex).map((c) => c / 255), a);
}

/** `a` moved `t` (0–1) of the way to `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** A colour with alpha, as CSS `rgb(r g b / a)`. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgb(${r} ${g} ${b} / ${a})`;
}

/** WCAG relative luminance (0 black – 1 white). */
export function luminance(hex: string): number {
  const lin = (c: number) => srgbToLinear(c / 255);
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg`, moved toward `toward` in small steps until it has `min` contrast against `bg` (or reaches it). */
export function ensureContrast(fg: string, bg: string, min: number, toward: string): string {
  let c = fg;
  for (let t = 0.1; contrast(c, bg) < min && t <= 1.001; t += 0.1) c = mix(fg, toward, t);
  return c;
}

/** Whichever of `light` and `dark` reads better on `bg`. */
export const readableOn = (bg: string, light: string, dark: string) => (contrast(light, bg) >= contrast(dark, bg) ? light : dark);
