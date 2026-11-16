// The value the brush paints into each cell (ADR 0103): the stamp tiled from where the stroke
// started, or one of its tiles at random by weight, with the brush's flips applied after the
// tile's own. Pure; brush.ts paints with it.
import { type Cell, type Stamp } from "../runtime/brushes";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, cellValue, flagsOf, tileIdOf } from "../runtime/format";
import { pickWeighted } from "../runtime/tileset";

/** The 2 × 2 matrix (on image coordinates, centred) a set of flip flags applies: vertical · horizontal · diagonal. */
function flipMatrix(flags: number): [number, number, number, number] {
  let m: [number, number, number, number] = [1, 0, 0, 1];
  const mul = (a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
  if (flags & FLIP_DIAGONAL) m = mul([0, 1, 1, 0], m);
  if (flags & FLIP_X) m = mul([-1, 0, 0, 1], m);
  if (flags & FLIP_Y) m = mul([1, 0, 0, -1], m);
  return m;
}

/** The flags of the brush's transform applied after a cell's own. */
export function combineFlags(cellFlags: number, brush: number): number {
  if (!brush) return cellFlags;
  const a = flipMatrix(brush), b = flipMatrix(cellFlags);
  const want = [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
  for (let f = 0; f < 8; f++) {
    const flags = (f & 1 ? FLIP_X : 0) | (f & 2 ? FLIP_Y : 0) | (f & 4 ? FLIP_DIAGONAL : 0);
    const m = flipMatrix(flags);
    if (m.every((v, i) => v === want[i])) return flags;
  }
  return cellFlags;
}

/** The value painted at a cell: the stamp's value for that cell (tiled from `origin`), or a random one of its tiles. */
export function brushValueAt(stamp: Stamp, x: number, y: number, origin: Cell, random: boolean, flags: number, weightOf: (id: number) => number = () => 1): number {
  let v: number;
  if (random) {
    const choices = stamp.values.filter((n) => n !== 0).map((value) => ({ value, weight: weightOf(tileIdOf(value)) }));
    v = pickWeighted(choices)?.value ?? 0;
  } else {
    const c = ((x - origin[0]) % stamp.width + stamp.width) % stamp.width;
    const r = ((y - origin[1]) % stamp.height + stamp.height) % stamp.height;
    v = stamp.values[r * stamp.width + c] ?? 0;
  }
  return v ? cellValue(tileIdOf(v), combineFlags(flagsOf(v), flags)) : 0;
}
