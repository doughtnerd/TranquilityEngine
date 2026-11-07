import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { sidecarValue } from "../scene/Assets";
import {
  DEFAULT_IMPORT_SETTINGS,
  defaultImportSettings,
  formatImportSettings,
  importSettingsJSON,
  isSidecarPath,
  parseImportSettings,
  sidecarAsset,
  sidecarPath,
  splitSpriteRef,
  whyNotSliceName,
} from "../scene/importSettings";
import { spriteFrame } from "../render/spriteFrame";

afterEach(() => Assets.clearSources());

describe("sidecar paths and slice references", () => {
  it("names a sidecar after its asset", () => {
    expect(sidecarPath("images/player.png")).toBe("images/player.png.meta.json");
    expect(isSidecarPath("images/player.png.meta.json")).toBe(true);
    expect(isSidecarPath("scenes/main.scene.json")).toBe(false);
    expect(sidecarAsset("images/player.png.meta.json")).toBe("images/player.png");
  });

  it("splits a slice reference at #", () => {
    expect(splitSpriteRef("asset:images/sheet.png#walk_0")).toEqual({ path: "images/sheet.png", slice: "walk_0" });
    expect(splitSpriteRef("images/sheet.png")).toEqual({ path: "images/sheet.png", slice: null });
    expect(splitSpriteRef("")).toEqual({ path: "", slice: null });
  });

  it("checks slice names", () => {
    expect(whyNotSliceName("walk_0")).toBeNull();
    expect(whyNotSliceName("")).toMatch(/empty/);
    expect(whyNotSliceName("a#b")).toMatch(/#/);
    expect(whyNotSliceName("a", ["a"])).toMatch(/already/);
  });
});

describe("parseImportSettings", () => {
  it("gives the defaults for a missing sidecar", () => {
    expect(parseImportSettings(undefined).settings).toEqual(DEFAULT_IMPORT_SETTINGS);
    expect(parseImportSettings({ format: "myco.import@1" }).settings).toEqual(DEFAULT_IMPORT_SETTINGS);
  });

  it("reads every setting, with slice pivots defaulting to the image's", () => {
    const { settings, problems } = parseImportSettings({
      format: "myco.import@1",
      pixelsPerUnit: 16,
      filter: "point",
      wrap: "repeat",
      mipmaps: false,
      pivot: [0.5, 0],
      volume: 0.5,
      stream: true,
      sprites: [
        { name: "a", rect: [0, 0, 8, 8], pivot: [0, 0], border: [1, 1, 1, 1] },
        { name: "b", rect: [8, 0, 8, 8] },
      ],
    });
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({ pixelsPerUnit: 16, filter: "point", wrap: "repeat", mipmaps: false, pivot: [0.5, 0], volume: 0.5, stream: true });
    expect(settings.sprites).toEqual([
      { name: "a", rect: [0, 0, 8, 8], pivot: [0, 0], border: [1, 1, 1, 1] },
      { name: "b", rect: [8, 0, 8, 8], pivot: [0.5, 0] },
    ]);
  });

  it("skips bad values and slices, listing why", () => {
    const { settings, problems } = parseImportSettings({
      format: "myco.import@1",
      filter: "cubic",
      pixelsPerUnit: -1,
      sprites: [{ name: "a", rect: [0, 0, 1, 1] }, { name: "a", rect: [1, 0, 1, 1] }, { name: "z", rect: [0, 0, 0, 4] }, { rect: [0, 0, 1, 1] }],
    });
    expect(settings.filter).toBe("linear");
    expect(settings.pixelsPerUnit).toBe(0);
    expect(settings.sprites.map((s) => s.name)).toEqual(["a"]);
    expect(problems).toHaveLength(5);
  });

  it("refuses another format", () => {
    expect(() => parseImportSettings({ format: "myco.import@2" })).toThrow(/unknown format/);
  });
});

describe("writing sidecars", () => {
  it("writes the format and only what differs from the defaults", () => {
    expect(importSettingsJSON(defaultImportSettings())).toEqual({ format: "myco.import@1" });
    const s = { ...defaultImportSettings(), filter: "point" as const, pixelsPerUnit: 32 };
    expect(importSettingsJSON(s)).toEqual({ format: "myco.import@1", pixelsPerUnit: 32, filter: "point" });
  });

  it("formats one slice per line and round-trips", () => {
    const s = { ...defaultImportSettings(), pivot: [0.5, 0] as [number, number], sprites: [{ name: "walk, 0", rect: [0, 0, 16, 16] as [number, number, number, number], pivot: [0.5, 0] as [number, number] }] };
    const text = formatImportSettings(s);
    expect(text).toBe(
      '{\n  "format": "myco.import@1",\n  "pivot": [0.5, 0],\n  "sprites": [\n    { "name": "walk, 0", "rect": [0, 0, 16, 16], "pivot": [0.5, 0] }\n  ]\n}\n',
    );
    expect(parseImportSettings(JSON.parse(text)).settings).toEqual(s);
  });
});

describe("Assets.importSettings", () => {
  it("reads the sidecar through the asset sources, defaults without one, and re-reads a changed sidecar", () => {
    const files: Record<string, unknown> = {
      "images/a.png": "blob:a",
      "images/a.png.meta.json": { format: "myco.import@1", filter: "point", sprites: [{ name: "x", rect: [0, 0, 2, 2] }] },
      "images/b.png": "blob:b",
    };
    Assets.addSource(Assets.fromObject(files));
    expect(Assets.importSettings("asset:images/a.png").filter).toBe("point");
    expect(Assets.importSettings("images/a.png#x").sprites[0].name).toBe("x"); // a slice reads its image's
    expect(Assets.importSettings("images/b.png")).toEqual(DEFAULT_IMPORT_SETTINGS);
    const before = sidecarValue("images/a.png");
    files["images/a.png.meta.json"] = { format: "myco.import@1", filter: "linear" };
    expect(sidecarValue("images/a.png")).not.toBe(before);
    expect(Assets.importSettings("images/a.png").filter).toBe("linear");
  });

  it("warns about a bad sidecar and uses the defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    Assets.addSource(Assets.fromObject({ "a.png.meta.json": { format: "nope" } }));
    expect(Assets.importSettings("a.png")).toEqual(DEFAULT_IMPORT_SETTINGS);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown format/));
    warn.mockRestore();
  });
});

