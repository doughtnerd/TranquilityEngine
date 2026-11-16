// The transform gizmo's on-screen size (ADR 0022, ADR 0075 stage 8): the root scale that draws
// Babylon's gizmo handles the size three's TransformControls drew them, so the editor's gizmo kept its
// look when the backend changed. One sizing model; `editorGizmo.ts` applies it each frame.
//
// three (TransformControls.updateMatrixWorld) scales every handle by `factor * size / 4`, where
//   perspective:  factor = distance(gizmo, camera) * min(1.9 * tan(fov / 2) / zoom, 7)
//                 (1.9 * tan(fov / 2) * distance is 0.95 x the visible world height at the gizmo)
//   orthographic: factor = (top - bottom) / zoom   (the visible world height)
// and its geometry is authored in unit-ish handle units: the move arrow's tip is 0.6 out, the
// rotation ring's radius 0.5, the scale handle's far edge 0.58.
//
// Babylon (Gizmo._update, updateScale on) sets the gizmo root's scale to `scaleRatio x depth along the
// camera's forward axis` (perspective: depth, not distance, so it shrinks toward the screen edge and
// ignores fov) or `scaleRatio x (orthoTop - orthoBottom)`. Its geometry is authored smaller and under a
// 1/3 child scale: the move arrow's tip is 0.3375 / 3 = 0.1125 out, the ring's radius 0.3 / 3 = 0.1,
// the scale box's far edge 0.32 / 3 = 0.1067.
//
// So the root scale that puts Babylon's handles where three's are is
//   R = (factor * size / 4) * (three reach / Babylon reach)
// per mode (the ratios are 5.333, 5 and 5.4375). We turn `updateScale` off and set `scaleRatio = R`
// (with updateScale off Babylon sets the root scale to exactly `scaleRatio`) every frame, using three's
// own distance and fov terms, so even off-centre gizmos match. `zoom` is 1 here: Babylon's orthographic
// zoom is already in orthoTop/orthoBottom. `size` is three's default of 1.

import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { GizmoOptions } from "../editorViewport";

type Mode = GizmoOptions["mode"];

/** TransformControls.size. */
const GIZMO_SIZE = 1;
const THREE_REACH: Record<Mode, number> = { translate: 0.6, rotate: 0.5, scale: 0.58 };
const BABYLON_REACH: Record<Mode, number> = { translate: 0.3375 / 3, rotate: 0.3 / 3, scale: 0.32 / 3 };

/** The root scale (Babylon `scaleRatio` with `updateScale` off) giving a `mode` gizmo at `at` the on-screen size three's TransformControls draws. */
export function gizmoRootScale(mode: Mode, camera: Camera, at: Vector3): number {
  let factor: number;
  if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
    factor = (camera.orthoTop ?? 1) - (camera.orthoBottom ?? -1);
  } else {
    let fov = camera.fov; // vertical, as three's
    if (camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED) fov = 2 * Math.atan(Math.tan(fov / 2) / camera.getScene().getEngine().getAspectRatio(camera));
    factor = Vector3.Distance(at, camera.getWorldMatrix().getTranslation()) * Math.min(1.9 * Math.tan(fov / 2), 7);
  }
  return ((factor * GIZMO_SIZE) / 4) * (THREE_REACH[mode] / BABYLON_REACH[mode]);
}
