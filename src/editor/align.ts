// Align and distribute (ADR 0022): line several selected nodes up by their bounds (sprite boxes, or
// origins for nodes without one) along an axis, or space them evenly. One undo step per action,
// with overrides on prefab instances, like the gizmo.
import { localPositionFor, worldBounds } from "../engine/editor";
import type { SceneDocument } from "./document";
import { gizmoEdit } from "./gizmo";
import { topmostKeys } from "./selectionModel";
import { openScene, selectedNodes, status } from "./state";

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

export type AlignAction = { kind: "align"; axis: Axis; edge: Edge } | { kind: "distribute"; axis: Axis };

const AXIS = ["X", "Y", "Z"];
const EDGE_2D: Record<string, string> = { "0min": "left", "0center": "centre", "0max": "right", "1min": "bottom", "1center": "middle", "1max": "top" };

/** A label for an action, in the 2D view's words (left, top…) where there are some. */
export function actionLabel(a: AlignAction, planar: boolean): string {
  if (a.kind === "distribute") return planar && a.axis < 2 ? `Distribute ${a.axis === 0 ? "horizontally" : "vertically"}` : `Distribute along ${AXIS[a.axis]}`;
  const word = planar ? EDGE_2D[`${a.axis}${a.edge}`] : undefined;
  return word ? `Align ${word}` : `Align ${AXIS[a.axis]} ${a.edge === "center" ? "centre" : a.edge}`;
}

/** The fewest nodes an action needs. */
export const minNodes = (a: AlignAction) => (a.kind === "align" ? 2 : 3);

/** Nodes an align action moves: the topmost selected nodes (a child of a selected node moves with it). */
export function alignTargets(doc: SceneDocument) {
  const selected = selectedNodes().filter((s) => s.node.transform);
  const top = new Set(topmostKeys(doc, selected.map((s) => s.key)));
  return selected.filter((s) => top.has(s.key));
}

const tidy = (n: number) => {
  const r = Math.round(n * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
};

/** Run an align or distribute action on the selection, as one undo step. Returns how many nodes moved. */
export function runAlign(action: AlignAction, planar: boolean): number {
  const scene = openScene.value;
  if (!scene) return 0;
  const targets = alignTargets(scene.doc);
  if (targets.length < minNodes(action)) {
    status.value = { kind: "info", text: `${actionLabel(action, planar)} needs ${minNodes(action)} or more selected nodes.` };
    return 0;
  }
  const boxes = targets.map((t) => worldBounds(t.node));
  const offsets = action.kind === "align" ? alignOffsets(boxes, action.axis, action.edge) : distributeOffsets(boxes, action.axis);
  const moves = targets.flatMap((t, i) => {
    if (Math.abs(offsets[i]) < 1e-9) return [];
    const p = t.node.transform!.worldPosition;
    const world = [p.x, p.y, p.z];
    world[action.axis] += offsets[i];
    const position = localPositionFor(t.node, world).map(tidy) as [number, number, number];
    return [{ path: t.path, position }];
  });
  if (moves.length === 0) return 0;
  scene.stack.beginGroup(`${actionLabel(action, planar)} (${targets.length} nodes)`);
  try {
    for (const m of moves) scene.stack.execute(gizmoEdit(scene.doc, m.path, "translate", { position: m.position, rotation: [0, 0, 0], scale: [1, 1, 1] }, "position"));
  } finally {
    scene.stack.endGroup();
  }
  return moves.length;
}
