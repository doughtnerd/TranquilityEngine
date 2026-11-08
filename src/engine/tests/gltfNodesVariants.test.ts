// ADR 0118: glTF node pivots, lights and cameras, the physical layers' textures and anisotropy,
// and material variants — parsed, baked, and drawn on Babylon.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets } from "../index";
import { MeshRenderer } from "../render/components";
import { decodeBakedModel, encodeBakedModel } from "../scene/bakedModel";
import { engineCamera, engineLight } from "../scene/gltf";
import { parseImportSettings } from "../scene/importSettings";
import { pinPartToModelSpace } from "../scene/pivotMigration";
import { migrateSceneFile } from "../scene/SceneLoader";
import { clearModelCache, drawnVariant, loadMeshes, loadModel, materialSlots } from "../scene/models";
import { modelBaseMaterial, surfaceMaterial } from "../render/babylon/materials";
import { carGltf, dataUrl } from "./fixtures/gltf/carGltf";

const round = (a: ArrayLike<number>) => Array.from(a, (n) => +n.toFixed(4) || 0);
const S = Math.SQRT1_2;

function useCar(sidecar?: Record<string, unknown>) {
  clearModelCache();
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "models/car.gltf": dataUrl(new TextEncoder().encode(JSON.stringify(carGltf()))),
      ...(sidecar ? { "models/car.gltf.meta.json": { format: "myco.import@1", ...sidecar } } : {}),
    }),
  );
}

