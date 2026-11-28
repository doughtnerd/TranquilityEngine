// ADR 0075 stage 8, 0128, 0276: the Babylon editor viewport's picking and canvas queries, through its adapter
// interface (and `ViewportHandle` for points on planes), on NullEngine with a fake renderer context (real
// Babylon meshes and utility layer, real engine Camera components) whose features "drew" quads, meshes and
// canvas rectangles.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { Matrix, Vector3 as BabylonVector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh as BabylonMesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { UtilityLayerRenderer } from "@babylonjs/core/Rendering/utilityLayerRenderer.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Assets, Camera, Engine, GameObject, SceneManager, Vector2 } from "../index";
import { ParticleSystem, SpriteRenderer } from "../render/components";
import { BabylonSprites } from "../render/babylon/sprites";
import { BabylonMaterials2D } from "../render/babylon/materials2D";
import { BabylonQuadBatches } from "../render/babylon/quadBatches";
import type { BabylonEditorContext, EditorDrawn } from "../render/babylon/editorContext";
import { PICK_ORDER } from "../render/babylon/feature";
import { BabylonEditorViewport } from "../render/babylon/editorViewport";
import { ViewportHandle } from "../render/editorViewport";
import { FakeRenderPolicyPort } from "../render/fakeViewport";

