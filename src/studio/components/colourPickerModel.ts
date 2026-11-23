// The colour picker's rules (spec §3.12, owner's prototype): hex ⇄ HSV, a typed hex read leniently, the custom
// picker's keys (saturation/brightness square: ←→ saturation, ↑↓ brightness, Shift bigger; hue strip: arrows 3°,
// Shift 15°, Page 30°, Home/End the ends), and the project palette of saved colours (no duplicates, newest last). Pure.

export interface Hsv {
  /** 0..360. */
  readonly h: number;
  /** 0..1. */
  readonly s: number;
  /** 0..1. */
  readonly v: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** "#rrggbb" from a typed text ("6aa8ff", "#6AA8FF", "#abc"), or null. */
export function readHex(text: string): string | null {
  let t = text.trim().toLowerCase();
  if (!t.startsWith("#")) t = `#${t}`;
  if (/^#[0-9a-f]{3}$/.test(t)) t = `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  return /^#[0-9a-f]{6}$/.test(t) ? t : null;
}

/** A hex colour's hue, saturation and brightness. */
export function hexToHsv(hex: string): Hsv {
  const h6 = readHex(hex) ?? "#000000";
  const r = parseInt(h6.slice(1, 3), 16) / 255, g = parseInt(h6.slice(3, 5), 16) / 255, b = parseInt(h6.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

/** "#rrggbb" of a hue, saturation and brightness. */
export function hsvToHex(c: Hsv): string {
  const h = ((c.h % 360) + 360) % 360, s = clamp01(c.s), v = clamp01(c.v);
  const k = v * s, x = k * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - k;
  const rgb = h < 60 ? [k, x, 0] : h < 120 ? [x, k, 0] : h < 180 ? [0, k, x] : h < 240 ? [0, x, k] : h < 300 ? [x, 0, k] : [k, 0, x];
  return `#${rgb.map((q) => Math.round((q + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Where a key moves the saturation/brightness square, or null for other keys. */
export function svKey(c: Hsv, key: string, shift: boolean): Hsv | null {
  const d = shift ? 0.1 : 0.02;
  if (key === "ArrowLeft") return { ...c, s: clamp01(c.s - d) };
  if (key === "ArrowRight") return { ...c, s: clamp01(c.s + d) };
  if (key === "ArrowUp") return { ...c, v: clamp01(c.v + d) };
  if (key === "ArrowDown") return { ...c, v: clamp01(c.v - d) };
  return null;
}

/** Where a key moves the hue strip, or null for other keys. */
export function hueKey(h: number, key: string, shift: boolean): number | null {
  const d = shift ? 15 : 3;
  let n: number;
  if (key === "ArrowLeft" || key === "ArrowDown") n = h - d;
  else if (key === "ArrowRight" || key === "ArrowUp") n = h + d;
  else if (key === "PageDown") n = h - 30;
  else if (key === "PageUp") n = h + 30;
  else if (key === "Home") return 0;
  else if (key === "End") return 359;
  else return null;
  return ((n % 360) + 360) % 360;
}

/** The palette with `hex` saved (once, at the end). */
export const saveColour = (saved: readonly string[], hex: string): string[] => [...saved.filter((c) => c !== hex), hex];

/** The palette without `hex`. */
export const removeColour = (saved: readonly string[], hex: string): string[] => saved.filter((c) => c !== hex);
