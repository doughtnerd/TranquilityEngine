// ADR 0108: sprites draw as thin instances, one batch per run of one texture in draw order, with the
// tint and the slice's UV rectangle per instance; the editor's scene view keeps a mesh per sprite.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Color, Engine, GameObject, SceneManager, Vector2 } from "../index";
import { SpriteRenderer } from "../render/components";
import { BabylonSprites } from "../render/babylon/sprites";
import type { FeatureSyncContext } from "../render/babylon/feature";
import { batchedSpriteMaterial, layeredQuadMaterial, SpriteBatcher, type SpriteItem } from "../render/babylon/layeredQuads";
import { BabylonMaterials2D } from "../render/babylon/materials2D";
import { nullEngine, shaderText } from "./pbrShaderSource";
import { _registeredRenderFeatures } from "../render/renderFeatures";
import { claimSprites } from "../render/spriteClaims";
import { drawPlace } from "../render/sortOrder";

/** A plugin's render feature spec, as its activation registered it. */
const registeredSpec = (name: string) => _registeredRenderFeatures().find((f) => f.spec.name === name)!.spec;
const SPRITES_SPEC = registeredSpec("sprites");

// Read through Babylon's public API only: the scene's meshes, their alphaIndex and thin-instance count,
// and the thin-instance buffers handed to `thinInstanceSetBuffer` (the batcher fills them in place).
const buffers = new Map<Mesh, Map<string, Float32Array>>();
const setBuffer = Mesh.prototype.thinInstanceSetBuffer;
beforeEach(() => {
  buffers.clear();
  vi.spyOn(Mesh.prototype, "thinInstanceSetBuffer").mockImplementation(function (this: Mesh, kind, data, ...rest) {
    if (data instanceof Float32Array) (buffers.get(this) ?? buffers.set(this, new Map()).get(this)!).set(kind, data);
    return setBuffer.call(this, kind, data, ...rest);
  });
});
afterEach(() => vi.restoreAllMocks());
/** The scene's meshes drawn now, in draw order. */
const drawn = (scene: Scene): AbstractMesh[] => scene.meshes.filter((m) => m.isEnabled() && !m.isDisposed()).sort((a, b) => a.alphaIndex - b.alphaIndex);
/** The sprite batches drawn now (thin-instance meshes), in draw order. */
const batches = (scene: Scene): Mesh[] => drawn(scene).filter((m): m is Mesh => m instanceof Mesh && m.thinInstanceCount > 0);
/** Instance `i`'s `stride` floats of a batch's buffer `kind`. */
const instance = (mesh: Mesh, kind: string, i: number, stride: number): number[] => [...buffers.get(mesh)!.get(kind)!.slice(i * stride, (i + 1) * stride)];
/** The material plugin a batch's material reads each instance's UV rectangle with (Babylon's plugin API). */
const uvPlugin = (mesh: Mesh): MaterialPluginBase => (mesh.material as PBRMaterial).pluginManager!.getPlugin("MycoSpriteUv")!;
/** The per-instance attribute that plugin reads. */
const uvAttribute = (mesh: Mesh): string => {
  const attributes: string[] = [];
  uvPlugin(mesh).getAttributes(attributes, mesh.getScene(), mesh);
  return attributes[0]!;
};
const batchedSprites = (scene: Scene): number => batches(scene).reduce((n, m) => n + m.thinInstanceCount, 0);

