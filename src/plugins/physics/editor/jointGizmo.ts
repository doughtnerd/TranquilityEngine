// Joint gizmos: every 3D and 2D joint in the edited scene is drawn in orange (the selected node's
// brighter): a cross at its anchor, a line to the connected anchor, a hinge's axis and limits arc,
// a slider's axis and range, a spring's zig-zag. 2D joints lie in the XY plane at the node's z.
// Display only: the joints are edited in the Inspector. The Physics plugin's always-on viewport tool
// `myco.physics.joints` (ADR 0138, 0142): it never becomes active and takes no presses.
import { GameObject, type Engine } from "../../../engine";
import { Joint, Joint2D, AxisJoint, AxisJoint2D, BallJoint, FixedJoint, FixedJoint2D, HingeJoint, HingeJoint2D, RopeJoint, RopeJoint2D, SliderJoint, SliderJoint2D, SpringJoint, SpringJoint2D } from "../runtime";
import type { EditorOverlay } from "../../../engine/editor";
import type { ViewportToolContribution } from "../../../editor/sdk";
import { worldCenter } from "./collider3dMath";
import { toWorld } from "./colliderMath";
import { jointWire, type JointKind, type JointShape, type V3 } from "./jointMath";
import { poseOf, pose3DOf } from "./colliderGizmo";
import { rotate } from "./collider3dMath";
import { selectedNodes } from "../../../editor/state";

const COLOR = 0xe8a33d;
const COLOR_SELECTED = 0xffcf70;

const kindOf3D = (j: Joint): JointKind =>
  j instanceof HingeJoint ? "hinge" : j instanceof SliderJoint ? "slider" : j instanceof BallJoint ? "ball" : j instanceof RopeJoint ? "rope" : j instanceof SpringJoint ? "spring" : j instanceof FixedJoint ? "fixed" : "fixed";
const kindOf2D = (j: Joint2D): JointKind =>
  j instanceof HingeJoint2D ? "hinge" : j instanceof SliderJoint2D ? "slider" : j instanceof RopeJoint2D ? "rope" : j instanceof SpringJoint2D ? "spring" : j instanceof FixedJoint2D ? "fixed" : "fixed";

/** The 3D joint's shape in world space. */
export function joint3DShape(j: Joint): JointShape | null {
  const node = j.node;
  if (!node.transform) return null;
  const pose = pose3DOf(node);
  const kind = kindOf3D(j);
  const anchor = worldCenter(pose, [j.anchor.x, j.anchor.y, j.anchor.z]);
  const other = j.connectedBody?.isValid && j.connectedBody.transform ? j.connectedBody : null;
  let connected: V3 | null = null;
  if (j.autoConfigureConnectedAnchor) {
    // Rope and spring joints measure from the connected body's origin; the others share the anchor.
    if (other && (kind === "rope" || kind === "spring")) connected = pose3DOf(other).position;
  } else if (other) {
    connected = worldCenter(pose3DOf(other), [j.connectedAnchor.x, j.connectedAnchor.y, j.connectedAnchor.z]);
  } else {
    connected = [j.connectedAnchor.x, j.connectedAnchor.y, j.connectedAnchor.z];
  }
  const shape: JointShape = { kind, anchor, connected };
  if (j instanceof AxisJoint) {
    shape.axis = rotate(pose.rotation, [j.axis.x, j.axis.y, j.axis.z]);
    shape.limits = j.useLimits && j.limits ? { min: j.limits.min, max: j.limits.max } : null;
  }
  return shape;
}

/** The 2D joint's shape in world space (in the XY plane at the node's z). */
export function joint2DShape(j: Joint2D): JointShape | null {
  const node = j.node;
  if (!node.transform) return null;
  const pose = poseOf(node);
  const kind = kindOf2D(j);
  const anchor = toWorld(pose, [j.anchor.x, j.anchor.y]);
  const other = j.connectedBody?.isValid && j.connectedBody.transform ? j.connectedBody : null;
  let connected: V3 | null = null;
  if (j.autoConfigureConnectedAnchor) {
    if (other && (kind === "rope" || kind === "spring")) connected = [...poseOf(other).position] as V3;
  } else if (other) {
    connected = toWorld(poseOf(other), [j.connectedAnchor.x, j.connectedAnchor.y]);
  } else {
    connected = [j.connectedAnchor.x, j.connectedAnchor.y, pose.position[2]];
  }
  const shape: JointShape = { kind, anchor, connected };
  const a = (pose.rotation * Math.PI) / 180;
  if (j instanceof HingeJoint2D) {
    shape.axis = [0, 0, 1];
    shape.ref = [Math.cos(a), Math.sin(a), 0];
  } else if (j instanceof SliderJoint2D) {
    const ax = j.axis.x, ay = j.axis.y;
    shape.axis = [ax * Math.cos(a) - ay * Math.sin(a), ax * Math.sin(a) + ay * Math.cos(a), 0];
  }
  if (j instanceof AxisJoint2D) shape.limits = j.useLimits && j.limits ? { min: j.limits.min, max: j.limits.max } : null;
  return shape;
}

/** What to draw this frame: every joint in the edited scene. */
export function jointOverlay(engine: Engine): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const selected = new Set(selectedNodes().map((s) => s.node));
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
