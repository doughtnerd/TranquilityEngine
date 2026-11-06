// ADR 0075 stage 8: the Babylon backend's editor picking and canvas queries, on NullEngine with a
// fake renderer context (real Babylon meshes, real engine Camera components).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Engine, GameObject, SceneManager } from "../index";
import type { BabylonEditorContext, EditorMesh, EditorSprite } from "../render/babylon/editorContext";
import { BabylonEditorQueries } from "../render/babylon/editorQueries";

describe("Babylon editor queries (ADR 0075 stage 8)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let sprites: EditorSprite[];
  let meshes: EditorMesh[];
  let texts: { component: { node: GameObject }; rect: { left: number; top: number; right: number; bottom: number } }[];
  let cameras: Camera[];
  let icons: GameObject[];
  let queries: BabylonEditorQueries;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 600 } } });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    scene.useRightHandedSystem = true;
    sprites = [];
    meshes = [];
    texts = [];
    cameras = [];
    icons = [];
    const ctx = {
      scene,
      canvas: { clientWidth: 800, clientHeight: 600 },
      world: () => World.require(),
      viewCameras: () => cameras,
      sprites: () => sprites,
      meshes: () => meshes,
      texts: () => texts,
    } as unknown as BabylonEditorContext;
    queries = new BabylonEditorQueries(ctx, () => icons);
  });

  afterEach(() => {
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const camera = (props: Record<string, unknown> = {}, pos: [number, number, number] = [0, 0, 10]) => {
    const node = GameObject.create("cam");
    node.transform!.position.set(...pos);
    const cam = node.addBehavior(Camera, { projection: "orthographic", orthographicSize: 5, ...props });
    cameras.push(cam);
    return cam;
  };
  const sprite = (name: string, order: number, pos: [number, number, number], scale: [number, number] = [2, 2]) => {
    const node = GameObject.create(name);
    const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
    mesh.freezeWorldMatrix(Matrix.Scaling(scale[0], scale[1], 1).multiply(Matrix.Translation(...pos)));
    sprites.push({ component: { node } as never, mesh, size: [1, 1], order });
    return node;
  };
  const box = (name: string, pos: [number, number, number], size = 2) => {
    const node = GameObject.create(name);
    const mesh = MeshBuilder.CreateBox(name, { size }, scene);
    mesh.freezeWorldMatrix(Matrix.Translation(...pos));
    meshes.push({ component: { node } as never, meshes: [mesh as Mesh] });
    return node;
  };
  const world = () => World.require();

  it("picks a sprite by order, not depth, and meshes nearest first below every sprite", () => {
    camera();
    const front = sprite("front", 1, [0, 0, 5]);
    const back = sprite("back", 5, [0, 0, -5]); // farther but drawn on top
    const near = box("near", [0, 0, 2]);
    const far = box("far", [0, 0, -2]);
    expect(queries.pick(world(), 400, 300)).toEqual([back, front, near, far]);
  });

  it("returns nothing for a miss or an empty canvas, and without a view camera", () => {
    expect(queries.pick(world(), 400, 300)).toEqual([]); // no camera
    camera();
    sprite("s", 0, [0, 0, 0]);
    expect(queries.pick(world(), 5, 5)).toEqual([]);
    expect(queries.pick(world(), 400, 300)).toHaveLength(1);
  });

  it("puts icons above sprites and text above icons, without duplicates", () => {
    camera();
    const s = sprite("s", 100, [0, 0, 0]);
    const icon = GameObject.create("icon");
    icons.push(icon, s);
    const label = GameObject.create("label");
    texts.push({ component: { node: label }, rect: { left: 390, top: 290, right: 410, bottom: 310 } });
    expect(queries.pick(world(), 400, 300)).toEqual([label, icon, s]);
    expect(queries.pick(world(), 300, 300)).toEqual([icon, s]);
  });

  it("picks meshes away from the origin (the ray goes into each mesh's own space)", () => {
    camera();
    const moved = box("moved", [3, 1, -2], 1);
    box("centre", [0, 0, 0], 1);
    const [x, y] = queries.worldToCanvas(world(), [3, 1, -2])!;
    expect(queries.pick(world(), x, y)).toEqual([moved]);
    expect(queries.pick(world(), x + 60, y)).toEqual([]); // one unit right: past its half-unit side
  });

  it("ignores hidden meshes and sprites", () => {
    camera();
    sprite("s", 0, [0, 0, 0]);
    box("b", [0, 0, -3]);
    sprites[0].mesh.setEnabled(false);
    meshes[0].meshes[0].isVisible = false;
    expect(queries.pick(world(), 400, 300)).toEqual([]);
  });

  it("round-trips rayAt and worldToCanvas", () => {
    camera({ projection: "perspective", fieldOfView: 50 }, [1, 2, 12]);
    const ray = queries.rayAt(world(), 123, 456)!;
    const p = [0, 1, 2].map((i) => ray.origin[i] + ray.direction[i] * 9);
    const back = queries.worldToCanvas(world(), p)!;
    expect(back[0]).toBeCloseTo(123, 3);
    expect(back[1]).toBeCloseTo(456, 3);
    expect(queries.worldToCanvas(world(), [1, 2, 30])).toBeNull(); // behind the camera
    expect(queries.rayAt(world(), 0, 0)).not.toBeNull();
  });

  it("returns null queries without a camera", () => {
    expect(queries.rayAt(world(), 1, 1)).toBeNull();
    expect(queries.worldToCanvas(world(), [0, 0, 0])).toBeNull();
    expect(queries.pointOnPlaneZ(world(), 1, 1)).toBeNull();
  });

  it("finds the point on a plane z, and on an arbitrary plane", () => {
    camera({ projection: "orthographic", orthographicSize: 5 }, [0, 0, 10]);
    const p = queries.pointOnPlaneZ(world(), 800, 0)!; // top-right: x 6.667, y 5
    expect(p[0]).toBeCloseTo(5 * (800 / 600));
    expect(p[1]).toBeCloseTo(5);
    expect(p[2]).toBe(0);
    expect(queries.pointOnPlaneZ(world(), 400, 300, 20)).toBeNull(); // behind the camera
    const q = queries.pointOnPlane(world(), 400, 300, [0, 0, 1], [0, 0, -4])!;
    expect(q[2]).toBeCloseTo(-4);
    expect(queries.pointOnPlane(world(), 400, 300, [1, 0, 0], [3, 0, 0])).toBeNull(); // parallel
    // A tilted perspective camera meets the ground plane.
    camera({ projection: "perspective" }, [0, 5, 0]);
    cameras.shift();
    cameras[0].node.transform!.eulerAngles = [-90, 0, 0];
    const g = queries.pointOnPlane(world(), 400, 300, [0, 1, 0], [0, 0, 0])!;
    expect(g[1]).toBeCloseTo(0);
    expect(g[0]).toBeCloseTo(0);
  });

  it("gives screen rectangles for sprites, meshes and plain nodes", () => {
    camera(); // 5 units half-height over 600px: 60px per unit, centre (400, 300)
    const root = GameObject.create("root");
    const s = sprite("s", 0, [1, 0, 0], [2, 2]);
    const b = box("b", [-3, 0, 0], 2);
    s.setParent(root);
    b.setParent(root);
    const plain = GameObject.create("plain");
    plain.transform!.position.set(0, 2, 0);
    plain.setParent(root);
    const out = queries.screenBounds(world(), root);
    const rect = (n: GameObject) => out.find((o) => o.node === n)!.rect;
    expect(rect(s).left).toBeCloseTo(400 + 0 * 60);
    expect(rect(s).right).toBeCloseTo(400 + 2 * 60);
    expect(rect(s).top).toBeCloseTo(300 - 60);
    expect(rect(s).bottom).toBeCloseTo(300 + 60);
    expect(rect(b).left).toBeCloseTo(400 - 4 * 60);
    expect(rect(b).right).toBeCloseTo(400 - 2 * 60);
    expect(rect(plain)).toEqual({ left: 400, right: 400, top: 300 - 120, bottom: 300 - 120 });
    expect(out.map((o) => o.node)[0]).toBe(root); // parents first
  });

  it("uses a screen-space text's own rectangle in screenBounds", () => {
    camera();
    const label = GameObject.create("label");
    texts.push({ component: { node: label }, rect: { left: 10, top: 20, right: 110, bottom: 60 } });
    expect(queries.screenBounds(world(), label)[0].rect).toEqual({ left: 10, top: 20, right: 110, bottom: 60 });
  });

  it("measures the world box around a node's meshes", () => {
    const n = box("b", [1, 2, 3], 2);
    const second = MeshBuilder.CreateBox("b2", { size: 2 }, scene);
    second.freezeWorldMatrix(Matrix.Translation(5, 2, 3));
    meshes[0] = { ...meshes[0], meshes: [...meshes[0].meshes, second] };
    expect(queries.meshBounds(n)).toEqual({ min: [0, 1, 2], max: [6, 3, 4] });
    expect(queries.meshBounds(GameObject.create("none"))).toBeNull();
  });
});
