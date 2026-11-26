/**
 * Auto-tiling (ADR 0103): terrains with neighbour patterns, which cover both Godot/Tiled-style
 * terrain sets (match sides, or sides and corners, the 16- and 47-tile blob sets) and Unity-style
 * rule tiles (a pattern with "don't care" neighbours). Pure: callers pass a cell reader.
 *
 * A cell belongs to terrain T when its tile's `terrain` is T. To place a terrain tile, the
 * neighbour pattern of the cell is read (8 neighbours, N NE E SE S SW W NW; same terrain or not;
 * on other grids the grid's own neighbours, ADR 0421: 6 on hexagonal maps, whose tiles have 6-character patterns)
 * and the terrain tile whose pattern matches best is chosen: every `1`/`0` must match, and of the
 * tiles that match, the most specific one (fewest `*`) wins, ties broken by weight. If none
 * matches, the tile with the most agreeing positions is used, so a partial tile set still paints.
 *
 * The tie between equally fitting variants is not rolled afresh on each paint (ADR 0400): it is drawn from a hash
 * of the cell and the map's seed (`cellRandom`), as Unity's rule tiles and LDtk do. So a cell keeps its variant
 * until the shape it needs changes, and the same strokes always paint the same map.
 */
import { cellRandom, TERRAIN_STREAM } from "./cellHash";
import { blobMasks, neighbourMask, patternFits, patternScore, pickTerrainTile } from "./neighbourPatterns";
import type { TileDef, Tileset, TilesetData } from "./tileset";

/** Reading and writing one layer's cells, for `paintTerrain`. Values are tile ids (flip flags are dropped by auto-tiling). */
export interface CellAccess {
  get(x: number, y: number): number;
  set(x: number, y: number, id: number): void;
  /** A cell's neighbours in pattern order (ADR 0421: `TileGrid.neighbours`). Absent: the square grid's 8. */
  neighbours?(x: number, y: number): readonly (readonly [number, number])[];
  /** How many neighbours a cell has (8, or 6 on hexagonal grids): the pattern length that fits. Absent: 8. */
  neighbourCount?: number;
}

/** A cell's neighbours on the access's grid (the square grid's 8 when it names none). */
function neighboursOf(access: CellAccess, x: number, y: number): readonly (readonly [number, number])[] {
  if (access.neighbours) return access.neighbours(x, y);
  const out: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push([x + dx, y + dy]);
  return out;
}

/** Writes cells through `access`, noting the ones whose value changed. */
function changeTracker(access: CellAccess) {
  const changed = new Map<string, [number, number]>();
  return {
    set(x: number, y: number, id: number) {
      if (access.get(x, y) === id) return;
      access.set(x, y, id);
      changed.set(`${x},${y}`, [x, y]);
    },
    changed: () => [...changed.values()],
  };
}

/** Re-pick the tile of every cell in `cells` that belongs to a terrain, its variant drawn by `seed`. */
function repick(tileset: Tileset, access: CellAccess, cells: Iterable<readonly [number, number]>, seed: number, set: CellAccess["set"]): void {
  const terrainAt = (x: number, y: number) => tileset.tile(access.get(x, y) & 0xffffff)?.terrain;
  for (const [x, y] of cells) {
    const t = terrainAt(x, y);
    if (!t) continue;
    const mask = neighbourMask(x, y, t, terrainAt, access.neighbours ? (nx, ny) => access.neighbours!(nx, ny) : undefined);
    const pick = pickTerrainTile(tileset.byTerrain.get(t) ?? [], mask, () => cellRandom(seed, x, y, TERRAIN_STREAM), access.neighbourCount ?? 8);
    if (pick) set(x, y, pick.id);
  }
}

/**
 * Paint `terrain` (or erase it, with `terrain` null) into the given cells, then re-pick the tiles of
 * those cells and their neighbours that belong to a terrain, equally fitting variants chosen by `seed`
 * (ADR 0400). Returns the cells whose value changed.
 */