describe("spriteFrame", () => {
  const settings = parseImportSettings({
    format: "myco.import@1",
    pixelsPerUnit: 10,
    pivot: [0.5, 0],
    sprites: [{ name: "walk", rect: [20, 0, 20, 10], pivot: [0, 1] }],
  }).settings;

  it("draws the whole image at the sidecar's pixels per unit and pivot", () => {
    expect(spriteFrame(settings, null, 40, 20, { component: 0, project: 100 })).toEqual({ uv: null, size: [4, 2], pivot: [0.5, 0], border: null, fill: "stretch", pixelsPerUnit: 10, pixelSize: [40, 20], missingSlice: false });
  });

  it("draws a slice's rectangle (UVs with v up) at its size and pivot", () => {
    const f = spriteFrame(settings, "walk", 40, 20, { component: 0, project: 100 });
    expect(f.uv).toEqual([0.5, 0.5, 1, 1]); // the top-right quarter
    expect(f.size).toEqual([2, 1]);
    expect(f.pivot).toEqual([0, 1]);
  });

  it("prefers the component's pixels per unit, then the sidecar's, then the project's; size overrides", () => {
    expect(spriteFrame(settings, "walk", 40, 20, { component: 20, project: 100 }).size).toEqual([1, 0.5]);
    expect(spriteFrame(defaultImportSettings(), null, 40, 20, { component: 0, project: 100 }).size).toEqual([0.4, 0.2]);
    expect(spriteFrame(settings, "walk", 40, 20, { component: 0, project: 100 }, { x: 3, y: 3 }).size).toEqual([3, 3]);
  });

  it("flags a missing slice and draws the whole image", () => {
    const f = spriteFrame(settings, "gone", 40, 20, { component: 0, project: 100 });
    expect(f).toMatchObject({ uv: null, missingSlice: true, size: [4, 2] });
  });
});
