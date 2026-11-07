import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { defaultImportSettings, formatImportSettings, parseImportSettings } from "../scene/importSettings";
import { colorHex, defaultMaterialSettings, formatMaterial, parseMaterial } from "../scene/material";
import { clearModelCache, loadMeshes, meshesIfLoaded, meshTriangles, modelMeshNames } from "../scene/models";

const file = (path: string) => readFileSync(new URL(`../../../samples/playground3d/${path}`, import.meta.url));
const dataUrl = (path: string) => `data:application/octet-stream;base64,${file(path).toString("base64")}`;

function useAssets(extra: Record<string, unknown> = {}) {
  clearModelCache();
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "models/crate.obj": dataUrl("models/crate.obj"),
      "models/crate.mtl": dataUrl("models/crate.mtl"),
      "models/robot.fbx": dataUrl("models/robot.fbx"),
      ...extra,
    }),
  );
}

const bounds = (geometry: { boundingBox: { min: { toArray(): number[] }; max: { toArray(): number[] } } | null }) => ({
  min: geometry.boundingBox!.min.toArray().map((n) => +n.toFixed(4)),
  max: geometry.boundingBox!.max.toArray().map((n) => +n.toFixed(4)),
});

describe("model assets (ADR 0044)", () => {
  beforeEach(() => useAssets());

  it("loads an OBJ with its MTL as one mesh with the library's material", async () => {
    const [crate] = await loadMeshes("asset:models/crate.obj");
    expect(crate.name).toBe("Crate");
    expect(bounds(crate.geometry!)).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    expect(crate.materials).toHaveLength(1);
    const m = crate.materials[0] as unknown as { type: string; color: { r: number } };
    expect(m.type).toBe("MeshStandardMaterial"); // converted to the default lit material
    expect(m.color.r).toBeGreaterThan(0.4);
    expect(meshTriangles(crate).indices.length).toBe(36); // six quads
  });

  it("loads an FBX's meshes in model space with unique names, and picks one with #name", async () => {
    expect(await modelMeshNames("models/robot.fbx")).toEqual(["Body", "Head"]);
    const [head] = await loadMeshes("asset:models/robot.fbx#Head#model");
    expect(bounds(head.geometry!)).toEqual({ min: [-0.25, 1.25, -0.25], max: [0.25, 1.75, 0.25] }); // its place in the file is baked in
    expect(meshesIfLoaded("asset:models/robot.fbx")?.map((m) => m.name)).toEqual(["Body", "Head"]);
  });

  it("applies the sidecar's scale and up axis, and loads again when the sidecar changes", async () => {
    useAssets({ "models/robot.fbx.meta.json": { format: "myco.import@1", scale: 2, upAxis: "z" } });
    const [head] = await loadMeshes("asset:models/robot.fbx#Head#model");
    // Z up: the file's +Y becomes the engine's -Z; scale 2.
    expect(bounds(head.geometry!)).toEqual({ min: [-0.5, -0.5, -3.5], max: [0.5, 0.5, -2.5] });
  });

  it("reports meshes still loading as null and missing ones as empty", async () => {
    expect(meshesIfLoaded("asset:models/crate.obj")).toBeNull();
    await loadMeshes("asset:models/crate.obj");
    expect(meshesIfLoaded("asset:models/crate.obj")).toHaveLength(1);
    expect(meshesIfLoaded("asset:models/crate.obj#Nope")).toEqual([]);
    expect(meshesIfLoaded("asset:models/missing.obj")).toEqual([]);
    expect(meshesIfLoaded("builtin:sphere")?.[0].name).toBe("sphere");
    expect(meshesIfLoaded("builtin:teapot")).toEqual([]);
  });
});

describe("model import settings (ADR 0044)", () => {
  it("reads and writes scale, up axis and normals, skipping bad values", () => {
    const { settings, problems } = parseImportSettings({ format: "myco.import@1", scale: 0.01, upAxis: "z", normals: "calculate" });
    expect(problems).toEqual([]);
    expect([settings.scale, settings.upAxis, settings.normals]).toEqual([0.01, "z", "calculate"]);
    expect(formatImportSettings(settings)).toBe('{\n  "format": "myco.import@1",\n  "scale": 0.01,\n  "upAxis": "z",\n  "normals": "calculate"\n}\n');
    const bad = parseImportSettings({ format: "myco.import@1", scale: -1, upAxis: "x" });
    expect(bad.problems).toHaveLength(2);
    expect(bad.settings.scale).toBe(defaultImportSettings().scale);
  });
});

describe("material assets (ADR 0043)", () => {
  it("parse with defaults, report bad values and write only what differs", () => {
    const { settings, problems } = parseMaterial({ format: "myco.material@1", color: "#ff000080", metalness: 2, roughness: 0.25, texture: "asset:t.png", tiling: [2, 2] });
    expect(problems).toEqual(['material: "metalness" should be a number from 0 to 1; using the default.']);
    expect(colorHex(settings.color)).toBe("#ff000080");
    expect(settings.roughness).toBe(0.25);
    expect(formatMaterial(settings)).toBe('{\n  "format": "myco.material@1",\n  "color": "#ff000080",\n  "texture": "asset:t.png",\n  "tiling": [2, 2],\n  "roughness": 0.25\n}\n');
    expect(formatMaterial(defaultMaterialSettings())).toBe('{\n  "format": "myco.material@1"\n}\n');
    expect(() => parseMaterial({ format: "other" })).toThrow(/unknown format/);
  });
});
