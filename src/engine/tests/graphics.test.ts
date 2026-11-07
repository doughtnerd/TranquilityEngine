import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGraphics, detectPlatform, PARTICLE_SCALE, parseGraphics, SHADOW_MAP_SIZE, type QualityTier } from "../core/graphics";
import { resolveSettings } from "../core/settings";
import { Graphics, QUALITY_KEY } from "../render/Graphics";
import { MemoryStorage, Storage } from "../platform/Storage";

// Graphics quality tiers (ADR 0050): the lenient project.json parser, the settings resolver and the
// Graphics class that switches the active tier.

const DEFAULT_NAMES = ["Low", "Medium", "High", "Ultra"];
const HIGH: Omit<QualityTier, "name"> = { renderScale: 1, antialias: "msaa", shadows: "high", shadowCascades: 3, cascadedLights: 2, shadowDistance: 80, anisotropy: 8, shaderLevel: "high", postProcessing: true, bloom: true, ambientOcclusion: "medium", depthOfField: true, reflectionProbes: "medium", particles: "high" };

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
        { name: "Fast", renderScale: 0.5, antialias: "off", shadows: "off", shadowCascades: 1, cascadedLights: 1, shadowDistance: 20, anisotropy: 2, shaderLevel: "low", postProcessing: false, bloom: false, ambientOcclusion: "off", depthOfField: false, reflectionProbes: "off", particles: "low" },
        { name: "Only", renderScale: 1.5, antialias: "fxaa", shadows: "ultra", shadowCascades: 4, cascadedLights: 3, shadowDistance: 500, anisotropy: 16, shaderLevel: "medium", postProcessing: true, bloom: false, ambientOcclusion: "ultra", depthOfField: true, reflectionProbes: "high", particles: "medium" },
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
      tiers: [{ name: "Bad", renderScale: 5, anisotropy: 3.5, shadows: "extreme", antialias: "taa", shaderLevel: "max" }],
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

  it("has the default shadow cascade settings per tier", () => {
    const tiers = defaultGraphics().tiers;
    expect(tiers.map((t) => [t.shadowCascades, t.shadowDistance])).toEqual([[1, 30], [2, 50], [3, 80], [4, 120]]);
  });

  it("keeps valid cascade values and reports bad ones", () => {
    const ok = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", shadowCascades: 2, shadowDistance: 250 }] });
    expect(ok.problems).toEqual([]);
    expect(ok.graphics.tiers[0]).toMatchObject({ shadowCascades: 2, shadowDistance: 250 });
    for (const [key, value] of [["shadowCascades", 0], ["shadowCascades", 5], ["shadowCascades", 2.5], ["shadowDistance", 5]] as const) {
      const { graphics, problems } = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", [key]: value }] });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(key);
      expect(graphics.tiers[0][key]).toBe(HIGH[key]);
    }
  });

  it("reports an unknown tier key", () => {
    const { problems } = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", ssr: true }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ssr");
  });

  it("reports an unknown top-level key", () => {
    const { problems } = parseGraphics({ defaultTier: "A", tiers: [{ name: "A" }], extra: 1 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("extra");
  });

  it("keeps valid post-processing values and accepts smaa and fxaa", () => {
    const raw = {
      defaultTier: "A",
      tiers: [
        { name: "A", antialias: "smaa", postProcessing: false, bloom: false, ambientOcclusion: "ultra", depthOfField: false },
        { name: "B", antialias: "fxaa", postProcessing: true, bloom: true, ambientOcclusion: "low", depthOfField: true },
      ],
    };
    const { graphics, problems } = parseGraphics(raw);
    expect(problems).toEqual([]);
    expect(graphics.tiers[0]).toMatchObject(raw.tiers[0]);
    expect(graphics.tiers[1]).toMatchObject(raw.tiers[1]);
  });

  it("reads reflection probe quality, reporting a bad value and using the High tier's", () => {
    const ok = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", reflectionProbes: "high" }, { name: "B", reflectionProbes: "off" }] });
    expect(ok.graphics.tiers.map((t) => t.reflectionProbes)).toEqual(["high", "off"]);
    expect(ok.problems).toEqual([]);
    const bad = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", reflectionProbes: "ultra" }] });
    expect(bad.graphics.tiers[0].reflectionProbes).toBe("medium");
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toContain("reflectionProbes");
    expect(defaultGraphics().tiers.map((t) => t.reflectionProbes)).toEqual(["off", "low", "medium", "high"]);
  });

  it("reads particle quality, reporting a bad value and using the High tier's", () => {
    const ok = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", particles: "low" }, { name: "B", particles: "medium" }] });
    expect(ok.graphics.tiers.map((t) => t.particles)).toEqual(["low", "medium"]);
    expect(ok.problems).toEqual([]);
    const bad = parseGraphics({ defaultTier: "A", tiers: [{ name: "A", particles: "ultra" }] });
    expect(bad.graphics.tiers[0].particles).toBe("high");
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toContain("particles");
    expect(defaultGraphics().tiers.map((t) => t.particles)).toEqual(["low", "medium", "high", "high"]);
    expect(PARTICLE_SCALE).toEqual({ low: 0.25, medium: 0.5, high: 1 });
  });

  it("reads autoDetect and targetFrameRate, defaulting and reporting bad values", () => {
    const d = parseGraphics(undefined).graphics;
    expect([d.autoDetect, d.targetFrameRate]).toEqual([false, 60]);
    const ok = parseGraphics({ autoDetect: true, targetFrameRate: 30 });
    expect([ok.graphics.autoDetect, ok.graphics.targetFrameRate, ok.problems]).toEqual([true, 30, []]);
    const bad = parseGraphics({ autoDetect: "yes", targetFrameRate: 500 });
    expect([bad.graphics.autoDetect, bad.graphics.targetFrameRate]).toEqual([false, 60]);
    expect(bad.problems).toHaveLength(2);
    expect(parseGraphics({ targetFrameRate: 10 }).problems).toHaveLength(1);
    expect(parseGraphics({ targetFrameRate: "60" }).problems).toHaveLength(1);
  });

  it("reports a bad boolean or ambient occlusion value and uses the High tier's", () => {
    const { graphics, problems } = parseGraphics({
      defaultTier: "A",
      tiers: [{ name: "A", postProcessing: "yes", bloom: 1, depthOfField: null, ambientOcclusion: "extreme" }],
    });
    expect(graphics.tiers[0]).toEqual({ name: "A", ...HIGH });
    expect(problems).toHaveLength(4);
    for (const key of ["postProcessing", "bloom", "depthOfField", "ambientOcclusion"]) expect(problems.some((p) => p.includes(key))).toBe(true);
  });

  it("has the documented post-processing defaults per tier", () => {
    const [low, medium, high, ultra] = defaultGraphics().tiers;
    expect([low.postProcessing, low.bloom, low.ambientOcclusion, low.depthOfField, low.antialias]).toEqual([false, false, "off", false, "off"]);
    expect([medium.postProcessing, medium.bloom, medium.ambientOcclusion, medium.depthOfField, medium.antialias]).toEqual([true, true, "off", false, "smaa"]);
    expect([high.ambientOcclusion, high.depthOfField, high.antialias]).toEqual(["medium", true, "msaa"]);
    expect([ultra.ambientOcclusion, ultra.depthOfField, ultra.antialias]).toEqual(["high", true, "msaa"]);
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

describe("cascadedLights", () => {
  it("defaults to 1, 1, 2, 4 across the default tiers", () => {
    expect(defaultGraphics().tiers.map((t) => t.cascadedLights)).toEqual([1, 1, 2, 4]);
  });

  it("is read, and a bad value is reported and replaced by the High tier's", () => {
    const ok = parseGraphics({ tiers: [{ name: "A", cascadedLights: 3 }] });
    expect(ok.graphics.tiers[0].cascadedLights).toBe(3);
    expect(ok.problems).toEqual([]);
    for (const bad of [0, 5, 1.5, "2"]) {
      const { graphics, problems } = parseGraphics({ tiers: [{ name: "A", cascadedLights: bad }] });
      expect(graphics.tiers[0].cascadedLights).toBe(2);
      expect(problems.join()).toContain("cascadedLights");
    }
  });
});

describe("platform defaults", () => {
  it("parses valid entries and omits the key when there are none", () => {
    expect(parseGraphics({ platformDefaults: { mobile: "Low", web: "Medium" } }).graphics.platformDefaults).toEqual({ mobile: "Low", web: "Medium" });
    expect(parseGraphics({}).graphics.platformDefaults).toBeUndefined();
  });

  it("reports and drops unknown platforms and unknown tiers", () => {
    const { graphics, problems } = parseGraphics({ platformDefaults: { desktop: "Ultra", console: "Low", mobile: "Nope", web: 3 } });
    expect(graphics.platformDefaults).toEqual({ desktop: "Ultra" });
    expect(problems).toHaveLength(3);
    expect(parseGraphics({ platformDefaults: [] }).problems).toHaveLength(1);
    expect(parseGraphics({ platformDefaults: { desktop: "Nope" } }).graphics.platformDefaults).toBeUndefined();
  });

  it("detects the platform", () => {
    expect(detectPlatform({ __TAURI_INTERNALS__: {}, navigator: { userAgent: "Android Mobile" } })).toBe("desktop");
    expect(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" } })).toBe("mobile");
    expect(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" } })).toBe("mobile");
    expect(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 } })).toBe("mobile");
    expect(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 } })).toBe("web");
    expect(detectPlatform({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" } })).toBe("web");
    expect(detectPlatform({})).toBe("web");
  });

  it("starts on: saved choice, then the platform default, then defaultTier", () => {
    const g = { ...defaultGraphics(), platformDefaults: { mobile: "Low" } };
    Graphics._configure(g, undefined, undefined, "mobile");
    expect(Graphics.quality).toBe("Low");
    expect(Graphics.defaultQuality).toBe("Low");
    expect(Graphics.platform).toBe("mobile");
    Graphics._configure(g, "Ultra", undefined, "mobile");
    expect(Graphics.quality).toBe("Ultra");
    Graphics._configure(g, undefined, undefined, "web");
    expect(Graphics.quality).toBe("High");
    expect(Graphics.defaultQuality).toBe("High");
    Graphics._configure({ ...g, platformDefaults: { mobile: "Gone" } }, undefined, undefined, "mobile");
    expect(Graphics.quality).toBe("High");
  });

  it("lets the auto-detected tier win over the platform default", () => {
    const g = { ...defaultGraphics(), autoDetect: true, platformDefaults: { web: "Low" } };
    Graphics._configure(g, undefined, "Medium", "web");
    expect(Graphics.quality).toBe("Medium");
  });
});
