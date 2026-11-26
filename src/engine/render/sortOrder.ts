/**
 * Draw order for 2D content (ADR 0014): a sorting layer's index × 10000 + the order in that layer.
 * Renderer-neutral, shared by sprites and the quad-batch host (tiles, ADR 0136), so tiles keep sorting
 * with sprites whichever plugins are on (ADR 0140).
 */

/** @internal The draw order of `order` in sorting layer `layer` of `layers` (bottom to top); an unknown layer counts as the first, and `warn` is told. */
export function sortingOrder(layers: readonly string[], layer: string, order: number, warn?: (layer: string) => void): number {
  let index = layers.indexOf(layer);
  if (index < 0) {
    warn?.(layer);
    index = 0;
  }
  return index * 10000 + order;
}

/** @internal The warning for a sorting layer the project doesn't list (logged once per layer). */
export const unknownLayerMessage = (layer: string): string => `unknown sorting layer "${layer}"; add it to project settings render.sortingLayers.`;

/**
 * @internal How far into its draw order a 2D draw sits (ADR 0421, 0424): `within` in [0, 1) maps to [0, WITHIN_SPAN), so
 * draws of one order sort among themselves (painter's order of isometric and hexagonal tile chunks, heights in a
 * y-sorted layer) and stay below the next whole order.
 */
export const WITHIN_SPAN = 0.5;
/** @internal The offset into its draw order of a draw `within` its order ([0, 1), clamped; anything else: 0). */
export function withinOrder(within: number): number {
  return Number.isFinite(within) ? Math.max(0, Math.min(within, 0.999999)) * WITHIN_SPAN : 0;
}

/** World heights `ySortFraction` tells apart: linear over ±Y_SORT_RANGE units, clamped beyond. */
const Y_SORT_RANGE = 100_000;

/**
 * @internal A world height as a `within` for a y-sorted layer (ADR 0424): monotonic, higher y smaller (drawn earlier, so
 * lower things draw over it), in [0, 1); linear over ±100 000 units and clamped beyond. NaN counts as 0.
 */
export function ySortFraction(y: number): number {
  const h = Number.isNaN(y) ? 0 : y;
  const f = (Y_SORT_RANGE - h) / (2 * Y_SORT_RANGE);
  return f <= 0 ? 0 : Math.min(f, 0.999999);
}

/** The render settings y-sorting reads: the sorting layers and which of them are y-sorted (`render` of the project settings). */
export interface YSortSettings {
  readonly sortingLayers: readonly string[];
  readonly ySortedLayers?: readonly string[];
}

/**
 * @internal The one place that decides a 2D draw's `within` from its height (ADR 0424): `ySortFraction(y)` when `layer` is
 * y-sorted in `render` (`render.ySortedLayers`), else 0. Render features pass it to `QuadBatch.setOrder` or add
 * `withinOrder` of it to their draw order (`drawPlace`).
 */
export function ySortWithin(render: YSortSettings, layer: string, y: number): number {
  return render.ySortedLayers?.includes(layer) ? ySortFraction(y) : 0;
}

/** @internal Whether `layer` is y-sorted in `render` (ADR 0424). */
export function isYSorted(render: YSortSettings, layer: string): boolean {
  return !!render.ySortedLayers?.includes(layer);
}

/**
 * @internal A 2D draw's place (what `layeredQuads.ts` sets as `alphaIndex`, and what picking ranks by, ADR 0276): its draw
 * order (`sortingOrder`) plus, in a y-sorted layer, its height's offset into that order (`ySortWithin`, ADR 0424).
 */
export function drawPlace(render: YSortSettings, layer: string, order: number, y: number, warn?: (layer: string) => void): number {
  return sortingOrder(render.sortingLayers, layer, order, warn) + withinOrder(ySortWithin(render, layer, y));
}
