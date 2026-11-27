// ADR 0136: the tile renderer is renderer-neutral, so it's tested against a fake quad-batch host.
import { afterEach, describe, expect, it, vi } from "vitest";
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
  /** `setOrder`'s third argument (ADR 0437): undefined when none was passed. */
  within: number | undefined;
  material: string | null;
  tint: [string, number];
  visible: boolean;
  matrix: number[];
  /** ADR 0444: the matrix each camera of the last `render` drew it with (its own `matrix` unless a listener set one). */
  drawnWith: number[][];
  /** A matrix set from a camera listener, for the camera drawing now. */
  cameraMatrix: number[] | null;
  disposed: boolean;
  /** The arrays of the last `setQuads`, and how many times it was called. */
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  sets: number;
}

function fakeHost() {
  const batches: FakeBatch[] = [];
  let loaded = false;
  const pending: (() => void)[] = [];
  const listeners = new Set<(camera: readonly [number, number, number]) => void>();
  let inCamera = false;
  const host: QuadBatchHost = {
    createBatch(name) {
      const b: FakeBatch = {
        name, texture: "", quads: 0, extent: [0, 0], order: ["", 0], within: undefined, material: null, tint: ["", 0], visible: false, matrix: [], drawnWith: [], cameraMatrix: null, disposed: false,
        positions: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), sets: 0,
        setMaterial(m) { b.material = m; },
        setBlend() {},
        setQuads(texture, positions, uvs, indices) {
          b.texture = texture;
          b.positions = positions;
          b.uvs = uvs;
          b.indices = indices;
          b.sets++;
          b.quads = indices.length / 6;
          b.extent = [0, 0];
          for (let i = 0; i < positions.length; i += 3) b.extent = [Math.max(b.extent[0], positions[i]), Math.max(b.extent[1], positions[i + 1])];
        },
        setTriangles() {},
        setMatrix(m, offset = 0) {
          const matrix = Array.from(m).slice(offset, offset + 16);
          if (inCamera) b.cameraMatrix = matrix;
          else b.matrix = matrix;
        },
        setOrder(layer, inLayer, within) { b.order = [layer, inLayer]; b.within = within; },
        setTint(c, a) { b.tint = [c, a]; },
        setMask() {},
        setVisible(v) { b.visible = v; },
        dispose() { b.disposed = true; },
      };
      batches.push(b);
      return b;
    },
    textureSize: (_path, onLoad) => (loaded ? [64, 32] : (pending.push(onLoad), null)),
    onCameraRender(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  /** Draw a frame with these cameras (world positions), as the backend does: listeners before each, then back to each batch's own matrix. */
  const render = (cameras: [number, number, number][]) => {
    for (const b of batches) b.drawnWith = [];
    for (const camera of cameras) {
      inCamera = true;
      for (const listener of listeners) listener(camera);
      inCamera = false;
      for (const b of batches) b.drawnWith.push(b.cameraMatrix ?? b.matrix);
    }
    for (const b of batches) b.cameraMatrix = null;
  };
  return { host, batches, render, listeners, load: () => ((loaded = true), pending.splice(0).forEach((f) => f())) };
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
    expect(first.every((b) => b.texture === "t.png" && b.order[0] === "Back" && b.order[1] === 3 && b.within === undefined && b.material === "" && b.visible && b.tint[0] === "#ff0000" && b.tint[1] === 0.5)).toBe(true);
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

  it("orders a non-square layer's chunks back to front, and draws again when the grid changes (ADR 0437)", async () => {
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
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")], gridShape: "isometric" });
    // Chunks (0, 0), (1, 0) and (1, 1): on an isometric map (1, 1) is the farthest back, (0, 0) the front.
    for (const [x, y] of [[0, 0], [16, 0], [16, 16]]) map.setTile(x, y, 1);
    tiles.sync(engine.world);
    const within = (chunk: string) => live().find((b) => b.name.endsWith(`:${chunk}`))!.within!;
    expect(live()).toHaveLength(3);
    expect(within("1,1")).toBeLessThan(within("1,0"));
    expect(within("1,0")).toBeLessThan(within("0,0"));
    for (const b of live()) {
      expect(b.within).toBeGreaterThanOrEqual(0);
      expect(b.within).toBeLessThan(1);
    }
    // Another grid lays the vertices out again; a square grid passes no painter's order.
    const before = live();
    map.gridShape = "square";
    tiles.sync(engine.world);
    expect(live().some((b) => before.includes(b))).toBe(false);
    expect(live().every((b) => b.within === undefined)).toBe(true);
  });
});

