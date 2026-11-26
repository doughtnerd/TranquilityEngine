// `animation.Gather` sub-step: playback (T17). Animator fields (update mode, culling and visibility, LOD rate, layer
// weights, root-motion baking) into each instance's input row, then its queued play and stop commands, in call order,
// onto the World's command writer (ADR 0370, 0372). Only the Animators of the frame's mode take part: fixed-mode ones
// in `animation.FixedEvaluate`, the others in lateUpdate.
import {
  CULL_ALWAYS,
  CULL_ROOT_MOTION_ONLY,
  CULL_WHEN_VISIBLE,
  FLAG_BAKE_ROOT,
  FLAG_FIXED,
  FLAG_UNSCALED,
  FLAG_VISIBLE,
  HANDLE_INDEX_MASK,
  INPUT_FLAGS,
  INPUT_LAYER_WEIGHTS,
  INPUT_LOD_STEP,
  INPUT_STRIDE,
  INPUT_TIME_SCALE,
  MAX_LAYERS,
} from "../../wasm/wire/core";
import { animatorsOf, releaseEarlierClips, type AnimatorRuntime } from "../../features/instances";
import { gameplayOnly } from "../../features/network/ghosts";
import { syncServerBones } from "../../features/network/serverBones";
import { flushQueue } from "../../features/playback/plays";
import { cameraViews, isVisible, lodStep, type CameraViews } from "../../features/playback/view";
import type { AnimationFrame } from "../frame";

const CULL = { always: CULL_ALWAYS, whenVisible: CULL_WHEN_VISIBLE, rootMotionOnly: CULL_ROOT_MOTION_ONLY } as const;

/** @internal Whether `rt` runs in `frame`'s pass (it has an instance in this World, and its update mode matches). */
export function inPass(frame: AnimationFrame, rt: AnimatorRuntime): boolean {
  return rt.instance !== 0 && rt.ns === frame.core && (rt.animator.updateMode === "fixed") === frame.fixed;
}

function writeRow(frame: AnimationFrame, rt: AnimatorRuntime, cams: CameraViews): void {
  const a = rt.animator;
  // Servers evaluate only what gameplay reads (T33): culled as `rootMotionOnly`, unless a BoneAttachment needs the pose.
  const serverOnly = gameplayOnly(rt);
  syncServerBones(rt); // and of a followed skeleton, only the followed bones' matrices (T70)
  const visible = !serverOnly && isVisible(cams, rt);
  const cull = serverOnly ? CULL_ROOT_MOTION_ONLY : (CULL[a.cullingMode] ?? CULL_ALWAYS);
  rt.visible = visible;
  rt.frozen = !visible && cull !== CULL_ALWAYS;
  let flags: number = cull;
  if (visible) flags |= FLAG_VISIBLE;
  if (a.updateMode === "unscaled") flags |= FLAG_UNSCALED;
  else if (a.updateMode === "fixed") flags |= FLAG_FIXED;
  if (a.rootMotion !== "none") flags |= FLAG_BAKE_ROOT;
  const inputs = frame.core.core.views().inputs;
  const row = (rt.instance & HANDLE_INDEX_MASK) * INPUT_STRIDE;
  inputs.setFloat32(row + INPUT_TIME_SCALE, 1, true);
  inputs.setUint32(row + INPUT_LOD_STEP, lodStep(cams, rt), true);
  inputs.setUint32(row + INPUT_FLAGS, flags, true);
  for (let l = 0; l < MAX_LAYERS; l++) {
    const w = rt.layerWeights[l]!;
    if (!Number.isNaN(w)) inputs.setFloat32(row + INPUT_LAYER_WEIGHTS + 4 * l, w, true);
  }
}

/** @internal */
export function gatherPlayback(frame: AnimationFrame): void {
  let cams: CameraViews | null = null;
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt)) continue;
    cams ??= cameraViews(frame.world);
    writeRow(frame, rt, cams);
    flushQueue(frame, rt);
    if (rt.earlierClips) releaseEarlierClips(rt); // clips of an earlier skeleton whose plays have ended since
  }
}
