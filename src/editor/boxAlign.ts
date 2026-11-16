// Box alignment: how far each of several axis-aligned boxes moves to line up along an axis or to be
// spaced evenly. Pure geometry; align.ts applies it to the selected nodes' bounds (ADR 0022).

export type Axis = 0 | 1 | 2;
export type Edge = "min" | "center" | "max";

/** A world-space box. */
export interface Box {
  min: readonly number[];
  max: readonly number[];
}

const centerOf = (b: Box, axis: Axis) => (b.min[axis] + b.max[axis]) / 2;

/** How far each box moves along `axis` so its `edge` lines up with that edge of all of them together. */
export function alignOffsets(boxes: readonly Box[], axis: Axis, edge: Edge): number[] {
  if (boxes.length === 0) return [];
  const lo = Math.min(...boxes.map((b) => b.min[axis])), hi = Math.max(...boxes.map((b) => b.max[axis]));
  const target = edge === "min" ? lo : edge === "max" ? hi : (lo + hi) / 2;
  return boxes.map((b) => target - (edge === "min" ? b.min[axis] : edge === "max" ? b.max[axis] : centerOf(b, axis)));
}

/**
 * How far each box moves along `axis` to space them evenly: the outermost two (by centre) stay, and
 * the others move so the gaps between neighbouring boxes are equal (for points, equal spacing).
 */
export function distributeOffsets(boxes: readonly Box[], axis: Axis): number[] {
  const out = boxes.map(() => 0);
  if (boxes.length < 3) return out;
  const order = boxes.map((b, i) => i).sort((a, b) => centerOf(boxes[a], axis) - centerOf(boxes[b], axis) || a - b);
  const first = boxes[order[0]], last = boxes[order[order.length - 1]];
  const sizes = order.map((i) => boxes[i].max[axis] - boxes[i].min[axis]);
  const span = last.max[axis] - first.min[axis];
  const gap = (span - sizes.reduce((s, n) => s + n, 0)) / (order.length - 1);
  let cursor = first.min[axis];
  order.forEach((i, k) => {
    out[i] = cursor - boxes[i].min[axis];
    cursor += sizes[k] + gap;
  });
  out[order[order.length - 1]] = 0; // exactly, without rounding drift
  return out;
}
