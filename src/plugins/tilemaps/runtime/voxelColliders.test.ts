// Square tile maps on Rapier's voxel colliders (ADR 0442): one voxel collider per chunk, edited in place when scripts
// change tiles. Driven through the public API only: Tilemap edits, ShapeCollider2D, bodies, Physics2D's queries and
// the World step. (That the core takes the voxel path at all is `physics/core.test.ts`'s, against a fake backend.)
import { afterEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider2D, Engine, GameObject, Physics2D, RigidBody2D, SceneManager, ShapeCollider2D, Tilemap } from "../../../myco";

const TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  tiles: [
    { id: 1, sprite: "asset:t.png#a", collision: "full" },
    { id: 2, sprite: "asset:t.png#b", collision: "oneWay" },
    { id: 3, sprite: "asset:t.png#c", collision: { polygon: [[0, 0], [1, 0], [1, 1]] } },
  ],
};

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function setup() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tiles.tileset.json": TILESET, "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10] as [number, number] } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}
const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

function map(scale: [number, number] = [1, 1]) {
  const node = GameObject.create("map");
  node.transform!.scale = [scale[0], scale[1], 1];
  const tiles = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
  const collider = node.addBehavior(ShapeCollider2D);
  return { tiles, collider };
}

function box(x: number, y: number) {
  const b = GameObject.create("box");
  b.transform!.position = [x, y, 0];
  const rb = b.addBehavior(RigidBody2D, { constraints: { freezePosition: { x: false, y: false }, freezeRotation: true } });
  b.addBehavior(BoxCollider2D, { size: { x: 0.8, y: 0.8 } as never });
  return { b, rb, y: () => b.transform!.worldPosition.y, x: () => b.transform!.worldPosition.x };
}

/** Where a ray straight down from high above `x` hits the map's top (at most half a unit below y = 0), or null. */
function groundAt(x: number): number | null {
  const hit = Physics2D.raycast({ x, y: 100 }, { x: 0, y: -1 }, 100.5);
  return hit?.collider instanceof ShapeCollider2D ? hit.point.y : null;
}

