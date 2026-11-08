// ADR 0089: material slots. A MeshRenderer's slots are its model's own materials in order of first
// use; `materials[i]`, then `material`, then the model's import settings replace them. Also the
// glTF surface fields (ADR 0088) on Babylon's PBR material.
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { MeshRenderer } from "../render/components";
import { getFields } from "../core/registry";
import { formatImportSettings, parseImportSettings } from "../scene/importSettings";
import { DEFAULT_SLOT, clearModelCache, loadMeshes, materialSlots, type SurfaceInfo } from "../scene/models";
import { meshOf, modelMaterial, surfaceMaterial } from "../render/babylon/materials";

const lamp = () => `data:application/octet-stream;base64,${readFileSync(new URL("../../../samples/playground3d/models/lamp.glb", import.meta.url)).toString("base64")}`;

describe("material slots (ADR 0089)", () => {
  beforeEach(() => {
    clearModelCache();
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/lamp.glb": lamp() }));
  });

  it("lists a model's materials once each, in order of first use, and one default slot for a built-in mesh", async () => {
    const meshes = await loadMeshes("asset:models/lamp.glb");
    expect(materialSlots(meshes).map((s) => s.name)).toEqual(["Stone", "Metal", "Bulb", "Glass"]); // Metal is shared by Base and Pole
    expect(materialSlots(await loadMeshes("asset:models/lamp.glb#Pole")).map((s) => s.name)).toEqual(["Metal"]);
    const cube = await loadMeshes("builtin:cube");
    expect(materialSlots(cube)).toEqual([{ name: "Default", surface: DEFAULT_SLOT }]);
  });

  it("gives MeshRenderer a list of material assets", () => {
    const f = getFields(MeshRenderer).find((x) => x.name === "materials");
    expect(f).toBeDefined();
    expect(new MeshRenderer().materials).toEqual([]);
  });

  it("reads and writes the sidecar's materials by name", () => {
    const { settings, problems } = parseImportSettings({ format: "myco.import@1", materials: { Stone: "asset:materials/rock.material.json", Metal: 3, Glass: "" } }, "lamp.glb.meta.json");
    expect(settings.materials).toEqual({ Stone: "asset:materials/rock.material.json" });
    expect(problems).toEqual(['lamp.glb.meta.json: materials["Metal"] should be a material asset path; ignored.']);
    expect(JSON.parse(formatImportSettings(settings))).toEqual({ format: "myco.import@1", materials: { Stone: "asset:materials/rock.material.json" } });
    expect(parseImportSettings({ format: "myco.import@1" }).settings.materials).toEqual({});
  });

  describe("on Babylon", () => {
    let engine: NullEngine;
    let scene: Scene;
    beforeEach(() => {
      engine = new NullEngine();
      scene = new Scene(engine);
    });
    afterEach(() => engine.dispose());

    it("draws a slot's replacement, the rest with the model's own materials, under one multi-material", async () => {
      const [base] = await loadMeshes("asset:models/lamp.glb#Base"); // Stone and Metal
      const cache = new WeakMap<object, BabylonMaterial>();
      const rock = new PBRMaterial("rock", scene);
      const made: BabylonMaterial[] = [];
      const mesh = meshOf(scene, "base", base);
      const m = modelMaterial(scene, cache, base, mesh, (s) => (s.name === "Stone" ? rock : null), made);
      expect(m).toBeInstanceOf(MultiMaterial);
      expect(made).toEqual([m]);
      const subs = (m as MultiMaterial).subMaterials;
      expect(subs[0]).toBe(rock);
      expect(subs[1]?.name).toBe("model:Base:Metal");
      expect(mesh.subMeshes.map((s) => s.materialIndex)).toEqual([0, 1]);
    });

    it("draws one material without submeshes when every slot has the same one, and asks for the default slot without surfaces", async () => {
      const [base] = await loadMeshes("asset:models/lamp.glb#Base");
      const all = new PBRMaterial("all", scene);
      expect(modelMaterial(scene, new WeakMap(), base, meshOf(scene, "b", base), () => all)).toBe(all);
      const [cube] = await loadMeshes("builtin:cube");
      expect(modelMaterial(scene, new WeakMap(), cube, meshOf(scene, "c", cube), (s) => (s === DEFAULT_SLOT ? all : null))).toBe(all);
      expect(modelMaterial(scene, new WeakMap(), cube, meshOf(scene, "c2", cube))).toBeNull();
    });

    it("maps glTF surface fields onto the PBR material (ADR 0088)", () => {
      const surface: SurfaceInfo = {
        name: "S",
        color: [1, 0.5, 0.25],
        opacity: 1,
        transparent: false,
        metalness: 0.3,
        roughness: 0.7,
        doubleSided: true,
        map: null,
        emissive: [2, 1, 0],
        alphaMode: "mask",
        alphaCutoff: 0.4,
        unlit: false,
        physical: { clearcoat: 0.5, clearcoatRoughness: 0.2, sheen: 1, sheenColor: [1, 0, 0], sheenRoughness: 0.3, transmission: 0.8, thickness: 0.1, ior: 1.4, specularIntensity: 0.9, specularColor: [1, 1, 1], iridescence: 0, iridescenceIOR: 1.3 },
      };
      const m = surfaceMaterial(scene, new WeakMap(), surface, "Mesh") as PBRMaterial;
      expect(m.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHATEST);
      expect(m.alphaCutOff).toBe(0.4);
      expect(m.emissiveColor.asArray()).toEqual([2, 1, 0]);
      expect(m.backFaceCulling).toBe(false);
      expect(m.clearCoat.isEnabled).toBe(true);
      expect(m.sheen.isEnabled).toBe(true);
      expect(m.subSurface.isRefractionEnabled).toBe(true);
      expect(m.indexOfRefraction).toBeCloseTo(1.4);
      expect(m.iridescence.isEnabled).toBe(false);
      const blend = surfaceMaterial(scene, new WeakMap(), { ...surface, alphaMode: "blend", opacity: 0.5, physical: undefined }, "Mesh") as PBRMaterial;
      expect(blend.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHABLEND);
      expect(blend.alpha).toBe(0.5);
      expect((surfaceMaterial(scene, new WeakMap(), { ...surface, unlit: true }, "Mesh") as PBRMaterial).unlit).toBe(true);
    });
  });
});
