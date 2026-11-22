import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGraphics, type GraphicsSettings } from "../core/graphics";
import { MemoryStorage, Storage } from "../platform/Storage";
import { AUTO_QUALITY_KEY, startAutoQuality, type AutoQuality } from "../render/autoQuality";
import { Graphics } from "../render/Graphics";

// Automatic quality (ADR 0055, 0322): whether to detect, the first pick, step-down from frame times and the saved
// detected tier, through the module's interface; Graphics keeps the active tier.

// Under Node there's no WebGL, so the GPU is unknown: with 8 cores the guess is "the default tier".
beforeAll(() => {
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
});

let backend: MemoryStorage;
beforeEach(() => {
  backend = new MemoryStorage();
  Storage.use(backend);
});

afterEach(() => {
  Graphics._configure(defaultGraphics());
});

const auto = (extra: Partial<GraphicsSettings> = {}): GraphicsSettings => ({ ...defaultGraphics(), autoDetect: true, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Configure Graphics as the project context does, then start automatic quality as project boot does. */
function boot(g: GraphicsSettings, saved?: unknown, detected?: unknown, platform: "desktop" | "web" | "mobile" = "web"): AutoQuality | null {
  Graphics._configure(g, saved, detected, platform);
  return startAutoQuality(g, saved);
}

/** Feed `count` frames of `dt` seconds; returns the indices (1-based) of frames after which the tier changed, and whether it still watches. */
function feed(aq: AutoQuality, count: number, dt: number): { changes: { frame: number; tier: string }[]; watching: boolean } {
  const changes: { frame: number; tier: string }[] = [];
  let watching = true;
  for (let i = 1; i <= count && watching; i++) {
    const before = Graphics.quality;
    watching = aq.frame(dt);
    if (Graphics.quality !== before) changes.push({ frame: i, tier: Graphics.quality });
  }
  return { changes, watching };
}

describe("the first pick", () => {
  it("maps an unrecognised GPU to the platform's default, not the desktop one", async () => {
    const g = auto({ platformDefaults: { mobile: "Low" } });
    expect(boot(g, undefined, undefined, "mobile")).not.toBeNull();
    expect(Graphics.quality).toBe("Low");
    expect(Graphics.detectQuality()).toBe("Low");
    expect(Graphics.autoDetected).toBe(true);
    await tick();
    expect(await backend.load("settings", AUTO_QUALITY_KEY)).toBe("Low");
  });

  it("detects when the saved tier no longer exists (renamed or removed)", () => {
    const g = auto({ platformDefaults: { web: "Medium" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(boot(g, "Gone")).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(Graphics.quality).toBe("Medium");
    expect(Graphics.autoDetected).toBe(true);
  });

  it("keeps the player's saved tier and doesn't watch", () => {
    expect(boot(auto(), "Ultra")).toBeNull();
    expect(Graphics.quality).toBe("Ultra");
    expect(Graphics.autoDetected).toBe(false);
  });

  it("does nothing when the project doesn't ask for detection", () => {
    expect(boot(defaultGraphics(), undefined, "Low")).toBeNull();
    expect(Graphics.quality).toBe("High");
    expect(Graphics.autoDetected).toBe(false);
  });

  it("keeps a tier detected on an earlier run instead of guessing again", async () => {
    expect(boot(auto(), undefined, "Low")).not.toBeNull();
    expect(Graphics.quality).toBe("Low");
    expect(Graphics.autoDetected).toBe(true);
    await tick();
    expect(await backend.load("settings", AUTO_QUALITY_KEY)).toBeUndefined();
  });

  it("guesses again when the tier detected earlier no longer exists", () => {
    expect(boot(auto(), undefined, "Nope")).not.toBeNull();
    expect(Graphics.quality).toBe("High");
    expect(Graphics.autoDetected).toBe(true);
  });
});

describe("Graphics restores a detected tier", () => {
  it("prefers the player's saved choice, then the detected tier, then the platform default", () => {
    Graphics._configure(auto({ platformDefaults: { web: "Low" } }), undefined, "Medium", "web");
    expect([Graphics.quality, Graphics.autoDetected]).toEqual(["Medium", true]);
    Graphics._configure(auto(), "Medium", "Low");
    expect([Graphics.quality, Graphics.autoDetected]).toEqual(["Medium", false]);
    Graphics._configure(defaultGraphics(), undefined, "Low");
    expect([Graphics.quality, Graphics.autoDetected]).toEqual(["High", false]);
  });

  it("clears the detected flag when the player sets a quality", async () => {
    Graphics._configure(auto(), undefined, "Low");
    Graphics.quality = "Ultra";
    expect([Graphics.quality, Graphics.autoDetected]).toEqual(["Ultra", false]);
    await tick();
  });
});

describe("stepping down from frame times", () => {
  const SLOW = 0.05; // 20 fps against a 60 fps target
  const FAST = 1 / 60;

  it("steps down one tier at a time while frames are slow, saving each, and stops at the lowest", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const aq = boot(auto({ platformDefaults: { web: "Ultra" } }))!;
      expect(Graphics.quality).toBe("Ultra");
      const { changes, watching } = feed(aq, 2000, SLOW);
      expect(changes.map((c) => c.tier)).toEqual(["High", "Medium", "Low"]);
      // 29 warm-up frames, then 3 s of settling (60 frames), then half a second of data before judging.
      expect(changes[0].frame).toBeGreaterThan(29 + 60 + 9);
      // A settle period follows each step.
      expect(changes[1].frame - changes[0].frame).toBeGreaterThanOrEqual(60);
      // Once at the lowest it runs out its watching time and stops.
      expect(watching).toBe(false);
      expect(aq.frame(SLOW)).toBe(false);
      await tick();
      expect(await backend.load("settings", AUTO_QUALITY_KEY)).toBe("Low");
      expect(Graphics.autoDetected).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it("never steps down while frames keep up, and stops after the watching time", () => {
    const aq = boot(auto())!;
    const { changes, watching } = feed(aq, 2000, FAST);
    expect(changes).toEqual([]);
    expect(watching).toBe(false);
    expect(Graphics.quality).toBe("High");
  });

  it("ignores frames during the warm-up", () => {
    const aq = boot(auto())!;
    // 29 load hitches would otherwise count as slow time; then fast frames only.
    feed(aq, 29, 0.2);
    expect(feed(aq, 2000, FAST).changes).toEqual([]);
  });

  it("stops as soon as the player picks a tier", async () => {
    const aq = boot(auto())!;
    feed(aq, 40, SLOW);
    Graphics.quality = "Ultra";
    expect(aq.frame(SLOW)).toBe(false);
    expect(Graphics.quality).toBe("Ultra");
    await tick();
  });
});
