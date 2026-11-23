// The baked file's summary as the tool shows it (ADR 0373; T55): lenient reads (bytes that aren't a pose database answer
// null, never throw) and the lines `describeSummary` makes. The summary of a real bake is in `bake.node.test.ts`.
import { describe, expect, it } from "vitest";
import { describeSize, describeSummary, readPoseDbSummary, type PoseDbSummary } from "./summaryLogic";

describe("readPoseDbSummary", () => {
  it("answers null for bytes that aren't a pose database", () => {
    expect(readPoseDbSummary(new Uint8Array(0))).toBeNull();
    expect(readPoseDbSummary(new Uint8Array(64))).toBeNull();
    expect(readPoseDbSummary(new TextEncoder().encode("MYCOSKEL".padEnd(64, "\0")))).toBeNull();
    // The right magic with a section count that runs past the bytes.
    const bad = new Uint8Array(40);
    bad.set(new TextEncoder().encode("MYCOPSDB"));
    new DataView(bad.buffer).setUint32(20, 9, true);
    expect(readPoseDbSummary(bad)).toBeNull();
  });
});

describe("describeSize", () => {
  it("writes bytes, kilobytes and megabytes", () => {
    expect(describeSize(512)).toBe("512 B");
    expect(describeSize(12.4 * 1024)).toBe("12.4 KB");
    expect(describeSize(1.3 * 1024 * 1024)).toBe("1.3 MB");
  });
});

describe("describeSummary", () => {
  const summary: PoseDbSummary = {
    size: 4096, frames: 300, dims: 24, rate: 30, seconds: 10, skeleton: "asset:rigs/hero.skel", kdTree: true,
    features: [{ kind: "bone position", count: 3 }, { kind: "trajectory direction", count: 3 }], clips: [], tags: [],
  };

  it("gives the frames, size, dimensions and search, and the skeleton when it has one", () => {
    expect(describeSummary(summary)).toEqual([
      { label: "Frames", value: "300 (10.0 s at 30 Hz)" },
      { label: "Size", value: "4.0 KB" },
      { label: "Dimensions", value: "24 per frame, 3 bone position, 3 trajectory direction" },
      { label: "Search", value: "KD-tree" },
      { label: "Skeleton", value: "asset:rigs/hero.skel" },
    ]);
    expect(describeSummary({ ...summary, skeleton: null, kdTree: false }).map((l) => l.label)).toEqual(["Frames", "Size", "Dimensions", "Search"]);
    expect(describeSummary({ ...summary, skeleton: null, kdTree: false })[3]!.value).toBe("linear scan");
  });
});
