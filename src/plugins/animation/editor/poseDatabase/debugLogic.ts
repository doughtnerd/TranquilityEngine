// The pose database debug view's geometry and its source (ADR 0373 "a debug view of the trajectory and the chosen pose in
// the viewport"; T55). While playing, with the view on, the scene view draws for the selected Animator: the **predicted
// trajectory** (the character's spring-damped prediction the pose-database node queries with: a line through its samples
// with a tick for each sample's facing), the **matched frame's trajectory** (what the chosen frame did over the same
// times) and a cross at the character.
//
// **Where the data comes from.** The core writes a graph's pose-database node state into the match buffer
// (`match_debug_write`, wire family `match`: the playing frame, its cost and clip), but the animation host reads none of
// it yet: `AnimationCore` has no `matchDebugWrite`, nothing flags an instance for debug output, and the predicted
// trajectory is not in the match report. So this side is written against `MatchDebugSource`: the debugger (T52) or a core
// change gives it by `setMatchDebugSource`, and the view draws what the source reads. Without one the tool says so.
//
// Samples are in the character's frame (D60): `x` to its right, `z` ahead, metres; the character stands at its node's
// position facing `yaw` radians about +Y (0 faces +Z). A pure library.
import type { GameObject } from "../../../../engine/scene/GameObject";

type V3 = [number, number, number];

/** One trajectory sample: seconds from now (past < 0), ground position and facing in the character's frame. */
export interface MatchDebugSample {
  readonly time: number;
  readonly position: readonly [number, number];
  /** The unit facing (x, z). */
  readonly direction: readonly [number, number];
}

/** What the view draws for one Animator. */
export interface MatchDebugState {
  /** The predicted trajectory, in time order. */
  readonly predicted: readonly MatchDebugSample[];
  /** The matched database frame, or null when none is playing. */
  readonly matched: {
    readonly frame: number;
    readonly clip: string;
    /** Its playhead in the clip, seconds. */
    readonly time: number;
    readonly cost: number;
    /** What the frame's clip did over the same times (the database's trajectory features), character frame. */
    readonly trajectory: readonly MatchDebugSample[];
  } | null;
}

/** Where the view reads match state from. */
export interface MatchDebugSource {
  /** The pose-database node state of the Animator on `animatorNode` (a node of a play World), or null when it has none. */
  read(animatorNode: GameObject): MatchDebugState | null;
}

/** A character: its world position and yaw (radians about +Y, 0 facing +Z). */
export interface CharacterPose {
  readonly position: readonly [number, number, number];
  readonly yaw: number;
}

/** The lines the view draws, in world space. */
export interface MatchDebugWires {
  readonly predicted: V3[][];
  readonly matched: V3[][];
  readonly character: V3[][];
}

/** The ticks' length (m) and the cross's half-size. */
const TICK = 0.25;
const CROSS = 0.15;
/** Lines sit this far above the ground (m), so they don't z-fight it. */
const LIFT = 0.02;

/** A character-frame ground point as a world point. */
export function toWorld(character: CharacterPose, x: number, z: number): V3 {
  const c = Math.cos(character.yaw), s = Math.sin(character.yaw);
  return [character.position[0] + x * c + z * s, character.position[1] + LIFT, character.position[2] - x * s + z * c];
}

/** A character-frame direction as a world direction (no translation). */
function directionToWorld(character: CharacterPose, x: number, z: number): [number, number] {
  const c = Math.cos(character.yaw), s = Math.sin(character.yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** The line through a trajectory (from the character through each sample) and a facing tick at each sample. */
function trajectoryLines(character: CharacterPose, samples: readonly MatchDebugSample[]): V3[][] {
  if (samples.length === 0) return [];
  // Past samples run behind the character, future ones ahead: one line through all of them in time order, passing the character.
  const ordered = [...samples].sort((a, b) => a.time - b.time);
  const here = toWorld(character, 0, 0);
  const points: V3[] = [];
  let placed = false;
  for (const s of ordered) {
    if (!placed && s.time > 0) {
      points.push(here);
      placed = true;
    }
    points.push(toWorld(character, s.position[0], s.position[1]));
  }
  if (!placed) points.push(here);
  const lines: V3[][] = [points];
  for (const s of ordered) {
    const from = toWorld(character, s.position[0], s.position[1]);
    const d = directionToWorld(character, s.direction[0], s.direction[1]);
    const n = Math.hypot(d[0], d[1]);
    if (n > 1e-6) lines.push([from, [from[0] + (d[0] / n) * TICK, from[1], from[2] + (d[1] / n) * TICK]]);
  }
  return lines;
}

/** The lines for `state` at `character`: the predicted trajectory, the matched frame's, and the character's cross. */
export function matchDebugWires(character: CharacterPose, state: MatchDebugState): MatchDebugWires {
  const at = toWorld(character, 0, 0);
  return {
    predicted: trajectoryLines(character, state.predicted),
    matched: state.matched ? trajectoryLines(character, state.matched.trajectory) : [],
    character: [
      [[at[0] - CROSS, at[1], at[2]], [at[0] + CROSS, at[1], at[2]]],
      [[at[0], at[1], at[2] - CROSS], [at[0], at[1], at[2] + CROSS]],
    ],
  };
}

/** The matched frame as a line of text ("frame 128 of walk.anim.json at 1.20 s, cost 0.42"), or "no match". */
export function describeMatch(state: MatchDebugState | null): string {
  if (!state) return "no pose database node";
  if (!state.matched) return "no frame matched yet";
  const m = state.matched;
  return `frame ${m.frame} of ${m.clip || "a clip"} at ${m.time.toFixed(2)} s, cost ${m.cost.toFixed(2)}`;
}
