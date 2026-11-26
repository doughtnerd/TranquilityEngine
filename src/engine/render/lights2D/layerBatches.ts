/**
 * Layer batches (ADR 0399), renderer-neutral: consecutive sorting layers lit by the same set of 2D lights share one set
 * of light textures (one per blend style in use). Worked out per camera per frame from the lights in its view.
 *
 * - A layer no light targets draws unlit (batch -1): with nothing to light it, it keeps its plain colours, so a
 *   background or overlay layer isn't blacked out by lights meant for the play layers.
 * - Past `maxBatches`, the highest batch merges into the one below it (their layers get the union of the two light
 *   sets), until the count fits; `merged` says how many merges that took.
 */

/** What layer batching needs of one light: the layers it targets (indices; null: every layer), its blend style index, and whether it lights normal maps. */
export interface BatchLight {
  readonly layers: readonly number[] | null;
  readonly style: number;
  readonly directional: boolean;
}

export interface LayerBatch {
  /** The sorting layer indices it covers, ascending. */
  layers: number[];
  /** The lights (indices into the input) lighting it, ascending. */
  lights: number[];
  /** The blend style indices its lights use, ascending: one light texture each. */
  styles: number[];
  /** Whether any of its lights lights normal maps (the directional textures). */
  directional: boolean;
}

export interface LayerBatches {
  batches: LayerBatch[];
  /** Per sorting layer index, its batch's index, or -1 (unlit). */
  layerBatch: Int32Array;
  /** How many merges `maxBatches` forced (0: none). */
  merged: number;
}

/** Batch `layerCount` sorting layers for `lights`, at most `maxBatches` batches (at least 1). */
export function layerBatches(layerCount: number, lights: readonly BatchLight[], maxBatches: number): LayerBatches {
  const perLayer: number[][] = Array.from({ length: layerCount }, () => []);
  lights.forEach((l, i) => {
    if (l.layers === null) for (const list of perLayer) list.push(i);
    else for (const layer of new Set(l.layers)) if (layer >= 0 && layer < layerCount) perLayer[layer]!.push(i);
  });
  const batches: LayerBatch[] = [];
  let lastKey = "";
  let lastLayer = -2;
  perLayer.forEach((ids, layer) => {
    if (ids.length === 0) return;
    const key = ids.join(",");
    if (key === lastKey && lastLayer === layer - 1) batches[batches.length - 1]!.layers.push(layer);
    else batches.push({ layers: [layer], lights: ids, styles: [], directional: false });
    lastKey = key;
    lastLayer = layer;
  });
  let merged = 0;
  const cap = Math.max(1, Math.floor(maxBatches));
  while (batches.length > cap) {
    const top = batches.pop()!;
    const below = batches[batches.length - 1]!;
    below.layers.push(...top.layers);
    below.lights = [...new Set([...below.lights, ...top.lights])].sort((a, b) => a - b);
    merged++;
  }
  const layerBatch = new Int32Array(layerCount).fill(-1);
  batches.forEach((b, i) => {
    b.styles = [...new Set(b.lights.map((l) => lights[l]!.style))].sort((x, y) => x - y);
    b.directional = b.lights.some((l) => lights[l]!.directional);
    for (const layer of b.layers) layerBatch[layer] = i;
  });
  return { batches, layerBatch, merged };
}

