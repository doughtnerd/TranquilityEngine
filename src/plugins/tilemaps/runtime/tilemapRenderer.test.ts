// ADR 0136: the tile renderer is renderer-neutral, so it's tested against a fake quad-batch host.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import { World } from "../../../engine/core/World";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { newLayer } from "./format";
import { Tilemap } from "./Tilemap";
import { TilemapRenderer } from "./tilemapRenderer";

interface FakeBatch extends QuadBatch {
  name: string;
  texture: string;
  quads: number;
  order: number;
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
        name, texture: "", quads: 0, order: 0, tint: ["", 0], visible: false, matrix: [], disposed: false,
        setQuads(texture, _p, _uv, indices) { b.texture = texture; b.quads = indices.length / 6; },
        setMatrix(m, offset = 0) { b.matrix = Array.from(m).slice(offset, offset + 16); },
        setOrder(o) { b.order = o; },
        setTint(c, a) { b.tint = [c, a]; },
        setVisible(v) { b.visible = v; },
        dispose() { b.disposed = true; },
      };
      batches.push(b);
      return b;
    },
    textureSize: (_path, onLoad) => (loaded ? [64, 32] : (pending.push(onLoad), null)),
    sortOrder: (layer, order) => ["Back", "Default"].indexOf(layer) * 10000 + order,
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
    const tiles = new TilemapRenderer(host);
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [{ ...newLayer("G", "Back"), orderInLayer: 3, tint: "#ff0000", opacity: 0.5 }] });
    map.fillRect(0, 0, 20, 2, 1); // two chunks
    const world = World.require();
    tiles.sync(world);
    expect(tiles.batchesOf(map)).toHaveLength(0); // texture still loading
    load();
    tiles.sync(world);
    const first = tiles.batchesOf(map) as FakeBatch[];
    expect(first.map((b) => b.quads).sort((a, b) => a - b)).toEqual([4 * 2, 16 * 2]);
    expect(first.every((b) => b.texture === "t.png" && b.order === 3 && b.visible && b.tint[0] === "#ff0000" && b.tint[1] === 0.5)).toBe(true);
    // Editing one chunk rebuilds only that chunk.
    map.setTile(18, 0, 0);
    tiles.sync(world);
    const after = tiles.batchesOf(map);
    expect(after.filter((b) => first.includes(b as FakeBatch))).toHaveLength(1);
    expect(batches.filter((b) => b.disposed)).toHaveLength(1);
    // Moving the node moves the batches.
    node.transform!.position.x = 5;
    tiles.sync(world);
    expect((after as FakeBatch[]).every((b) => b.matrix[12] === 5)).toBe(true);
    // Hiding the layer hides its batches; releasing the tilemap disposes them.
    map.layers = map.toLayerData().map((l) => ({ ...l, visible: false }));
    tiles.sync(world);
    expect((tiles.batchesOf(map) as FakeBatch[]).every((b) => !b.visible)).toBe(true);
    tiles.release(map);
    expect(batches.every((b) => b.disposed)).toBe(true);
  });
});
