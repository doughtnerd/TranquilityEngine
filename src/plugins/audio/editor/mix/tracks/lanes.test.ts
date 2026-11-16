import { describe, expect, it } from "vitest";
import { assignLanes, type LaneSpan } from "./lanes";

const span = (start: number, end: number | null): LaneSpan => ({ start, end });

describe("assignLanes", () => {
  it("takes the first free lane, a new one up to the cap, then the last lane (counted)", () => {
    expect(assignLanes([span(0, 10), span(1, 2), span(2, 3), span(3, 9)], 6)).toEqual({ lane: [0, 1, 1, 1], lanes: 2, overflow: 0 });
    const r = assignLanes(Array.from({ length: 8 }, () => span(0, null)), 6);
    expect([r.lanes, r.overflow, r.lane[r.lane.length - 1]]).toEqual([6, 2, 5]);
  });

  it("an open span keeps its lane for ever; a span starting at another's end reuses its lane", () => {
    expect(assignLanes([span(0, null), span(5, 6), span(6, 7)], 4).lane).toEqual([0, 1, 1]);
  });
});
