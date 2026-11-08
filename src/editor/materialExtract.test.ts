import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../engine";
import { colorHex, parseMaterial } from "../engine/scene/material";
import { clearModelCache, type SurfaceInfo } from "../engine/scene/models";
import { readImportSettings } from "./assetImport";
import { extractModelMaterials, materialFromSurface } from "./materialExtract";
import { joinPath, openFolderProject } from "./projects";
import { MemoryFileSystem, ROOT } from "./testing";

const surface = (over: Partial<SurfaceInfo> = {}): SurfaceInfo => ({ name: "S", color: [1, 0.2158605, 0], opacity: 0.5, transparent: true, metalness: 0.4, roughness: 0.3, doubleSided: false, map: null, ...over });

describe("extracting a model's materials (ADR 0089)", () => {
  afterEach(() => {
    clearModelCache();
    Assets.clearSources();
  });

  it("turns a surface into material asset settings, in sRGB, keeping its maps (ADR 0118)", () => {
    const tex = (src: string, uvSet = 0) => ({ image: null, src, uvSet });
    const roles: string[] = [];
    const { settings, lost } = materialFromSurface(
      surface({ alphaMode: "mask", alphaCutoff: 0.3, emissive: [2, 0, 0], emissiveMap: tex("e"), metalRoughMap: tex("mr"), occlusionMap: tex("o", 1), occlusionStrength: 0.5, normalMap: tex("n"), normalScale: 0.8 }),
      (info, role) => (roles.push(role), `asset:${info.src}.png`),
    );
    expect(colorHex(settings.color)).toBe("#ff8000");
    expect([settings.metalness, settings.roughness, settings.shader]).toEqual([0.4, 0.3, "lit"]);
    expect(colorHex(settings.emission)).toBe("#ff0000");
    expect(settings.emissionIntensity).toBe(2); // HDR emission as colour × intensity
    expect([settings.emissionMap, settings.metalRoughMap, settings.occlusionMap, settings.normalMap]).toEqual(["asset:e.png", "asset:mr.png", "asset:o.png", "asset:n.png"]);
    expect([settings.occlusionStrength, settings.normalScale, settings.alphaMode, settings.alphaCutoff]).toEqual([0.5, 0.8, "mask", 0.3]);
    expect(roles).toEqual(["Normal", "Emission", "MetalRough", "Occlusion"]);
    expect(lost).toEqual(["occlusion map (on the second UV set)"]);
    const blend = materialFromSurface(surface({ alphaMode: "blend" }), () => "").settings;
    expect([colorHex(blend.color), blend.alphaMode]).toEqual(["#ff800080", "blend"]);
    expect(materialFromSurface(surface({ unlit: true }), () => "").settings.shader).toBe("unlit");
    const glass = materialFromSurface(surface({ physical: { clearcoat: 0, clearcoatRoughness: 0, sheen: 0, sheenColor: [1, 1, 1], sheenRoughness: 1, transmission: 0.9, thickness: 0.2, ior: 1.45, specularIntensity: 1, specularColor: [1, 1, 1], iridescence: 0, iridescenceIOR: 1.3 } }), () => "").settings;
    expect([glass.shader, glass.transmission, glass.ior]).toEqual(["physical", 0.9, 1.45]);
    expect(materialFromSurface(surface({ map: { image: null, src: "u" } }), () => "asset:t.png").settings.texture).toBe("asset:t.png");
  });

  it("keeps the physical layers' textures, anisotropy, attenuation and iridescence thickness (ADR 0118)", () => {
    const physical = { clearcoat: 1, clearcoatRoughness: 0, sheen: 0, sheenColor: [1, 1, 1] as [number, number, number], sheenRoughness: 1, transmission: 0, thickness: 0, ior: 1.5, specularIntensity: 1, specularColor: [1, 1, 1] as [number, number, number], iridescence: 0, iridescenceIOR: 1.3 };
    const s = materialFromSurface(
      surface({
        physical: { ...physical, anisotropy: 0.6, anisotropyRotation: Math.PI / 2, attenuationDistance: 2, attenuationColor: [1, 0, 0], iridescenceThickness: [200, 800] },
        layerMaps: { clearcoat: { image: null, src: "c" }, clearcoatNormal: { image: null, src: "cn" }, sheenColor: { image: null, src: "s" }, anisotropy: { image: null, src: "a" } },
        clearcoatNormalScale: 0.5,
      }),
      (info) => `asset:${info.src}.png`,
    ).settings;
    expect(s.shader).toBe("physical");
    expect([s.clearcoatMap, s.clearcoatNormalMap, s.sheenColorMap, s.anisotropyMap]).toEqual(["asset:c.png", "asset:cn.png", "asset:s.png", "asset:a.png"]);
    expect([s.anisotropy, s.anisotropyRotation, s.attenuationDistance, colorHex(s.attenuationColor), s.iridescenceThicknessMin, s.iridescenceThicknessMax, s.clearcoatNormalScale]).toEqual([0.6, 90, 2, "#ff0000", 200, 800, 0.5]);
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
    expect(result.lost).toEqual([]);
    const metal = parseMaterial(project.assets.get("models/lamp Materials/Metal.material.json")).settings;
    expect([metal.metalness, metal.roughness]).toEqual([1, 0.35]);
    const glass = parseMaterial(project.assets.get("models/lamp Materials/Glass.material.json")).settings;
    expect(glass.color.a).toBeCloseTo(0.3, 2);
    expect(readImportSettings(project, "models/lamp.glb").settings.materials).toEqual(result.materials);
  });
});
