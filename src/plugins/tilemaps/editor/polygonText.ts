// A tile's collision polygon as text (ADR 0103): the Tileset Inspector shows and reads it as
// `x,y x,y …` in cell units.

/** `x,y x,y …` in cell units, or null if it isn't three or more points. */
export function parsePolygon(text: string): [number, number][] | null {
  const pts: [number, number][] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const m = /^(-?\d*\.?\d+),(-?\d*\.?\d+)$/.exec(part);
    if (!m) return null;
    pts.push([Number(m[1]), Number(m[2])]);
  }
  return pts.length >= 3 ? pts : null;
}

/** Points as `x,y x,y …`, the way the Inspector shows a collision polygon. */
export const polygonText = (pts: readonly (readonly number[])[]) => pts.map((p) => `${p[0]},${p[1]}`).join(" ");
