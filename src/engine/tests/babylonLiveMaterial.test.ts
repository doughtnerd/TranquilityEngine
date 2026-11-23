// ADR 0371 (T24): a model's materials animate live. A glTF material whose texture transform an animation drives keeps
// it on its textures instead of baked into the UVs, and a renderer's slot overrides (`materials[slot].<name>`, set
// with `MeshRenderer.setMaterialProperty(name, value, slot)`) draw on their own copy of that slot's material, set in
// place. Run headless on Babylon's NullEngine, through the material module's and the library's interfaces; the baked
// path's own arithmetic (three.js's texture matrix, as `models.ts` bakes it) is the reference for the transform.
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Matrix3 } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine, GameObject, SceneManager, Vector2 } from "../index";
import { MeshRenderer } from "../render/components";
import { BabylonMaterialLibrary } from "../render/babylon/materialLibrary";
import { modelBaseMaterial } from "../render/babylon/materials";
import { babylonUv, type TextureTransform } from "../render/babylon/textureTransform";
import { loadMeshes, materialSlots, meshesIfLoaded, type ModelMesh, type SurfaceInfo } from "../scene/models";

const lamp = `data:application/octet-stream;base64,${readFileSync(new URL("../../../samples/playground3d/models/lamp.glb", import.meta.url)).toString("base64")}`;
const PNG = "data:image/png;base64,iVBORw0KGgo=";

const TRANSFORMS: [string, TextureTransform][] = [
  ["offset", { offset: [0.25, -0.5], scale: [1, 1], rotation: 0 }],
  ["scale", { offset: [0, 0], scale: [2, 3], rotation: 0 }],
  ["rotation", { offset: [0, 0], scale: [1, 1], rotation: 0.7 }],
  ["all three, a non-uniform scale turned", { offset: [0.1, 0.35], scale: [2, 0.5], rotation: -1.2 }],
];

/** Where the baked path puts the file's UV (u, v): three's texture matrix on the file's UVs, then V flipped. */
function baked(t: TextureTransform, u: number, v: number): [number, number] {
  const m = new Matrix3().setUvTransform(t.offset[0], t.offset[1], t.scale[0], t.scale[1], t.rotation, 0, 0).elements; // as `uvTransformsOf`
  return [m[0] * u + m[3] * v + m[6], 1 - (m[1] * u + m[4] * v + m[7])];
}

/** Where a Babylon texture puts a mesh UV. */
function through(tex: Texture, u: number, v: number): [number, number] {
  const p = Vector3.TransformCoordinates(new Vector3(u, v, 0), tex.getTextureMatrix());
  return [p.x, p.y];
}

const POINTS: [number, number][] = [[0, 0], [1, 0], [0, 1], [0.3, 0.8], [1, 1]];

