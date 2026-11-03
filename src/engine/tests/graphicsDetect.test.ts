import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGraphics } from "../core/graphics";
import { AUTO_QUALITY_KEY, Graphics } from "../render/Graphics";
import { MemoryStorage, Storage } from "../platform/Storage";

// Automatic quality detection (ADR 0055): the Graphics class picks a tier from the machine when the
// project asks for it, remembers that the tier was detected, and lets the player's choice win.

afterEach(() => {
  Graphics._configure(defaultGraphics());
});

describe("Graphics automatic detection", () => {
  it("applies the detected tier when autoDetect is on and nothing is saved", () => {
    Graphics._configure({ ...defaultGraphics(), autoDetect: true }, undefined, "Low");
    expect(Graphics.quality).toBe("Low");
    expect(Graphics.autoDetected).toBe(true);
  });

  it("ignores the detected tier when autoDetect is off", () => {
    Graphics._configure(defaultGraphics(), undefined, "Low");
    expect(Graphics.quality).toBe("High");
    expect(Graphics.autoDetected).toBe(false);
  });

  it("prefers the player's saved choice over the detected tier", () => {
    Graphics._configure({ ...defaultGraphics(), autoDetect: true }, "Medium", "Low");
    expect(Graphics.quality).toBe("Medium");
    expect(Graphics.autoDetected).toBe(false);
  });

  it("falls back to the default tier when the detected name is not a tier", () => {
    Graphics._configure({ ...defaultGraphics(), autoDetect: true }, undefined, "Nope");
    expect(Graphics.quality).toBe("High");
    expect(Graphics.autoDetected).toBe(false);
  });

  it("applies a detected tier and remembers it in storage", async () => {
    const backend = new MemoryStorage();
    Storage.use(backend);
    Graphics._configure(defaultGraphics());
    Graphics._applyDetected("Medium");
    expect(Graphics.quality).toBe("Medium");
    expect(Graphics.autoDetected).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(await Storage.load(AUTO_QUALITY_KEY, "settings")).toBe("Medium");
  });

  it("ignores an unknown detected tier, with a warning", () => {
    Graphics._configure(defaultGraphics());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      Graphics._applyDetected("Nope");
      expect(Graphics.quality).toBe("High");
      expect(Graphics.autoDetected).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("clears the detected flag when the player sets a quality", async () => {
    Storage.use(new MemoryStorage());
    Graphics._configure({ ...defaultGraphics(), autoDetect: true }, undefined, "Low");
    expect(Graphics.autoDetected).toBe(true);
    Graphics.quality = "Ultra";
    expect(Graphics.quality).toBe("Ultra");
    expect(Graphics.autoDetected).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("detectQuality returns one of the project's tiers", () => {
    Graphics._configure(defaultGraphics());
    expect(Graphics.tiers).toContain(Graphics.detectQuality());
  });
});