describe("the sprite batcher (ADR 0108)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let batcher: SpriteBatcher;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    batcher = new SpriteBatcher(scene);
    materials.clear();
  });
  afterEach(() => {
    batcher.dispose();
    scene.dispose();
    engine.dispose();
  });

  /** A sprite batch material per texture (as the 2D materials share them, ADR 0418). */
  const materials = new Map<Texture | null, PBRMaterial>();
  const batchMaterial = (texture: Texture | null, s: Scene = scene): PBRMaterial => {
    let m = materials.get(texture);
    if (!m || m.getScene() !== s) {
      materials.set(texture, (m = layeredQuadMaterial("sprites", s, texture)));
      batchedSpriteMaterial(m);
    }
    return m;
  };
  const item = (texture: Texture | null, order: number, x = 0, s: Scene = scene): SpriteItem => {
    const matrix = new Float32Array(16);
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    matrix[12] = x;
    return { material: batchMaterial(texture, s), order, matrix, color: [1, 0.5, 0.25, 0.75], uvRect: [0.25, 0, 0.25, 0.5] };
  };

  it("draws one batch per run of one material (one texture), in draw order", () => {
    const atlas = new Texture(null, scene), other = new Texture(null, scene);
    // Equal orders group by texture; a different texture in between splits a run.
    batcher.update([item(atlas, 0), item(other, 1), item(atlas, 0, 1), item(atlas, 2), item(atlas, 2, 1)]);
    expect([batches(scene).length, batchedSprites(scene)]).toEqual([3, 5]);
    const meshes = batches(scene);
    expect(meshes.map((m) => m.thinInstanceCount)).toEqual([2, 1, 2]);
    // Each run's alphaIndex is its draw order, as a lone sprite's or a tilemap layer's is.
    expect(meshes.map((m) => m.alphaIndex)).toEqual([0, 1, 2]);
    // Two textures in one order: the second run sits just after the first, still before the next order.
    batcher.update([item(atlas, 5), item(other, 5), item(atlas, 6)]);
    const [x, y, z] = batches(scene).map((m) => m.alphaIndex);
    expect(x).toBe(5);
    expect(y).toBeGreaterThan(5);
    expect(y).toBeLessThan(6);
    expect(z).toBe(6);
    expect((meshes[0].material as PBRMaterial).albedoTexture).toBe(atlas);
    expect(meshes[0].material).toBe(meshes[2].material); // a run draws with its sprites' material
    // A whole tile map from one atlas is one draw.
    batcher.update(Array.from({ length: 500 }, (_, i) => item(atlas, 0, i)));
    expect([batches(scene).length, batchedSprites(scene)]).toEqual([1, 500]);
    expect(batches(scene)[0].thinInstanceCount).toBe(500);
    expect(meshes[1].isEnabled()).toBe(false); // runs no longer needed are hidden, kept for reuse
  });

  it("keeps runs of two materials at one y-sorted place below the next height (ADR 0438)", () => {
    const atlas = new Texture(null, scene), other = new Texture(null, scene);
    const place = (y: number) => drawPlace({ sortingLayers: ["Default"], ySortedLayers: ["Default"] }, "Default", 0, y);
    const ySortedItem = (texture: Texture, y: number): SpriteItem => ({ ...item(texture, place(y)), ySorted: true });
    // A tenth of a unit lower than the two at y = 1: the plain run step (1e-4) would put the second run above it.
    batcher.update([ySortedItem(atlas, 1), ySortedItem(other, 1), ySortedItem(atlas, 0.9)]);
    const [first, second, lower] = batches(scene);
    expect(first!.alphaIndex).toBe(place(1));
    expect(second!.alphaIndex).toBeGreaterThan(first!.alphaIndex);
    expect(second!.alphaIndex).toBeLessThan(lower!.alphaIndex);
    expect(lower!.alphaIndex).toBe(place(0.9));
  });

  it("fills the per-instance matrix, colour and UV rectangle", () => {
    batcher.update([item(null, 0, 3)]);
    const [mesh] = batches(scene);
    expect(instance(mesh, "matrix", 0, 16)[12]).toBe(3);
    expect(instance(mesh, "instanceColor", 0, 4)).toEqual([1, 0.5, 0.25, 0.75]);
    expect(instance(mesh, uvAttribute(mesh), 0, 4)).toEqual([0.25, 0, 0.25, 0.5]);
  });

  it("puts the UV rectangle in both PBR vertex shaders, after the UV is read", async () => {
    for (const language of ["glsl", "wgsl"] as const) {
      const e = nullEngine(language);
      const s = new Scene(e);
      const b = new SpriteBatcher(s);
      b.update([item(null, 0, 0, s)]);
      const mesh = batches(s)[0]!;
      const { vertex, fragment } = await shaderText(mesh.material!, mesh);
      const attribute = uvAttribute(mesh);
      expect(vertex).toContain(language === "wgsl" ? `attribute ${attribute}: vec4f;` : `attribute vec4 ${attribute};`);
      const update = vertex.indexOf(language === "wgsl" ? `uvUpdated = vertexInputs.${attribute}.xy` : `uvUpdated = ${attribute}.xy`);
      expect(update).toBeGreaterThan(vertex.search(/uvUpdated\s*[:=]/));
      expect(fragment).not.toContain(attribute); // vertex only
      b.dispose();
      s.dispose();
      e.dispose();
    }
  });
});

