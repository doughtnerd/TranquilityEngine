// The Scene plan's words (journeys walk 2, V11): labels spread so none overlaps another or covers an object's mark, and the
// selected object's toolbar placed where it covers no label (a131: an obstacle's toolbar over "Player 1 · listening"; a129:
// the listener's over "Emitter 1 ↓3 m"; the emitter's label over the obstacle's).
import { describe, expect, it } from "vitest";
import { labelRect, overlaps, placeToolbar, spreadLabels, unionRect, type PlanLabel } from "./planLayout";

const label = (id: string, x: number, y: number, text: string, size = 11): PlanLabel => ({ id, x, y, text, size });

describe("the plan's labels", () => {
  it("keep their places when they don't touch", () => {
    expect(spreadLabels([label("a", 100, 100, "Emitter 1"), label("b", 400, 100, "Player 1 · listening")]).size).toBe(0);
  });

  it("move apart when they overlap: the first keeps its place, the next moves a line", () => {
    const labels = [label("emitter", 640, 440, "Emitter 1 ↓3 m · ▸ playing"), label("wall", 638, 449, "Obstacle 1 · concrete", 10)];
    const dy = spreadLabels(labels);
    expect(dy.has("emitter")).toBe(false);
    expect(dy.get("wall")).not.toBeUndefined();
    expect(overlaps(labelRect(labels[0]!), labelRect(labels[1]!, dy.get("wall")))).toBe(false);
  });

  it("don't cover another object's mark", () => {
    const mark = { x: 90, y: 112, w: 22, h: 22 };
    const dy = spreadLabels([label("a", 100, 110, "Emitter 2")], new Map([["b", mark]]));
    // Its own mark doesn't push it.
    expect(spreadLabels([label("b", 100, 110, "Emitter 2")], new Map([["b", mark]])).size).toBe(0);
    expect(overlaps(labelRect(label("a", 100, 110, "Emitter 2"), dy.get("a") ?? 0), mark)).toBe(false);
  });
});

describe("the selection's toolbar", () => {
  const view = { width: 800, height: 600 };
  const bar = { w: 120, h: 30 };

  it("sits above a point, or under a shape, when nothing is there", () => {
    const point = { x: 388, y: 288, w: 24, h: 24 };
    expect(placeToolbar({ target: point, bar, view, avoid: [], prefer: "above" })).toEqual({ x: 340, y: 250 });
    const shape = { x: 300, y: 200, w: 200, h: 60 };
    expect(placeToolbar({ target: shape, bar, view, avoid: [], prefer: "below" })).toEqual({ x: 340, y: 268 });
  });

  it("moves to another side when its place covers a label (a131, a129)", () => {
    const shape = { x: 576, y: 430, w: 124, h: 36 };
    const listenerLabel = labelRect(label("p1", 590, 500, "Player 1 · listening"));
    const at = placeToolbar({ target: shape, bar: { w: 60, h: 28 }, view, avoid: [listenerLabel], prefer: "below" });
    expect(overlaps({ x: at.x, y: at.y, w: 60, h: 28 }, listenerLabel)).toBe(false);
    expect(overlaps({ x: at.x, y: at.y, w: 60, h: 28 }, shape)).toBe(false);
    // The listener's toolbar above it would cover the emitter's label up there.
    const listener = unionRect({ x: 637, y: 407, w: 24, h: 24 }, labelRect(label("p1", 649, 441, "Player 1 · listening")));
    const emitterLabel = labelRect(label("e1", 741, 384, "Emitter 1 ↓3 m · ▸ playing"));
    const p = placeToolbar({ target: listener, bar: { w: 130, h: 30 }, view, avoid: [emitterLabel], prefer: "above" });
    expect(overlaps({ x: p.x, y: p.y, w: 130, h: 30 }, emitterLabel)).toBe(false);
  });

  it("stays inside the view", () => {
    const p = placeToolbar({ target: { x: 2, y: 2, w: 20, h: 20 }, bar, view, avoid: [], prefer: "above" });
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(4);
  });
});
