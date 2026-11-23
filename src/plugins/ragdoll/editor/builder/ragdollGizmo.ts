// The ragdoll builder's gizmos (ADR 0373 "edit shapes and limits with gizmos"; T55): the viewport tool `myco.ragdoll.builder`.
// With a Ragdoll node selected, the scene view outlines every body at its bone's pose (the selected table row's brighter)
// and draws the selected body's joint: the swing cone and the twist arc, from the physics plugin's joint maths. With "Edit
// Ragdoll" on (the toggle the host adds to the Ragdoll card, ADR 0266) the selected body gets handles: its shape's size
// handles (a capsule's radius and height, a box's three sizes, a sphere's radius) and the joint's four limit handles (swing
// y and z, twist min and max). A handle drag is one undo step (an override on prefab instances; Escape puts it back).
// What each body looks like and what a drag sets is `gizmoGeometry.ts`; this module is the loop over it: finding the
// bodies' poses, drawing, picking, and writing the accepted `bones` list through the component field write (ADR 0257).
import { signal } from "@preact/signals";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { viewport, type EditorOverlay } from "../../../../engine/editor";
import { type ComponentEditMode, type ViewportToolContribution, editor, theme, viewportColors } from "../../../../editor/sdk";
import { boneWorldMatrixOf } from "../../../animation/runtime";
import type { SkeletonInfo } from "../../../animation/runtime";
import { Ragdoll, type RagdollBone } from "../../runtime/Ragdoll";
import { bodyHandles, bodyMatrix, dragPatch, handlesToWorld, invertAffine, jointLimitWire, shapeWire, transformPoint, wireToWorld } from "./gizmoGeometry";
import { editBone } from "./ragdollLogic";
import { findRigSkeleton } from "./rigLookup";
import { skeletonInfoIfLoaded } from "./skeletonInfo";

/** The tool's id: also its overlay id and its active-tool id. */
export const RAGDOLL_TOOL_ID = "myco.ragdoll.builder";

/** The bone whose body the gizmo shows (a table row's selection), per session. */
export const selectedBodyBone = signal<string | null>(null);

/** The ragdoll being edited ("Edit Ragdoll"), or null. */
export const editingRagdoll = editor.viewport.mode<ComponentEditMode>(RAGDOLL_TOOL_ID);

const BODY = 0x4a90b8;
const BODY_SELECTED = 0x9ddcff;
const JOINT = 0xffcf70;

type V3 = [number, number, number];

/** The selected node's Ragdoll with the node of its Skeleton, or null. */
function selectedRagdoll(): { node: GameObject; ragdoll: Ragdoll; rig: GameObject; info: SkeletonInfo } | null {
  const node = editor.scene.selection.node();
  const ragdoll = node?.getComponent(Ragdoll);
  const rig = node && findRigSkeleton(node);
  const info = rig && skeletonInfoIfLoaded(rig.skeleton.skeleton);
  if (!node || !ragdoll || !rig || !info) return null;
  return { node, ragdoll, rig: rig.node, info };
}

/** A body's frame in the world now: its bone's world matrix turned by the body's frame, or null when the bone isn't posed. */
function bodyFrame(sel: { rig: GameObject; info: SkeletonInfo }, b: RagdollBone): number[] | null {
  const bone = boneWorldMatrixOf(sel.rig, sel.info, b.bone);
  return bone ? bodyMatrix(bone, b.frame) : null;
}

/** What to draw this frame: every body of the selected Ragdoll, the selected one's joint, and its handles while editing. */
function ragdollOverlay(): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  const sel = selectedRagdoll();
  if (!sel) return overlay;
  const selected = selectedBodyBone.value;
  const editing = editingRagdoll.value !== null;
  for (const b of sel.ragdoll.bones) {
    const m = bodyFrame(sel, b);
    if (!m) continue;
    const isSelected = b.bone === selected;
    for (const points of wireToWorld(m, shapeWire(b))) overlay.lines.push({ points, closed: false, color: isSelected ? BODY_SELECTED : BODY });
    if (!isSelected) continue;
    for (const points of wireToWorld(m, jointLimitWire(b))) overlay.lines.push({ points, closed: false, color: JOINT });
    if (editing) {
      const color = viewportColors(theme.peek()).handle; // the theme's accent
      for (const [id, position] of Object.entries(handlesToWorld(m, bodyHandles(b)))) overlay.handles.push({ id, position, color });
    }
  }
  return overlay;
}

/** The scene view's ragdoll tool: body outlines, the selected joint's limits, and handle drags while "Edit Ragdoll" is on. */
export const ragdollTool: ViewportToolContribution<ComponentEditMode> = {
  id: RAGDOLL_TOOL_ID,
  editsComponents: {
    types: ["engine.Ragdoll"],
    label: "Edit Ragdoll",
    hint: "Show handles in the viewport to resize the selected body and set its joint's swing and twist limits",
    stopHint: "Stop editing the ragdoll (handles hide, the transform gizmo returns)",
  },
  install(view) {
    const { world } = view;
    view.overlay(ragdollOverlay, { kind: "other" });
    view.onPress((p) => {
      if (p.button !== 0) return null;
      const mode = editingRagdoll.peek();
      const sel = selectedRagdoll();
      const scene = editor.scene.peekOpen();
      const bone = selectedBodyBone.peek();
      const body = sel?.ragdoll.bones.find((b) => b.bone === bone);
      if (!mode || !sel || !scene || !body) return null;
      const id = viewport(world).pickOverlayHandle(p.x, p.y);
      if (!id) return null;
      const m = bodyFrame(sel, body);
      const inverse = m && invertAffine(m);
      const ray = viewport(world).rayAt(p.x, p.y);
      const handle = m && bodyHandles(body)[id];
      // A press on a handle never also selects, orbits or starts the transform gizmo, even when it changes nothing.
      if (!m || !inverse || !ray || !handle) return {};
      // The pointer moves on the plane through the handle that faces the camera; its point in the body frame sets the value.
      const at = transformPoint(m, handle);
      const normal: V3 = [-ray.direction[0], -ray.direction[1], -ray.direction[2]];
      const place = { scene, path: mode.key.split("/"), type: mode.type, index: mode.index };
      const start = sel.ragdoll.bones;
      return (
        view.gesture("Edit ragdoll body", {
          move: (q) => {
            const hit = viewport(world).pointOnPlane(q.x, q.y, normal, at);
            if (!hit) return;
            const patch = dragPatch(body, id, transformPoint(inverse, hit));
            const result = patch && editBone(start, body.bone, patch);
            if (result && "next" in result) void editor.scene.writeField(place, "bones", result.next);
          },
        }) ?? {}
      );
    });
  },
};
