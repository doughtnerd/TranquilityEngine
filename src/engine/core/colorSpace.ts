/**
 * The engine's one colour codec (ADR 0461): hex text to and from 0–1 components, and the sRGB transfer function.
 * Every TypeScript reader of `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` and every sRGB↔linear conversion goes
 * through here, so a colour reads the same in every module. Each caller keeps its own fallback for text that isn't
 * a hex colour (white, black, the default). Shader source keeps its own GLSL/WGSL copy of the curve.
 * Pure and renderer-neutral.
 */

/** RGBA components, each 0–1 (sRGB for colours parsed from text). */
export type Rgba = [number, number, number, number];

const HEX_TEXT = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (any case, surrounding spaces ignored, the `#` optional) as
 * `[r, g, b, a]` 0–1; alpha is 1 when the text has none. Anything else is null.
 */
export function parseHex(text: string): Rgba | null {
  const m = HEX_TEXT.exec(text.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const byte = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [byte(0), byte(2), byte(4), h.length === 8 ? byte(6) : 1];
}

const byteHex = (v: number) => Math.round((v > 0 ? (v < 1 ? v : 1) : 0) * 255).toString(16).padStart(2, "0");

/**
 * 0–1 components (the first three of `rgb`) and `alpha` as lower-case `#rrggbb`, or `#rrggbbaa` when the alpha
 * byte is below `ff`. Every value is clamped to 0–1 first, so the text is always 7 or 9 characters.
 */
export function formatHex(rgb: readonly number[], alpha = 1): string {
  const a = byteHex(alpha);
  return `#${byteHex(rgb[0] ?? 0)}${byteHex(rgb[1] ?? 0)}${byteHex(rgb[2] ?? 0)}${a === "ff" ? "" : a}`;
}

/** An sRGB-encoded component (0–1) as linear light (the IEC 61966-2-1 curve). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** A linear component as sRGB-encoded 0–1, clamped first so out-of-range input never gives NaN or leaves 0–1. */
export function linearToSrgb(c: number): number {
  const v = c > 0 ? (c < 1 ? c : 1) : 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