/** An Engine with `files` as its assets (plus an empty scene) and `project` settings, its scene loaded; and a loaded fake host. */
async function setup(files: Record<string, unknown>, project: Record<string, unknown> = {}, kind?: "editor") {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "t.png": "data:image/png;base64,", "u.png": "data:image/png;base64,", ...files }));
  const engine = await Engine.create({ headless: true, project, ...(kind ? { kind } : {}) });
  engines.push(engine);
  await SceneManager.load("s.json");
  const fake = fakeHost();
  fake.load();
  return { engine, ...fake, live: () => fake.batches.filter((b) => !b.disposed) };
}

/** Advance the World's scaled time by `seconds`, a frame at a time. */
function advance(engine: Engine, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) engine.step(Math.min(0.05, seconds - t));
}

const SLICES = { format: "myco.import@1", sprites: ["a", "b", "c"].map((name, i) => ({ name, rect: [i * 16, 0, 16, 16], pivot: [0, 0] })) };
/** u0 of slice i of `SLICES` in the fake 64 × 32 texture. */
const sliceU = (i: number) => (i * 16) / 64;

describe("the tile renderer's animated tiles (ADR 0437)", () => {
  const files = (start?: "random") => ({
    "t.png.meta.json": SLICES,
    "ts.tileset.json": {
      format: "myco.tileset@1",
      tileSize: [16, 16],
      tiles: [
        { id: 1, sprite: "asset:t.png#a", animation: { frames: [{ sprite: "asset:t.png#a", duration: 0.1 }, { sprite: "asset:t.png#b", duration: 0.2 }, { sprite: "asset:t.png#c", duration: 0.1 }], ...(start ? { start } : {}) } },
        { id: 2, sprite: "asset:t.png#c" },
        { id: 3, sprite: "asset:t.png#a", animation: { frames: [{ sprite: "asset:t.png#a", duration: 0.1 }, { sprite: "asset:u.png", duration: 0.1 }] } },
      ],
    },
  });

  it("puts a square chunk's animated tiles in their own batch and rewrites their UVs in the same arrays when a frame changes", async () => {
    const { engine, host, live } = await setup(files());
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.setTile(0, 0, 1);
    map.setTile(1, 0, 1);
    map.setTile(2, 0, 2);
    tiles.sync(engine.world);
    expect(live()).toHaveLength(2);
    const animated = live().find((b) => b.quads === 2)!, still = live().find((b) => b.quads === 1)!;
    expect(animated.uvs[0]).toBeCloseTo(sliceU(0), 3);
    const [positions, uvs, indices] = [animated.positions, animated.uvs, animated.indices];
    // Not yet at the next frame: nothing is sent again.
    advance(engine, 0.05);
    tiles.sync(engine.world);
    expect(animated.sets).toBe(1);
    // Frame 1: the animated batch gets the same arrays again, with the new UVs; the static batch isn't touched.
    advance(engine, 0.1);
    tiles.sync(engine.world);
    expect(animated.sets).toBe(2);
    expect(animated.positions).toBe(positions);
    expect(animated.uvs).toBe(uvs);
    expect(animated.indices).toBe(indices);
    expect(animated.uvs[0]).toBeCloseTo(sliceU(1), 3);
    expect(animated.uvs[8]).toBeCloseTo(sliceU(1), 3);
    expect(still.sets).toBe(1);
    expect(live()).toHaveLength(2); // nothing rebuilt
    // Past the loop's end it starts again.
    advance(engine, 0.3);
    tiles.sync(engine.world);
    expect(animated.uvs[0]).toBeCloseTo(sliceU(0), 3);
  });

  it("follows animationSpeed (0 stops), and draws a frame from another image as the tile's sprite", async () => {
    const { engine, host, live } = await setup(files());
    const tiles = new TilemapRenderer(host);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")], animationSpeed: 0 });
    map.setTile(0, 0, 1);
    map.setTile(0, 1, 3);
    tiles.sync(engine.world);
    const [batch] = live(); // both animated tiles, cell (0, 0) first
    advance(engine, 0.5);
    tiles.sync(engine.world);
    expect(batch.sets).toBe(1); // stopped
    expect(batch.uvs[0]).toBeCloseTo(sliceU(0), 3);
    map.animationSpeed = 0.25; // ADR 0444: the clock goes on from where it stopped; 0.5 s of World time is 0.125 s of animation: frame 1
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(0), 3);
    advance(engine, 0.5);
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(1), 3);
    expect(batch.texture).toBe("t.png");
    expect(batch.uvs[8]).toBeCloseTo(sliceU(0), 3); // tile 3's frame 1 is from u.png: drawn as its own sprite
    expect(warn.mock.calls.some(([m]) => String(m).includes("u.png"))).toBe(true);
    warn.mockRestore();
  });

  it("keeps a clock per map: a speed change mid-play keeps the frame shown and changes the rate (ADR 0444)", async () => {
    const { engine, host, live } = await setup(files());
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    const other = GameObject.create("other").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.setTile(0, 0, 1);
    other.setTile(0, 0, 1);
    tiles.sync(engine.world);
    const [batch, otherBatch] = live();
    advance(engine, 0.15); // frames last 0.1, 0.2 and 0.1 s: frame 1 runs from 0.1 to 0.3 s
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(1), 3);
    // Twice as fast: still frame 1 now (time × speed would jump to frame 2 at 0.3 s)...
    map.animationSpeed = 2;
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(1), 3);
    // ...and 0.1 s of World time later its clock is at 0.35 s: frame 2, while the other map (0.25 s) is still on frame 1.
    advance(engine, 0.1);
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(2), 3);
    expect(otherBatch.uvs[0]).toBeCloseTo(sliceU(1), 3);
    // Stopped, it holds its frame; started again, it goes on from there.
    map.animationSpeed = 0;
    advance(engine, 1);
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(2), 3);
    map.animationSpeed = 1;
    advance(engine, 0.1); // 0.45 s: past the loop's end (0.4 s), frame 0
    tiles.sync(engine.world);
    expect(batch.uvs[0]).toBeCloseTo(sliceU(0), 3);
  });

  it("starts random tiles at offsets from the cell and the seed, the same every time", async () => {
    const { engine, host, live } = await setup(files("random"));
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")], variantSeed: 7 });
    map.fillRect(0, 0, 16, 1, 1);
    advance(engine, 0.2);
    const draw = () => {
      const other = fakeHost();
      other.load();
      new TilemapRenderer(other.host).sync(engine.world);
      return Array.from(other.batches[0].uvs);
    };
    new TilemapRenderer(host).sync(engine.world);
    const first = Array.from(live()[0].uvs);
    expect(draw()).toEqual(first);
    const us = new Set(first.filter((_, i) => i % 8 === 0).map((u) => Math.round(u * 4)));
    expect(us.size).toBeGreaterThan(1); // not in lock-step
    // Another seed, other offsets.
    map.variantSeed = 8;
    expect(draw()).not.toEqual(first);
  });

  it("shows first frames in the editor's edit World", async () => {
    const { engine, host, live } = await setup(files("random"), {}, "editor");
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.fillRect(0, 0, 4, 1, 1);
    advance(engine, 0.15);
    tiles.sync(engine.world);
    const uvs = live()[0].uvs;
    for (let q = 0; q < 4; q++) expect(uvs[q * 8]).toBeCloseTo(sliceU(0), 3);
    advance(engine, 0.15);
    tiles.sync(engine.world);
    expect(live()[0].sets).toBe(1);
  });
});

