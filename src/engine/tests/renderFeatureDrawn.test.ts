// ADR 0276: what a render feature drew is a hook the renderer iterates over every loaded feature, so tile
// layers, water and meshes alike are reported, framed and counted in a thumbnail, and a feature's content
// holds the World's readiness until it has loaded. A thumbnail renderer (the one way a renderer takes an
// engine it's given) on Babylon's NullEngine, with the real plugin features and its real editor tools.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { MeshRenderer } from "../render/components";
import { WaterSurface } from "../render/water/WaterSurface";
import { Tilemap } from "../../plugins/tilemaps/runtime/Tilemap";
import { newLayer } from "../../plugins/tilemaps/runtime/format";
import { BabylonRenderer, loadPluginFeatures, type PluginFeature } from "../render/babylon/BabylonRenderer";
import type { BabylonFeatureFactory } from "../render/babylon/feature";
import type { RenderFeatureSpec } from "../render/renderFeatures";

describe("what render features drew (ADR 0276)", () => {
  let nullEngine: NullEngine;
  let renderer: BabylonRenderer;
  let world: World;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "t.png": "data:image/png;base64,iVBORw0KGgo=",
        "t.png.meta.json": { format: "myco.import@1", sprites: [{ name: "a", rect: [0, 0, 16, 16], pivot: [0, 0] }] },
        "ts.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "asset:t.png#a" }] },
      }),
    );
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    world = World.require();
    nullEngine = new NullEngine();
  });
  afterEach(() => {
    renderer?.dispose();
    nullEngine.dispose();
    Assets.clearSources();
  });

  /** Sync until the content has loaded (textures, models), at most a few hundred ms. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      renderer.sync(world);
      if (renderer.contentReady()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("reports, frames and counts tile layers, water and meshes, each under its feature's name", async () => {
    const map = GameObject.create("Ground").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.fillRect(0, 0, 4, 2, 1);
    const sea = GameObject.create("Sea").addBehavior(WaterSurface, { size: 10 });
    sea.node.transform!.position.set(0, -2, 0);
    const crate = GameObject.create("Crate").addBehavior(MeshRenderer, { mesh: "builtin:cube" });
    GameObject.create("Hidden").addBehavior(MeshRenderer, { mesh: "builtin:cube" }).enabled = false;
    // The features this World needs (the lazy water one too), as thumbnails load them.
    renderer = BabylonRenderer.forThumbnail(nullEngine, world.settings, await loadPluginFeatures(world), { studio: null });
    renderer.setPolicy({ drawPolicy: "perObject" });
    await settle();
    await settle(); // the water feature arrives a sync after it loads

    const drawn = renderer.diagnostics().drawn.map((d) => `${d.feature}:${d.node.name}`).sort();
    expect(drawn).toEqual(["meshes:Crate", "tilemaps:Ground", "water:Sea"]);
    expect(renderer.diagnostics().drawn.find((d) => d.feature === "meshes")!.materials).toHaveLength(1);

    const tools = (await renderer.loadEditorTools())!;
    const tiles = tools.drawnBounds(map.node)!;
    expect(tiles).not.toBeNull(); // four by two cells, in the node's plane
    expect(tiles.max[0] - tiles.min[0]).toBeGreaterThan(tiles.max[1] - tiles.min[1]);
    const water = tools.drawnBounds(sea.node)!;
    expect(water.max[0] - water.min[0]).toBeCloseTo(10, 3);
    expect(tools.drawnBounds(crate.node)).toEqual({ min: [expect.closeTo(-0.5), expect.closeTo(-0.5), expect.closeTo(-0.5)], max: [expect.closeTo(0.5), expect.closeTo(0.5), expect.closeTo(0.5)] });

    // A thumbnail frames everything drawn in the world: the crate, the tile layer's chunk and the sea.
    expect(renderer.contentMeshes().map((m) => m.name).sort()).toEqual(expect.arrayContaining(["myco-water", expect.stringMatching(/^tilemap:Ground/)]));
  });

  it("holds the World's readiness while any loaded feature's content is loading", () => {
    let loaded = false;
    const factory: BabylonFeatureFactory = () => ({ sync: () => {}, loaded: () => loaded, dispose: () => {} });
    const spec: RenderFeatureSpec = { name: "slow", phase: "content", types: [], lazy: false };
    const plugged: PluginFeature = { registration: { spec, load: async () => factory }, factory };
    renderer = BabylonRenderer.forThumbnail(nullEngine, world.settings, [plugged], { studio: null });
    renderer.sync(world);
    expect(renderer.contentReady()).toBe(false);
    loaded = true;
    renderer.sync(world);
    expect(renderer.contentReady()).toBe(true);
  });
});
