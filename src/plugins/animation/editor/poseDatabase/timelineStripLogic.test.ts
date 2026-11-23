// The timeline strip's maths (ADR 0373; T55): positions on the bar, snapping, the drag of a range's start, end or whole, and
// tag colours.
import { describe, expect, it } from "vitest";
import { SNAP, TAG_COLORS, colorSlot, dragRange, percentOf, rangeLabel, snapTime, tagOrder, timeAt, timeText } from "./timelineStripLogic";

describe("positions and snapping", () => {
  it("places a time as a percent of the clip, clamped to the bar", () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(-1, 4)).toBe(0);
    expect(percentOf(9, 4)).toBe(100);
    expect(percentOf(1, 0)).toBe(0);
  });

  it("turns a fraction of the bar into a snapped time", () => {
    expect(timeAt(0.5, 3)).toBe(1.5);
    expect(timeAt(0.3337, 3)).toBeCloseTo(1, 2);
    expect(timeAt(-1, 3)).toBe(0);
    expect(timeAt(2, 3)).toBe(3);
    expect(snapTime(1.234)).toBeCloseTo(1.23, 10);
    expect(SNAP).toBe(0.01);
  });
});

describe("dragRange", () => {
  const range = { from: 1, to: 2 };

  it("drags the start up to the end and down to zero", () => {
    expect(dragRange(range, "start", 0.5, 4)).toEqual({ from: 1.5, to: 2 });
    expect(dragRange(range, "start", 5, 4)).toEqual({ from: 2, to: 2 });
    expect(dragRange(range, "start", -5, 4)).toEqual({ from: 0, to: 2 });
  });

  it("drags the end down to the start and up to the clip's end", () => {
    expect(dragRange(range, "end", 0.5, 4)).toEqual({ from: 1, to: 2.5 });
    expect(dragRange(range, "end", -5, 4)).toEqual({ from: 1, to: 1 });
    expect(dragRange(range, "end", 5, 4)).toEqual({ from: 1, to: 4 });
  });

  it("moves the whole range keeping its length and stops at both ends", () => {
    expect(dragRange(range, "move", 0.5, 4)).toEqual({ from: 1.5, to: 2.5 });
    expect(dragRange(range, "move", -5, 4)).toEqual({ from: 0, to: 1 });
    expect(dragRange(range, "move", 5, 4)).toEqual({ from: 3, to: 4 });
  });

  it("snaps what it returns", () => {
    const r = dragRange(range, "move", 0.123456, 4);
    expect(r.from).toBeCloseTo(1.12, 10);
    expect(r.to - r.from).toBeCloseTo(1, 10);
  });

  it("is unbounded above while the clip's length is unknown", () => {
    expect(dragRange(range, "end", 100, 0)).toEqual({ from: 1, to: 102 });
    expect(dragRange(range, "move", 100, 0)).toEqual({ from: 101, to: 102 });
  });
});

describe("tags", () => {
  const sources = [{ ranges: [{ from: 0, to: 1, tags: ["walk"] }, { from: 1, to: 2, tags: ["stop", "walk"] }, { from: 2, to: 3, tags: [] }] }, { ranges: [{ from: 0, to: 1, tags: ["run"] }] }];

  it("orders the tags by first use across the clips", () => {
    expect(tagOrder(sources)).toEqual(["walk", "stop", "run"]);
  });

  it("colours a range by its first tag's place, none for an untagged range, repeating after the theme's colours", () => {
    const order = tagOrder(sources);
    expect(colorSlot(order, { tags: ["walk"] })).toBe(1);
    expect(colorSlot(order, { tags: ["stop", "walk"] })).toBe(2);
    expect(colorSlot(order, { tags: ["run"] })).toBe(3);
    expect(colorSlot(order, { tags: [] })).toBe(0);
    expect(colorSlot(order, { tags: ["unknown"] })).toBe(0);
    const many = Array.from({ length: TAG_COLORS + 1 }, (_, i) => `t${i}`);
    expect(colorSlot(many, { tags: [many[TAG_COLORS]!] })).toBe(1);
  });

  it("labels a range and writes a time as a short number", () => {
    expect(rangeLabel({ from: 1, to: 2.5, tags: ["walk", "loop"] })).toBe("1.00–2.50 s walk loop");
    expect(rangeLabel({ from: 0, to: 1, tags: [] })).toBe("0.00–1.00 s");
    expect(timeText(1.2)).toBe("1.2");
    expect(timeText(1.2345)).toBe("1.23");
    expect(timeText(2)).toBe("2");
  });
});
