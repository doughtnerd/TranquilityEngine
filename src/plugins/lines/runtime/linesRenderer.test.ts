// ADR 0396: line and trail drawing is renderer-neutral, so it's tested against fake dynamic-mesh and quad-batch hosts.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine, GameObject, SceneManager, Vector3 } from "../../../myco";
import type { DynamicGeometry, DynamicMesh, DynamicMeshHost } from "../../../engine/render/dynamicMeshes";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { LineRenderer } from "./LineRenderer";
import { PICK_ORDER, type DrawnNode, type DrawnShape } from "../../../engine/render/babylon/feature";
import { LinesRenderer } from "./linesRenderer";
import { drawPlace, ySortFraction } from "../../../engine/render/sortOrder";

/** A drawn ribbon's polyline (ADR 0276). */
const ribbon = (d: DrawnNode) => d.shape as Extract<DrawnShape, { kind: "polyline" }>;
import { TrailRenderer } from "./TrailRenderer";

function fakeHosts() {
  const meshes: (DynamicMesh & { geometry: DynamicGeometry | null; look: [string, string]; matrix: number[]; visible: boolean; disposed: boolean; shadows: [boolean, boolean] })[] = [];
  const batches: (QuadBatch & { positions: Float32Array | null; colors: Float32Array | null; texture: string; order: [string, number]; within: number; material: string | null; visible: boolean; disposed: boolean; matrix: number[] })[] = [];
  const dynamicMeshes: DynamicMeshHost = {
    createMesh() {
      const m: (typeof meshes)[number] = {
        geometry: null, look: ["", ""], matrix: [], visible: false, disposed: false, shadows: [false, true],
        setGeometry(g) { m.geometry = g; },
        setLook(a, b) { m.look = [a, b]; },
        setMatrix(x, o = 0) { m.matrix = Array.from(x).slice(o, o + 16); },
        setShadows(c, r) { m.shadows = [c, r]; },
        setVisible(v) { m.visible = v; },
        loaded: () => true,
        dispose() { m.disposed = true; },
      };
      meshes.push(m);
      return m;
    },
  };
  const quads: QuadBatchHost = {
    createBatch() {
      const b: (typeof batches)[number] = {
        positions: null, colors: null, texture: "", order: ["", 0], within: 0, material: null, visible: false, disposed: false, matrix: [],
        setMaterial(m) { b.material = m; },
        setBlend() {},
        setQuads() {},
        setTriangles(t, p, _uv, _i, c) { b.texture = t; b.positions = p; b.colors = c ?? null; },
        setMask() {},
        setMatrix(x, o = 0) { b.matrix = Array.from(x).slice(o, o + 16); },
        setOrder(layer, inLayer, within = 0) { b.order = [layer, inLayer]; b.within = within; },
        setTint() {},
        setVisible(v) { b.visible = v; },
        dispose() { b.disposed = true; },
      };
      batches.push(b);
      return b;
    },
    textureSize: () => [1, 1],
    onCameraRender: () => () => {},
  };
  return { host: { dynamicMeshes, quads }, meshes, batches };
}

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function headless(ySortedLayers: string[] = []): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default"], ySortedLayers } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

