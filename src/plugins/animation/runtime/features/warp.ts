// Motion warping from code (ADR 0372; T40t): `Animator.warp(window, target)` sets where a clip's warp window (named by a
// cue marker) lands. Targets are read in `animation.Gather` (`stages/gather/warp.ts`).
import type { Animator } from "../components/Animator";
import { notBuilt } from "../notBuilt";
import type { AnimatorWarpTarget } from "../types";

/** @internal `Animator.warp`. */
export function warp(_animator: Animator, _window: string, _target: AnimatorWarpTarget | null): void {
  notBuilt("Animator.warp", "T40t");
}