describe("the sprite feature (ADR 0108, 0130)", () => {
  let nullEngine: NullEngine;
  let scene: Scene;
  let world: World;
  let policy: "batched" | "perObject";
  let textures: Map<string, Texture>;
  let warnings: string[];
  /** The y-sorted sorting layers the feature is told (ADR 0438); undefined: the project's. */
  let ySorted: string[] | undefined;
  /** The sprites drawn by a mesh of their own (ADR 0276: drawn as a quad). */
  const own = (f: BabylonSprites): SpriteRenderer[] => [...f.drawn()].filter((d) => d.shape?.kind === "quad").map((d) => d.component as SpriteRenderer);
  /** The quad meshes of the sprites drawn by a mesh of their own. */
  const quads = (f: BabylonSprites) => [...f.drawn()].flatMap((d) => (d.shape?.kind === "quad" ? [d.shape.mesh] : []));
  /** The nodes with a sprite drawn now, batched or not (`RenderDiagnostics.drawn`). */
  const drawnNodes = (f: BabylonSprites) => [...f.drawn()].map((d) => d.component.node);
  const make = (): BabylonSprites =>
    new BabylonSprites({
      scene,
      pixelsPerUnit: () => world.settings.render.pixelsPerUnit,
      sortingLayers: () => world.settings.render.sortingLayers,
      ySortedLayers: () => ySorted ?? world.settings.render.ySortedLayers,
      texture: (path) => textures.get(path) ?? null,
      materials2D: new BabylonMaterials2D({ scene, library: { texture: (path) => textures.get(path) ?? null } }),
      drawPolicy: () => policy,
      warnOnce: (key) => void warnings.push(key),
    });

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
    scene = new Scene(nullEngine);
    policy = "batched";
    textures = new Map();
    warnings = [];
    ySorted = undefined;
  });
  afterEach(() => {
    scene.dispose();
    nullEngine.dispose();
  });

  const sprite = (name: string, x: number, props: Record<string, unknown> = {}) => {
    const node = GameObject.create(name);
    node.transform!.position.set(x, 0, 0);
    return node.addBehavior(SpriteRenderer, { size: new Vector2(1, 1), ...props });
  };
  const ctx = {} as FeatureSyncContext;

  it("is registered as a content-phase, eager feature that owns SpriteRenderers", () => {
    expect(SPRITES_SPEC).toMatchObject({ name: "sprites", phase: "content", lazy: false });
    expect(SPRITES_SPEC.types).toEqual([SpriteRenderer]);
  });

  it("batches plain sprites into one draw, and re-fills when a sprite changes", () => {
    const f = make();
    sprite("a", 0); const b = sprite("b", 2, { color: Color.from("#ff0000") });
    f.sync(world, ctx);
    expect(batches(scene).map((m) => m.thinInstanceCount)).toEqual([2]);
    expect(own(f)).toEqual([]); // no mesh per sprite
    const [batch] = batches(scene);
    expect(instance(batch, "instanceColor", 0, 4)).toEqual([1, 1, 1, 1]); // a
    expect(instance(batch, "instanceColor", 1, 4)).toEqual([1, 0, 0, 1]); // b, red
    expect(drawnNodes(f).map((n) => n.name).sort()).toEqual(["a", "b"]);
    b.enabled = false;
    f.sync(world, ctx);
    expect(batchedSprites(scene)).toBe(1);
    expect(drawnNodes(f).map((n) => n.name)).toEqual(["a"]);
    f.dispose();
  });

  it("leaves sprites another feature claims to it (ADR 0371: skinned slices), in the same frame", () => {
    const f = make();
    sprite("a", 0);
    const b = sprite("b", 2);
    const unclaim = claimSprites((r) => r === b);
    f.sync(world, ctx);
    expect(drawnNodes(f).map((n) => n.name)).toEqual(["a"]);
    unclaim();
    f.sync(world, ctx);
    expect(drawnNodes(f).map((n) => n.name).sort()).toEqual(["a", "b"]);
    f.dispose();
  });

  it("gives 9-sliced sprites a mesh of their own in the batched path (the batcher draws plain quads)", () => {
    const f = make();
    textures.set("images/ui.png", RawTexture.CreateRGBATexture(new Uint8Array(16 * 8 * 4), 16, 8, scene)); // as if loaded (ADR 0127)
    const sliced = sprite("panel", 0, { sprite: "asset:images/ui.png#panel", size: new Vector2(3, 2) });
    const plain = sprite("dot", 1, { sprite: "asset:images/ui.png#dot" });
    f.sync(world, ctx);
    expect(own(f)).toEqual([sliced]);
    expect(batches(scene).map((m) => m.thinInstanceCount)).toEqual([1]); // the plain one
    expect(drawnNodes(f)).toContain(plain.node);
    f.dispose();
  });

  it("keeps a mesh per sprite when the draw policy is perObject (the editor's scene view)", () => {
    policy = "perObject";
    const f = make();
    const a = sprite("a", 0);
    f.sync(world, ctx);
    expect(own(f)).toEqual([a]);
    expect(batches(scene)).toEqual([]);
    f.dispose();
  });

  it("batches in a game, and keeps a mesh per sprite once the policy turns perObject (ADR 0129)", () => {
    const f = make();
    const a = sprite("a", 0);
    f.sync(world, ctx);
    expect(own(f)).toEqual([]);
    expect(batchedSprites(scene)).toBe(1);
    policy = "perObject"; // editor play mode reaches into the game World: its viewport handle asks for per-object meshes
    f.sync(world, ctx);
    expect(own(f)).toEqual([a]);
    expect(batchedSprites(scene)).toBe(0);
    f.dispose();
  });

  it("snaps sprites to the texel grid under a pixel-perfect camera", () => {
    const f = make();
    GameObject.create("cam").addBehavior(Camera, { pixelPerfect: true });
    sprite("a", 0.51);
    f.sync(world, ctx);
    const m = instance(batches(scene)[0], "matrix", 0, 16);
    expect(m[12] * 16).toBeCloseTo(Math.round(m[12] * 16)); // on a 1/16 grid (the quad's pivot offset is 0 here)
    expect(m[12]).toBeCloseTo(0.5);
    f.dispose();
  });

  it("orders by sorting layer, warns once-per-key on an unknown layer, and sizes sprites", () => {
    const f = make();
    const layers = world.settings.render.sortingLayers;
    expect(f.sortOrder(layers[0], 5)).toBe(5);
    if (layers.length > 1) expect(f.sortOrder(layers[1], 5)).toBe(10005);
    expect(f.sortOrder("nope", 3)).toBe(3);
    expect(warnings).toEqual(["layer|nope"]);
    const sized = sprite("a", 0, { size: new Vector2(2, 3) });
    f.sync(world, ctx);
    expect([...f.drawn()].find((d) => d.component === sized)?.size).toEqual([2, 3]);
    f.dispose();
  });

  /** A sprite at height `y` with order in layer `order` (same texture: the default, white). */
  const at = (name: string, y: number, order = 0) => {
    const s = sprite(name, 0, { orderInLayer: order });
    s.node.transform!.position.set(0, y, 0);
    return s;
  };
  /** Each batch's instances' world heights, in draw order. */
  const heights = () => batches(scene).map((m) => Array.from({ length: m.thinInstanceCount }, (_, i) => instance(m, "matrix", i, 16)[13]));

  it("draws each sprite of a y-sorted layer at its own place, higher first, within its order in layer (ADR 0438)", () => {
    ySorted = ["Default"];
    const f = make();
    at("a", 2); at("b", 0); at("c", 1); at("d", 5, 1); at("e", -3, 1);
    f.sync(world, ctx);
    expect(heights()).toEqual([[2], [1], [0], [5], [-3]]); // order 0 by height, then order 1 by height
    const [a, c, b, d, e] = batches(scene).map((m) => m.alphaIndex);
    expect(a).toBeLessThan(c!);
    expect(c).toBeLessThan(b!);
    for (const v of [a, b, c]) expect(Math.floor(v!)).toBe(0); // still in their order in layer's band
    for (const v of [d, e]) expect(Math.floor(v!)).toBe(1);
    expect(d).toBeLessThan(e!);
    f.dispose();
  });

  it("still batches sprites of one material at one height in a y-sorted layer, and moves a sprite that moves", () => {
    ySorted = ["Default"];
    const f = make();
    at("a", 1); at("b", 1); const low = at("c", 0);
    f.sync(world, ctx);
    expect(heights()).toEqual([[1, 1], [0]]);
    low.node.transform!.position.set(0, 4, 0); // walks up past the others: drawn behind them now
    f.sync(world, ctx);
    expect(heights()).toEqual([[4], [1, 1]]);
    f.dispose();
  });

  it("leaves layers that aren't y-sorted as they were: one run per order and material", () => {
    const f = make();
    at("a", 2); at("b", 0); at("c", 1); at("d", 5, 1);
    f.sync(world, ctx);
    expect(batches(scene).map((m) => [m.thinInstanceCount, m.alphaIndex])).toEqual([[3, 0], [1, 1]]);
    f.dispose();
  });

  it("places a sprite with a mesh of its own by height too, and reports that place for picking", () => {
    ySorted = ["Default"];
    policy = "perObject";
    const f = make();
    const high = at("high", 3), low = at("low", -1);
    f.sync(world, ctx);
    const placed = new Map([...f.drawn()].map((d) => [d.component, d]));
    const mesh = (r: SpriteRenderer) => (placed.get(r)!.shape as { mesh: AbstractMesh }).mesh;
    expect(mesh(high).alphaIndex).toBeLessThan(mesh(low).alphaIndex);
    expect(placed.get(high)!.order).toBe(mesh(high).alphaIndex);
    expect(placed.get(low)!.order).toBe(mesh(low).alphaIndex);
    f.dispose();
  });

  it("release drops a sprite's mesh and batch entry; dispose frees everything", () => {
    policy = "perObject";
    const f = make();
    const a = sprite("a", 0);
    f.sync(world, ctx);
    const [mesh] = quads(f);
    f.release(a);
    expect(own(f)).toEqual([]);
    expect(drawnNodes(f)).toEqual([]);
    expect(mesh.isDisposed()).toBe(true);
    sprite("b", 1);
    f.sync(world, ctx);
    const [meshB] = quads(f);
    f.dispose();
    expect(meshB.isDisposed()).toBe(true);
    expect(own(f)).toEqual([]);
    expect(scene.meshes).toEqual([]);
  });
});