describe("line and trail drawing (ADR 0396)", () => {
  it("draws a 3D line as a camera-facing dynamic mesh with its look, widths and gradient", async () => {
    const engine = await headless();
    const { host, meshes } = fakeHosts();
    const lines = new LinesRenderer(host);
    const node = GameObject.create("laser");
    node.transform!.position.x = 10;
    const line = node.addBehavior(LineRenderer, { width: 0.2, material: "beam.material.json", texture: "", positions: [new Vector3(0, 0, 0), new Vector3(0, 0, 4)] });
    line.widthCurve = [[0, 1], [1, 0.5]];
    line.colorGradient = { colors: [[0, "#ff0000"], [1, "#0000ff"]], alphas: [[0, 1], [1, 0]] };
    line.color = new Color(1, 1, 1, 0.5);
    lines.sync(engine.world);
    expect(meshes).toHaveLength(1);
    const m = meshes[0]!;
    expect(m.visible).toBe(true);
    expect(m.look).toEqual(["beam.material.json", ""]);
    const g = m.geometry!;
    expect(g.ribbon).toBeTruthy();
    expect(g.ribbon!.extents[0]).toBeCloseTo(0.1); // half of width × curve(0)
    expect(g.ribbon!.extents[4]).toBeCloseTo(0.05); // half of width × curve(1)
    expect(Array.from(g.colors!.subarray(0, 4))).toEqual([1, 0, 0, 0.5]); // gradient × colour
    // World space by default (as in Unity): the node's move doesn't move the points.
    expect(m.matrix[12]).toBe(0);
    expect(g.positions[0]).toBe(0);
    const drawn = [...lines.drawn()];
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.order).toBe(PICK_ORDER.depthTested);
    expect(ribbon(drawn[0]!).halfWidth).toBeCloseTo(0.1);
  });

  it("puts a node-space line under its node's matrix and reports its points in world space", async () => {
    const engine = await headless();
    const { host, meshes } = fakeHosts();
    const lines = new LinesRenderer(host);
    const node = GameObject.create("rope");
    node.transform!.position.y = 3;
    node.addBehavior(LineRenderer, { useWorldSpace: false, positions: [new Vector3(0, 0, 0), new Vector3(1, 0, 0)] });
    lines.sync(engine.world);
    expect(meshes[0]!.matrix[13]).toBe(3);
    expect(Array.from(ribbon([...lines.drawn()][0]!).points)).toEqual([0, 3, 0, 1, 3, 0]);
  });

  it("sorts a 2D line by its node's height in a y-sorted layer (ADR 0440), and picks it at that place", async () => {
    const engine = await headless(["Default"]);
    const { host, batches } = fakeHosts();
    const lines = new LinesRenderer(host);
    const node = GameObject.create("path");
    node.transform!.position.y = 3;
    node.addBehavior(LineRenderer, { mode: "2d", sortingLayer: "Default", orderInLayer: 2, positions: [new Vector3(0, 0, 0), new Vector3(2, 0, 0)] });
    const other = GameObject.create("back");
    other.addBehavior(LineRenderer, { mode: "2d", sortingLayer: "Back", orderInLayer: 2, positions: [new Vector3(0, 0, 0), new Vector3(2, 0, 0)] });
    lines.sync(engine.world);
    const [ySorted, plain] = batches;
    expect(ySorted!.within).toBe(ySortFraction(3));
    expect(plain!.within).toBe(0); // "Back" isn't y-sorted
    const orders = [...lines.drawn()].map((d) => d.order);
    expect(orders).toEqual([drawPlace(engine.world.settings.render, "Default", 2, 3), 2]);
    expect(orders[0]).toBeGreaterThan(10002);
    expect(orders[0]).toBeLessThan(10003);
  });

  it("draws a 2D line as layered quads in its sorting layer, flat in the XY plane", async () => {
    const engine = await headless();
    const { host, meshes, batches } = fakeHosts();
    const lines = new LinesRenderer(host);
    const node = GameObject.create("path");
    const line = node.addBehavior(LineRenderer, { mode: "2d", sortingLayer: "Back", orderInLayer: 7, texture: "dash.png", positions: [new Vector3(0, 0, 0), new Vector3(2, 0, 0)] });
    lines.sync(engine.world);
    expect(meshes).toHaveLength(0);
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    expect(b.order).toEqual(["Back", 7]);
    expect(b.material).toBe(""); // the default 2D material (Sprite Lit)
    expect(b.texture).toBe("dash.png");
    expect(b.colors!.length).toBe(4 * 4);
    expect(Math.abs(b.positions![1]!)).toBeCloseTo(0.05); // offset across, in y
    expect([...lines.drawn()][0]!.order).toBe(7);
    // Switching to 3D drops the batch for a mesh.
    line.mode = "3d";
    lines.sync(engine.world);
    expect(b.disposed).toBe(true);
    expect(meshes).toHaveLength(1);
  });

  it("hides a disabled line, drops a destroyed one, and draws a trail head first", async () => {
    const engine = await headless();
    const { host, meshes } = fakeHosts();
    const lines = new LinesRenderer(host);
    const a = GameObject.create("a").addBehavior(LineRenderer);
    lines.sync(engine.world);
    a.enabled = false;
    lines.sync(engine.world);
    expect(meshes[0]!.visible).toBe(false);
    expect([...lines.drawn()]).toHaveLength(0);
    GameObject.destroy(a.node);
    engine.step(0);
    lines.sync(engine.world);
    expect(meshes[0]!.disposed).toBe(true);

    const trail = GameObject.create("t").addBehavior(TrailRenderer, { lifetime: 1 });
    trail.addPosition([0, 0, 0]);
    trail.addPosition([5, 0, 0]);
    lines.sync(engine.world);
    const drawn = [...lines.drawn()].find((d) => d.component === trail)!;
    expect(ribbon(drawn).points[0]).toBe(5); // the newest point first: the head is the ribbon's start (curve and gradient at 0)
  });
});
