import { describe, expect, it } from "vitest";
import { fitCanvas } from "../render/canvasFit";
import { resolveSettings } from "../core/settings";

describe("fitCanvas (ADR 0116)", () => {
  it("fit keeps the aspect ratio inside the container", () => {
    expect(fitCanvas("fit", 1280, 720, 1920, 1200)).toEqual({ width: 1920, height: 1080 });
    expect(fitCanvas("fit", 1280, 720, 800, 900)).toEqual({ width: 800, height: 450 });
  });
  it("stretch fills the container", () => {
    expect(fitCanvas("stretch", 1280, 720, 1000, 900)).toEqual({ width: 1000, height: 900 });
  });
  it("pixel-perfect uses whole multiples, and fits when smaller than the reference", () => {
    expect(fitCanvas("pixel-perfect", 320, 180, 1000, 700)).toEqual({ width: 960, height: 540 });
    expect(fitCanvas("pixel-perfect", 320, 180, 319, 700)).toEqual({ width: 319, height: 179 });
  });
  it("survives a zero-sized container", () => {
    expect(fitCanvas("fit", 1280, 720, 0, 0)).toEqual({ width: 1280, height: 720 }); // the reference size
  });
  it("defaults the setting to fit", () => {
    expect(resolveSettings({}).display.scaleMode).toBe("fit");
    expect(resolveSettings({ display: { width: 4, height: 3 } }).display.scaleMode).toBe("fit");
  });
});