export function paintTerrain(
  tileset: Tileset,
  access: CellAccess,
  cells: readonly (readonly [number, number])[],
  terrain: string | null,
  seed = 0,
): [number, number][] {
  const terrainAt = (x: number, y: number) => tileset.tile(access.get(x, y) & 0xffffff)?.terrain;
  // Tiles whose pattern doesn't fit the grid (6 characters on a square map, 8 on a hexagonal one) are skipped (ADR 0421).
  const tiles = terrain ? (tileset.byTerrain.get(terrain) ?? []).filter((t) => patternFits(t.pattern, access.neighbourCount ?? 8)) : [];
  if (terrain && !tiles.length) return [];
  const { set, changed } = changeTracker(access);
  // First mark the cells with any tile of the terrain (or clear them), so neighbours see them.
  for (const [x, y] of cells) set(x, y, terrain ? (terrainAt(x, y) === terrain ? access.get(x, y) : tiles[0].id) : 0);
  // Then re-pick every terrain cell in and around the painted area.
  const visit = new Map<string, [number, number]>();
  for (const [x, y] of cells) {
    visit.set(`${x},${y}`, [x, y]);
    for (const [nx, ny] of neighboursOf(access, x, y)) visit.set(`${nx},${ny}`, [nx, ny]);
  }
  repick(tileset, access, visit.values(), seed, set);
  return changed();
}

/**
 * Re-pick the tile of every terrain cell in `cells` for its neighbourhood as it is, by `seed` (ADR 0400): after the
 * seed changed (a re-roll) or the tileset's terrain tiles did. Other cells are left alone. Returns the cells whose
 * value changed.
 */
export function retileTerrain(tileset: Tileset, access: CellAccess, cells: Iterable<readonly [number, number]>, seed = 0): [number, number][] {
  const { set, changed } = changeTracker(access);
  repick(tileset, access, cells, seed, set);
  return changed();
}

/** The masks a terrain's tiles can't serve exactly (of the 47 blob masks). Empty means complete. */
export function missingBlobMasks(tiles: readonly TileDef[]): number[] {
  return blobMasks().filter((m) => !tiles.some((t) => patternFits(t.pattern, 8) && patternScore(t.pattern ?? "********", m) >= 0));
}

/**
 * Terrain tiles whose pattern can't serve the grid their terrain is for (ADR 0421), as messages naming them: when the
 * tileset says which cells it is drawn for (`previewGrid`), a pattern of the other length (6 characters for hexagonal
 * maps, 8 for the rest); otherwise a pattern whose length differs from most of its terrain's. Auto-tiling skips such
 * tiles on a map they don't fit.
 */
export function patternProblems(data: TilesetData): string[] {
  const problems: string[] = [];
  const want = data.previewGrid === "hexagonal" ? 6 : data.previewGrid ? 8 : 0;
  const byTerrain = new Map<string, TileDef[]>();
  for (const t of data.tiles) {
    if (!t.terrain || t.pattern === undefined) continue;
    let l = byTerrain.get(t.terrain);
    if (!l) byTerrain.set(t.terrain, (l = []));
    l.push(t);
  }
  const name = (t: TileDef) => `tile ${t.id}${t.name ? ` "${t.name}"` : ""}`;
  for (const [terrain, tiles] of byTerrain) {
    const lengths = new Map<number, number>();
    for (const t of tiles) lengths.set(t.pattern!.length, (lengths.get(t.pattern!.length) ?? 0) + 1);
    const fit = want || [...lengths].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    for (const t of tiles) {
      const n = t.pattern!.length;
      if (n === fit) continue;
      problems.push(`Terrain "${terrain}": ${name(t)}'s pattern names ${n} neighbours, so it fits only ${n === 6 ? "hexagonal maps" : "square, isometric and staggered maps"}; auto-tiling skips it on the others.`);
    }
  }
  return problems;
}
