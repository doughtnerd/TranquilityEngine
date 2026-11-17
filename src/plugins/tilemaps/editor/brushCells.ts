// The value the brush paints into each cell (ADR 0103): the stamp tiled from where the stroke
// started, or one of its tiles at random by weight, with the brush's flips applied after the
// tile's own. Pure; brush.ts paints with it.
import { type Cell, type Stamp } from "../runtime/brushes";
import { cellValue, flagsOf, tileIdOf } from "../runtime/format";
import { compose } from "../runtime/tileFlips";
import { pickWeighted } from "../runtime/tileset";

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
  return v ? cellValue(tileIdOf(v), compose(flagsOf(v), flags)) : 0;
}
