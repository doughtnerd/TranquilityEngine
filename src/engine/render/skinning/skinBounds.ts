/**
 * Internal (ADR 0370; `SkinnedMeshRenderer.boundsMode`): culling bounds of a skinned mesh, without
 * reading the GPU's output back. Pure.
 *
 * `bones` mode: a skinned vertex is a convex combination of its influences' matrices applied to its
 * morphed rest position, and each of those lies in the box of that matrix applied to the morphed rest
 * box. So the union of the used joints' transformed rest boxes bounds the mesh exactly (conservatively):
 * eight corners per used joint a frame, only when the palette changes. The morphed rest box is the rest
 * box grown by each target's largest delta times its weight's magnitude.
 */
import { PALETTE_FLOATS } from "./skinKernel";
import { vertexCount, type SkinGeometry } from "./skinData";

/** An axis-aligned box: min x, y, z then max x, y, z. */
export type Box6 = [number, number, number, number, number, number];

/** The box of a geometry's rest positions (a degenerate box at the origin for none). */
export function restBox(g: SkinGeometry): Box6 {
  const n = vertexCount(g);
  if (!n) return [0, 0, 0, 0, 0, 0];
  const b: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 3; k++) {
      const x = g.positions[v * 3 + k];
      if (x < b[k]) b[k] = x;
      if (x > b[k + 3]) b[k + 3] = x;
    }
  }
  return b;
}

/** Per morph target, the largest |delta| on each axis (x, y, z per target). */
export function morphReach(g: SkinGeometry): Float32Array {
  const n = vertexCount(g);
  const out = new Float32Array(g.morphTargets.length * 3);
  g.morphTargets.forEach((t, m) => {
    if (!t.positions) return;
    for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) out[m * 3 + k] = Math.max(out[m * 3 + k], Math.abs(t.positions[v * 3 + k]));
  });
  return out;
}

/** The rest box grown by the morph targets at `weights` (`reach` from `morphReach`). */
export function morphedBox(rest: Box6, reach: Float32Array, weights: ArrayLike<number>): Box6 {
  const b: Box6 = [...rest];
  const targets = reach.length / 3;
  for (let m = 0; m < targets && m < weights.length; m++) {
    const w = Math.abs(Number(weights[m]) || 0);
    if (!w) continue;
    for (let k = 0; k < 3; k++) {
      b[k] -= reach[m * 3 + k] * w;
      b[k + 3] += reach[m * 3 + k] * w;
    }
  }
  return b;
}

/**
 * The bounds of the skinned mesh: `box` (the morphed rest box) through each of `joints`' palette
 * matrices (row-major 3×4, D10), united. No joints (no skin): `box` itself.
 */
export function skinnedBox(box: Box6, palette: Float32Array, joints: readonly number[]): Box6 {
  if (!joints.length) return [...box];
  const out: Box6 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const j of joints) {
    const o = j * PALETTE_FLOATS;
    if (o + PALETTE_FLOATS > palette.length) continue;
    for (let row = 0; row < 3; row++) {
      // Per row, the extremes of a·p + t over the box are found per axis (the box's projection).
      let lo = palette[o + row * 4 + 3];
      let hi = lo;
      for (let k = 0; k < 3; k++) {
        const a = palette[o + row * 4 + k];
        const e0 = a * box[k];
        const e1 = a * box[k + 3];
        lo += Math.min(e0, e1);
        hi += Math.max(e0, e1);
      }
      if (lo < out[row]) out[row] = lo;
      if (hi > out[row + 3]) out[row + 3] = hi;
    }
  }
  return out[0] === Infinity ? [...box] : out;
}

/** `box` through a column-major affine 4×4 matrix (the engine's world matrices) at `offset`: the transformed box's bounds. */
export function transformBox(box: Box6, m: ArrayLike<number>, offset = 0): Box6 {
  const out: Box6 = [0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row++) {
    let lo = m[offset + 12 + row];
    let hi = lo;
    for (let k = 0; k < 3; k++) {
      const a = m[offset + k * 4 + row];
      const e0 = a * box[k];
      const e1 = a * box[k + 3];
      lo += Math.min(e0, e1);
      hi += Math.max(e0, e1);
    }
    out[row] = lo;
    out[row + 3] = hi;
  }
  return out;
}
