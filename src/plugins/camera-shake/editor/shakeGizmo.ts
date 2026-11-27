// The Camera Shake plugin's viewport tool `myco.camera-shake.reach` (ADR 0138, 0435 "Editor"): each selected node's
// ShakeImpulseSources draw their reach around the node, `radius` in the theme's accent and `radius +
// dissipationDistance` in the camera gizmo colour; circles in the XY plane while the scene view is 2D (its grid lies in
// XY), spheres as three great circles in 3D. Display only: it never becomes active and takes no presses.
import { type EditorOverlay, viewport } from "../../../engine/editor";
import { type ViewportToolContribution, editor, shapeKit3d, theme, viewportColors } from "../../../editor/sdk";
import { ShakeImpulseSource } from "../runtime/ShakeImpulseSource";
import { reachRadii, ringWire } from "./reachRings";

const SHAKE_REACH_TOOL_ID = "myco.camera-shake.reach";

export const shakeReachTool: ViewportToolContribution = {
  id: SHAKE_REACH_TOOL_ID,
  install(view) {
    const { engine, world } = view;
    view.overlay((): EditorOverlay => {
      const overlay: EditorOverlay = { lines: [], handles: [] };
      const sources = editor.scene.selection.nodes().flatMap((s) => (s.node.transform && engine.world.inEditMode(s.node.entity) ? s.node.getComponents(ShakeImpulseSource) : []));
      if (sources.length === 0) return overlay;
      const colors = viewportColors(theme.peek());
      const flat = viewport(world).grid()?.plane === "xy";
      for (const source of sources) {
        const centre = shapeKit3d.pose3DOf(source.node).position;
        const { radius, outer } = reachRadii(source.radius, source.dissipationDistance);
        for (const points of ringWire(centre, radius, flat)) overlay.lines.push({ points, closed: false, color: colors.handle });
        if (outer > radius) for (const points of ringWire(centre, outer, flat)) overlay.lines.push({ points, closed: false, color: colors.cameraGizmo });
      }
      return overlay;
    }, { kind: "other" });
  },
};
