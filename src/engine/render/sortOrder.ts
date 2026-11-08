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