describe("glTF node pivots (ADR 0118)", () => {
  it("records each mesh's model-space pose and the group nodes on its path", async () => {
    useCar();
    const data = await loadModel("models/car.gltf");
    const wheel = data.meshes.find((m) => m.name === "Wheel")!;
    expect(round(wheel.pose!.position)).toEqual([1, 0.5, 0]);
    expect(round(wheel.pose!.rotation)).toEqual(round([0, S, 0, S]));
    expect(data.nodes?.find((n) => n.name === "Car")).toMatchObject({ path: [], pose: { position: [0, 0, 0] } });
  });

  it("puts one mesh in its node's space by default, in model space with pivots: model or #model", async () => {
    useCar();
    const [node] = await loadMeshes("asset:models/car.gltf#Wheel");
    expect(round(node.data.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(round(node.data.normals!.slice(0, 3))).toEqual([0, 0, 1]);
    const [pinned] = await loadMeshes("asset:models/car.gltf#Wheel#model");
    expect(round(pinned.data.positions)).toEqual([1, 0.5, 0, 1, 0.5, -1, 1, 1.5, 0]);
    // A whole-model reference stays in model space.
    const whole = await loadMeshes("asset:models/car.gltf");
    expect(round(whole.find((m) => m.name === "Wheel")!.data.positions.slice(0, 3))).toEqual([1, 0.5, 0]);
    useCar({ pivots: "model" });
    const [model] = await loadMeshes("asset:models/car.gltf#Wheel");
    expect(round(model.data.positions)).toEqual([1, 0.5, 0, 1, 0.5, -1, 1, 1.5, 0]);
  });

  it("reads and writes the pivots import setting", () => {
    expect(parseImportSettings({ format: "myco.import@1" }).settings.pivots).toBe("node");
    expect(parseImportSettings({ format: "myco.import@1", pivots: "model" }).settings.pivots).toBe("model");
    expect(parseImportSettings({ format: "myco.import@1", pivots: "wheel" }, "a.glb.meta.json").problems).toEqual(['a.glb.meta.json: "pivots" should be "model" or "node"; using the default.']);
  });
});

describe("scene format 1 → 2: part references keep model space (ADR 0118)", () => {
  it("pins FBX and glTF part references of version 1 files to model space, on nodes and in overrides", () => {
    useCar();
    const file = migrateSceneFile({
      format: "myco.scene@1",
      nodes: [
        { id: "a", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:models/car.gltf#Wheel" } }, { type: "engine.MeshCollider", data: { mesh: "asset:models/car.gltf#Body" } }] },
        { id: "b", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:models/car.gltf" } }] },
        { id: "c", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:models/crate.obj#Box" } }] },
        { id: "d", prefab: "prefabs/p.prefab.json", overrides: [{ component: "engine.MeshRenderer", field: "mesh", value: "asset:models/car.glb#Door" }] },
      ],
    });
    expect(file.format).toBe("myco.scene@2");
    const mesh = (i: number, c = 0) => file.nodes[i].components![c].data!.mesh;
    expect(mesh(0)).toBe("asset:models/car.gltf#Wheel#model");
    expect(mesh(0, 1)).toBe("asset:models/car.gltf#Body#model");
    expect(mesh(1)).toBe("asset:models/car.gltf"); // a whole model: model space anyway
    expect(mesh(2)).toBe("asset:models/crate.obj#Box"); // OBJ parts are the same in both spaces
    expect(file.nodes[3].overrides![0].value).toBe("asset:models/car.glb#Door#model");
    // Version 2 files are left alone.
    expect(migrateSceneFile({ format: "myco.scene@2", nodes: [{ id: "a", components: [{ type: "engine.MeshRenderer", data: { mesh: "asset:models/car.gltf#Wheel" } }] }] }).nodes[0].components![0].data!.mesh).toBe("asset:models/car.gltf#Wheel");
  });

  it("leaves models that opted into node pivots under version 1", () => {
    useCar({ pivots: "node" });
    expect(pinPartToModelSpace("asset:models/car.gltf#Wheel")).toBe("asset:models/car.gltf#Wheel");
  });
});

describe("glTF lights and cameras (ADR 0118)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("records lights and cameras as nodes in the engine's terms, and no longer warns about them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useCar();
    const data = await loadModel("models/car.gltf");
    const lamp = data.nodes!.find((n) => n.name === "Lamp")!;
    expect(lamp.path).toEqual(["Car"]);
    expect(round(lamp.pose.position)).toEqual([0, 3, 0]);
    expect(lamp.light).toMatchObject({ type: "point", intensity: 20, range: 8 });
    expect(round(lamp.light!.color)).toEqual([1, 0.7354, 0]); // linear 0.5 as sRGB
    const spot = data.nodes!.find((n) => n.name === "Spot")!.light!;
    expect(spot).toMatchObject({ type: "spot", range: 0 });
    expect(spot.spotAngle).toBeCloseTo(90);
    expect(spot.spotSoftness).toBeCloseTo(0.5);
    const cam = data.nodes!.find((n) => n.name === "Cam")!.camera!;
    expect(cam).toMatchObject({ projection: "perspective", near: 0.05, far: 1000 });
    expect(cam.fieldOfView).toBeCloseTo((0.8 * 180) / Math.PI);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/camera|light/i);
  });

  it("scales ranges and clip planes with the import scale", async () => {
    useCar({ scale: 2 });
    const data = await loadModel("models/car.gltf");
    expect(data.nodes!.find((n) => n.name === "Lamp")!.light!.range).toBe(16);
    expect(data.nodes!.find((n) => n.name === "Cam")!.camera!.far).toBe(2000);
    expect(round(data.nodes!.find((n) => n.name === "Cam")!.pose.position)).toEqual([0, 4, 20]);
  });

  it("converts light and camera definitions", () => {
    expect(engineLight({ type: "directional" })).toEqual({ type: "directional", color: [1, 1, 1], intensity: 1, range: 0, spotAngle: 90, spotSoftness: 1 });
    expect(engineCamera({ type: "orthographic", orthographic: { xmag: 4, ymag: 3, znear: 0.1, zfar: 50 } })).toEqual({ projection: "orthographic", fieldOfView: 60, orthographicSize: 3, near: 0.1, far: 50 });
    expect(engineCamera({ type: "perspective" })).toBeNull();
  });
});

describe("glTF physical layer textures and anisotropy (ADR 0118)", () => {
  it("reads every layer's texture and the anisotropy and iridescence values onto the surface", async () => {
    useCar();
    const [body] = await loadMeshes("asset:models/car.gltf#Body");
    const paint = body.surfaces[0];
    expect(Object.keys(paint.layerMaps ?? {}).sort()).toEqual(
      ["anisotropy", "clearcoat", "clearcoatNormal", "clearcoatRoughness", "iridescence", "iridescenceThickness", "sheenColor", "sheenRoughness", "specularColor", "specularIntensity", "transmission"].sort(),
    );
    expect(paint.layerMaps!.clearcoat!.src).toMatch(/^data:image\/png/);
    expect(paint.clearcoatNormalScale).toBe(0.5);
    expect(paint.physical).toMatchObject({ anisotropy: 0.6, anisotropyRotation: 0.5, iridescenceThickness: [200, 800], transmission: 0.5 });
  });
});

describe("glTF material variants (ADR 0118)", () => {
  it("lists the variants and each mesh's surfaces per variant, keeping slots those of the defaults", async () => {
    useCar();
    const data = await loadModel("models/car.gltf");
    expect(data.variants).toEqual(["Red", "Blue"]);
    const body = data.meshes.find((m) => m.name === "Body")!;
    expect(body.variantSurfaces?.Red.map((s) => s.name)).toEqual(["Red"]);
    expect(body.variantSurfaces?.Blue[0].color).toEqual([0, 0, 1]);
    expect(data.meshes.find((m) => m.name === "Wheel")!.variantSurfaces).toBeUndefined();
    expect(materialSlots(data.meshes).map((s) => s.name)).toEqual(["Paint", "Rubber"]);
  });

  it("gives MeshRenderer a variant field and the model's variant names", async () => {
    useCar();
    await loadModel("models/car.gltf");
    const r = new MeshRenderer();
    expect(r.variant).toBe("");
    expect(r.variants).toEqual([]); // the default cube has none
    r.mesh = "asset:models/car.gltf";
    expect(r.variants).toEqual(["Red", "Blue"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(drawnVariant(r.mesh, "Blue")).toBe("Blue");
    expect(drawnVariant(r.mesh, "Green")).toBeUndefined();
    expect(warn.mock.calls.flat().join("\n")).toMatch(/no material variant "Green"/);
    warn.mockRestore();
  });

  it("survives baking (poses, nodes, variants, layer textures)", async () => {
    useCar();
    const data = await loadModel("models/car.gltf");
    const settings = { scale: 1, upAxis: "y" as const, normals: "import" as const };
    const { bytes, dropped } = encodeBakedModel(data, settings);
    expect(dropped).toEqual([]);
    const back = decodeBakedModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, settings, (p) => p)!;
    expect(back.variants).toEqual(["Red", "Blue"]);
    expect(back.nodes?.map((n) => n.name)).toEqual(data.nodes?.map((n) => n.name));
    const body = back.meshes.find((m) => m.name === "Body")!;
    expect(body.pose).toEqual(data.meshes.find((m) => m.name === "Body")!.pose);
    expect(body.variantSurfaces?.Red[0].name).toBe("Red");
    expect(body.surfaces[0].layerMaps?.clearcoat?.bytes?.length).toBeGreaterThan(0);
  });
});

describe("glTF layers and variants on Babylon (ADR 0118)", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => engine.dispose());

  it("maps layer textures and anisotropy onto the PBR material", async () => {
    useCar();
    const [body] = await loadMeshes("asset:models/car.gltf#Body");
    const m = surfaceMaterial(scene, new WeakMap(), body.surfaces[0], "Body") as PBRMaterial;
    expect(m.clearCoat.texture).not.toBeNull();
    expect(m.clearCoat.textureRoughness).not.toBeNull();
    expect(m.clearCoat.bumpTexture?.level).toBe(0.5);
    expect(m.sheen.texture).not.toBeNull();
    expect(m.sheen.textureRoughness).not.toBeNull();
    expect(m.subSurface.refractionIntensityTexture).not.toBeNull();
    expect(m.subSurface.useGltfStyleTextures).toBe(true);
    expect(m.metallicReflectanceTexture).not.toBeNull();
    expect(m.reflectanceTexture).not.toBeNull();
    expect(m.iridescence.thicknessTexture).not.toBeNull();
    expect([m.iridescence.minimumThickness, m.iridescence.maximumThickness]).toEqual([200, 800]);
    expect(m.anisotropy.isEnabled).toBe(true);
    expect(m.anisotropy.intensity).toBeCloseTo(0.6);
    expect(m.anisotropy.angle).toBeCloseTo(0.5);
    expect(m.anisotropy.texture).not.toBeNull();
  });

  it("draws a variant's surface, unless the slot has its own material", async () => {
    useCar();
    const [body] = await loadMeshes("asset:models/car.gltf#Body");
    const cache = new WeakMap<object, BabylonMaterial>();
    const red = modelBaseMaterial(scene, cache, body, () => null, undefined, "Red") as PBRMaterial;
    expect(red.name).toBe("model:Body:Red");
    expect((modelBaseMaterial(scene, cache, body) as PBRMaterial).name).toBe("model:Body:Paint");
    expect(modelBaseMaterial(scene, cache, body, () => null, undefined, "Nope")!.name).toBe("model:Body:Paint");
    const asset = new PBRMaterial("asset", scene);
    expect(modelBaseMaterial(scene, cache, body, (s) => (s === body.surfaces[0] ? asset : null), undefined, "Red")).toBe(asset);
  });
});