describe("the tile renderer's layer offset, parallax and view opacity (ADR 0441)", () => {
  const files = { "ts.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "asset:t.png" }] } };

  it("shifts a layer by its offset in the batch matrix, without rebuilding, and reads cells under it", async () => {
    const { engine, host, batches, live } = await setup(files);
    const tiles = new TilemapRenderer(host);
    const node = GameObject.create("map");
    node.transform!.position.x = 2;
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default"), newLayer("H", "Default")], cellSize: new Vector2(2, 2) });
    map.setTile(0, 0, 1, 0);
    map.setTile(0, 0, 1, 1);
    tiles.sync(engine.world);
    map.setLayerOffset("H", 1, 0.5);
    tiles.sync(engine.world);
    const [g, h] = live();
    expect(batches.some((b) => b.disposed)).toBe(false);
    expect([g.matrix[12], g.matrix[13]]).toEqual([2, 0]);
    expect([h.matrix[12], h.matrix[13]]).toEqual([3, 0.5]);
    expect(map.layerOffset(1)).toEqual(new Vector2(1, 0.5));
    expect(map.toLayerData()[1].offset).toEqual([1, 0.5]);
    // Cells: under the offset with a layer, as before without one.
    expect(map.worldToCell({ x: 2.5, y: 0.25 })).toEqual(new Vector2(0, 0));
    expect(map.worldToCell({ x: 2.5, y: 0.25 }, "H")).toEqual(new Vector2(-1, -1));
    expect(map.localToCell({ x: 1.5, y: 0.75 }, 1)).toEqual(new Vector2(0, 0));
    map.setLayerOffset(1, 0, 0);
    expect(map.toLayerData()[1].offset).toBeUndefined();
    expect(() => map.setLayerOffset(5, 1, 1)).toThrow();
  });

  it("moves a parallax layer by (1 − parallax) × (view camera − node) each frame", async () => {
    const { engine, host, live } = await setup(files);
    let view: [number, number] | null = [10, 4];
    const tiles = new TilemapRenderer(host, () => view);
    const node = GameObject.create("map");
    node.transform!.position.x = 2;
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.setTile(0, 0, 1);
    map.setLayerParallax(0, 0.5, 0);
    tiles.sync(engine.world);
    const [b] = live();
    expect([b.matrix[12], b.matrix[13]]).toEqual([2 + 0.5 * (10 - 2), 4]);
    view = [20, -6];
    tiles.sync(engine.world);
    expect([b.matrix[12], b.matrix[13]]).toEqual([2 + 0.5 * (20 - 2), -6]);
    expect(map.layerParallax(0)).toEqual(new Vector2(0.5, 0));
    expect(map.toLayerData()[0].parallax).toEqual([0.5, 0]);
    // Without a view camera, or at parallax 1, it draws with the node.
    view = null;
    tiles.sync(engine.world);
    expect(b.matrix[12]).toBe(2);
    view = [20, -6];
    map.setLayerParallax(0, 1, 1);
    tiles.sync(engine.world);
    expect([b.matrix[12], b.matrix[13]]).toEqual([2, 0]);
  });

  it("gives each camera its own parallax matrix before it draws, and leaves the view camera's in place (ADR 0444)", async () => {
    const { engine, host, live, render, listeners } = await setup(files);
    const tiles = new TilemapRenderer(host, () => [10, 4]);
    const node = GameObject.create("map");
    node.transform!.position.x = 2;
    const map = node.addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default"), newLayer("P", "Default"), newLayer("Q", "Default")] });
    for (let l = 0; l < 3; l++) map.setTile(0, 0, 1, l);
    map.setLayerOffset("P", 1, 0);
    map.setLayerParallax("P", 0.5, 0);
    map.setLayerParallax("Q", 0, 0.25);
    tiles.sync(engine.world);
    const [g, p, q] = live();
    // Split screen: the view camera at (10, 4), another at (-6, 20).
    render([[10, 4, -10], [-6, 20, -10]]);
    const at = (m: number[]) => [m[12], m[13]];
    expect(g.drawnWith.map(at)).toEqual([[2, 0], [2, 0]]);
    expect(p.drawnWith.map(at)).toEqual([[3 + 0.5 * (10 - 2), 4], [3 + 0.5 * (-6 - 2), 20]]);
    expect(q.drawnWith.map(at)).toEqual([[10, 0.75 * 4], [-6, 0.75 * 20]]);
    // Between frames (picking, the editor's tools) the batches hold the view camera's matrix.
    expect(at(p.matrix)).toEqual([3 + 0.5 * (10 - 2), 4]);
    expect(at(q.matrix)).toEqual([10, 3]);
    // Without parallax every camera draws the layer with the node; disposing stops listening.
    map.setLayerParallax("P", 1, 1);
    tiles.sync(engine.world);
    render([[10, 4, -10], [-6, 20, -10]]);
    expect(p.drawnWith.map(at)).toEqual([[3, 0], [3, 0]]);
    tiles.dispose();
    expect(listeners.size).toBe(0);
  });

  it("draws parallax layers with the node for every camera when the World has no view camera (a thumbnail)", async () => {
    const { engine, host, live, render } = await setup(files);
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")] });
    map.setTile(0, 0, 1);
    map.setLayerParallax(0, 0.5, 0.5);
    tiles.sync(engine.world);
    render([[8, 8, -10]]);
    expect(live()[0].drawnWith.map((m) => [m[12], m[13]])).toEqual([[0, 0]]);
  });

  it("multiplies a layer's opacity by the view-only factor, leaving the layer data alone", async () => {
    const { engine, host, live } = await setup(files);
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [{ ...newLayer("G", "Default"), opacity: 0.5 }, newLayer("H", "Default")] });
    map.setTile(0, 0, 1, 0);
    map.setTile(0, 0, 1, 1);
    map._setViewOpacity(1, 0.35);
    tiles.sync(engine.world);
    expect(live().map((b) => b.tint[1])).toEqual([0.5, 0.35]);
    expect(map.toLayerData().map((l) => l.opacity)).toEqual([0.5, 1]);
    map._setViewOpacity(1, null);
    tiles.sync(engine.world);
    expect(live().map((b) => b.tint[1])).toEqual([0.5, 1]);
  });
});

