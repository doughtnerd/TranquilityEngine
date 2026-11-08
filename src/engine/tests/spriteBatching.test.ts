// ADR 0108: sprites draw as thin instances, one batch per run of one texture in draw order, with the
// tint and the slice's UV rectangle per instance; the editor's scene view keeps a mesh per sprite.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { pbrVertexShader } from "@babylonjs/core/Shaders/pbr.vertex.js";
import { pbrVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/pbr.vertex.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Color, Engine, GameObject, SceneManager, SpriteRenderer, Vector2 } from "../index";
import { BabylonRenderer } from "../render/babylon/BabylonRenderer";
import { SpriteBatcher, spriteUvCode, UV_RECT_ATTRIBUTE, type SpriteItem } from "../render/babylon/spriteBatches";

describe("the sprite batcher (ADR 0108)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let batcher: SpriteBatcher;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    batcher = new SpriteBatcher(scene);
  });
  afterEach(() => {
    batcher.dispose();
    scene.dispose();
    engine.dispose();
  });

  const item = (texture: Texture | null, order: number, x = 0): SpriteItem => {
    const matrix = new Float32Array(16);
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    matrix[12] = x;
    return { texture, order, matrix, color: [1, 0.5, 0.25, 0.75], uvRect: [0.25, 0, 0.25, 0.5] };
  };

  it("draws one batch per run of one texture, in draw order", () => {
    const atlas = new Texture(null, scene), other = new Texture(null, scene);
    // Equal orders group by texture; a different texture in between splits a run.
    batcher.update([item(atlas, 0), item(other, 1), item(atlas, 0, 1), item(atlas, 2), item(atlas, 2, 1)]);
    expect(batcher.stats()).toEqual({ batches: 3, sprites: 5 });
    const meshes = batcher.meshes();
    expect(meshes.map((m) => m.thinInstanceCount)).toEqual([2, 1, 2]);
    // Each run's alphaIndex is its draw order, as a lone sprite's or a tilemap layer's is.
    expect(meshes.map((m) => m.alphaIndex)).toEqual([0, 1, 2]);
    // Two textures in one order: the second run sits just after the first, still before the next order.
    batcher.update([item(atlas, 5), item(other, 5), item(atlas, 6)]);
    const [x, y, z] = batcher.meshes().map((m) => m.alphaIndex);
    expect(x).toBe(5);
    expect(y).toBeGreaterThan(5);
    expect(y).toBeLessThan(6);
    expect(z).toBe(6);
    expect((meshes[0].material as unknown as { albedoTexture: Texture }).albedoTexture).toBe(atlas);
    expect(meshes[0].material).toBe(meshes[2].material); // one material per texture
    // A whole tile map from one atlas is one draw.
    batcher.update(Array.from({ length: 500 }, (_, i) => item(atlas, 0, i)));
    expect(batcher.stats()).toEqual({ batches: 1, sprites: 500 });
    expect(batcher.meshes()[0].thinInstanceCount).toBe(500);
    expect(meshes[1].isEnabled()).toBe(false); // runs no longer needed are hidden, kept for reuse
  });

  it("fills the per-instance matrix, colour and UV rectangle", () => {
    batcher.update([item(null, 0, 3)]);
    const storage = (batcher.meshes()[0] as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array }; _userThinInstanceBuffersStorage: { data: Record<string, Float32Array> } });
    expect(storage._thinInstanceDataStorage.matrixData[12]).toBe(3);
    expect([...storage._userThinInstanceBuffersStorage.data.instanceColor.slice(0, 4)]).toEqual([1, 0.5, 0.25, 0.75]);
    expect([...storage._userThinInstanceBuffersStorage.data[UV_RECT_ATTRIBUTE].slice(0, 4)]).toEqual([0.25, 0, 0.25, 0.5]);
  });

  it("puts the UV rectangle where both PBR vertex shaders have the UV", () => {
    for (const [language, source] of [[ShaderLanguage.GLSL, pbrVertexShader.shader], [ShaderLanguage.WGSL, pbrVertexShaderWGSL.shader]] as const) {
      const code = spriteUvCode("vertex", language)!;
      for (const point of Object.keys(code)) expect(source, point).toContain(`#define ${point}`);
      // The update point comes after the UV is read.
      expect(source.indexOf("#define CUSTOM_VERTEX_UPDATE_POSITION")).toBeGreaterThan(source.search(/uvUpdated\s*[:=]/));
    }
    expect(spriteUvCode("fragment", ShaderLanguage.GLSL)).toBeNull();
  });
});

