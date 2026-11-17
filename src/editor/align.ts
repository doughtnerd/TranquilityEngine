// Align and distribute (ADR 0022): line several selected nodes up by their bounds (sprite boxes, or
// origins for nodes without one) along an axis, or space them evenly. One undo step per action,
// with overrides on prefab instances, like the gizmo.
import { localPositionFor, worldBounds } from "../engine/editor";
import type { SceneDocument } from "./document";
import { gizmoEdit } from "./gizmo";
import { topmostKeys } from "./selectionModel";
import { openScene, selectedNodes, status } from "./state";
import { alignOffsets, distributeOffsets, type Axis, type Edge } from "./boxAlign";
import { undoStep } from "./undoStep";

export type { Axis, Edge } from "./boxAlign";

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
  undoStep(scene.stack, `${actionLabel(action, planar)} (${targets.length} nodes)`, () => {
    for (const m of moves) scene.stack.execute(gizmoEdit(scene.doc, m.path, "translate", { position: m.position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, "position"));
  });
  return moves.length;
}
