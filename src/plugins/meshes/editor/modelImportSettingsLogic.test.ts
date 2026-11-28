import { describe, expect, it } from "vitest";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "../../../engine/scene/importSettings";
import { DEFAULT_LOD_SETTINGS, type LodSettings } from "../../../engine/scene/lod/types";
import type { ModelMesh } from "../../../engine/scene/models";
import { addLevel, canAddLevel, editLevel, levelReports, MAX_LOD_LEVELS, modelTriangles, removeLevel, setGenerate, setPixelError, shortWarning, suggestsLods } from "./modelImportSettingsLogic";

/** A mesh with `triangles` at LOD0 and the given triangle counts and errors for its generated levels. */
function mesh(triangles: number, levels: { triangles: number; error: number }[] = []): ModelMesh {
  const all = [{ triangles, error: 0 }, ...levels];
  return {
    name: "m",
    materials: [],
    surfaces: [],
    data: { positions: new Float32Array(0), normals: null, uvs: null, indices: new Uint32Array(triangles * 3), groups: [] },
    lods: levels.length ? { levels: all.map((l) => ({ ...l, mesh: null as never })), occluder: null, bounds: [0, 0, 0, 1, 1, 1], pixelError: 1 } : undefined,
  } as ModelMesh;
}

/** The sidecar the import settings would write, read back. */
const sidecarLod = (lod: LodSettings | null) => parseImportSettings(JSON.parse(formatImportSettings({ ...defaultImportSettings(), lod }))).settings.lod;

describe("the Generate LODs switch", () => {
  it("is off as no levels and on as the defaults, in the sidecar too", () => {
    expect(setGenerate(DEFAULT_LOD_SETTINGS, false)).toBeNull();
    expect(sidecarLod(setGenerate(null, false))).toBeNull();
    expect(setGenerate(null, true)).toEqual(DEFAULT_LOD_SETTINGS);
    expect(sidecarLod(setGenerate(null, true))).toEqual(DEFAULT_LOD_SETTINGS);
  });

  it("keeps the levels already edited when it is asked on again", () => {
    const edited = editLevel(DEFAULT_LOD_SETTINGS, 0, { ratio: 0.4 });
    expect(setGenerate(edited, true)).toBe(edited);
  });

  it("never shares the defaults' level objects with a draft", () => {
    const on = setGenerate(null, true)!;
    expect(on.levels[0]).not.toBe(DEFAULT_LOD_SETTINGS.levels[0]);
  });
});

describe("level rows", () => {
  it("edit a ratio and an error, and the sidecar reads them back", () => {
    let lod = editLevel(DEFAULT_LOD_SETTINGS, 1, { ratio: 0.3 });
    lod = editLevel(lod, 1, { error: 0.03 });
    expect(lod.levels[1]).toEqual({ ratio: 0.3, error: 0.03 });
    expect(sidecarLod(lod)).toEqual(lod);
  });

  it("keep ratios inside 0.01–0.99 and falling, so the sidecar never drops a level", () => {
    expect(editLevel(DEFAULT_LOD_SETTINGS, 0, { ratio: 5 }).levels[0].ratio).toBe(0.99);
    expect(editLevel(DEFAULT_LOD_SETTINGS, 0, { ratio: 0 }).levels[0].ratio).toBe(0.01);
    const raised = editLevel(DEFAULT_LOD_SETTINGS, 2, { ratio: 0.9 });
    expect(raised.levels[2].ratio).toBeLessThan(raised.levels[1].ratio);
    const lowered = editLevel(DEFAULT_LOD_SETTINGS, 0, { ratio: 0.1 }); // below the next two: they follow it down
    expect(lowered.levels.map((l) => l.ratio)).toEqual([0.1, 0.09, 0.08]);
    for (const lod of [raised, lowered]) expect(sidecarLod(lod)).toEqual(lod);
  });

  it("refuse a negative or non-finite error", () => {
    expect(editLevel(DEFAULT_LOD_SETTINGS, 0, { error: -1 }).levels[0].error).toBe(0);
    expect(editLevel(DEFAULT_LOD_SETTINGS, 0, { error: NaN }).levels[0].error).toBe(0);
  });

  it("ignore a row that isn't there", () => {
    expect(editLevel(DEFAULT_LOD_SETTINGS, 9, { ratio: 0.2 })).toBe(DEFAULT_LOD_SETTINGS);
    expect(removeLevel(DEFAULT_LOD_SETTINGS, 9)).toBe(DEFAULT_LOD_SETTINGS);
  });

  it("add a level at half the last one's triangles, up to four", () => {
    let lod = DEFAULT_LOD_SETTINGS;
    expect(canAddLevel(lod)).toBe(true);
    lod = addLevel(lod);
    expect(lod.levels).toHaveLength(MAX_LOD_LEVELS);
    expect(lod.levels[3]).toEqual({ ratio: 0.0625, error: 0.08 });
    expect(canAddLevel(lod)).toBe(false);
    expect(addLevel(lod)).toBe(lod);
    expect(sidecarLod(lod)).toEqual(lod);
  });

  it("remove a level but never the last", () => {
    const lod = removeLevel(DEFAULT_LOD_SETTINGS, 0);
    expect(lod.levels.map((l) => l.ratio)).toEqual([0.25, 0.125]);
    const one = removeLevel(removeLevel(lod, 0), 0);
    expect(one.levels).toHaveLength(1);
    expect(removeLevel(one, 0)).toBe(one);
  });

  it("set the pixel error to a positive number only", () => {
    expect(setPixelError(DEFAULT_LOD_SETTINGS, 2).pixelError).toBe(2);
    expect(setPixelError(DEFAULT_LOD_SETTINGS, 0)).toBe(DEFAULT_LOD_SETTINGS);
    expect(setPixelError(DEFAULT_LOD_SETTINGS, NaN)).toBe(DEFAULT_LOD_SETTINGS);
  });
});

