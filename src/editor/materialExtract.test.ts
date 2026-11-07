import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../engine";
import { colorHex } from "../engine/scene/material";
import { clearModelCache, type SurfaceInfo } from "../engine/scene/models";
import { readImportSettings } from "./assetImport";
import { readMaterial } from "./materialAssets";
import { extractModelMaterials, materialFromSurface } from "./materialExtract";
import { joinPath, openFolderProject } from "./projects";
import { MemoryFileSystem, ROOT } from "./testing";

const surface = (over: Partial<SurfaceInfo> = {}): SurfaceInfo => ({ name: "S", color: [1, 0.2158605, 0], opacity: 0.5, transparent: true, metalness: 0.4, roughness: 0.3, doubleSided: false, map: null, ...over });

describe("extracting a model's materials (ADR 0089)", () => {
  afterEach(() => {
    clearModelCache();
    Assets.clearSources();
  });

  it("turns a surface into material asset settings, in sRGB, saying what it can't keep", () => {
    const { settings, lost } = materialFromSurface(surface({ alphaMode: "blend", emissive: [2, 0, 0], occlusionMap: { image: null, src: "x" } }), () => "");
    expect(colorHex(settings.color)).toBe("#ff8000" + "80");
    expect([settings.metalness, settings.roughness, settings.shader]).toEqual([0.4, 0.3, "lit"]);
    expect(colorHex(settings.emission)).toBe("#ff0000");
    expect(lost).toEqual(["emission brighter than 1", "occlusion map"]);
    expect(materialFromSurface(surface({ unlit: true }), () => "").settings.shader).toBe("unlit");
    const glass = materialFromSurface(surface({ physical: { clearcoat: 0, clearcoatRoughness: 0, sheen: 0, sheenColor: [1, 1, 1], sheenRoughness: 1, transmission: 0.9, thickness: 0.2, ior: 1.45, specularIntensity: 1, specularColor: [1, 1, 1], iridescence: 0, iridescenceIOR: 1.3 } }), () => "").settings;
    expect([glass.shader, glass.transmission, glass.ior]).toEqual(["physical", 0.9, 1.45]);
    expect(materialFromSurface(surface({ map: { image: null, src: "u" } }), () => "asset:t.png").settings.texture).toBe("asset:t.png");
  });

  it("writes a material asset per material beside the model and maps them in its import settings", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "models/lamp.glb"), new Uint8Array(readFileSync(new URL("../../samples/playground3d/models/lamp.glb", import.meta.url))));
    const project = await openFolderProject(fs, ROOT);
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/lamp.glb": `data:application/octet-stream;base64,${readFileSync(new URL("../../samples/playground3d/models/lamp.glb", import.meta.url)).toString("base64")}` }));
    const result = await extractModelMaterials(project, "models/lamp.glb");
    expect(Object.keys(result.materials)).toEqual(["Stone", "Metal", "Bulb", "Glass"]);
    expect(result.materials.Metal).toBe("asset:models/lamp Materials/Metal.material.json");
    expect(result.lost).toEqual(["Bulb: emission brighter than 1"]);
    const metal = readMaterial(project, "models/lamp Materials/Metal.material.json").settings;
    expect([metal.metalness, metal.roughness]).toEqual([1, 0.35]);
    const glass = readMaterial(project, "models/lamp Materials/Glass.material.json").settings;
    expect(glass.color.a).toBeCloseTo(0.3, 2);
    expect(readImportSettings(project, "models/lamp.glb").settings.materials).toEqual(result.materials);
  });
});