describe("the tile renderer on y-sorted sorting layers (ADR 0440)", () => {
  const files = {
    "t.png.meta.json": SLICES,
    "ts.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "asset:t.png#a" }, { id: 2, sprite: "asset:t.png#b", sortOffset: 1 }, { id: 3, sprite: "asset:u.png" }] },
  };
  const project = { render: { sortingLayers: ["Ground", "Actors"], ySortedLayers: ["Actors"] } };

  it("draws a batch per row and texture, higher rows first, split by sortOffset; and per chunk again off a y-sorted layer", async () => {
    const { engine, host, live } = await setup(files, project);
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("Walls", "Actors")] });
    map.fillRect(0, 0, 3, 3, 1);
    map.setTile(1, 0, 2); // sorts a cell higher: with row 1
    map.setTile(2, 2, 3); // another texture in row 2
    tiles.sync(engine.world);
    const rows = live();
    expect(rows).toHaveLength(5);
    const row = (y: number, slice = 0) => rows.find((b) => b.texture === "t.png" && Math.abs(b.uvs[0] - sliceU(slice)) < 0.01 && b.extent[1] === y + 1)!;
    const other = rows.find((b) => b.texture === "u.png")!; // in row 2
    expect(row(0).quads).toBe(2);
    expect(row(0, 1).quads).toBe(1); // the sortOffset tile
    expect(other.quads).toBe(1);
    expect(row(2).within).toBeLessThan(row(1).within!);
    expect(row(1).within).toBeLessThan(row(0).within!);
    expect(row(0, 1).within).toBe(row(1).within);
    expect(other.within).toBe(row(2).within);
    // Moving the node down raises every row's place (lower things draw later), keeping their order.
    const before = row(0).within!;
    map.node.transform!.position.y = -5;
    tiles.sync(engine.world);
    expect(row(0).within).toBeGreaterThan(before);
    // Off a y-sorted layer: one batch per chunk and texture again.
    map.layers = map.toLayerData().map((l) => ({ ...l, sortingLayer: "Ground" }));
    tiles.sync(engine.world);
    expect(live().map((b) => b.quads).sort()).toEqual([1, 8]);
    expect(live().every((b) => b.within === undefined)).toBe(true);
  });

  it("sorts non-square rows by their bottom corner", async () => {
    const { engine, host, live } = await setup(files, project);
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("Walls", "Actors")], gridShape: "isometric" });
    map.setTile(0, 0, 1); // the front corner
    map.setTile(1, 0, 1); // a row back, with (0, 1)
    map.setTile(0, 1, 1);
    tiles.sync(engine.world);
    const batches = live();
    expect(batches.map((b) => b.quads).sort()).toEqual([1, 2]);
    const front = batches.find((b) => b.quads === 1)!, back = batches.find((b) => b.quads === 2)!;
    expect(back.within).toBeLessThan(front.within!);
  });
});

describe("the tile renderer's painter's order across textures (ADR 0437)", () => {
  it("gives a non-square chunk's texture batches ordered steps of their own, inside the chunk's", async () => {
    const { engine, host, live } = await setup({ "ts.tileset.json": { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "asset:t.png" }, { id: 2, sprite: "asset:u.png" }] } });
    const tiles = new TilemapRenderer(host);
    const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "ts.tileset.json", layers: [newLayer("G", "Default")], gridShape: "isometric" });
    map.setTile(0, 0, 1);
    map.setTile(1, 1, 2);
    map.setTile(16, 16, 1); // a chunk farther back
    tiles.sync(engine.world);
    const inChunk = (key: string) => live().filter((b) => b.name.endsWith(`:${key}`)).map((b) => b.within!);
    const near = inChunk("0,0"), far = inChunk("1,1");
    expect(near).toHaveLength(2);
    expect(new Set(near).size).toBe(2);
    expect(Math.max(...far)).toBeLessThan(Math.min(...near));
    for (const w of [...near, ...far]) expect(w).toBeLessThan(1);
  });
});