describe("the hint", () => {
  it("shows for an off switch and 2,000 triangles or more", () => {
    expect(suggestsLods(null, 2000)).toBe(true);
    expect(suggestsLods(null, 1999)).toBe(false);
    expect(suggestsLods(DEFAULT_LOD_SETTINGS, 50000)).toBe(false);
  });

  it("counts a model's triangles at LOD0, with or without levels", () => {
    expect(modelTriangles([mesh(1000), mesh(1500, [{ triangles: 700, error: 0.01 }])])).toBe(2500);
  });
});

describe("what the generated levels reached", () => {
  const lod = DEFAULT_LOD_SETTINGS; // targets 0.5, 0.25, 0.125

  it("is nothing for a model without levels", () => {
    expect(levelReports([mesh(5000)], lod)).toBeNull();
  });

  it("gives each level's triangles, reached ratio and error", () => {
    const reports = levelReports([mesh(1000, [{ triangles: 500, error: 0.01 }, { triangles: 250, error: 0.02 }, { triangles: 125, error: 0.04 }])], lod)!;
    expect(reports.map((r) => [r.level, r.triangles, r.reached, r.error, r.short])).toEqual([
      [1, 500, 0.5, 0.01, false],
      [2, 250, 0.25, 0.02, false],
      [3, 125, 0.125, 0.04, false],
    ]);
  });

  it("sums over meshes, counting a shorter mesh's last level deeper and taking the worst error", () => {
    const a = mesh(1000, [{ triangles: 500, error: 0.01 }, { triangles: 250, error: 0.02 }]);
    const b = mesh(1000, [{ triangles: 400, error: 0.03 }]);
    const [one, two] = levelReports([a, b], lod)!;
    expect(one).toMatchObject({ triangles: 900, error: 0.03 });
    expect(two).toMatchObject({ triangles: 650, error: 0.03 });
  });

  it("warns, naming the levels and suggesting Permissive, when one stopped short", () => {
    const reports = levelReports([mesh(1000, [{ triangles: 500, error: 0.01 }, { triangles: 400, error: 0.02 }, { triangles: 300, error: 0.04 }])], lod)!;
    expect(reports.map((r) => r.short)).toEqual([false, true, true]); // 0.4 > 1.2 × 0.25 and 0.3 > 1.2 × 0.125
    const text = shortWarning(reports, lod)!;
    expect(text).toContain("LOD2, LOD3");
    expect(text).toContain("Permissive");
  });

  it("does not suggest Permissive when it is already on", () => {
    const on = { ...lod, permissive: true };
    const reports = levelReports([mesh(1000, [{ triangles: 900, error: 0.01 }])], on)!;
    expect(shortWarning(reports, on)).not.toContain("turn on Permissive");
  });

  it("stays quiet at exactly 1.2 times the target and when nothing is short", () => {
    const reports = levelReports([mesh(1000, [{ triangles: 600, error: 0.01 }])], lod)!;
    expect(reports[0].short).toBe(false);
    expect(shortWarning(reports, lod)).toBeNull();
    expect(shortWarning(null, lod)).toBeNull();
  });
});
