/**
 * Skin influences per vertex (ADR 0371 "Model import"): **4 by default** (Unity's, Godot's and Blender's glTF export
 * default), 8 when the model sidecar sets `influences: 8`. A vertex's influences are gathered from every joint and
 * weight set the file has (glTF `JOINTS_0`/`WEIGHTS_0`, `JOINTS_1`/`WEIGHTS_1`), merged when a joint repeats, the
 * smallest dropped first past the limit, then normalised to sum 1. A vertex with no weight at all is bound fully to
 * its first joint (palette entry 0 when it has none), so it follows the skeleton instead of collapsing to the origin.
 *
 * Pure. Internal: not public API.
 */

/** @internal Influences per vertex a model may ask for. */
export const SKIN_INFLUENCES = [4, 8] as const;
export type SkinInfluences = (typeof SKIN_INFLUENCES)[number];

/** @internal A vertex attribute set: `size` joint indices and as many weights per vertex. */
export interface InfluenceSet {
  readonly size: number;
  readonly joints: ArrayLike<number>;
  readonly weights: ArrayLike<number>;
}

/** @internal Every vertex's influences, `influences` per vertex, sorted by weight (largest first), normalised. */
export interface LimitedInfluences {
  readonly influences: SkinInfluences;
  /** Joint (palette) index per influence; unused slots are 0 with weight 0. */
  readonly joints: Uint16Array;
  readonly weights: Float32Array;
  /** Vertices that had more non-zero influences than the limit (some dropped). */
  readonly truncated: number;
}

/** @internal `vertexCount` vertices' influences from `sets`, limited to `influences` and normalised (see the module comment). */
export function limitInfluences(vertexCount: number, sets: readonly InfluenceSet[], influences: SkinInfluences): LimitedInfluences {
  const joints = new Uint16Array(vertexCount * influences);
  const weights = new Float32Array(vertexCount * influences);
  let truncated = 0;
  const js: number[] = [];
  const ws: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    js.length = 0;
    ws.length = 0;
    let first = -1;
    for (const set of sets) {
      for (let k = 0; k < set.size; k++) {
        const j = set.joints[v * set.size + k];
        const w = set.weights[v * set.size + k];
        if (first < 0) first = j;
        if (!(w > 0)) continue;
        const at = js.indexOf(j);
        if (at >= 0) ws[at] += w;
        else {
          js.push(j);
          ws.push(w);
        }
      }
    }
    // Largest first; equal weights keep the file's order (stable sort).
    const order = js.map((_, i) => i).sort((a, b) => ws[b] - ws[a]);
    if (order.length > influences) truncated++;
    const kept = order.slice(0, influences);
    const sum = kept.reduce((s, i) => s + ws[i], 0);
    const base = v * influences;
    if (sum > 0) {
      kept.forEach((i, slot) => {
        joints[base + slot] = js[i];
        weights[base + slot] = ws[i] / sum;
      });
    } else {
      joints[base] = Math.max(0, first);
      weights[base] = 1;
    }
  }
  return { influences, joints, weights, truncated };
}