describe("live material values of a model (ADR 0371, T24)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let lib: BabylonMaterialLibrary;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "models/lamp.glb": lamp }));
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    engine = new NullEngine();
    scene = new Scene(engine);
    lib = new BabylonMaterialLibrary(scene);
  });
  afterEach(() => {
    lib.dispose();
    scene.dispose();
    engine.dispose();
  });

  const cube = (): ModelMesh => meshesIfLoaded("builtin:cube")![0]!;
  const textured = (over: Partial<SurfaceInfo>): SurfaceInfo => ({
    name: "Prop", color: [1, 1, 1], opacity: 1, transparent: false, metalness: 0, roughness: 0.5, doubleSided: false,
    map: { image: null, src: PNG }, normalMap: { image: null, src: PNG }, ...over,
  });
  /** The surface as the model's material of a cube (`modelBaseMaterial`), as the render sync builds it. */
  const built = (surface: SurfaceInfo): PBRMaterial => modelBaseMaterial(scene, new WeakMap(), { ...cube(), surfaces: [surface] }) as PBRMaterial;

  describe("texture transforms", () => {
    it.each(TRANSFORMS)("draws an unchanged live transform (%s) where the baked path puts the UVs", (_name, t) => {
      const m = built(textured({ animatedTextureTransform: t }));
      for (const tex of [m.albedoTexture, m.bumpTexture] as Texture[]) {
        for (const [u, v] of POINTS) {
          const [bu, bv] = baked(t, u, v);
          const [lu, lv] = through(tex, u, 1 - v); // the mesh holds the file's UVs, V flipped
          expect(lu).toBeCloseTo(bu, 5);
          expect(lv).toBeCloseTo(bv, 5);
        }
      }
    });

    it("leaves a surface without an animated transform alone (nothing live, the UVs carry it)", () => {
      const m = built(textured({}));
      const tex = m.albedoTexture as Texture;
      expect([tex.uOffset, tex.vOffset, tex.uScale, tex.vScale, tex.wAng]).toEqual([0, 0, 1, 1, 0]);
    });

    it("composes a texture whose V flip is in its matrix (KTX2) with the transform", () => {
      const t: TextureTransform = { offset: [0.1, 0.35], scale: [2, 0.5], rotation: -1.2 };
      const tex = new Texture(PNG, scene);
      const flat = babylonUv(t, false, { uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, wAng: 0 });
      const flipped = babylonUv(t, true, { uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, wAng: 0 });
      const set = (uv: typeof flat) => Object.assign(tex, uv, { homogeneousRotationInUVTransform: true, uRotationCenter: 0, vRotationCenter: 0, wRotationCenter: 0 });
      for (const [u, v] of POINTS) {
        set(flat);
        const [fu, fv] = through(tex, u, v);
        set(flipped);
        const [ku, kv] = through(tex, u, v);
        expect(ku).toBeCloseTo(fu, 5);
        expect(kv).toBeCloseTo(1 - fv, 5);
      }
    });

    it("moves the texture matrix with a slot's offset, scale and rotation, on the renderer's copy only", async () => {
      const surface = textured({ animatedTextureTransform: { offset: [0, 0], scale: [1, 1], rotation: 0 } });
      const sources = [{ ...cube(), surfaces: [surface] }];
      const r = GameObject.create("prop").addBehavior(MeshRenderer, { mesh: "builtin:cube" });
      const draw = () => lib.meshMaterials(r, materialSlots(sources)).of(sources[0]!) as PBRMaterial;
      const shared = draw();
      const before = through(shared.albedoTexture as Texture, 0.5, 0.5);
      r.setMaterialProperty("textureTransform.offset", new Vector2(0.25, 0.5), 0);
      const mine = draw();
      expect(mine).not.toBe(shared);
      const t: TextureTransform = { offset: [0.25, 0.5], scale: [1, 1], rotation: 0 };
      const [bu, bv] = baked(t, 0.5, 0.5);
      const [lu, lv] = through(mine.albedoTexture as Texture, 0.5, 0.5);
      expect(lu).toBeCloseTo(bu, 5);
      expect(lv).toBeCloseTo(bv, 5);
      expect(through(shared.albedoTexture as Texture, 0.5, 0.5)).toEqual(before); // the shared material's textures stay
      // Every texture of the material moves, and the other components keep the surface's own value.
      r.setMaterialProperty("textureTransform.rotation", 0.5, 0);
      r.setMaterialProperty("textureTransform.scale", [2, 2], 0);
      const turned = draw();
      expect(turned).toBe(mine); // in place
      for (const tex of [turned.albedoTexture, turned.bumpTexture] as Texture[]) {
        const [tu, tv] = baked({ offset: [0.25, 0.5], scale: [2, 2], rotation: 0.5 }, 0.5, 0.5);
        const [gu, gv] = through(tex, 0.5, 0.5);
        expect(gu).toBeCloseTo(tu, 5);
        expect(gv).toBeCloseTo(tv, 5);
      }
      r.clearMaterialProperties(0);
      expect(draw()).toBe(shared);
    });

    it("warns once about a slot transform its material keeps no live", () => {
      const warned: string[] = [];
      const own = new BabylonMaterialLibrary(scene, { warn: (_k, m) => warned.push(m) });
      const sources = [{ ...cube(), surfaces: [textured({})] }];
      const r = GameObject.create("still").addBehavior(MeshRenderer, { mesh: "builtin:cube" });
      r.setMaterialProperty("textureTransform.offset", [1, 1], 0);
      own.meshMaterials(r, materialSlots(sources)).of(sources[0]!);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("texture transform of slot 0");
      own.dispose();
    });
  });

  describe("slot overrides", () => {
    async function lampRenderer(): Promise<{ r: MeshRenderer; sources: readonly ModelMesh[]; draw(): MultiMaterial }> {
      const sources = await loadMeshes("asset:models/lamp.glb#Base"); // slot 0 Stone, slot 1 Metal
      expect(materialSlots(sources)).toHaveLength(2);
      const r = GameObject.create("lamp").addBehavior(MeshRenderer, { mesh: "asset:models/lamp.glb#Base", material: "" });
      return { r, sources, draw: () => lib.meshMaterials(r, materialSlots(sources)).of(sources[0]!) as MultiMaterial };
    }

    it("reaches the Babylon material of its slot only, in place, without touching the model's own", async () => {
      const { r, draw } = await lampRenderer();
      const [stone, metal] = (draw() as MultiMaterial).subMaterials as PBRMaterial[];
      const metalRoughness = metal.roughness;
      r.setMaterialProperty("roughness", 0.123, 1);
      const multi = draw();
      const [stone2, metal2] = multi.subMaterials as PBRMaterial[];
      expect(stone2).toBe(stone); // slot 0: the model's own, shared
      expect(metal2).not.toBe(metal);
      expect(metal2.roughness).toBeCloseTo(0.123);
      expect(metal.roughness).toBe(metalRoughness); // the shared material is another renderer's too
      // Animated every frame: the same copy, the same multi-material.
      const before = scene.materials.length;
      for (let i = 0; i < 20; i++) {
        r.setMaterialProperty("roughness", i / 20, 1);
        const m = draw();
        expect(m).toBe(multi);
        expect((m.subMaterials![1] as PBRMaterial).roughness).toBeCloseTo(i / 20);
      }
      expect(scene.materials.length).toBe(before);
      // Another renderer of the same model keeps the model's own material.
      const other = GameObject.create("lamp2").addBehavior(MeshRenderer, { mesh: "asset:models/lamp.glb#Base", material: "" });
      const otherDraw = lib.meshMaterials(other, materialSlots(await loadMeshes("asset:models/lamp.glb#Base"))).of((await loadMeshes("asset:models/lamp.glb#Base"))[0]!) as MultiMaterial;
      expect(otherDraw.subMaterials![1]).toBe(metal);
    });

    it("sets the built-in names of a model's material: colours linear, glTF's extras, the physical layers", async () => {
      const { r, draw } = await lampRenderer();
      const base = (draw().subMaterials![0] as PBRMaterial);
      r.setMaterialProperty("color", new Color(0.2, 0.4, 0.6, 0.5), 0);
      r.setMaterialProperty("emission", [3, 2, 1], 0);
      r.setMaterialProperty("metalness", 0.9, 0);
      r.setMaterialProperty("alphaCutoff", 0.25, 0);
      r.setMaterialProperty("occlusionStrength", 0.4, 0);
      r.setMaterialProperty("clearcoat", 0.8, 0);
      r.setMaterialProperty("clearcoatRoughness", 0.3, 0);
      r.setMaterialProperty("sheenColor", [0.1, 0.2, 0.3], 0);
      r.setMaterialProperty("anisotropyRotation", 1.5, 0);
      const m = draw().subMaterials![0] as PBRMaterial;
      expect(m).not.toBe(base);
      expect(m.albedoColor.asArray().map((v) => +v.toFixed(4))).toEqual([0.2, 0.4, 0.6]); // linear: no sRGB conversion
      expect(m.alpha).toBe(0.5);
      expect(m.emissiveColor.asArray()).toEqual([3, 2, 1]);
      expect(m.metallic).toBeCloseTo(0.9);
      expect(m.alphaCutOff).toBe(0.25);
      expect(m.ambientTextureStrength).toBe(0.4);
      expect(m.clearCoat.isEnabled).toBe(true);
      expect(m.clearCoat.intensity).toBeCloseTo(0.8);
      expect(m.clearCoat.roughness).toBeCloseTo(0.3);
      expect(m.sheen.color.asArray().map((v) => +v.toFixed(4))).toEqual([0.1, 0.2, 0.3]);
      expect(m.anisotropy.angle).toBe(1.5); // radians
      // Each override cleared: the model's own value again.
      r.clearMaterialProperties(0);
      expect(draw().subMaterials![0]).toBe(base);
    });

    it("frees a renderer's slot copies when it goes, and when its overrides are cleared", async () => {
      const { r, draw } = await lampRenderer();
      draw();
      const own = scene.materials.length;
      r.setMaterialProperty("roughness", 0.2, 0);
      r.setMaterialProperty("roughness", 0.4, 1);
      draw();
      expect(scene.materials.length).toBeGreaterThan(own); // two copies and their multi-material
      r.clearMaterialProperties();
      r.clearMaterialProperties(0);
      r.clearMaterialProperties(1);
      draw();
      expect(scene.materials.length).toBe(own);
      r.setMaterialProperty("roughness", 0.4, 1);
      draw();
      lib.release(r);
      expect(scene.materials.length).toBe(own);
    });

    it("keeps a slot's override apart from the renderer-wide ones and its own getters", () => {
      const r = GameObject.create("x").addBehavior(MeshRenderer, { mesh: "builtin:cube" });
      r.setMaterialProperty("roughness", 0.5);
      r.setMaterialProperty("roughness", 0.9, 2);
      expect(r.getMaterialProperty("roughness")).toBe(0.5);
      expect(r.getMaterialProperty("roughness", 2)).toBe(0.9);
      expect(r.getMaterialProperty("roughness", 1)).toBeUndefined();
      r.clearMaterialProperty("roughness", 2);
      expect(r.getMaterialProperty("roughness", 2)).toBeUndefined();
      expect(r.getMaterialProperty("roughness")).toBe(0.5);
    });
  });
});
