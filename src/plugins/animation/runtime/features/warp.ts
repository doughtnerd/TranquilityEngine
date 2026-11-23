// Motion warping from code (ADR 0372; T40t, D42, D67): `Animator.warp(window, target)` sets where a clip's warp window
// lands. Targets are read in `animation.Gather` (`stages/gather/warp.ts`) as `WARP_TARGET` commands (world space).
//
// - `window` names a `rig/motionWarp` node of the Animator's graph: its id, its name, or the cue marker that opens its
//   window (`warp/windows.ts`). A name the graph doesn't have warns once and is dropped.
// - A target is a world position and rotation (only the yaw is matched, D42); a missing `position` or `rotation` takes
//   the character's own at the time it is sent. A node target is followed: its world transform is sent again whenever
//   it changes (a moving target re-plans from the current frame, D67).
// - `null` clears the window's target (`WARP_CLEAR`): the clip's own root motion plays.
// - Targets set before the graph has loaded wait for it; a new instance (re-enable) gets the standing targets again.
import { Quaternion, Vector3 } from "../../../../engine/core/math";
import { GameObject } from "../../../../engine/scene/GameObject";
import type { Animator } from "../components/Animator";
import type { AnimatorWarpTarget } from "../types";
import { warpState } from "./warp/state";

/** @internal `Animator.warp`. */
export function warp(animator: Animator, window: string, target: AnimatorWarpTarget | null): void {
  const s = warpState(animator);
  if (target === null) {
    s.set(window, { target: null, sent: null });
    return;
  }
  if (target instanceof GameObject) {
    s.set(window, { target, sent: null });
    return;
  }
  const position = target.position instanceof Vector3 ? target.position.clone() : null;
  const rotation = target.rotation instanceof Quaternion ? target.rotation.clone() : null;
  s.set(window, { target: { position, rotation }, sent: null });
}
