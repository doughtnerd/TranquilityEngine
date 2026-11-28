import { describe, expect, it } from "vitest";
import { DrawCounter, type DrawingEngine } from "./drawCounter";

/** An engine that records what it was asked to draw. */
function engine() {
  const drawn: string[] = [];
  const e: DrawingEngine = {
    drawElementsType: (mode, start, count, instances) => void drawn.push(`e${mode}:${start}:${count}:${instances}`),
    drawArraysType: (mode, start, count, instances) => void drawn.push(`a${mode}:${start}:${count}:${instances}`),
  };
  return { e, drawn };
}

describe("DrawCounter", () => {
  it("adds indexed and unindexed triangle draws, times their instances, and still draws", () => {
    const { e, drawn } = engine();
    const c = new DrawCounter();
    c.attach(e);
    e.drawElementsType(0, 0, 300); // not instanced: one
    e.drawElementsType(0, 6, 30, 5); // 10 triangles x 5
    e.drawArraysType(0, 0, 9, 0); // 0 instances means not instanced
    expect(c.triangles).toBe(100 + 50 + 3);
    expect(drawn).toEqual(["e0:0:300:undefined", "e0:6:30:5", "a0:0:9:0"]);
  });

  it("counts strips and fans as count - 2, and ignores lines and points", () => {
    const { e } = engine();
    const c = new DrawCounter();
    c.attach(e);
    e.drawElementsType(7, 0, 6);
    e.drawElementsType(8, 0, 5, 2);
    expect(c.triangles).toBe(4 + 6);
    e.drawElementsType(1, 0, 600); // wireframe
    e.drawElementsType(2, 0, 600); // points
    e.drawArraysType(4, 0, 600); // line list
    expect(c.triangles).toBe(10);
  });

  it("starts each frame from zero, so between frames it holds the last frame's total", () => {
    const { e } = engine();
    const c = new DrawCounter();
    c.attach(e);
    c.beginFrame();
    e.drawElementsType(0, 0, 30); // a shadow pass
    e.drawElementsType(0, 0, 60); // the main view
    expect(c.triangles).toBe(30);
    c.beginFrame();
    expect(c.triangles).toBe(0);
    e.drawElementsType(0, 0, 3);
    expect(c.triangles).toBe(1);
  });
});