describe("voxel tile colliders on Rapier (ADR 0442)", () => {
  it("a body lands and slides across chunk borders, corners where four chunks meet included, without catching", async () => {
    const engine = await setup();
    const { tiles } = map();
    tiles.fillRect(-40, 14, 80, 3, 1); // rows 14..16: row 16 is in the chunks above, so the top runs along chunk corners
    const { rb, x, y } = box(-36, 17.45);
    steps(engine, 20);
    expect(y()).toBeCloseTo(17.4, 1);
    let lowest = Infinity, highest = -Infinity;
    for (let i = 0; i < 380; i++) {
      rb.velocity = { x: 12, y: rb.velocity.y };
      engine.step(1 / 60);
      lowest = Math.min(lowest, y());
      highest = Math.max(highest, y());
      expect(Math.abs(rb.velocity.x - 12), `frame ${i} at x = ${x().toFixed(2)}`).toBeLessThan(0.5);
    }
    expect(x()).toBeGreaterThan(36); // across the borders at x = −32, −16, 0, 16 and 32
    expect(lowest).toBeGreaterThan(17.3);
    expect(highest).toBeLessThan(17.5); // no hop over a seam
  });

  it("setTile digs a hole a body falls through, on a chunk border too, and filling it back holds the next one", async () => {
    const engine = await setup();
    const { tiles } = map();
    tiles.fillRect(-20, -1, 40, 1, 1); // floor top at y = 0
    const inner = box(4.5, 0.45);
    const border = box(-0.5, 0.45); // cell −1: the last column of chunk −1, beside chunk 0
    steps(engine, 30);
    expect(inner.y()).toBeCloseTo(0.4, 1);
    expect(border.y()).toBeCloseTo(0.4, 1);
    tiles.clearTile(4, -1);
    tiles.clearTile(-1, -1);
    steps(engine, 60);
    expect(inner.y()).toBeLessThan(-2);
    expect(border.y()).toBeLessThan(-2);
    expect(groundAt(-1.5)).toBeCloseTo(0, 3); // the neighbours stay
    expect(groundAt(0.5)).toBeCloseTo(0, 3);
    tiles.setTile(4, -1, 1);
    tiles.setTile(-1, -1, 1);
    const again = box(4.5, 2);
    const againBorder = box(-0.5, 2);
    steps(engine, 60);
    expect(again.y()).toBeCloseTo(0.4, 1);
    expect(againBorder.y()).toBeCloseTo(0.4, 1);
  });

  it("emptying a whole chunk removes its collider, filling it again adds one, and bodies slide over the new seams", async () => {
    const engine = await setup();
    const { tiles } = map();
    tiles.fillRect(-32, -1, 80, 2, 1); // rows −1 and 0: chunks −2 to 2 in two chunk rows; top at y = 1
    const resting = box(8, 1.45);
    steps(engine, 30);
    tiles.fillRect(0, -1, 16, 2, 0); // all of chunks (0, −1) and (0, 0)
    steps(engine, 60);
    expect(resting.y()).toBeLessThan(-2);
    expect(groundAt(8)).toBeNull();
    expect(groundAt(-0.5)).toBeCloseTo(1, 3);
    expect(groundAt(16.5)).toBeCloseTo(1, 3);
    tiles.fillRect(0, -1, 16, 2, 1);
    expect(groundAt(8)).toBeNull(); // until the next step builds it
    steps(engine, 1);
    expect(groundAt(8)).toBeCloseTo(1, 3);
    const slider = box(-4, 1.45);
    steps(engine, 20);
    for (let i = 0; i < 210; i++) {
      slider.rb.velocity = { x: 12, y: slider.rb.velocity.y };
      engine.step(1 / 60);
      expect(Math.abs(slider.rb.velocity.x - 12), `frame ${i} at x = ${slider.x().toFixed(2)}`).toBeLessThan(0.5);
    }
    expect(slider.x()).toBeGreaterThan(36); // across the borders at x = 0, 16 and 32
    expect(slider.y()).toBeCloseTo(1.4, 1);
  });

  it("cells dug and filled again on a chunk border don't catch a body sliding over them", async () => {
    const engine = await setup();
    const { tiles } = map();
    tiles.fillRect(-32, -1, 64, 2, 1); // rows −1 and 0, top at y = 1
    steps(engine, 1);
    tiles.fillRect(-1, -1, 2, 2, 0); // the four cells where chunks (−1, −1), (0, −1), (−1, 0) and (0, 0) meet
    steps(engine, 1);
    expect(groundAt(0.5)).toBeNull();
    tiles.fillRect(-1, -1, 2, 2, 1);
    const slider = box(-4, 1.45);
    steps(engine, 20);
    for (let i = 0; i < 100; i++) {
      slider.rb.velocity = { x: 12, y: slider.rb.velocity.y };
      engine.step(1 / 60);
      expect(Math.abs(slider.rb.velocity.x - 12), `frame ${i} at x = ${slider.x().toFixed(2)}`).toBeLessThan(0.5);
    }
    expect(slider.x()).toBeGreaterThan(12);
    expect(slider.y()).toBeCloseTo(1.4, 1);
  });

  it("one-way and polygon tiles painted at runtime still work beside the voxels", async () => {
    const engine = await setup();
    const { tiles } = map();
    tiles.fillRect(-10, -1, 20, 1, 1); // floor top at y = 0
    const jumper = box(0, 0.45);
    steps(engine, 10);
    tiles.fillRect(-3, 2, 6, 1, 2); // a one-way platform at y = 2..3
    tiles.fillRect(20, 2, 5, 1, 3); // a row of triangles at y = 2..3, nothing under them
    steps(engine, 2);
    jumper.rb.velocity = { x: 0, y: 12 }; // jump up through the platform
    let maxY = -Infinity;
    for (let i = 0; i < 180; i++) {
      engine.step(1 / 60);
      maxY = Math.max(maxY, jumper.y());
    }
    expect(maxY).toBeGreaterThan(3.4);
    expect(jumper.y()).toBeCloseTo(3.4, 1); // landed on top
    const faller = box(22.7, 5);
    steps(engine, 120);
    expect(faller.y()).toBeGreaterThan(2.3); // held by the triangles
    expect(faller.y()).toBeLessThan(3.5);
    tiles.clearTile(-1, -1); // a voxel edit leaves the platform alone
    steps(engine, 30);
    expect(jumper.y()).toBeCloseTo(3.4, 1);
  });

  for (const scale of [[-1, 1], [1, -1]] as [number, number][]) {
    it(`a map mirrored by scale (${scale}) collides where it's drawn and digs where it's edited`, async () => {
      const engine = await setup();
      const { tiles } = map(scale);
      // Cells x 0..19 on row −1 (mirrored in x: world x −20..0) or on row 0 (mirrored in y: world y −1..0).
      const row = scale[1] < 0 ? 0 : -1;
      tiles.fillRect(scale[0] < 0 ? 0 : -10, row, 20, 1, 1);
      const cellX = scale[0] < 0 ? 5 : -6; // world x −6..−5 either way
      steps(engine, 1);
      expect(groundAt(-5.5)).toBeCloseTo(0, 3);
      expect(groundAt(-0.5)).toBeCloseTo(0, 3);
      if (scale[0] < 0) expect(groundAt(0.5)).toBeNull();
      else expect(groundAt(0.5)).toBeCloseTo(0, 3);
      const b = box(-5.5, 0.45);
      steps(engine, 30);
      expect(b.y()).toBeCloseTo(0.4, 1);
      tiles.clearTile(cellX, row);
      steps(engine, 60);
      expect(b.y()).toBeLessThan(-2);
      expect(groundAt(-4.5)).toBeCloseTo(0, 3);
      expect(groundAt(-6.5)).toBeCloseTo(0, 3);
    });
  }
});

