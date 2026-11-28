// ADR 0186: layered 2D quads own the 2D material and the draw order (alphaIndex) of tiles, sprite runs,
// lone sprites and particle meshes. Read through Babylon's public API: the scene's meshes and alphaIndex.
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batchedSpriteMaterial, layeredQuadMaterial, placeInLayer, placeParticles, SpriteBatcher, type SpriteItem } from "../render/babylon/layeredQuads";
import { BabylonQuadBatches } from "../render/babylon/quadBatches";
import { BabylonMaterials2D } from "../render/babylon/materials2D";
import { sortingOrder } from "../render/sortOrder";

const LAYERS = ["Back", "Default"];
const order = (layer: string, inLayer: number) => sortingOrder(LAYERS, layer, inLayer);

describe("layered 2D quads (ADR 0014, 0108, 0136, 0186)", () => {
  const materials = new Map<Texture, PBRMaterial>();
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    materials.clear();
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  /** The scene's meshes drawn now, by name, in Babylon's transparent order (alphaIndex first). */
  const drawOrder = (): string[] =>
    scene.meshes
      .filter((m) => m.isEnabled())
      .sort((a, b) => a.alphaIndex - b.alphaIndex)
      .map((m) => m.name);
  /** A sprite batch material per texture (as the 2D materials share them). */
  const batchMaterial = (texture: Texture): PBRMaterial => {
    let m = materials.get(texture);
    if (!m) {
      materials.set(texture, (m = layeredQuadMaterial(`sprites:${materials.size}`, scene, texture)));
      batchedSpriteMaterial(m);
    }
    return m;
  };
  const sprite = (texture: Texture, at: number): SpriteItem => ({ material: batchMaterial(texture), order: at, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), color: [1, 1, 1, 1], uvRect: [0, 0, 1, 1] });
  const tileLayer = (name: string, layer: string, inLayer: number) => {
    const tex = { getBaseSize: () => ({ width: 16, height: 16 }), hasAlpha: false } as unknown as Texture;
    const quads = new BabylonQuadBatches({ scene, materials2D: new BabylonMaterials2D({ scene, library: { texture: () => tex } }), texture: () => tex, sortSettings: () => ({ sortingLayers: LAYERS }), unknownLayer: () => {} });
    const batch = quads.createBatch(name);
    batch.setOrder(layer, inLayer);
    batch.setVisible(true);
    batch.setQuads("t.png", new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), new Uint32Array([0, 1, 2, 0, 2, 3]));
    return { quads, batch };
  };
  const particles = (name: string, renderOrder: number) => placeParticles(new Mesh(name, scene), renderOrder);

  it("draws tiles, sprite runs, lone sprites and particle meshes in one order", () => {
    const { quads, batch } = tileLayer("tiles", "Back", 2);
    const batcher = new SpriteBatcher(scene);
    const atlas = new Texture(null, scene), other = new Texture(null, scene);
    batcher.update([sprite(atlas, order("Back", 1)), sprite(other, order("Back", 1)), sprite(atlas, order("Default", 0))]);
    const lone = new Mesh("lone", scene);
    placeInLayer(lone, order("Back", 2));
    particles("fx-behind", -3);
    particles("fx-default", 0);
    particles("fx-front", 5);
    const names = drawOrder();
    // The two runs of Back 1 (two textures) come first among 2D content, then Back 2 (tiles and the lone
    // sprite share it), then Default 0. A negative particle order sits before them; 0 sits with the
    // scene's other transparent meshes, after all 2D content; a positive one after everything.
    expect(names[0]).toBe("fx-behind");
    expect(names.slice(1, 3)).toEqual(["sprites:0", "sprites:1"]);
    expect(names.slice(3, 5).sort()).toEqual(["lone", "tiles"]);
    expect(names.slice(5)).toEqual(["sprites:2", "fx-default", "fx-front"]);
    // Runs of one order stay below the next whole order.
    const alpha = Object.fromEntries(scene.meshes.map((m) => [m.name, m.alphaIndex]));
    expect(alpha["sprites:0"]).toBe(1);
    expect(alpha["sprites:1"]).toBeGreaterThan(1);
    expect(alpha["sprites:1"]).toBeLessThan(2);
    expect(alpha.tiles).toBe(2);
    expect(alpha.lone).toBe(2);
    expect(alpha["sprites:2"]).toBe(10000);
    expect(alpha["fx-default"]).toBe(Number.MAX_VALUE); // Babylon's default: where the scene's other meshes sit
    // A tile layer moved to another order follows.
    batch.setOrder("Default", 1);
    expect(drawOrder().slice(4)).toEqual(["sprites:2", "tiles", "fx-default", "fx-front"]);
    batcher.dispose();
    quads.dispose();
  });

  it("steps each further run of one order, fractional orders included", () => {
    // orderInLayer is any number: two textures at 0.5 are two runs, the second a step past the first.
    const batcher = new SpriteBatcher(scene);
    const a = new Texture(null, scene), b = new Texture(null, scene), c = new Texture(null, scene);
    batcher.update([sprite(a, 0.5), sprite(b, 0.5), sprite(c, 0.5), sprite(a, -2.25), sprite(b, -2.25), sprite(a, 1.5)]);
    const alpha = drawOrder().map((n) => scene.getMeshByName(n)!.alphaIndex);
    expect(new Set(alpha).size).toBe(6); // no two runs tie
    expect(alpha[0]).toBe(-2.25);
    expect(alpha[1]).toBeGreaterThan(-2.25);
    expect(alpha[1]).toBeLessThan(0.5);
    expect(alpha[2]).toBe(0.5);
    expect(alpha[4]).toBeLessThan(1.5);
    expect(alpha[5]).toBe(1.5);
    batcher.dispose();
  });

  it("gives every 2D quad the unlit, layer-ordered material", () => {
    const tex = new Texture(null, scene);
    const m = layeredQuadMaterial("q", scene, tex);
    expect(m).toBeInstanceOf(PBRMaterial);
    expect(m.unlit).toBe(true);
    expect(m.backFaceCulling).toBe(false);
    expect(m.disableDepthWrite).toBe(true);
    expect(m.depthFunction).toBe(Constants.ALWAYS);
    expect(m.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHABLEND);
    expect(m.useAlphaFromAlbedoTexture).toBe(true);
    expect(m.albedoTexture).toBe(tex);
  });
});
