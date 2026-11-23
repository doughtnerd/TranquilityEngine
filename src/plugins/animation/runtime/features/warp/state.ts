// Per-Animator motion-warp targets on the host (ADR 0372; T40t): what `Animator.warp` set, by window name, and what was
// last sent to which instance, so a standing target is sent once and again only when it changes.
import type { Quaternion, Vector3 } from "../../../../../engine/core/math";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import type { Animator } from "../../components/Animator";

/** @internal A window's target: a node, a position and rotation (either may be null: the character's own), or null (clear). */
export type WarpGoal = GameObject | { readonly position: Vector3 | null; readonly rotation: Quaternion | null } | null;

/** @internal One window's request. */
export interface WarpRequest {
  readonly target: WarpGoal;
  /** The instance and the words last sent for it ("instance:px,py,…"), or null when nothing was sent yet. */
  sent: string | null;
}

const states = new WeakMap<Animator, Map<string, WarpRequest>>();

/** @internal An Animator's warp requests by window (made on first use). */
export function warpState(animator: Animator): Map<string, WarpRequest> {
  let s = states.get(animator);
  if (!s) states.set(animator, (s = new Map()));
  return s;
}

/** @internal An Animator's warp requests, or null when it never had any. */
export function existingWarpState(animator: Animator): Map<string, WarpRequest> | null {
  return states.get(animator) ?? null;
}
