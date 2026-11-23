// T34: the Animation table's rows from a frame-stats snapshot, and the number formats.
import { describe, expect, it } from "vitest";
import type { AnimationFrameStats } from "../../runtime/core/frameMeter";
import { animationRows, formatCount, formatFuel, formatMegabytes, formatMs } from "./profilerLogic";

const stats: AnimationFrameStats = {
  frames: 15,
  gatherMs: 0.25,
  evaluateMs: 1.5,
  applyMs: 0.5,
  instances: 40,
  active: 30,
  culled: 10,
  lodSkipped: 12.5,
  evaluated: 17.5,
  bones: 700,
  skinned: 30,
  nodeFuel: 12_300,
  faults: 2,
};
const memory = { memoryBytes: 8 * 1024 * 1024, neededBytes: 6 * 1024 * 1024 };
const row = (label: string) => animationRows(stats, memory).find((r) => r.label === label)!;

describe("number formats", () => {
  it.each([
    [0, "0.00 ms"],
    [1.234, "1.23 ms"],
  ])("formats %s ms", (ms, text) => expect(formatMs(ms)).toBe(text));
  it.each([
    [12, "12"],
    [12.01, "12"],
    [0.5, "0.5"],
    [12.5, "12.5"],
  ])("formats the count %s", (n, text) => expect(formatCount(n)).toBe(text));
  it.each([
    [999, "999"],
    [12_300, "12.3k"],
    [1_200_000, "1.2M"],
  ])("formats fuel %s", (n, text) => expect(formatFuel(n)).toBe(text));
  it("formats memory in MB", () => expect(formatMegabytes(1.5 * 1024 * 1024)).toBe("1.5 MB"));
});

describe("animationRows", () => {
  it("lists the rows in order", () => {
    expect(animationRows(stats, memory).map((r) => r.label)).toEqual(["Frame", "Evaluate", "Instances", "LOD skipped", "Evaluated", "Skinned", "Core memory", "Node fuel", "Node faults"]);
  });

  it("sums the stages into the frame time", () => {
    expect(row("Frame")).toEqual({ label: "Frame", value: "2.25 ms", detail: "gather 0.25 ms · apply 0.50 ms" });
    expect(row("Evaluate").value).toBe("1.50 ms");
  });

  it("shows active instances out of all, with the culled ones", () => {
    expect(row("Instances")).toMatchObject({ value: "30", detail: "of 40 · culled 10" });
  });

  it("shows the LOD-skipped, evaluated and bone counts", () => {
    expect(row("LOD skipped").value).toBe("12.5");
    expect(row("Evaluated")).toMatchObject({ value: "17.5", detail: "700 bones" });
    expect(row("Skinned").value).toBe("30");
  });

  it("shows memory, node fuel and faults", () => {
    expect(row("Core memory")).toMatchObject({ value: "8.0 MB", detail: "limits need 6.0 MB" });
    expect(row("Node fuel").value).toBe("12.3k");
    expect(row("Node faults").value).toBe("2");
  });
});
