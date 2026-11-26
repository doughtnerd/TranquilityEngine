// UI pass MX-63: the project's loudness targets (Project settings · Loudness targets) and a whole take's integrated
// loudness, through the model the Loudness panel uses.
import { describe, expect, it } from "vitest";
import { audioProjectToJson, defaultAudioProject, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { addTarget, editTarget, makeDefaultTarget, NO_TAKE_LOUDNESS, removeTarget, resetTargets, takeLoudnessStep, takeLoudnessText, type TakeLoudness, type TakeReplayReading } from "./loudnessTargetsModel";

const next = (r: { next: AudioProject } | { refused: string }): AudioProject => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("the project's loudness targets", () => {
  it("start from the defaults (console −24, PC/web −18, mobile −16, ±2 LU, −1 dBTP)", () => {
    expect(defaultAudioProject().loudness.targets.map((t) => [t.name, t.integrated, t.tolerance, t.truePeak])).toEqual([["console", -24, 2, -1], ["pc-web", -18, 2, -1], ["mobile", -16, 2, -1]]);
  });

  it("add, edit (clamped), reorder, remove and reset; saved in audio.json", () => {
    let p = next(addTarget(defaultAudioProject()));
    expect(p.loudness.targets[3]).toEqual({ name: "Target", integrated: -24, tolerance: 2, truePeak: -1 });
    p = next(editTarget(p, 3, { name: "Handheld", integrated: -14, tolerance: 50, truePeak: -1.5 }));
    expect(p.loudness.targets[3]).toEqual({ name: "Handheld", integrated: -14, tolerance: 12, truePeak: -1.5 });
    expect(editTarget(p, 3, { name: "console" })).toEqual({ refused: expect.stringContaining("another target") });
    expect(editTarget(p, 3, { name: " " })).toEqual({ refused: expect.any(String) });
    p = next(makeDefaultTarget(p, 3));
    expect(p.loudness.targets[0]!.name).toBe("Handheld");
    p = next(removeTarget(p, 1));
    expect(p.loudness.targets.map((t) => t.name)).toEqual(["Handheld", "pc-web", "mobile"]);
    const read = parseAudioProject(JSON.parse(JSON.stringify(audioProjectToJson(p))));
    expect(read.problems).toEqual([]);
    expect(read.project.loudness.targets).toEqual(p.loudness.targets);
    expect(next(resetTargets(p)).loudness.targets).toEqual(defaultAudioProject().loudness.targets);
  });

  it("keep at least one and at most eight", () => {
    let p = defaultAudioProject();
    p = next(removeTarget(next(removeTarget(p, 0)), 0));
    expect(removeTarget(p, 0)).toEqual({ refused: expect.stringContaining("at least one") });
    for (let i = 0; i < 7; i++) p = next(addTarget(p));
    expect(addTarget(p)).toEqual({ refused: expect.stringContaining("at most 8") });
  });
});

describe("a whole take's integrated loudness", () => {
  const at = (time: number, playing: boolean, integrated = -17.4, take = "takes/a.sporesample"): TakeReplayReading => ({ take, duration: 10, time, playing, integrated });
  const run = (readings: (TakeReplayReading | null)[]) => {
    let t: TakeLoudness = NO_TAKE_LOUDNESS;
    const resets: number[] = [];
    readings.forEach((r, i) => {
      const s = takeLoudnessStep(t, r);
      if (s.reset) resets.push(i);
      t = s.next;
    });
    return { t, resets };
  };
  const target = { name: "pc-web", integrated: -18, tolerance: 2, truePeak: -1 };

  it("measures a replay played from its start to its end (the meters reset at the start), pauses included", () => {
    const ticks = Array.from({ length: 17 }, (_, i) => at(2 + i * 0.5, true)); // 2 s … 10 s, a tick each half second
    const { t, resets } = run([at(0, false), at(0.05, true), at(1, true), at(1.5, false), at(1.5, true), ...ticks]);
    expect(resets).toEqual([1]);
    expect(t).toEqual({ state: "done", take: "takes/a.sporesample", duration: 10, integrated: -17.4 });
    expect(takeLoudnessText(t, target)).toEqual({ text: "Whole take: −17.4 LUFS integrated over 0:10 · on target (−18 ±2)", verdict: "ok" });
    expect(takeLoudnessText({ ...t, integrated: -12 } as TakeLoudness, target)?.verdict).toBe("warn");
  });

  it("a seek or a jump breaks it; a replay not from the start doesn't begin one; no take is idle", () => {
    expect(run([at(0, true), at(1, true), at(6, true)]).t.state).toBe("broken");
    expect(run([at(0, true), at(3, true), at(2, true)]).t.state).toBe("broken");
    expect(run([at(4, true), at(4.1, true)]).t).toEqual({ state: "idle", take: "takes/a.sporesample" });
    expect(run([at(0, true), null]).t).toEqual(NO_TAKE_LOUDNESS);
    expect(takeLoudnessText(NO_TAKE_LOUDNESS, target)).toBeNull();
    expect(takeLoudnessText(run([at(0, true), at(1, true)]).t, target)?.text).toBe("Whole take: measuring… 0:01 of 0:10 · −17.4 LUFS so far");
  });
});
