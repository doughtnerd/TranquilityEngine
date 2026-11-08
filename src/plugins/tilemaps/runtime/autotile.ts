/**
 * Auto-tiling (ADR 0103): terrains with neighbour patterns, which cover both Godot/Tiled-style
 * terrain sets (match sides, or sides and corners, the 16- and 47-tile blob sets) and Unity-style
 * rule tiles (a pattern with "don't care" neighbours). Pure: callers pass a cell reader.
 *
 * A cell belongs to terrain T when its tile's `terrain` is T. To place a terrain tile, the
 * neighbour pattern of the cell is read (8 neighbours, N NE E SE S SW W NW; same terrain or not)
 * and the terrain tile whose pattern matches best is chosen: every `1`/`0` must match, and of the
 * tiles that match, the most specific one (fewest `*`) wins, ties broken by weight. If none
 * matches, the tile with the most agreeing positions is used, so a partial tile set still paints.
 */
import { NEIGHBOUR_OFFSETS, pickWeighted, type TileDef, type Tileset } from "./tileset";

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

/** Reading and writing one layer's cells, for `paintTerrain`. Values are tile ids (flip flags are dropped by auto-tiling). */
export interface CellAccess {
  get(x: number, y: number): number;
  set(x: number, y: number, id: number): void;
}

/**
 * Paint `terrain` (or erase it, with `terrain` null) into the given cells, then re-pick the tiles of
 * those cells and their neighbours that belong to a terrain. Returns the cells whose value changed.
 */
export function paintTerrain(
  tileset: Tileset,
  access: CellAccess,
  cells: readonly (readonly [number, number])[],
  terrain: string | null,
  random: () => number = Math.random,
): [number, number][] {
  const terrainAt = (x: number, y: number) => tileset.tile(access.get(x, y) & 0xffffff)?.terrain;
  const tiles = terrain ? (tileset.byTerrain.get(terrain) ?? []) : [];
  if (terrain && !tiles.length) return [];
  const changed = new Map<string, [number, number]>();
  const set = (x: number, y: number, id: number) => {
    if (access.get(x, y) === id) return;
    access.set(x, y, id);
    changed.set(`${x},${y}`, [x, y]);
  };
  // First mark the cells with any tile of the terrain (or clear them), so neighbours see them.
  for (const [x, y] of cells) set(x, y, terrain ? (terrainAt(x, y) === terrain ? access.get(x, y) : tiles[0].id) : 0);
  // Then re-pick every terrain cell in and around the painted area.
  const visit = new Map<string, [number, number]>();
  for (const [x, y] of cells) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) visit.set(`${x + dx},${y + dy}`, [x + dx, y + dy]);
  }
  for (const [x, y] of visit.values()) {
    const t = terrainAt(x, y);
    if (!t) continue;
    const pick = pickTerrainTile(tileset.byTerrain.get(t) ?? [], neighbourMask(x, y, t, terrainAt), random);
    if (pick) set(x, y, pick.id);
  }
  return [...changed.values()];
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

/** The masks a terrain's tiles can't serve exactly (of the 47 blob masks). Empty means complete. */
export function missingBlobMasks(tiles: readonly TileDef[]): number[] {
  return blobMasks().filter((m) => !tiles.some((t) => patternScore(t.pattern ?? "********", m) >= 0));
}
