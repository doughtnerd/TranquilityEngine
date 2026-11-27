// ADR 0418: the 2D materials, through their interface (`acquire`, a handle's `material`, `update`, `release`) and the
// quad batches that use them, on NullEngine: sharing and release, the lit decision, refreshing in place when the 2D
// lighting rig's layout changes, the texture's normal map, and the tangents a deforming quad batch then gets.
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Light2D, SceneManager } from "../../myco";
import { LIGHTS_2D_QUALITY } from "../core/graphics";
import { World } from "../core/World";
import { BabylonLights2D } from "../render/babylon/lights2D";
import { TANGENT_2D_ATTRIBUTE, type LitQuadSetup } from "../render/babylon/lights2DMaterial";
import { BabylonMaterials2D, type Material2DRequest } from "../render/babylon/materials2D";
import { BabylonQuadBatches } from "../render/babylon/quadBatches";
import { nullEngine } from "./pbrShaderSource";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function world(files: Record<string, unknown> = {}): Promise<World> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, ...files }));
  const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default", "Front"] } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return World.require();
}

/** A scene with a 2D lighting rig and 2D materials whose every texture has loaded. */
function setUp() {
  const scene = new Scene(nullEngine("glsl"));
  const tex = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene) as unknown as Texture;
  const rig = new BabylonLights2D({ scene, texture: () => null, textureSize: () => null });
  const materials2D = new BabylonMaterials2D({ scene, library: { texture: () => tex } });
  return { scene, tex, rig, materials2D };
}

const light2D = (material: Material) => (material as PBRMaterial).pluginManager?.getPlugin<{ setup: LitQuadSetup }>("MycoLight2D") ?? null;
const at = (layer: string, fields: Partial<Material2DRequest> = {}): Material2DRequest => ({ texture: "hero.png", material: "", sortingLayer: layer, ...fields });

