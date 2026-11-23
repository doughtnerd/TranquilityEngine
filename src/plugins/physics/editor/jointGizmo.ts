// Joint gizmos: every 3D and 2D joint in the edited scene is drawn in orange (the selected node's
// brighter): a cross at its anchor, a line to the connected anchor, a hinge's axis and limits arc,
// a slider's axis and range, a spring's zig-zag. 2D joints lie in the XY plane at the node's z.
// Display only: the joints are edited in the Inspector. The Physics plugin's always-on viewport tool
// `myco.physics.joints` (ADR 0138, 0142): it never becomes active and takes no presses.
// What a joint is and where its anchors are come from the joint class itself (`_jointFields`, `_worldAnchors`,
// ADR 0305), as the physics worlds build it; 2D axes turn and mirror with the node's 2D frame (ADR 0301).
import { GameObject, type Engine } from "../../../engine";
import { Quat, Vector3 } from "../../../engine/core/math";
import { Joint, Joint2D } from "../runtime";
import { fromXTo } from "../runtime/jointFrame";
import type { EditorOverlay } from "../../../engine/editor";
import { frame2DOf, frameDirection } from "../../../engine/scene/frame2d";
import { jointWire, type JointShape, type V3 } from "./jointMath";
import { type ViewportToolContribution, editor, shapeKit3d } from "../../../editor/sdk";

const { pose3DOf, rotate } = shapeKit3d;

const COLOR = 0xe8a33d;
const COLOR_SELECTED = 0xffcf70;

/** The 3D joint's shape in world space. */
function joint3DShape(j: Joint): JointShape | null {
  if (!j.node.transform) return null;
  const fields = j._jointFields();
  const shape: JointShape = { kind: fields.kind, ...j._worldAnchors() };
  if (fields.kind === "hinge" || fields.kind === "slider") {
    shape.axis = rotate(pose3DOf(j.node).rotation, fields.axis);
    shape.limits = fields.limits;
  }
  if (fields.kind === "ball") {
    const axis = rotate(pose3DOf(j.node).rotation, fields.axis);
    shape.axis = axis;
    if (fields.limits) {
      // The joint's frame, as the physics world builds it: the shortest turn of x onto the twist axis carries y and z.
      const frame = fromXTo(new Vector3(...axis).normalize());
      const turn = (v: V3): V3 => Quat.rotate(frame, new Vector3(...v)).toArray() as V3;
      shape.ball = { twist: fields.limits.twist, swing: fields.limits.swing, frameY: turn([0, 1, 0]), frameZ: turn([0, 0, 1]) };
    }
  }
  return shape;
}

/** The 2D joint's shape in world space (in the XY plane at the node's z). */
function joint2DShape(j: Joint2D): JointShape | null {
  if (!j.node.transform) return null;
  const fields = j._jointFields();
  const frame = frame2DOf(j.node);
  const shape: JointShape = { kind: fields.kind, ...j._worldAnchors() };
  if (fields.kind === "hinge") {
    shape.axis = [0, 0, 1];
    shape.ref = [Math.cos(frame.angle), Math.sin(frame.angle), 0];
    shape.limits = fields.limits;
  } else if (fields.kind === "slider") {
    shape.axis = [...frameDirection(frame, fields.axis), 0];
    shape.limits = fields.limits;
  }
  return shape;
}

/** What to draw this frame: every joint in the edited scene. */
function jointOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(editor.scene.selection.nodes().map((s) => s.node));
  const draw = (node: GameObject, shape: JointShape | null) => {
    if (!shape) return;
    const color = selected.has(node) ? COLOR_SELECTED : COLOR;
    for (const points of jointWire(shape)) overlay.lines.push({ points, closed: false, color });
  };
  for (const j of GameObject.findObjectsOfType(Joint)) {
    if (j.node.transform && engine.world.inEditMode(j.node.entity)) draw(j.node, joint3DShape(j));
  }
  for (const j of GameObject.findObjectsOfType(Joint2D)) {
    if (j.node.transform && engine.world.inEditMode(j.node.entity)) draw(j.node, joint2DShape(j));
  }
  return overlay;
}

/** The scene view's joint drawing, toggled with the collider gizmos. */
export const jointTool: ViewportToolContribution = {
  id: "myco.physics.joints",
  install(view) {
    view.overlay(() => jointOverlay(view.engine), { kind: "colliders" });
  },
};
