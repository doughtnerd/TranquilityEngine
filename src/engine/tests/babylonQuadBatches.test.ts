// ADR 0103, 0136: tilemap chunks drawn through the Babylon quad batches, on NullEngine with a fake texture loader.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { Tilemap } from "../../plugins/tilemaps/runtime/Tilemap";
import { BabylonQuadBatches } from "../render/babylon/quadBatches";
import { TilemapRenderer } from "../../plugins/tilemaps/runtime/tilemapRenderer";
import { newLayer } from "../../plugins/tilemaps/runtime/format";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

describe("Babylon quad batches drawing tilemaps (ADR 0103, 0136)", () => {
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
    const pending: ((t: Texture) => void)[] = [];
    const tex = { getBaseSize: () => ({ width: 64, height: 32 }), hasAlpha: false } as unknown as Texture;
    const quads = new BabylonQuadBatches({
      scene,
      texture: (_path, onLoad) => (loaded ? tex : (pending.push(onLoad), null)),
      dataTexture: () => null,
      sortOrder: (layer, order) => ["Back", "Default"].indexOf(layer) * 10000 + order,
    });
    const tilemaps = new TilemapRenderer(quads);
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [{ ...newLayer("G", "Back"), orderInLayer: 3 }] });
    map.fillRect(0, 0, 20, 2, 1); // two chunks
    const world = World.require();
    tilemaps.sync(world);
    expect([...scene.meshes]).toHaveLength(0); // texture still loading
    loaded = true;
    pending.forEach((f) => f(tex));
    tilemaps.sync(world);
    const meshes = [...scene.meshes];
    expect(meshes).toHaveLength(2);
    expect(meshes.map((m) => m.getTotalVertices()).sort((a, b) => a - b)).toEqual([4 * 4 * 2, 16 * 4 * 2]);
    expect(meshes[0].alphaIndex).toBe(3);
    // Editing one chunk rebuilds only that chunk.
    map.setTile(18, 0, 0);
    tilemaps.sync(world);
    const after = [...scene.meshes];
    expect(after.filter((m) => meshes.includes(m))).toHaveLength(1);
    // Hiding the layer hides its meshes; removing the tilemap disposes them.
    map.layers = map.toLayerData().map((l) => ({ ...l, visible: false }));
    tilemaps.sync(world);
    expect([...scene.meshes].every((m) => !m.isEnabled())).toBe(true);
    const material = after[0].material!;
    expect(after.every((m) => m.material === material)).toBe(true); // one shared material per texture and tint
    tilemaps.release(map);
    expect(after.every((m) => m.isDisposed())).toBe(true);
    expect(scene.materials.includes(material)).toBe(false); // released with its last batch
    quads.dispose();
  });
});

describe("Babylon quad batches drawing triangles (ADR 0370, 0371: skinned sprites)", () => {
  it("builds a mesh of any triangles, then only moves its vertices while the indices stay the same", () => {
    const scene = new Scene(new NullEngine());
    const tex = { getBaseSize: () => ({ width: 8, height: 8 }), hasAlpha: false } as unknown as Texture;
    const quads = new BabylonQuadBatches({ scene, texture: () => tex, dataTexture: () => null, sortOrder: (_layer, order) => order });
    const batch = quads.createBatch("skinned");
    batch.setVisible(true);
    const indices = new Uint32Array([0, 1, 2]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    batch.setTriangles("t.png", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs, indices);
    const mesh = quads.meshOf(batch)!;
    expect(mesh.getTotalVertices()).toBe(3);
    expect(mesh.getTotalIndices()).toBe(3);
    // Same indices: the same mesh, its positions moved.
    batch.setTriangles("t.png", new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), uvs, indices);
    expect(quads.meshOf(batch)).toBe(mesh);
    expect(Array.from(mesh.getVerticesData("position")!)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    // New indices (another mesh): rebuilt.
    batch.setTriangles("t.png", new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), new Float32Array(8), new Uint32Array([0, 1, 2, 0, 2, 3]));
    expect(quads.meshOf(batch)).not.toBe(mesh);
    expect(mesh.isDisposed()).toBe(true);
    expect(quads.meshOf(batch)!.getTotalIndices()).toBe(6);
    quads.dispose();
  });
});
