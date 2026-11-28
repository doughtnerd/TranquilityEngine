/**
 * CSS colours for UI stylesheets (ADR 0077): the colour values a declaration, an attribute or a paint value (a shadow,
 * a gradient stop, ADR 0422) takes. Pure and renderer-neutral.
 */
import { parseHex } from "../../core/colorSpace";
import { Color } from "../../core/math";

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", lime: "#00ff00", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", orange: "#ffa500",
  purple: "#800080", pink: "#ffc0cb", brown: "#a52a2a", gray: "#808080", grey: "#808080", silver: "#c0c0c0",
  navy: "#000080", teal: "#008080", maroon: "#800000", olive: "#808000", gold: "#ffd700", coral: "#ff7f50",
  crimson: "#dc143c", indigo: "#4b0082", violet: "#ee82ee", salmon: "#fa8072", tomato: "#ff6347",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", dimgray: "#696969", dimgrey: "#696969",
};

/** A CSS colour: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, a named colour, `transparent`; `none` is null (no fill). */
export function parseColor(raw: string): Color | null | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "none") return null;
  if (v === "transparent") return new Color(0, 0, 0, 0);
  const named = NAMED_COLORS[v];
  if (named) return Color.from(named);
  const hex = v.startsWith("#") ? parseHex(v) : null; // CSS hex needs its "#"
  if (hex) return new Color(hex[0], hex[1], hex[2], hex[3]);
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const channel = (s: string) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s) / 255);
    const alpha = (s: string) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));
    const c = new Color(channel(parts[0]), channel(parts[1]), channel(parts[2]), parts[3] !== undefined ? alpha(parts[3]) : 1);
    return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? c : undefined;
  }
  return undefined;
}
