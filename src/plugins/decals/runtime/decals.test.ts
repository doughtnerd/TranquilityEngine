// ADR 0395: decals are drawn by renderer-neutral code (tested against fake decal and quad hosts), and spawned decals
// live in a per-World pool aged by the `decals.Pool` system, read here through `Decals` and the handles it returns.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Camera, Color, Engine, GameObject, Quaternion, SceneManager, SpriteRenderer, Vector2, Vector3 } from "../../../myco";
import type { DecalBatch, DecalHost, DecalLook } from "../../../engine/render/decals";
import type { QuadBatch, QuadBatchHost, QuadMask } from "../../../engine/render/quadBatches";
import { drawPlace, ySortFraction } from "../../../engine/render/sortOrder";
import { Decal2D, DecalProjector } from "./components";
import { DecalRenderer } from "./decalRenderer";
import { Decals } from "./Decals";

type FakeDecalBatch = DecalBatch & { look: DecalLook; count: number; matrices: Float32Array; colors: Float32Array; uvs: Float32Array; angles: Float32Array; order: number; disposed: boolean };
/** `order` is the sorting layer and order in layer it was given; `within` how far into that order (ADR 0438), undefined when not passed. */
type FakeQuads = QuadBatch & { texture: string; positions: Float32Array; colors: Float32Array | null; mask: QuadMask | null; order: [string, number]; within: number | undefined; material: string | null; disposed: boolean };

/** Fake hosts; `view` is the view camera distance fades are measured from (none by default). */
function fakeHosts(view: () => Camera | null = () => null) {
  const boxes: FakeDecalBatch[] = [];
  const quads: FakeQuads[] = [];
  const decals: DecalHost = {
    createBatch(_name, look) {
      const b: FakeDecalBatch = {
        look, count: 0, matrices: new Float32Array(), colors: new Float32Array(), uvs: new Float32Array(), angles: new Float32Array(), order: 0, disposed: false,
        setInstances(count, m, c, u, a) { Object.assign(b, { count, matrices: m, colors: c, uvs: u, angles: a }); },
        setOrder(o) { b.order = o; },
        setVisible() {},
        loaded: () => true,
        dispose() { b.disposed = true; },
      };
      boxes.push(b);
      return b;
    },
  };
  const quadHost: QuadBatchHost = {
    createBatch() {
      const b: FakeQuads = {
        texture: "", positions: new Float32Array(), colors: null, mask: null, order: ["", 0], within: undefined, material: null, disposed: false,
        setMaterial(m) { b.material = m; },
        setBlend() {},
        setQuads() {},
        setTriangles(t, p, _uv, _i, c) { b.texture = t; b.positions = p; b.colors = c ?? null; },
        setMask(m) { b.mask = m; },
        setMatrix() {},
        setOrder(layer, inLayer, within) { b.order = [layer, inLayer]; b.within = within; },
        setTint() {},
        setVisible() {},
        dispose() { b.disposed = true; },
      };
      quads.push(b);
      return b;
    },
    textureSize: () => [100, 50],
  };
  return { host: { decals, quads: quadHost, pixelsPerUnit: () => 100, viewCamera: view }, boxes, quads };
}

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

/** A headless engine on the sorting layers Back and Default; `ySortedLayers` are y-sorted (ADR 0438, none by default). */
async function headless(maxDecals = 1000, ySortedLayers: string[] = []): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "splat.png": "data:image/png;base64,", "crate.png": "data:image/png;base64," }));
  const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default"], ySortedLayers, maxDecals } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

