// ADR 0103: tilemap chunks on the Babylon backend, on NullEngine with a fake texture loader.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, GameObject, SceneManager, Tilemap } from "../index";
import { BabylonTilemaps } from "../render/babylon/tilemaps";
import { newLayer } from "../tilemap/format";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

describe("Babylon tilemaps (ADR 0103)", () => {
  it("builds one mesh per chunk and texture, rebuilds only changed chunks, and follows layer settings", async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "t.png": "data:image/png;base64,",
        "t.png.meta.json": { format: "myco.import@1", sprites: [{ name: "a", rect: [0, 0, 16, 16], pivot: [0, 0] }] },
        "ts.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "asset:t.png#a" }] },
      }),
    );
    const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default"] } } });
    engines.push(engine);
    await SceneManager.load("s.json");
    const scene = new Scene(new NullEngine());
    let loaded = false;
    const pending: (() => void)[] = [];
    const tex = { getBaseSize: () => ({ width: 64, height: 32 }), hasAlpha: false } as unknown as Texture;
    const tilemaps = new BabylonTilemaps({
      scene,
      texture: (_path, onLoad) => (loaded ? tex : (pending.push(onLoad), null)),
      sortOrder: (layer, order) => ["Back", "Default"].indexOf(layer) * 10000 + order,
    });
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [{ ...newLayer("G", "Back"), orderInLayer: 3 }] });
    map.fillRect(0, 0, 20, 2, 1); // two chunks
    const world = World.require();
    tilemaps.sync(world);
    expect(tilemaps.meshesOf(map)).toHaveLength(0); // texture still loading
    loaded = true;
    pending.forEach((f) => f());
    tilemaps.sync(world);
    const meshes = tilemaps.meshesOf(map);
    expect(meshes).toHaveLength(2);
    expect(meshes.map((m) => m.getTotalVertices()).sort((a, b) => a - b)).toEqual([4 * 4 * 2, 16 * 4 * 2]);
    expect(meshes[0].alphaIndex).toBe(3);
    // Editing one chunk rebuilds only that chunk.
    map.setTile(18, 0, 0);
    tilemaps.sync(world);
    const after = tilemaps.meshesOf(map);
    expect(after.filter((m) => meshes.includes(m))).toHaveLength(1);
    // Hiding the layer hides its meshes; removing the tilemap disposes them.
    map.layers = map.toLayerData().map((l) => ({ ...l, visible: false }));
    tilemaps.sync(world);
    expect(tilemaps.meshesOf(map).every((m) => !m.isEnabled())).toBe(true);
    tilemaps.release(map);
    expect(after.every((m) => m.isDisposed())).toBe(true);
  });
});