describe("sprites on the Babylon renderer (ADR 0108)", () => {
  let nullEngine: NullEngine;
  let world: World;
  type Internals = { spriteBatcher: SpriteBatcher; sprites: Map<SpriteRenderer, { mesh: unknown; item: SpriteItem | null }> };
  const make = (fill: boolean) => {
    const Ctor = BabylonRenderer as unknown as new (engine: NullEngine, settings: unknown, fill: boolean) => BabylonRenderer;
    return new Ctor(nullEngine, world.settings, fill);
  };

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "images/ui.png.meta.json": { format: "myco.import@1", sprites: [{ name: "panel", rect: [0, 0, 8, 8], pivot: [0.5, 0.5], border: [2, 2, 2, 2] }, { name: "dot", rect: [8, 0, 8, 8], pivot: [0.5, 0.5] }] },
      }),
    );
    await Engine.create({ headless: true, project: { render: { pixelsPerUnit: 16 } } });
    await SceneManager.load("s.json");
    world = World.require();
    nullEngine = new NullEngine();
  });
  afterEach(() => nullEngine.dispose());

  const sprite = (name: string, x: number, props: Record<string, unknown> = {}) => {
    const node = GameObject.create(name);
    node.transform!.position.set(x, 0, 0);
    return node.addBehavior(SpriteRenderer, { size: new Vector2(1, 1), ...props });
  };
  const syncSprites = (r: BabylonRenderer) => {
    const b = r as unknown as { syncSprite(w: World, s: SpriteRenderer, snap: number): void; flushSprites(): void; spriteSnap(w: World): number };
    const snap = b.spriteSnap(world);
    for (const s of world._componentsOfType(SpriteRenderer)) b.syncSprite(world, s, snap);
    b.flushSprites();
  };

  it("batches plain sprites into one draw, and re-fills when a sprite changes", () => {
    const r = make(false);
    const a = sprite("a", 0), b = sprite("b", 2, { color: Color.from("#ff0000") });
    syncSprites(r);
    const internals = r as unknown as Internals;
    expect(internals.spriteBatcher.stats()).toEqual({ batches: 1, sprites: 2 });
    expect(internals.sprites.get(a)!.mesh).toBeNull(); // no mesh per sprite
    expect(internals.sprites.get(b)!.item!.color[1]).toBe(0);
    b.enabled = false;
    syncSprites(r);
    expect(internals.spriteBatcher.stats().sprites).toBe(1);
    r.dispose();
  });

  it("gives 9-sliced sprites a mesh of their own in the batched path (the batcher draws plain quads)", () => {
    const r = make(false);
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(16 * 8 * 4), 16, 8, (r as unknown as { scene: Scene }).scene);
    (r as unknown as { materials: { textures: Map<string, unknown> } }).materials.textures.set("images/ui.png", tex); // as if loaded (ADR 0127)
    const sliced = sprite("panel", 0, { sprite: "asset:images/ui.png#panel", size: new Vector2(3, 2) });
    const plain = sprite("dot", 1, { sprite: "asset:images/ui.png#dot" });
    syncSprites(r);
    const internals = r as unknown as Internals;
    expect(internals.sprites.get(sliced)!.mesh).not.toBeNull();
    expect(internals.sprites.get(plain)!.mesh).toBeNull();
    expect(internals.spriteBatcher.stats()).toEqual({ batches: 1, sprites: 1 });
    r.dispose();
  });

  it("keeps a mesh per sprite in the editor's scene view", () => {
    const r = make(true);
    const a = sprite("a", 0);
    syncSprites(r);
    const internals = r as unknown as Internals;
    expect(internals.sprites.get(a)!.mesh).not.toBeNull();
    expect(internals.spriteBatcher.stats().batches).toBe(0);
    r.dispose();
  });

  it("snaps sprites to the texel grid under a pixel-perfect camera", () => {
    const r = make(false);
    GameObject.create("cam").addBehavior(Camera, { pixelPerfect: true });
    const a = sprite("a", 0.51);
    syncSprites(r);
    const m = (r as unknown as Internals).sprites.get(a)!.item!.matrix;
    expect(m[12] * 16).toBeCloseTo(Math.round(m[12] * 16)); // on a 1/16 grid (the quad's pivot offset is 0 here)
    expect(m[12]).toBeCloseTo(0.5);
    r.dispose();
  });
});
