/**
 * Neighbour patterns (ADR 0103): the matching model under auto-tiling. A cell's 8 neighbours
 * (N NE E SE S SW W NW) make a bit mask, a terrain tile's pattern says per neighbour "same terrain"
 * (`1`), "not" (`0`) or "don't care" (`*`), and the best-fitting tile of a terrain is picked for a
 * mask. Pure; `autotile.ts` paints with it.
 */
import { NEIGHBOUR_OFFSETS, pickWeighted, type TileDef } from "./tileset";

/** Bit i set when neighbour i (N NE E SE S SW W NW) is the same terrain. */
export function neighbourMask(x: number, y: number, terrain: string, terrainAt: (x: number, y: number) => string | undefined): number {
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    const [dx, dy] = NEIGHBOUR_OFFSETS[i];
    if (terrainAt(x + dx, y + dy) === terrain) mask |= 1 << i;
  }
  return mask;
}

/** How well `pattern` fits `mask`: -1 if any fixed position disagrees, else the number of fixed positions. */
export function patternScore(pattern: string, mask: number): number {
  let score = 0;
  for (let i = 0; i < 8; i++) {
    const c = pattern.charCodeAt(i);
    if (c === 42) continue; // *
    const same = (mask >> i) & 1;
    if ((c === 49) !== (same === 1)) return -1;
    score++;
  }
  return score;
}

/** Agreeing fixed positions minus disagreeing ones, for the fallback when nothing matches. */
function looseScore(pattern: string, mask: number): number {
  let score = 0;
  for (let i = 0; i < 8; i++) {
    const c = pattern.charCodeAt(i);
    if (c === 42) continue;
    score += (c === 49) === (((mask >> i) & 1) === 1) ? 1 : -1;
  }
  return score;
}

/** The terrain tile for a neighbour mask, or undefined if the terrain has no tiles. */
export function pickTerrainTile(tiles: readonly TileDef[], mask: number, random: () => number = Math.random): TileDef | undefined {
  if (!tiles.length) return undefined;
  let best: TileDef[] = [], bestScore = -1;
  // The raw mask first; then with corners that don't matter cleared, so 47-tile sets written with exact corners still match.
  for (const m of mask === canonicalBlob(mask) ? [mask] : [mask, canonicalBlob(mask)]) {
    for (const t of tiles) {
      const s = patternScore(t.pattern ?? "********", m);
      if (s < 0) continue;
      if (s > bestScore) (best = [t]), (bestScore = s);
      else if (s === bestScore) best.push(t);
    }
    if (best.length) break;
  }
  if (!best.length) {
    let loose = -Infinity;
    for (const t of tiles) {
      const s = looseScore(t.pattern ?? "********", mask);
      if (s > loose) (best = [t]), (loose = s);
      else if (s === loose) best.push(t);
    }
  }
  return pickWeighted(best, random);
}

/**
 * The 47 masks of the "match sides and corners" blob set: corner bits only count when both sides
 * next to the corner are set. Useful for checking a terrain is complete.
 */
export function blobMasks(): number[] {
  const out = new Set<number>();
  for (let m = 0; m < 256; m++) out.add(canonicalBlob(m));
  return [...out].sort((a, b) => a - b);
}

/** Clear corner bits whose two neighbouring sides aren't both set. */
export function canonicalBlob(mask: number): number {
  const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;
  let m = mask;
  if (!(m & N && m & E)) m &= ~NE;
  if (!(m & S && m & E)) m &= ~SE;
  if (!(m & S && m & W)) m &= ~SW;
  if (!(m & N && m & W)) m &= ~NW;
  return m;
}

/** A mask as a pattern string (no wildcards). */
export function maskToPattern(mask: number): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += (mask >> i) & 1 ? "1" : "0";
  return s;
}

/** The pattern of a "match sides" (16-tile) set: sides fixed, corners don't care. */
export function sidesPattern(n: boolean, e: boolean, s: boolean, w: boolean): string {
  return `${n ? 1 : 0}*${e ? 1 : 0}*${s ? 1 : 0}*${w ? 1 : 0}*`;
}
