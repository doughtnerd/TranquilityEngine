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
import { blobMasks, neighbourMask, patternScore, pickTerrainTile } from "./neighbourPatterns";
import type { TileDef, Tileset } from "./tileset";

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

/** The masks a terrain's tiles can't serve exactly (of the 47 blob masks). Empty means complete. */
export function missingBlobMasks(tiles: readonly TileDef[]): number[] {
  return blobMasks().filter((m) => !tiles.some((t) => patternScore(t.pattern ?? "********", m) >= 0));
}