describe("the 2D materials (ADR 0418)", () => {
  it("share a material between draws asking for the same, and free it with its last handle", async () => {
    await world();
    const { scene, materials2D } = setUp();
    const a = materials2D.acquire(at("Default"));
    const b = materials2D.acquire(at("Default"));
    const red = materials2D.acquire(at("Default", { tint: { r: 1, g: 0, b: 0, a: 1 } }));
    expect(a.material).toBe(b.material);
    expect(red.material).not.toBe(a.material);
    const shared = a.material;
    a.release();
    expect(scene.materials).toContain(shared);
    b.release();
    expect(scene.materials).not.toContain(shared);
    materials2D.dispose();
    expect(scene.materials).not.toContain(red.material);
  });

  it("light a draw on a lit layer; not on an unlit layer, nor with Sprite Unlit or no material", async () => {
    const w = await world({
      "flat.material.json": { format: "myco.material@1", shader: "sprite-unlit" },
      "flat.shadergraph.json": { format: "myco.shadergraph@1", target: "sprite-unlit" },
      "lit.shadergraph.json": { format: "myco.shadergraph@1", target: "sprite-lit" },
    });
    const { rig, materials2D } = setUp();
    Object.assign(GameObject.create("sun").addComponent(Light2D), { type: "global", targetSortingLayers: ["Back"] });
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(light2D(materials2D.acquire(at("Back")).material)?.setup.batch).toBe(rig.batchOfLayer("Back"));
    expect(light2D(materials2D.acquire(at("Default")).material)).toBeNull(); // no 2D light on its layer
    expect(light2D(materials2D.acquire(at("Back", { material: null })).material)).toBeNull();
    expect(light2D(materials2D.acquire(at("Back", { material: "flat.material.json" })).material)).toBeNull();
    expect(light2D(materials2D.acquire(at("Back", { material: "flat.shadergraph.json" })).material)).toBeNull();
    expect(light2D(materials2D.acquire(at("Back", { material: "lit.shadergraph.json" })).material)).not.toBeNull();
    // 2D particles take the setup itself: the same object while the lighting holds.
    expect(materials2D.litSetup("", "Back")).toBe(materials2D.litSetup("", "Back"));
    expect(materials2D.litSetup("", "Default")).toBeNull();
  });

  it("pick their material again, in place, when the rig's layer batches change", async () => {
    const w = await world();
    const { scene, rig, materials2D } = setUp();
    const sun = Object.assign(GameObject.create("sun").addComponent(Light2D), { type: "global", targetSortingLayers: ["Back"] });
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    const changed = vi.fn();
    const h = materials2D.acquire(at("Default"), changed);
    const unlit = h.material;
    const setup = materials2D.litSetup("", "Back");
    expect(light2D(unlit)).toBeNull();
    sun.targetSortingLayers = []; // every layer now
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(h.material).not.toBe(unlit);
    expect(light2D(h.material)).not.toBeNull();
    expect(scene.materials).not.toContain(unlit); // its last handle moved on
    expect(materials2D.litSetup("", "Back")).not.toBe(setup); // particles rebuild their draws
    rig.sync(w, LIGHTS_2D_QUALITY.high); // the same layout: nothing changes
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keep a masked draw's material while its mask moves, and change it for another mask texture", async () => {
    await world();
    const { materials2D } = setUp();
    const h = materials2D.acquire(at("Default", { mask: { texture: "crate.png", uv: [1, 0, 0, 0, 1, 0] } }));
    const first = h.material;
    const mask = () => (h.material as PBRMaterial).pluginManager!.getPlugin<{ mask: { uv: readonly number[] } }>("MycoQuadMask")!.mask;
    h.update(at("Default", { mask: { texture: "crate.png", uv: [2, 0, 0.5, 0, 2, 0.5] } }));
    expect(h.material).toBe(first);
    expect(mask().uv).toEqual([2, 0, 0.5, 0, 2, 0.5]);
    h.update(at("Default", { mask: { texture: "barrel.png", uv: [1, 0, 0, 0, 1, 0] } }));
    expect(h.material).not.toBe(first);
  });

  it("read the texture's normal map, and a deforming quad batch then gets tangents that follow its vertices", async () => {
    const w = await world({ "hero.png": "data:,", "hero.png.meta.json": { format: "myco.import@1", secondaryTextures: { normalMap: "asset:hero_n.png" } } });
    const { scene, tex, rig, materials2D } = setUp();
    GameObject.create("sun").addComponent(Light2D).type = "global";
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(materials2D.acquire(at("Default")).normalMapped).toBe(true);
    expect(light2D(materials2D.acquire(at("Default")).material)?.setup.normal).toBe(tex);
    expect(materials2D.acquire(at("Default", { texture: "plain.png" })).normalMapped).toBe(false);

    const quads = new BabylonQuadBatches({ scene, materials2D, texture: () => tex, sortOrder: (_layer, order) => order });
    const batch = quads.createBatch("skinned");
    batch.setOrder("Default", 0);
    batch.setMaterial("");
    const indices = new Uint32Array([0, 1, 2]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    batch.setTriangles("hero.png", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs, indices);
    const mesh = quads.meshOf(batch)!;
    expect(Array.from(mesh.getVerticesData(TANGENT_2D_ATTRIBUTE)!).map(Math.round)).toEqual([1, 0, 1, 0, 1, 0]);
    // Turned a quarter: texture +U now points along +Y.
    batch.setTriangles("hero.png", new Float32Array([0, 0, 0, 0, 1, 0, -1, 0, 0]), uvs, indices);
    expect(quads.meshOf(batch)).toBe(mesh);
    expect(Array.from(mesh.getVerticesData(TANGENT_2D_ATTRIBUTE)!).map(Math.round)).toEqual([0, 1, 0, 1, 0, 1]);
    batch.setMaterial(null); // unlit: no normal map, no tangents
    expect(mesh.isVerticesDataPresent(TANGENT_2D_ATTRIBUTE)).toBe(false);
    quads.dispose();
  });
});
