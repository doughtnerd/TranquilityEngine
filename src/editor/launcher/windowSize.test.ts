import { describe, expect, it } from "vitest";
import { fitWindowToWorkArea, windowSizeFor } from "./windowSize";

describe("windowSizeFor", () => {
  it("rounds the content size up to whole pixels", () => {
    expect(windowSizeFor({ width: 609.4, height: 700.2 }, 1000)).toEqual({ width: 610, height: 701 });
  });
  it("caps the height, widening by the scrollbar the page then shows", () => {
    expect(windowSizeFor({ width: 610, height: 2000 }, 952, 17)).toEqual({ width: 627, height: 952 });
  });
  it("adds no scrollbar width when the content fits", () => {
    expect(windowSizeFor({ width: 610, height: 700 }, 1000, 17)).toEqual({ width: 610, height: 700 });
  });
  it("never shrinks below a usable height", () => {
    expect(windowSizeFor({ width: 610, height: 900 }, 50).height).toBe(200);
  });
});

describe("fitWindowToWorkArea", () => {
  const content = { width: 610, height: 700 };
  it("keeps the size where it fits and centres in the work area", () => {
    const r = fitWindowToWorkArea(content, { x: 0, y: 0, width: 1920, height: 1040 }, 1);
    expect(r.size).toEqual(content);
    expect(r.position).toEqual({ x: 655, y: 170 });
  });
  it("centres in a work area that is offset (taskbar on top, second monitor)", () => {
    const r = fitWindowToWorkArea(content, { x: 1920, y: 40, width: 1920, height: 1040 }, 1);
    expect(r.position).toEqual({ x: 1920 + 655, y: 40 + 170 });
  });
  it("caps the height to the work area on a short screen, so the bottom stays on screen", () => {
    const area = { x: 0, y: 0, width: 1280, height: 640 };
    const r = fitWindowToWorkArea(content, area, 1, 17);
    expect(r.size).toEqual({ width: 627, height: 624 });
    expect(r.position.y).toBe(8);
    expect(r.position.y + r.size.height).toBeLessThanOrEqual(area.height);
  });
  it("accounts for the scale factor (physical work area, logical size)", () => {
    // 1920x1080 at 200% is 960x540 logical; the work area is 40 physical px shorter (taskbar).
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const r = fitWindowToWorkArea(content, area, 2, 0);
    expect(r.size.height).toBe(504); // 520 logical - 16 margin
    expect(r.position.y + r.size.height * 2).toBeLessThanOrEqual(area.height);
    expect(r.position.y).toBe(16);
  });
  it("caps the width on a narrow work area", () => {
    expect(fitWindowToWorkArea(content, { x: 0, y: 0, width: 500, height: 1000 }, 1).size.width).toBe(484);
  });
  it("keeps a position the user chose when it is inside the work area", () => {
    const r = fitWindowToWorkArea(content, { x: 0, y: 0, width: 1920, height: 1040 }, 1, 0, { x: 100, y: 50 });
    expect(r.position).toEqual({ x: 100, y: 50 });
  });
  it("nudges a window that has grown past the bottom back inside", () => {
    const r = fitWindowToWorkArea({ width: 610, height: 900 }, { x: 0, y: 0, width: 1920, height: 1040 }, 1, 0, { x: 655, y: 170 });
    expect(r.position).toEqual({ x: 655, y: 140 });
  });
});