describe("a Tilemap's whole cells as a shape source offers them (ADR 0442)", () => {
  /** The solid cells of a group, as "x,y". */
  const solidCells = (group: { chunks: readonly { cx: number; cy: number; solid: Uint8Array }[] }, size: number) =>
    group.chunks.flatMap((c) => [...c.solid].flatMap((v, i) => (v ? [`${c.cx * size + (i % size)},${c.cy * size + Math.floor(i / size)}`] : []))).sort();

  it("offers the colliding layers' full tiles per chunk and offset, versions changing only for edited chunks", async () => {
    await setup();
    const node = GameObject.create("map");
    const tiles = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json", cellSize: { x: 2, y: 0.5 } as never });
    tiles.layers = [{ ...tiles.layers[0], name: "A" }, { ...tiles.layers[0], name: "B" }, { ...tiles.layers[0], name: "C", collision: false }, { ...tiles.layers[0], name: "D" }];
    tiles.setTile(0, 0, 1, "A");
    tiles.setTile(0, 0, 1, "B"); // the same cell in another layer counts once
    tiles.setTile(1, 0, 2, "A"); // one-way: not a whole cell
    tiles.setTile(2, 0, 3, "B"); // a polygon: not a whole cell
    tiles.setTile(3, 0, 1, "C"); // a layer that doesn't collide
    tiles.setTile(17, 0, 1, "B"); // the next chunk
    tiles.setTile(5, 5, 1, "D");
    tiles.setLayerOffset("D", 1, 0.25); // half a cell either way
    const cells = tiles.collisionCells()!;
    expect(cells.unit).toEqual({ x: 2, y: 0.5 });
    expect(cells.chunkSize).toBe(16);
    expect(cells.groups).toHaveLength(2);
    const [main, moved] = cells.groups;
    expect(main.offset).toEqual({ x: 0, y: 0 });
    expect(solidCells(main, 16)).toEqual(["0,0", "17,0"]);
    expect(moved.offset).toEqual({ x: 0.5, y: 0.5 });
    expect(solidCells(moved, 16)).toEqual(["5,5"]);
    const versions = new Map(main.chunks.map((c) => [`${c.cx},${c.cy}`, c.version]));
    tiles.setTile(18, 0, 1, "A");
    const after = tiles.collisionCells()!.groups[0];
    expect(after.chunks.find((c) => c.cx === 0)!.version).toBe(versions.get("0,0"));
    expect(after.chunks.find((c) => c.cx === 1)!.version).not.toBe(versions.get("1,0"));
    expect(solidCells(after, 16)).toEqual(["0,0", "17,0", "18,0"]);
    // The shapes beside the cells: without the full tiles, with everything else; without the option, as before.
    const without = tiles.collisionShapes("rectangles", { withoutCells: true })!;
    expect(without.boxes).toEqual([]);
    expect(without.oneWay).toHaveLength(1);
    expect(without.polygons.length).toBeGreaterThan(0);
    expect(tiles.collisionShapes("rectangles")!.boxes.length).toBeGreaterThan(0);
    expect(tiles.collisionShapes("outline", { withoutCells: true })!.loops).toEqual([]);
    expect(tiles.collisionShapes("outline")!.loops.length).toBeGreaterThan(0);
  });

  it("offers no cells on other grids, where the shapes keep their whole cells", async () => {
    await setup();
    const tiles = GameObject.create("map").addBehavior(Tilemap, { tileset: "tiles.tileset.json", gridShape: "isometric" });
    tiles.fillRect(0, 0, 3, 3, 1);
    expect(tiles.collisionCells()).toBeNull();
    expect(tiles.collisionShapes("rectangles", { withoutCells: true })!.polygons.length).toBeGreaterThan(0);
  });
});