describe("decal drawing (ADR 0395)", () => {
  it("makes a projector an instance of its look's batch: the box from node, pivot and size; UVs; angle fade cosines", async () => {
    const engine = await headless();
    const { host, boxes } = fakeHosts();
    const decals = new DecalRenderer(host);
    const node = GameObject.create("scorch");
    node.transform!.position.set(1, 2, 3);
    node.addBehavior(DecalProjector, { texture: "scorch.png", size: new Vector3(2, 4, 6), uvScale: new Vector2(2, 1), order: 3, color: new Color(1, 0.5, 0, 1), opacity: 0.5 });
    decals.sync(engine.world);
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.look).toEqual({ material: "", texture: "scorch.png", blend: "alpha" });
    expect(b.order).toBe(3);
    expect(b.count).toBe(1);
    // Column-major: x axis × 2, y × 4, z × 6; the centre is the node plus the pivot (0, 0, 0.5), which size doesn't scale (as Unity's).
    expect([b.matrices[0], b.matrices[5], b.matrices[10]]).toEqual([2, 4, 6]);
    expect([b.matrices[12], b.matrices[13], b.matrices[14]]).toEqual([1, 2, 3.5]);
    expect(Array.from(b.colors)).toEqual([1, 0.5, 0, 0.5]);
    expect(Array.from(b.uvs)).toEqual([2, 1, 0, 0]);
    expect(b.angles[0]).toBeCloseTo(Math.cos(Math.PI / 3));
    expect(b.angles[1]).toBeCloseTo(0);
    const drawn = [...decals.drawn()];
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.shape?.kind).toBe("box");
    expect(drawn[0]!.pickable).toBe(false); // a click on the wall selects the wall
  });

  it("fades a projector out over fadeRange before drawDistance, and drops its batch once nothing uses it", async () => {
    const engine = await headless();
    const eye = GameObject.create("eye").addComponent(Camera); // at the origin
    const { host, boxes } = fakeHosts(() => eye);
    const decals = new DecalRenderer(host);
    const p = GameObject.create("far").addBehavior(DecalProjector, { drawDistance: 100, fadeRange: 10, pivot: new Vector3(0, 0, 0) });
    p.node.transform!.position.z = 95; // the box's centre: 5 m inside the 10 m fade
    decals.sync(engine.world);
    expect(boxes[0]!.colors[3]).toBeCloseTo(0.5);
    p.node.transform!.position.z = 200;
    decals.sync(engine.world);
    expect(boxes[0]!.disposed).toBe(true);
  });

  it("stamps a Decal2D as a layered quad sized from its sprite, clipped by its parent's sprite", async () => {
    const engine = await headless();
    const { host, quads } = fakeHosts();
    const decals = new DecalRenderer(host);
    const crate = GameObject.create("crate");
    crate.transform!.position.x = 4;
    crate.addBehavior(SpriteRenderer, { sprite: "crate.png" }); // 100 × 50 px at 100 px per unit: 1 × 0.5, pivot centred
    const splat = GameObject.create("splat", { parent: crate });
    splat.addBehavior(Decal2D, { sprite: "splat.png", sortingLayer: "Default", orderInLayer: 2 });
    decals.sync(engine.world);
    expect(quads).toHaveLength(1);
    const q = quads[0]!;
    expect(q.order).toEqual(["Default", 2]);
    expect(q.material).toBe(""); // the default 2D material (Sprite Lit)
    expect(q.texture).toBe("splat.png");
    expect(Array.from(q.positions.subarray(0, 3))).toEqual([3.5, -0.25, 0]); // its own 1 × 0.5 quad around the node at x = 4
    expect(q.mask!.texture).toBe("crate.png");
    // The mask maps world (4, 0), the crate's centre, to the crate's UV centre.
    const [a, b, c, d, e, f] = Array.from(q.mask!.uv);
    expect(a! * 4 + b! * 0 + c!).toBeCloseTo(0.5);
    expect(d! * 4 + e! * 0 + f!).toBeCloseTo(0.5);
    expect(a! * 4.5 + c!).toBeCloseTo(1); // its right edge
  });
});

