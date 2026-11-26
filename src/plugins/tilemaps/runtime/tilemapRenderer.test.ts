// ADR 0136: the tile renderer is renderer-neutral, so it's tested against a fake quad-batch host.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Vector2 } from "../../../myco";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { newLayer } from "./format";
import { Tilemap } from "./Tilemap";
import { TilemapRenderer } from "./tilemapRenderer";

interface FakeBatch extends QuadBatch {
  name: string;
  texture: string;
  quads: number;
  /** The farthest vertex from the map's origin, in local units. */
  extent: [number, number];
  order: [string, number];
  material: string | null;
  tint: [string, number];
  visible: boolean;
  matrix: number[];
  disposed: boolean;
}

function fakeHost() {
  const batches: FakeBatch[] = [];
  let loaded = false;
  const pending: (() => void)[] = [];
  const host: QuadBatchHost = {
    createBatch(name) {
      const b: FakeBatch = {
        name, texture: "", quads: 0, extent: [0, 0], order: ["", 0], material: null, tint: ["", 0], visible: false, matrix: [], disposed: false,
        setMaterial(m) { b.material = m; },
        setBlend() {},
        setQuads(texture, positions, _uv, indices) {
          b.texture = texture;
          b.quads = indices.length / 6;
          b.extent = [0, 0];
          for (let i = 0; i < positions.length; i += 3) b.extent = [Math.max(b.extent[0], positions[i]), Math.max(b.extent[1], positions[i + 1])];
        },
        setTriangles() {},
        setMatrix(m, offset = 0) { b.matrix = Array.from(m).slice(offset, offset + 16); },
        setOrder(layer, inLayer) { b.order = [layer, inLayer]; },
        setTint(c, a) { b.tint = [c, a]; },
        setMask() {},
        setVisible(v) { b.visible = v; },
        dispose() { b.disposed = true; },
      };
      batches.push(b);
      return b;
    },
    textureSize: (_path, onLoad) => (loaded ? [64, 32] : (pending.push(onLoad), null)),
  };
  return { host, batches, load: () => ((loaded = true), pending.splice(0).forEach((f) => f())) };
}

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

describe("the tile renderer (ADR 0103, 0136)", () => {
  it("makes one batch per chunk and texture, rebuilds only changed chunks, and follows layer settings and the node", async () => {
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
    const { host, batches, load } = fakeHost();
    const live = () => batches.filter((b) => !b.disposed); // the batches drawn (the test has one tilemap)
    const tiles = new TilemapRenderer(host);
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [{ ...newLayer("G", "Back"), orderInLayer: 3, tint: "#ff0000", opacity: 0.5 }] });
    map.fillRect(0, 0, 20, 2, 1); // two chunks
    const world = engine.world;
    tiles.sync(world);
    expect(live()).toHaveLength(0); // texture still loading
    load();
    tiles.sync(world);
    const first = live();
    expect(first.map((b) => b.quads).sort((a, b) => a - b)).toEqual([4 * 2, 16 * 2]);
    expect(first.every((b) => b.texture === "t.png" && b.order[0] === "Back" && b.order[1] === 3 && b.material === "" && b.visible && b.tint[0] === "#ff0000" && b.tint[1] === 0.5)).toBe(true);
    // Editing one chunk rebuilds only that chunk.
    map.setTile(18, 0, 0);
    tiles.sync(world);
    const after = live();
    expect(after.filter((b) => first.includes(b))).toHaveLength(1);
    expect(batches.filter((b) => b.disposed)).toHaveLength(1);
    // Moving the node moves the batches.
    node.transform!.position.x = 5;
    tiles.sync(world);
    expect(after.every((b) => b.matrix[12] === 5)).toBe(true);
    // Replacing the field with the same cells (as the editor does) keeps the unchanged chunks: nothing is rebuilt.
    map.layers = map.toLayerData();
    tiles.sync(world);
    expect(live().every((b, i) => b === after[i])).toBe(true);
    expect(batches.filter((b) => b.disposed)).toHaveLength(1);
    // Hiding the layer hides its batches; releasing the tilemap disposes them.
    map.layers = map.toLayerData().map((l) => ({ ...l, visible: false }));
    tiles.sync(world);
    expect(live().every((b) => !b.visible)).toBe(true);
    tiles.release(map);
    expect(batches.every((b) => b.disposed)).toBe(true);
  });

  it("draws again at the new size when the cell size changes, as collision does", async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": { format: "myco.scene@1", nodes: [] },
        "t.png": "data:image/png;base64,",
        "ts.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "asset:t.png" }] },
      }),
    );
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    await SceneManager.load("s.json");
    const { host, batches, load } = fakeHost();
    load();
    const live = () => batches.filter((b) => !b.disposed);
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.fillRect(0, 0, 2, 1, 1);
    tiles.sync(engine.world);
    const before = live().map((b) => b.extent);
    expect(before).toHaveLength(1);
    map.cellSize = new Vector2(0.5, 2);
    tiles.sync(engine.world);
    expect(live().map((b) => b.extent)).toEqual([[before[0][0] * 0.5, before[0][1] * 2]]);
    // Unchanged again: nothing is rebuilt.
    const drawn = live();
    tiles.sync(engine.world);
    expect(live()).toEqual(drawn);
    expect(batches.filter((b) => b.disposed)).toHaveLength(1);
  });
});
