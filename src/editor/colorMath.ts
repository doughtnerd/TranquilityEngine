// Colour maths on hex colours: parsing, mixing, WCAG luminance and contrast, and nudging a colour
// until it reads against another. The editor's theme (theme.ts) derives its tokens with it.

export type RGB = [number, number, number];

/** `#rgb` or `#rrggbb` to 0–255 channels (anything else: null). */
export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;

export const rgb = (hex: string): RGB => parseHex(hex) ?? [0, 0, 0];

/** `#rrggbb` with opacity `a` (0–1) appended as `aa` when below 1: the `#rrggbb[aa]` form asset files store. */
export function hexWithAlpha(hex: string, a: number): string {
  const opaque = toHex(rgb(hex));
  return a >= 1 ? opaque : `${opaque}${Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0")}`;
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
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
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
