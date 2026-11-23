// The rig gizmos in the scene view (ADR 0373 "gizmos in the viewport (IK targets, pole vectors, spring-bone colliders,
// look-at limits)"), through the viewport tool mechanism the bone gizmo uses: while a rig entry is picked in the graph
// editor and the selected node has a Skeleton, its overlay draws that entry's shapes (`rigLogic.ts`) at the bones' current
// world matrices, so they follow the animated pose. Display only, like the bone and joint gizmos: an always-on tool that
// never becomes active and takes no presses.
import { signal } from "@preact/signals";
import type { EditorOverlay } from "../../../../engine/editor";
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import { editor, type ViewportToolContribution } from "../../../../editor/sdk";
import { boneWorldMatrix } from "../scene/bones";
import { nodeById } from "./graphEditLogic";
import { rigBones, rigGizmoLines } from "./rigLogic";

/** @internal The rig entry picked in the graph editor: its graph's path and node id, or null. */
export const pickedRigEntry = signal<{ path: string; node: string } | null>(null);

/** What the gizmo draws this frame: the picked entry's shapes on the selected node's skeleton, or nothing. */
function rigOverlay(): EditorOverlay {
  const picked = pickedRigEntry.value;
  const scene = editor.scene.peekOpen();
  const path = editor.scene.selection.path();
  const project = editor.project.current;
  if (!picked || !scene || !path || !project || !project.files.includes(picked.path)) return { lines: [], handles: [] };
  const graph = editor.assets.read<AnimGraph>(project, picked.path).value;
  const node = nodeById(graph, picked.node);
  if (!node || node.family !== "rig") return { lines: [], handles: [] };
  const size = rigBones(node).map((b) => boneWorldMatrix(scene, path, b)).find((f) => f)?.size ?? 1;
  const lines = rigGizmoLines(node, (bone) => boneWorldMatrix(scene, path, bone)?.matrix ?? null, size);
  return { lines: lines.map((l) => ({ points: l.points, closed: l.closed, color: l.color })), handles: [] };
}

/** @internal The scene view's rig gizmos. */
export const rigGizmoTool: ViewportToolContribution = {
  id: "myco.animation.rig",
  install(view) {
    view.overlay(rigOverlay, { kind: "other" });
  },
};