describe("2D decals in a y-sorted sorting layer (ADR 0438)", () => {
  const RENDER = { sortingLayers: ["Back", "Default"], ySortedLayers: ["Default"] };
  /** A placed Decal2D on `layer` at order 2, at height `y`. */
  const stamp = (name: string, layer: string, y: number): Decal2D => {
    const node = GameObject.create(name);
    node.transform!.position.y = y;
    return node.addBehavior(Decal2D, { sprite: "splat.png", sortingLayer: layer, orderInLayer: 2 });
  };
  /** Each placed decal's pick order, from what the feature reports drawn. */
  const pickOrders = (decals: DecalRenderer): Map<string, number> => new Map([...decals.drawn()].map((d) => [d.component.node.name, d.order]));

  it("places placed decals by height within their order in layer, lower on top, and follows a decal that moves", async () => {
    const engine = await headless(1000, ["Default"]);
    const { host, quads } = fakeHosts();
    const decals = new DecalRenderer(host);
    stamp("high", "Default", 3);
    const low = stamp("low", "Default", -1);
    decals.sync(engine.world);
    expect(quads).toHaveLength(2);
    const [high, lowQuads] = quads as [FakeQuads, FakeQuads];
    expect(high.order).toEqual(["Default", 2]);
    expect(high.within).toBe(ySortFraction(3));
    expect(lowQuads.within).toBe(ySortFraction(-1));
    expect(lowQuads.within!).toBeGreaterThan(high.within!); // the lower one draws later, over the higher
    // Picking ranks by the same places: in the band of order 2 of the second layer, the lower one on top.
    let orders = pickOrders(decals);
    expect(orders.get("high")).toBe(drawPlace(RENDER, "Default", 2, 3));
    expect(orders.get("low")).toBe(drawPlace(RENDER, "Default", 2, -1));
    for (const o of orders.values()) expect(o >= 10002 && o < 10003).toBe(true);
    expect(orders.get("low")!).toBeGreaterThan(orders.get("high")!);

    low.node.transform!.position.y = 5; // now above the other: drawn under it
    decals.sync(engine.world);
    expect(quads).toHaveLength(2); // the same batch, moved
    expect(lowQuads.within).toBe(ySortFraction(5));
    expect(lowQuads.within!).toBeLessThan(high.within!);
    orders = pickOrders(decals);
    expect(orders.get("low")).toBe(drawPlace(RENDER, "Default", 2, 5));
    expect(orders.get("low")!).toBeLessThan(orders.get("high")!);
  });

  it("gives decals of a layer that isn't y-sorted their order alone, whatever their height", async () => {
    const engine = await headless(1000, ["Default"]);
    const { host, quads } = fakeHosts();
    const decals = new DecalRenderer(host);
    stamp("high", "Back", 3);
    stamp("low", "Back", -1);
    decals.sync(engine.world);
    expect(quads.map((q) => q.within)).toEqual([0, 0]);
    expect([...pickOrders(decals).values()]).toEqual([2, 2]);
  });

  it("splits spawned decals of one texture by height in a y-sorted layer, and keeps them in one batch elsewhere", async () => {
    const engine = await headless(1000, ["Default"]);
    const { host, quads } = fakeHosts();
    const decals = new DecalRenderer(host);
    Decals.stamp({ position: new Vector2(0, 2), sprite: "splat.png" }); // the Default layer, order 0
    Decals.stamp({ position: new Vector2(1, -2), sprite: "splat.png" });
    Decals.stamp({ position: new Vector2(0, 2), sprite: "splat.png", sortingLayer: "Back" });
    Decals.stamp({ position: new Vector2(1, -2), sprite: "splat.png", sortingLayer: "Back" });
    decals.sync(engine.world);
    const ySorted = quads.filter((q) => q.order[0] === "Default");
    expect(ySorted.map((q) => q.within)).toEqual([ySortFraction(2), ySortFraction(-2)]);
    expect(ySorted.every((q) => q.positions.length === 12)).toBe(true); // one quad each
    const back = quads.filter((q) => q.order[0] === "Back");
    expect(back).toHaveLength(1);
    expect(back[0]!.within).toBe(0);
    expect(back[0]!.positions.length).toBe(24); // both quads
  });
});

describe("spawned decals (ADR 0395)", () => {
  it("counts them, ages them out after lifetime and fadeOut, and removes them by hand", async () => {
    const engine = await headless();
    const hole = Decals.project({ position: [0, 1, 0], rotation: Quaternion.identity, lifetime: 0.2, fadeOut: 0.2 });
    const splat = Decals.stamp({ position: new Vector2(1, 1), sprite: "splat.png" });
    expect(Decals.count).toBe(2);
    engine.step(0.25);
    expect(hole.alive).toBe(true); // fading
    engine.step(0.25);
    expect(hole.alive).toBe(false);
    expect(Decals.count).toBe(1);
    splat.remove(0);
    expect(splat.alive).toBe(false);
    engine.step(0.01);
    expect(Decals.count).toBe(0);
  });

  it("follows a parent node and goes with it", async () => {
    const engine = await headless();
    const { host, boxes } = fakeHosts();
    const decals = new DecalRenderer(host);
    const door = GameObject.create("door");
    door.transform!.position.x = 5;
    const hole = Decals.project({ position: [0, 1, 0], parent: door });
    decals.sync(engine.world);
    expect(boxes[0]!.matrices[12]).toBe(5);
    door.transform!.position.x = 7;
    decals.sync(engine.world);
    expect(boxes[0]!.matrices[12]).toBe(7);
    GameObject.destroy(door);
    engine.step(0.01); // destroyed at the end of this frame
    engine.step(0.01);
    expect(hole.alive).toBe(false);
  });

  it("fades out the oldest past render.maxDecals, and clear() removes them all", async () => {
    const engine = await headless(2);
    const first = Decals.project({ position: [0, 0, 0] });
    Decals.project({ position: [1, 0, 0] });
    Decals.project({ position: [2, 0, 0] });
    engine.step(0.3);
    expect(first.alive).toBe(false);
    expect(Decals.count).toBe(2);
    Decals.clear();
    expect(Decals.count).toBe(0);
  });
});
