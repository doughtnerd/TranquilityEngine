// Stamps with named layers (ADR 0442): what the selection tool copies, the editor's tile clipboard and the stamps saved
// in a tileset. A `StampBlock` holds tileset ids (with flip flags) of one tileset; saved stamps (`TileStamp`) name
// tiles by uuid through a palette per layer, in the layer encoding of `format.ts` (run-length cells, row by row from
// the bottom-left), so they travel with the tileset. Moving a block to another tileset matches tiles by uuid. A block
// copied on a staggered or hexagonal map keeps its frame (ADR 0444), saved as the stamp's `stagger`, so it keeps its
// shape wherever it's placed. Pure.
import type { Stamp } from "../runtime/brushes";
import { cellValue, decodeRuns, encodeChunk, flagsOf, tileIdOf } from "../runtime/format";
import type { Tileset, TileStamp, TileStampLayer, TilesetData } from "../runtime/tileset";
import type { BlockFrame } from "../runtime/grids";

/** One named layer of a block: `width × height` cell values (tileset id plus flips; 0 leaves the map's cell alone), row 0 at the bottom. */
export interface StampBlockLayer {
  name: string;
  values: number[];
}

/** A block of cells in one or more named layers. */
export interface StampBlock {
  width: number;
  height: number;
  layers: StampBlockLayer[];
  /**
   * ADR 0444: where the block was laid out on a staggered or hexagonal map, so it keeps its shape wherever it's placed
   * (`TileGrid.placeCell`). Absent: its cells land cell for cell.
   */
  frame?: BlockFrame;
}

/** A one-layer stamp as a block whose layer is called `name`, laid out in `frame` (absent: cell for cell). */
export function blockOfStamp(stamp: Stamp, name = "", frame?: BlockFrame | null): StampBlock {
  const block: StampBlock = { width: stamp.width, height: stamp.height, layers: [{ name, values: [...stamp.values] }] };
  if (frame) block.frame = frame;
  return block;
}

/** The block's layer called `name`, else its first layer with a tile, as a stamp (all empty: its first layer). */
export function stampOfBlock(block: StampBlock, name?: string): Stamp {
  const layer = block.layers.find((l) => l.name === name) ?? block.layers.find((l) => l.values.some((v) => v !== 0)) ?? block.layers[0];
  return { width: block.width, height: block.height, values: layer ? [...layer.values] : new Array<number>(block.width * block.height).fill(0) };
}

/** True when no layer of the block has a tile. */
export function blockIsEmpty(block: StampBlock): boolean {
  return block.layers.every((l) => l.values.every((v) => v === 0));
}

/**
 * The block's tiles as tiles of `to`, matched by uuid through `from` (the tileset its ids are of). Cells whose tile `to`
 * lacks become empty; `missing` counts them.
 */
export function retargetBlock(block: StampBlock, from: Tileset, to: Tileset): { block: StampBlock; missing: number } {
  let missing = 0;
  const layers = block.layers.map((l) => ({
    name: l.name,
    values: l.values.map((v) => {
      if (!v) return 0;
      const uuid = from.tile(tileIdOf(v))?.uuid;
      const tile = uuid !== undefined ? to.tileByUuid(uuid) : undefined;
      if (!tile) {
        missing++;
        return 0;
      }
      return cellValue(tile.id, flagsOf(v));
    }),
  }));
  return { block: { ...block, layers }, missing };
}

/** The block saved as stamp `name` of `tileset` (the tileset its ids are of): each layer's tiles numbered in a palette of uuids, its cells run-length encoded. */
export function encodeStamp(name: string, block: StampBlock, tileset: Tileset): TileStamp {
  const layers: TileStampLayer[] = block.layers.map((l) => {
    const numbers = new Map<string, number>();
    const palette: Record<string, string> = {};
    const cells = l.values.map((v) => {
      const tile = v ? tileset.tile(tileIdOf(v)) : undefined;
      if (!tile) return 0;
      let n = numbers.get(tile.uuid);
      if (n === undefined) {
        n = numbers.size + 1;
        numbers.set(tile.uuid, n);
        palette[n] = tile.uuid;
      }
      return cellValue(n, flagsOf(v));
    });
    return { name: l.name, palette, cells: encodeChunk(cells) };
  });
  const stamp: TileStamp = { name, size: [block.width, block.height], layers };
  if (block.frame) stamp.stagger = { axis: block.frame.axis, shifted: block.frame.shifted };
  return stamp;
}

/**
 * A saved stamp as a block of `tileset`'s ids. A cell naming a tile the tileset no longer has reads as empty, as layers
 * read it (ADR 0392); `missing` counts those cells.
 */
export function decodeStamp(stamp: TileStamp, tileset: Tileset): { block: StampBlock; missing: number } {
  const [width, height] = stamp.size;
  let missing = 0;
  const layers = stamp.layers.map((l) => ({
    name: l.name,
    values: [...decodeRuns(l.cells, width * height)].map((v) => {
      if (!v) return 0;
      const uuid = l.palette[tileIdOf(v)];
      const tile = uuid !== undefined ? tileset.tileByUuid(uuid) : undefined;
      if (!tile) {
        missing++;
        return 0;
      }
      return cellValue(tile.id, flagsOf(v));
    }),
  }));
  const block: StampBlock = { width, height, layers };
  if (stamp.stagger) block.frame = { axis: stamp.stagger.axis, shifted: stamp.stagger.shifted };
  return { block, missing };
}

/** `base`, or `base 2`, `base 3`… : the first name no stamp of `data` has. */
export function uniqueStampName(data: TilesetData, base: string): string {
  const taken = new Set((data.stamps ?? []).map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** `data` with `stamp` saved: replacing the stamp of the same name, else added last. */
export function withStamp(data: TilesetData, stamp: TileStamp): TilesetData {
  const stamps = data.stamps ?? [];
  const i = stamps.findIndex((s) => s.name === stamp.name);
  return { ...data, stamps: i >= 0 ? stamps.map((s, j) => (j === i ? stamp : s)) : [...stamps, stamp] };
}

/** `data` with stamp `from` called `to` (unchanged when `to` is empty or another stamp's name). */
export function renameStamp(data: TilesetData, from: string, to: string): TilesetData {
  const stamps = data.stamps ?? [];
  if (!to || from === to || stamps.some((s) => s.name === to)) return data;
  return { ...data, stamps: stamps.map((s) => (s.name === from ? { ...s, name: to } : s)) };
}

/** `data` without stamp `name` (no `stamps` key once the last goes). */
export function removeStamp(data: TilesetData, name: string): TilesetData {
  const stamps = (data.stamps ?? []).filter((s) => s.name !== name);
  const { stamps: _, ...rest } = data;
  return stamps.length ? { ...rest, stamps } : rest;
}

/** `data` offering prefab `ref` (an `asset:` reference) to the prefab brush, once. */
export function withPrefab(data: TilesetData, ref: string): TilesetData {
  const prefabs = data.prefabs ?? [];
  return prefabs.includes(ref) ? data : { ...data, prefabs: [...prefabs, ref] };
}

/** `data` without prefab `ref` (no `prefabs` key once the last goes). */
export function removePrefab(data: TilesetData, ref: string): TilesetData {
  const prefabs = (data.prefabs ?? []).filter((p) => p !== ref);
  const { prefabs: _, ...rest } = data;
  return prefabs.length ? { ...rest, prefabs } : rest;
}
