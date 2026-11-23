// The pose database debug view's geometry (ADR 0373; T55): where character-frame trajectory samples land in the world for a
// character at a position and yaw, the lines that draw the predicted and matched trajectories, and the description of a match.
import { describe, expect, it } from "vitest";
import { describeMatch, matchDebugStateOf, matchDebugWires, toWorld, type CharacterPose, type MatchDebugState } from "./debugLogic";

const LIFT = 0.02;
const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe("toWorld", () => {
  it("puts character-frame points ahead (+z) and to the right (+x) of a character facing +Z", () => {
    const c: CharacterPose = { position: [1, 0, 2], yaw: 0 };
    close(toWorld(c, 0, 3), [1, LIFT, 5]);
    close(toWorld(c, 2, 0), [3, LIFT, 2]);
  });

  it("turns with the yaw: facing +X, ahead is +x and right is -z", () => {
    const c: CharacterPose = { position: [0, 1, 0], yaw: Math.PI / 2 };
    close(toWorld(c, 0, 3), [3, 1 + LIFT, 0]);
    close(toWorld(c, 2, 0), [0, 1 + LIFT, -2]);
  });
});

describe("matchDebugWires", () => {
  const character: CharacterPose = { position: [0, 0, 0], yaw: 0 };
  const state: MatchDebugState = {
    predicted: [
      { time: 0.5, position: [0, 1], direction: [0, 1] },
      { time: -0.25, position: [0, -0.5], direction: [0, 1] },
      { time: 1, position: [0.5, 2], direction: [1, 0] },
    ],
    matched: { frame: 12, clip: "walk", time: 0.4, cost: 0.3, trajectory: [{ time: 0.5, position: [0, 1.1], direction: [0, 1] }] },
  };

  it("draws one line through the samples in time order, passing the character, with a facing tick per sample", () => {
    const w = matchDebugWires(character, state);
    expect(w.predicted).toHaveLength(1 + 3);
    const line = w.predicted[0]!;
    expect(line).toHaveLength(4);
    close(line[0]!, [0, LIFT, -0.5]); // the past sample
    close(line[1]!, [0, LIFT, 0]); // the character
    close(line[2]!, [0, LIFT, 1]);
    close(line[3]!, [0.5, LIFT, 2]);
    // The tick at the last sample faces +x, 0.25 m long.
    const tick = w.predicted[3]!;
    close(tick[0]!, [0.5, LIFT, 2]);
    close(tick[1]!, [0.75, LIFT, 2]);
  });

  it("draws the matched frame's trajectory separately, and nothing when none is matched", () => {
    expect(matchDebugWires(character, state).matched).toHaveLength(2);
    expect(matchDebugWires(character, { ...state, matched: null }).matched).toEqual([]);
  });

  it("ends the line at the character when every sample is in the past, and draws nothing for no samples", () => {
    const past = matchDebugWires(character, { predicted: [{ time: -0.5, position: [0, -1], direction: [0, 1] }], matched: null });
    expect(past.predicted[0]).toHaveLength(2);
    close(past.predicted[0]![1]!, [0, LIFT, 0]);
    expect(matchDebugWires(character, { predicted: [], matched: null }).predicted).toEqual([]);
  });

  it("marks the character with a cross", () => {
    const w = matchDebugWires({ position: [4, 1, 4], yaw: 1 }, state);
    expect(w.character).toHaveLength(2);
    close(w.character[0]![0]!, [4 - 0.15, 1 + LIFT, 4]);
    close(w.character[1]![1]!, [4, 1 + LIFT, 4 + 0.15]);
  });

  it("carries the samples through the yaw", () => {
    const w = matchDebugWires({ position: [0, 0, 0], yaw: Math.PI / 2 }, { predicted: [{ time: 1, position: [0, 2], direction: [0, 1] }], matched: null });
    close(w.predicted[0]!.at(-1)!, [2, LIFT, 0]);
  });
});

describe("describeMatch", () => {
  it("says what is matched", () => {
    const s: MatchDebugState = { predicted: [], matched: { frame: 128, clip: "walk.anim.json", time: 1.2, cost: 0.424, trajectory: [] } };
    expect(describeMatch(s)).toBe("frame 128 of walk.anim.json at 1.20 s, cost 0.42");
    expect(describeMatch({ ...s, matched: { ...s.matched!, clip: "" } })).toBe("frame 128 of a clip at 1.20 s, cost 0.42");
    expect(describeMatch({ predicted: [], matched: null })).toBe("no frame matched yet");
    expect(describeMatch(null)).toBe("no pose database node");
  });
});

// T70: the play session's source turns the core's match report (`matchDebugOf`) into what the view draws.
describe("matchDebugStateOf", () => {
  const sample = (time: number, z: number) => ({ time, position: [0, z] as const, direction: [0, 1] as const });
  it("passes the predicted trajectory and the matched frame through, naming a mirrored copy", () => {
    const predicted = [sample(0.33, 0.5), sample(0.66, 1)];
    const trajectory = [sample(0.33, 0.4), sample(0.66, 0.9)];
    const matched = { frame: 12, clip: "clips/run.anim", time: 0.4, cost: 0.25, mirrored: false, trajectory };
    expect(matchDebugStateOf({ predicted, matched })).toEqual({ predicted, matched: { frame: 12, clip: "clips/run.anim", time: 0.4, cost: 0.25, trajectory } });
    expect(matchDebugStateOf({ predicted, matched: { ...matched, mirrored: true } })!.matched!.clip).toBe("clips/run.anim (mirrored)");
  });

  it("has no matched frame before one plays, and no state without a report", () => {
    expect(matchDebugStateOf({ predicted: [], matched: null })).toEqual({ predicted: [], matched: null });
    expect(matchDebugStateOf(null)).toBeNull();
  });
});
