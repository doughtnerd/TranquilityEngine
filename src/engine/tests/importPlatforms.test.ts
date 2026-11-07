import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { clampTextureSize, defaultImportSettings, formatImportSettings, importSettingsJSON, parseImportSettings, resolveImportSettings } from "../scene/importSettings";

afterEach(() => {
  Assets.clearSources();
  Assets.platform = null;
});

const parse = (raw: unknown) => parseImportSettings({ format: "myco.import@1", ...(raw as object) });

describe("platform overrides and compression (ADR 0115)", () => {
  it("parses maxSize, compression and platform overrides", () => {
    const { settings, problems } = parse({ maxSize: 1024, compression: "normal", platforms: { web: { maxSize: 512, compression: "high", mipmaps: false }, desktop: { filter: "point" } } });
    expect(problems).toEqual([]);
    expect(settings.maxSize).toBe(1024);
    expect(settings.compression).toBe("normal");
    expect(settings.platforms).toEqual({ web: { maxSize: 512, compression: "high", mipmaps: false }, desktop: { filter: "point" } });
  });

  it("is lenient: bad values warn and default", () => {
    const { settings, problems } = parse({
      maxSize: -4,
      compression: "ultra",
      platforms: { web: { filter: "cubic", pivot: [0, 0], maxSize: 2.5, wrap: "repeat" }, console: { filter: "point" }, desktop: 3 },
    });
    expect(settings.maxSize).toBe(0);
    expect(settings.compression).toBe("none");
    expect(settings.platforms).toEqual({ web: { wrap: "repeat" } });
    expect(problems).toHaveLength(7);
    expect(parse({ platforms: [] }).problems).toHaveLength(1);
  });

  it("writes only non-default values, and drops overrides equal to the base", () => {
    expect(importSettingsJSON(defaultImportSettings())).toEqual({ format: "myco.import@1" });
    const s = defaultImportSettings();
    s.compression = "low";
    s.platforms = { web: { compression: "low", maxSize: 256 }, desktop: { filter: "linear", wrap: "clamp" } };
    expect(importSettingsJSON(s)).toEqual({ format: "myco.import@1", compression: "low", platforms: { web: { maxSize: 256 } } });
    expect(parse(JSON.parse(formatImportSettings(s))).settings.platforms).toEqual({ web: { maxSize: 256 } });
  });

  it("resolves a platform's overrides over the base", () => {
    const s = parse({ filter: "point", maxSize: 2048, platforms: { web: { maxSize: 512, filter: "linear" } } }).settings;
    const web = resolveImportSettings(s, "web");
    expect(web.maxSize).toBe(512);
    expect(web.filter).toBe("linear");
    expect(web.platforms).toEqual({});
    expect(resolveImportSettings(s, "desktop")).toBe(s);
    expect(s.maxSize).toBe(2048); // not mutated
  });

  it("resolves for Assets.platform at load time", () => {
    Assets.addSource(Assets.fromObject({ "a.png": "a.png", "a.png.meta.json": { format: "myco.import@1", mipmaps: true, platforms: { desktop: { mipmaps: false }, web: { maxSize: 64 } } } }));
    Assets.platform = "desktop";
    expect(Assets.importSettings("a.png").mipmaps).toBe(false);
    expect(Assets.importSettings("a.png").maxSize).toBe(0);
    Assets.platform = "web";
    expect(Assets.importSettings("a.png").mipmaps).toBe(true);
    expect(Assets.importSettings("a.png").maxSize).toBe(64);
    Assets.platform = null;
    expect(Assets.platform).toBe("web"); // no Tauri in tests
  });

  it("clamps texture sizes to maxSize keeping the aspect ratio", () => {
    expect(clampTextureSize(1024, 512, 0)).toEqual([1024, 512]);
    expect(clampTextureSize(1024, 512, 2048)).toEqual([1024, 512]);
    expect(clampTextureSize(1024, 512, 256)).toEqual([256, 128]);
    expect(clampTextureSize(100, 3, 10)).toEqual([10, 1]);
  });
});
