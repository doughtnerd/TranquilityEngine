// The bone gizmo (ADR 0373 "Skeleton and retarget tools"; T18): while the Inspector's target is a bone, the scene view
// draws its axes (x red, y green, z blue) at the bone's current transform, the skeleton node's world matrix × the bone's
// model-space matrix (D104), so it follows the animated pose. Display only, like the joint gizmos (an always-on viewport
// tool that never becomes active and takes no presses); the bone is read-only.
import type { EditorOverlay } from "../../../../engine/editor";
import { editor, type ViewportToolContribution } from "../../../../editor/sdk";
import { boneWorldMatrix } from "./bones";

const AXIS_COLORS = [0xe5484d, 0x46a758, 0x3e63dd] as const;
/** Axis length as a share of the rig's rest radius, with a floor so a tiny rig still shows. */
const AXIS_SHARE = 0.12;
const AXIS_MIN = 0.02;

type V3 = [number, number, number];

/** The bone's three axis lines in world space, from its world matrix (column-major 4×4) and the rig's size. */
function boneAxisLines(matrix: ArrayLike<number>, size: number): EditorOverlay["lines"] {
  const origin: V3 = [matrix[12]!, matrix[13]!, matrix[14]!];
  const length = Math.max(AXIS_MIN, size * AXIS_SHARE);
  return AXIS_COLORS.map((color, axis) => {
    const x = matrix[axis * 4]!, y = matrix[axis * 4 + 1]!, z = matrix[axis * 4 + 2]!;
    const n = Math.hypot(x, y, z) || 1;
    const end: V3 = [origin[0] + (x / n) * length, origin[1] + (y / n) * length, origin[2] + (z / n) * length];
    return { points: [origin, end], closed: false, color };
  });
}

/** What the gizmo draws this frame: the selected bone's axes, or nothing. */
function boneOverlay(): EditorOverlay {
  const selected = editor.scene.selection.bone;
  const scene = editor.scene.peekOpen();
  if (!selected || !scene) return { lines: [], handles: [] };
  const found = boneWorldMatrix(scene, selected.path, selected.bone);
  return { lines: found ? boneAxisLines(found.matrix, found.size) : [], handles: [] };
}

/** @internal The scene view's bone gizmo. */
export const boneGizmoTool: ViewportToolContribution = {
  id: "myco.animation.bone",
  install(view) {
    view.overlay(boneOverlay, { kind: "other" });
  },
};
