import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGraphics, parseGraphics, SHADOW_MAP_SIZE, type QualityTier } from "../core/graphics";
import { resolveSettings } from "../core/settings";
import { Graphics, QUALITY_KEY } from "../render/Graphics";
import { MemoryStorage, Storage } from "../platform/Storage";

// Graphics quality tiers (ADR 0050): the lenient project.json parser, the settings resolver and the
// Graphics class that switches the active tier.

const DEFAULT_NAMES = ["Low", "Medium", "High", "Ultra"];
const HIGH: Omit<QualityTier, "name"> = { renderScale: 1, antialias: "msaa", shadows: "high", anisotropy: 8, shaderLevel: "high" };

afterEach(() => {
  Graphics._configure(defaultGraphics());
});

describe("parseGraphics", () => {
  it("uses the default tiers when the section is missing", () => {
    const { graphics, problems } = parseGraphics(undefined);
    expect(graphics.tiers.map((t) => t.name)).toEqual(DEFAULT_NAMES);
    expect(graphics.defaultTier).toBe("High");
    expect(problems).toEqual([]);
  });

  it("round-trips a valid custom section", () => {
    const raw = {
      defaultTier: "Only",
      tiers: [
        { name: "Fast", renderScale: 0.5, antialias: "off", shadows: "off", anisotropy: 2, shaderLevel: "low" },
        { name: "Only", renderScale: 1.5, antialias: "msaa", shadows: "ultra", anisotropy: 16, shaderLevel: "medium" },
      ],
    };
    const { graphics, problems } = parseGraphics(raw);
    expect(graphics.tiers).toEqual(raw.tiers);
    expect(graphics.defaultTier).toBe("Only");
    expect(problems).toEqual([]);
  });

  it("reports each bad value and replaces it with the High tier's value", () => {
    const raw = {
      defaultTier: "Bad",
      tiers: [{ name: "Bad", renderScale: 5, anisotropy: 3.5, shadows: "extreme", antialias: "fxaa", shaderLevel: "max" }],
    };
    const { graphics, problems } = parseGraphics(raw);
    expect(graphics.tiers).toEqual([{ name: "Bad", ...HIGH }]);
    expect(problems).toHaveLength(5);
    expect(problems.some((p) => p.includes("renderScale"))).toBe(true);
    expect(problems.some((p) => p.includes("anisotropy"))).toBe(true);
    expect(problems.some((p) => p.includes("shadows"))).toBe(true);
    expect(problems.some((p) => p.includes("antialias"))).toBe(true);
    expect(problems.some((p) => p.includes("shaderLevel"))).toBe(true);
  });

  it("reports an unknown tier key", () => {
    const { problems } = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", bloom: true }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("bloom");
  });

  it("reports an unknown top-level key", () => {
    const { problems } = parseGraphics({ defaultTier: "A", tiers: [{ name: "A" }], extra: 1 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("extra");
  });

  it("skips a tier without a name", () => {
    const { graphics, problems } = parseGraphics({ defaultTier: "Keep", tiers: [{ renderScale: 0.5 }, { name: "Keep" }] });
    expect(graphics.tiers.map((t) => t.name)).toEqual(["Keep"]);
    expect(problems).toHaveLength(1);
  });

  it("skips a tier whose name duplicates an earlier one", () => {
    const { graphics, problems } = parseGraphics({ defaultTier: "A", tiers: [{ name: "A" }, { name: "A", renderScale: 0.5 }] });
    expect(graphics.tiers.map((t) => t.name)).toEqual(["A"]);
    expect(graphics.tiers[0].renderScale).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("already named");
  });

  it("uses the default tiers, with a problem, when tiers is an empty list", () => {
    const { graphics, problems } = parseGraphics({ defaultTier: "High", tiers: [] });
    expect(graphics.tiers.map((t) => t.name)).toEqual(DEFAULT_NAMES);
    expect(problems).toHaveLength(1);
  });

  it("falls back to High, with a problem, when defaultTier names no tier", () => {
    const { graphics, problems } = parseGraphics({ defaultTier: "Nope", tiers: [{ name: "Low" }, { name: "High" }, { name: "X" }] });
    expect(graphics.defaultTier).toBe("High");
    expect(problems).toHaveLength(1);
  });

  it("falls back to the last tier, with a problem, when defaultTier names no tier and there is no High", () => {
    const { graphics, problems } = parseGraphics({ defaultTier: "Z", tiers: [{ name: "A" }, { name: "B" }] });
    expect(graphics.defaultTier).toBe("B");
    expect(problems).toHaveLength(1);
  });

  it("uses the default tiers, with a problem, when the section is not an object", () => {
    const { graphics, problems } = parseGraphics("nope");
    expect(graphics.tiers.map((t) => t.name)).toEqual(DEFAULT_NAMES);
    expect(graphics.defaultTier).toBe("High");
    expect(problems).toHaveLength(1);
  });
});

describe("resolveSettings graphics", () => {
  it("fills graphics with the default tiers when the project has none", () => {
    expect(resolveSettings({}).graphics).toEqual(defaultGraphics());
  });

  it("keeps a custom tier list", () => {
    const graphics = resolveSettings({ graphics: { tiers: [{ name: "Only" }], defaultTier: "Only" } as never }).graphics;
    expect(graphics.tiers.map((t) => t.name)).toEqual(["Only"]);
  });
});

describe("Graphics", () => {
  it("is High with all four tiers after configuring the defaults", () => {
    Graphics._configure(defaultGraphics());
    expect(Graphics.quality).toBe("High");
    expect(Graphics.tiers).toEqual(DEFAULT_NAMES);
    expect(Graphics.defaultQuality).toBe("High");
  });

  it("picks the saved tier when it names one", () => {
    Graphics._configure(defaultGraphics(), "Low");
    expect(Graphics.quality).toBe("Low");
  });

  it("falls back to the default tier when the saved name is not a tier", () => {
    Graphics._configure(defaultGraphics(), "Nope");
    expect(Graphics.quality).toBe("High");
  });

  it("applies a tier and bumps the version, but not when the same tier is applied again", () => {
    Graphics._configure(defaultGraphics());
    const before = Graphics._version;
    expect(Graphics._apply("Low")).toBe(true);
    expect(Graphics.quality).toBe("Low");
    const afterChange = Graphics._version;
    expect(afterChange).toBeGreaterThan(before);
    expect(Graphics._apply("Low")).toBe(true);
    expect(Graphics._version).toBe(afterChange);
  });

  it("rejects an unknown tier, warns, and leaves the quality unchanged", () => {
    Graphics._configure(defaultGraphics());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(Graphics._apply("Nope")).toBe(false);
      expect(Graphics.quality).toBe("High");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("saves the player's choice when the quality is set", async () => {
    const backend = new MemoryStorage();
    Storage.use(backend);
    Graphics._configure(defaultGraphics());
    Graphics.quality = "Medium";
    expect(Graphics.quality).toBe("Medium");
    await new Promise((r) => setTimeout(r, 0));
    expect(await Storage.load(QUALITY_KEY, "settings")).toBe("Medium");
  });
});

describe("SHADOW_MAP_SIZE", () => {
  it("maps each shadow quality to its map size", () => {
    expect(SHADOW_MAP_SIZE).toEqual({ off: 0, low: 512, medium: 1024, high: 2048, ultra: 4096 });
  });
});
