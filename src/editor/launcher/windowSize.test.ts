import { describe, expect, it } from "vitest";
import { windowSizeFor } from "./windowSize";

describe("windowSizeFor", () => {
  it("rounds the content size up to whole pixels", () => {
    expect(windowSizeFor({ width: 609.4, height: 700.2 }, 1080)).toEqual({ width: 610, height: 701 });
  });
  it("caps the height to the screen, widening by the scrollbar the page then shows", () => {
    expect(windowSizeFor({ width: 610, height: 2000 }, 1000, 17)).toEqual({ width: 627, height: 952 });
  });
  it("adds no scrollbar width when the content fits", () => {
    expect(windowSizeFor({ width: 610, height: 700 }, 1080, 17)).toEqual({ width: 610, height: 700 });
  });
  it("never shrinks below a usable height on a tiny screen", () => {
    expect(windowSizeFor({ width: 610, height: 900 }, 100).height).toBe(200);
  });
});