describe("Babylon editor viewport picking and queries (ADR 0075 stage 8, 0128)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let layer: UtilityLayerRenderer;
  let drawn: EditorDrawn[];
  let cameras: Camera[];
  let queries: BabylonEditorViewport;
  let handle: ViewportHandle;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true, project: { display: { width: 800, height: 600 } } });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    layer = new UtilityLayerRenderer(scene);
    drawn = [];
    cameras = [];
    const ctx = {
      scene,
      overlay: layer,
      editor: true,
      settings: World.require().settings,
      canvas: { clientWidth: 800, clientHeight: 600 },
      world: () => World.require(),
      viewCameras: () => cameras,
      babylonCamera: () => null,
      drawn: () => drawn,
    } as unknown as BabylonEditorContext;
    queries = new BabylonEditorViewport(ctx);
    handle = new ViewportHandle(() => queries, new FakeRenderPolicyPort());
  });

  afterEach(() => {
    queries.dispose();
    layer.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const camera = (props: Record<string, unknown> = {}, pos: [number, number, number] = [0, 0, -10]) => {
    const node = GameObject.create("cam"); // looking along +Z (ADR 0164)
    node.transform!.position.set(...pos);
    const cam = node.addBehavior(Camera, { projection: "orthographic", orthographicSize: 5, ...props });
    cameras.push(cam);
    return cam;
  };
  const sprite = (name: string, order: number, pos: [number, number, number], scale: [number, number] = [2, 2]) => {
    const node = GameObject.create(name);
    const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
    mesh.freezeWorldMatrix(Matrix.Scaling(scale[0], scale[1], 1).multiply(Matrix.Translation(...pos)));
    drawn.push({ component: { node } as never, shape: { kind: "quad", mesh }, order, size: [1, 1] });
    return node;
  };
  const box = (name: string, pos: [number, number, number], size = 2, more: Partial<EditorDrawn> = {}) => {
    const node = GameObject.create(name);
    const mesh = MeshBuilder.CreateBox(name, { size }, scene);
    mesh.freezeWorldMatrix(Matrix.Translation(...pos));
    drawn.push({ component: { node } as never, shape: { kind: "meshes", meshes: [mesh as Mesh] }, order: PICK_ORDER.depthTested, ...more });
    return node;
  };
  const world = () => World.require();

  it("picks a sprite by order, not depth, and meshes nearest first below every sprite", () => {
    camera();
    const front = sprite("front", 1, [0, 0, -5]);
    const back = sprite("back", 5, [0, 0, 5]); // farther but drawn on top
    const near = box("near", [0, 0, -2]);
    const far = box("far", [0, 0, 2]);
    expect(queries.pick(400, 300)).toEqual([back, front, near, far]);
  });

  it("picks the sprite drawn on top in a y-sorted layer: the lower one (ADR 0440), from the sprite feature's places", () => {
    camera();
    const pickSprites = (ySortedLayers: string[]) => {
      const materials2D = new BabylonMaterials2D({ scene, library: { texture: () => null } });
      const sprites = new BabylonSprites({
        scene,
        pixelsPerUnit: () => 100,
        quads: new BabylonQuadBatches({ scene, materials2D, texture: () => null, sortSettings: () => ({ sortingLayers: ["Default"], ySortedLayers }), unknownLayer: () => {} }),
        texture: () => null,
        materials2D,
        drawPolicy: () => "perObject", // the editor's scene view: a quad per sprite
        warnOnce: () => {},
      });
      sprites.sync(world());
      drawn = [];
      for (const d of sprites.drawn()) if (d.shape?.kind === "quad" && d.order !== undefined) drawn.push({ component: d.component, shape: d.shape, order: d.order });
      const picked = queries.pick(400, 300);
      sprites.dispose();
      return picked;
    };
    // Overlapping at the canvas centre; the higher one comes first in the World.
    const high = GameObject.create("high");
    high.transform!.position.set(0, 0.5, 0);
    high.addBehavior(SpriteRenderer, { size: new Vector2(2, 2) });
    const low = GameObject.create("low");
    low.addBehavior(SpriteRenderer, { size: new Vector2(2, 2) });
    expect(pickSprites(["Default"])).toEqual([low, high]);
    expect(pickSprites([])).toEqual([high, low]); // not y-sorted: one order, so the first drawn
  });

  it("returns nothing for a miss or an empty canvas, and without a view camera", () => {
    expect(queries.pick(400, 300)).toEqual([]); // no camera
    camera();
    sprite("s", 0, [0, 0, 0]);
    expect(queries.pick(5, 5)).toEqual([]);
    expect(queries.pick(400, 300)).toHaveLength(1);
  });

  it("puts icons above sprites, without duplicates", () => {
    camera();
    const s = sprite("s", 100, [0, 0, 0]);
    World.require().setEditMode(s.entity, true);
    s.addBehavior(ParticleSystem); // the sprite's node has an icon too: listed once
    const icon = GameObject.create("icon");
    World.require().setEditMode(icon.entity, true);
    icon.transform!.position.set(-1, 0, 0); // 60 px left of the sprite's centre, within reach of (300, 300)
    icon.addBehavior(Camera);
    queries.sync(world());
    expect(queries.pick(400, 300)).toEqual([s]); // its own icon and its quad, listed once
    expect(queries.pick(345, 300)).toEqual([icon, s]); // the camera icon, then the sprite under it
  });

  it("picks meshes away from the origin (the ray goes into each mesh's own space)", () => {
    camera();
    const moved = box("moved", [3, 1, 2], 1);
    box("centre", [0, 0, 0], 1);
    const [x, y] = queries.worldToCanvas([3, 1, 2])!;
    expect(queries.pick(x, y)).toEqual([moved]);
    expect(queries.pick(x + 60, y)).toEqual([]); // one unit right: past its half-unit side
  });

  it("picks a mesh whose vertices live only on the GPU (a GPU-skinned draw) by its bounding box, nearest first (T18)", () => {
    camera();
    // A skinned draw skinned on the GPU has no CPU positions: only indices, and the bounds the skinning feature sets.
    const skinnedNode = GameObject.create("skinned");
    const skinned = new BabylonMesh("skinned", scene);
    skinned.setIndices([0, 1, 2], 3);
    skinned.freezeWorldMatrix(Matrix.Translation(3, 0, 0));
    skinned.setBoundingInfo(new BoundingInfo(new BabylonVector3(-1, -1, -1), new BabylonVector3(1, 1, 1), skinned.getWorldMatrix()));
    drawn.push({ component: { node: skinnedNode } as never, shape: { kind: "meshes", meshes: [skinned] }, order: PICK_ORDER.depthTested });
    const [x, y] = queries.worldToCanvas([3, 0, 0])!;
    expect(queries.pick(x, y)).toEqual([skinnedNode]);
    expect(queries.pick(x + 50, y)).toEqual([skinnedNode]); // inside the box's 1-unit half width (60 px a unit)
    expect(queries.pick(x + 70, y)).toEqual([]); // past it
    // A mesh in front of the box picks first; one behind it after.
    const front = box("front", [3, 0, -4], 1);
    const back = box("back", [3, 0, 4], 1);
    expect(queries.pick(x, y)).toEqual([front, skinnedNode, back]);
  });

  it("ignores hidden meshes and sprites", () => {
    camera();
    sprite("s", 0, [0, 0, 0]);
    box("b", [0, 0, 3]);
    const [quad, meshes] = drawn.map((d) => d.shape);
    if (quad?.kind === "quad") quad.mesh.setEnabled(false);
    if (meshes?.kind === "meshes") meshes.meshes[0].isVisible = false;
    expect(queries.pick(400, 300)).toEqual([]);
  });

  it("picks meshes a feature drew in a layer's order above depth-tested ones (a tile layer), and leaves unpickable drawings to their own route", () => {
    camera();
    const tiles = box("tiles", [0, 0, 5], 2, { order: 20000 }); // farther, but layered 2D content draws on top
    const mesh = box("mesh", [0, 0, -2]);
    const canvas = box("canvas", [0, 0, -4], 2, { pickable: false }); // a world canvas: the UI core picks it (ADR 0117)
    expect(queries.pick(400, 300)).toEqual([tiles, mesh]);
    expect(queries.drawnBounds(canvas)).toEqual({ min: [-1, -1, -5], max: [1, 1, -3] }); // still framed
    expect(queries.screenBounds(canvas)).toHaveLength(1);
  });

  it("ignores drawings with no shape of their own (batched sprites), and answers sprite sizes from what was drawn", () => {
    camera();
    const node = GameObject.create("batched");
    const component = { node } as never;
    drawn.push({ component, shape: null, order: 0, size: [3, 4] });
    expect(queries.pick(400, 300)).toEqual([]);
    expect(queries.drawnBounds(node)).toBeNull();
    expect(queries.spriteSize(component)).toEqual([3, 4]);
    expect(queries.spriteSize({ node } as never)).toBeNull(); // another sprite: not drawn
  });

  it("round-trips rayAt and worldToCanvas", () => {
    camera({ projection: "perspective", fieldOfView: 50 }, [1, 2, -12]);
    const ray = queries.rayAt(123, 456)!;
    const p = [0, 1, 2].map((i) => ray.origin[i] + ray.direction[i] * 9);
    const back = queries.worldToCanvas(p)!;
    expect(back[0]).toBeCloseTo(123, 3);
    expect(back[1]).toBeCloseTo(456, 3);
    expect(queries.worldToCanvas([1, 2, -30])).toBeNull(); // behind the camera
    expect(queries.rayAt(0, 0)).not.toBeNull();
  });

  it("returns null queries without a camera", () => {
    expect(queries.rayAt(1, 1)).toBeNull();
    expect(queries.worldToCanvas([0, 0, 0])).toBeNull();
    expect(handle.pointOnPlane(1, 1, [0, 0, 1], [0, 0, 0])).toBeNull();
  });

  it("finds the point on a plane z, and on an arbitrary plane", () => {
    camera({ projection: "orthographic", orthographicSize: 5 }, [0, 0, -10]);
    const p = handle.pointOnPlane(800, 0, [0, 0, 1], [0, 0, 0])!; // top-right: x 6.667, y 5
    expect(p[0]).toBeCloseTo(5 * (800 / 600));
    expect(p[1]).toBeCloseTo(5);
    expect(p[2]).toBe(0);
    expect(handle.pointOnPlane(400, 300, [0, 0, 1], [0, 0, -20])).toBeNull(); // behind the camera
    const q = handle.pointOnPlane(400, 300, [0, 0, 1], [0, 0, 4])!;
    expect(q[2]).toBeCloseTo(4);
    expect(handle.pointOnPlane(400, 300, [1, 0, 0], [3, 0, 0])).toBeNull(); // parallel
    // A tilted perspective camera meets the ground plane.
    camera({ projection: "perspective" }, [0, 5, 0]);
    cameras.shift();
    cameras[0].node.transform!.eulerAngles = [Math.PI / 2, 0, 0]; // pitched down (radians, ADR 0164)
    const g = handle.pointOnPlane(400, 300, [0, 1, 0], [0, 0, 0])!;
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
    const out = queries.screenBounds(root);
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

  it("measures the world box around everything drawn for a node: its meshes and its sprite's quad", () => {
    const n = box("b", [1, 2, 3], 2);
    const second = MeshBuilder.CreateBox("b2", { size: 2 }, scene);
    second.freezeWorldMatrix(Matrix.Translation(5, 2, 3));
    const first = drawn[0].shape;
    if (first?.kind === "meshes") drawn[0] = { ...drawn[0], shape: { kind: "meshes", meshes: [...first.meshes, second] } };
    expect(queries.drawnBounds(n)).toEqual({ min: [0, 1, 2], max: [6, 3, 4] });
    expect(queries.drawnBounds(GameObject.create("none"))).toBeNull();
    const s = sprite("s", 0, [1, 0, 0], [2, 2]);
    const box2 = queries.drawnBounds(s)!;
    expect(box2.min.map((v) => +v.toFixed(5))).toEqual([0, -1, 0]);
    expect(box2.max.map((v) => +v.toFixed(5))).toEqual([2, 1, 0]);
  });
});
