/**
 * A camera's view offset (ADR 0436): a camera-space position (world units) and rotation (degrees, applied yaw Y,
 * pitch X, roll Z) the renderer adds to the camera's view this frame, after reading its node's world matrix and
 * before pixel snapping. Only the drawn view moves: the camera's Transform, physics, the audio listener and camera rays
 * (ADR 0073) keep the node's pose.
 *
 * Writers *add* to it (camera shake is the first; head bob or recoil kick can be others). The `engine.CameraViewOffsets`
 * system zeroes every offset at the start of each frame's `update` phase, before scripts, so a writer adds its
 * contribution every frame it wants one, and an offset nobody writes is gone the next frame, in every World, headless
 * ones included.
 */
import { defineComponent, f32 } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";

export const CameraViewOffset = defineComponent("engine.CameraViewOffset", { px: f32, py: f32, pz: f32, rx: f32, ry: f32, rz: f32 });

defineBuiltinSystem({
  name: "engine.CameraViewOffsets",
  phase: "update",
  before: ["engine.UpdateScripts"],
  run(world) {
    const store = world._dataStore(CameraViewOffset);
    if (store.dense.length === 0) return;
    for (const f of CameraViewOffset.fields) store.arrays[f]!.fill(0);
  },
});
