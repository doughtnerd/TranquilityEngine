// Motion matching's debug output for the editor (ADR 0373 "a debug view of the trajectory and the chosen pose"; T70):
// an Animator's pose-database node state as the core reports it after each evaluate (`AnimationCore.setMatchDebug` /
// `matchDebug`, wire family `match`): the trajectory the node predicted, the playing database frame with its clip
// (named through the database's clip list) and cost, and that frame's trajectory. The instance is flagged for reports
// while someone asks (`watchMatchDebug`), so Animators nobody looks at cost nothing. The first graph-level pose-database
// node is the one reported. Authoring support: a running game never calls it.
import type { Animator } from "../../components/Animator";
import type { MatchSampleReport } from "../../core/AnimationCore";
import { MATCH_MIRRORED } from "../../wasm/wire/match";
import { animatorRuntime } from "../instances";

/** @internal One Animator's motion-matching state, as of its last evaluate. */
export interface AnimatorMatchDebug {
  /** The trajectory the node predicted, in time order (character frame: x right, z ahead). */
  readonly predicted: readonly MatchSampleReport[];
  /** The playing database frame, or null when none plays. */
  readonly matched: {
    readonly frame: number;
    /** The frame's clip as the database lists it ("" when unnamed). */
    readonly clip: string;
    /** The playhead in that clip, seconds. */
    readonly time: number;
    readonly cost: number;
    /** A mirrored copy plays (the clip mirrored). */
    readonly mirrored: boolean;
    /** The frame's trajectory features. */
    readonly trajectory: readonly MatchSampleReport[];
  } | null;
}

const NONE = 0xffffffff;

/**
 * @internal Starts (`on`) or stops reports for `animator`'s core instance. While on, `matchDebugOf` answers from the
 * last evaluate. Stopping an Animator that wasn't watched does nothing.
 */
export function watchMatchDebug(animator: Animator, on: boolean): void {
  const rt = animatorRuntime(animator);
  if (rt?.ns?.open && rt.instance) rt.ns.core.setMatchDebug(rt.instance, on);
}

/** @internal `animator`'s motion-matching state as of its last evaluate, or null (not watched, not evaluated, or no pose-database node). */
export function matchDebugOf(animator: Animator): AnimatorMatchDebug | null {
  const rt = animatorRuntime(animator);
  if (!rt?.ns?.open || !rt.instance) return null;
  const core = rt.ns.core;
  const node = core.matchDebug(rt.instance)?.nodes[0];
  if (!node) return null;
  return {
    predicted: node.predicted,
    matched:
      node.frame === NONE
        ? null
        : {
            frame: node.frame,
            clip: node.dbClip === NONE ? "" : core.poseDbClip(node.database, node.dbClip),
            time: node.time,
            cost: node.cost,
            mirrored: (node.flags & MATCH_MIRRORED) !== 0,
            trajectory: node.matched,
          },
  };
}
