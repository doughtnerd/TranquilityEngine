// ADR 0336 (the audio core's ABI 4.9): a loop's seam and exit crossfade shapes in the one loop-behaviour parse and
// writer (sample loops, clip loop overrides, sequence loops): read when set, the default (equalPower) left out, a bad
// name one problem line.
import { describe, expect, it } from "vitest";
import { loopBehaviourToJson, loopOverrideToJson, parseLoopBehaviour, parseLoopOverride } from "./loopBehaviour";

describe("loop crossfade shapes (ADR 0336)", () => {
  it("reads and writes a seam and an exit shape; equalPower is the default and isn't written", () => {
    const problems: string[] = [];
    const b = parseLoopBehaviour({ exit: "crossfade", crossfadeShape: "sCurve", exitShape: "log2" }, "l", problems);
    expect([b.crossfadeShape, b.exitShape, problems]).toEqual(["sCurve", "log2", []]);
    expect(loopBehaviourToJson(b)).toMatchObject({ crossfadeShape: "sCurve", exitShape: "log2" });
    const plain = parseLoopBehaviour({ crossfadeShape: "equalPower" }, "l", problems);
    expect("crossfadeShape" in plain).toBe(false);
    expect(Object.keys(loopBehaviourToJson(plain))).not.toContain("crossfadeShape");
  });

  it("a bad shape is one problem and the default", () => {
    const problems: string[] = [];
    const b = parseLoopBehaviour({ crossfadeShape: "wobbly" }, "loops[0]", problems);
    expect(b.crossfadeShape).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("loops[0].crossfadeShape");
  });

  it("a clip's loop override can set the shapes", () => {
    const problems: string[] = [];
    const o = parseLoopOverride({ exitShape: "exp3" }, "o", problems)!;
    expect([o.exitShape, problems]).toEqual(["exp3", []]);
    expect(loopOverrideToJson(o)).toEqual({ exitShape: "exp3" });
  });
});
