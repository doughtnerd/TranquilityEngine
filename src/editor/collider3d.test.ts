import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider, Engine, MeshRenderer } from "../engine";
import { addAsset, prepareAssets, whyNotAddable } from "./assetBrowser";
import { newComponentEntry } from "./componentEdits";
import {
  boxHandles3D,
  boxWire,
  capsuleHandles3D,
  capsuleWire,
  centerDelta,
  closestOnAxis,
  dragBoxFace3D,
  dragCapsuleHeight,
  dragCapsuleRadius,
  dragSphereRadius,
  meshWire,
  rotate,
  sphereHandles3D,
  type Pose3D,
} from "./collider3dMath";
import { colliderOverlay } from "./colliderGizmo";
import { AddComponent, SetField } from "./document";
import { createNode, newNodeEntry } from "./nodeCreate";
import { openSceneFile } from "./project";
import { editingCollider, openScene, selection } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
const identity: Pose3D = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const turnY90: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

describe("3D collider wireframes and handles (ADR 0045)", () => {
  it("turns vectors by quaternions", () => {
    close(rotate(turnY90, [1, 0, 0]), [0, 0, -1]);
    close(rotate(turnY90, [0, 0, 1]), [1, 0, 0]);
  });

  it("puts box handles on face centres, scaled, turned and offset like the physics shape", () => {
    const pose: Pose3D = { position: [1, 2, 3], rotation: turnY90, scale: [2, 1, 1] };
    const h = boxHandles3D(pose, [0.5, 0, 0], [1, 2, 4]);
    close(h.center, [1, 2, 2]); // centre (0.5 × 2) along the node's x, which faces -z
    close(h["x+"], [1, 2, 1]); // half of 1 × 2 further along it
    close(h["y+"], [1, 3, 2]);
    close(h["z-"], [-1, 2, 2]);
    expect(boxWire(identity, [0, 0, 0], [1, 1, 1])).toHaveLength(12);
  });

  it("sizes sphere and capsule handles by the scale rules", () => {
    const pose: Pose3D = { ...identity, scale: [1, 3, 1] };
    close(sphereHandles3D(pose, [0, 0, 0], 0.5)["radius:x+"], [1.5, 0, 0]);
    const c = capsuleHandles3D(identity, [0, 0, 0], 0.5, 3, "z");
    close(c["height+"], [0, 0, 1.5]);
    close(c["radius:u+"], [0.5, 0, 0]); // across z: x first
    expect(capsuleWire(identity, [0, 0, 0], 0.5, 3, "y").length).toBe(10); // two rings, four sides, four caps
  });

  it("drags a box face with the opposite face fixed, or both with Alt", () => {
    expect(dragBoxFace3D("x+", 2, identity, [0, 0, 0], [2, 2, 2])).toEqual({ center: [0.5, 0, 0], size: [3, 2, 2] });
    expect(dragBoxFace3D("y-", -3, identity, [0, 0, 0], [2, 2, 2])).toEqual({ center: [0, -1, 0], size: [2, 4, 2] });
    expect(dragBoxFace3D("z+", 2, identity, [0, 0, 1], [2, 2, 2], true)).toEqual({ center: [0, 0, 1], size: [2, 2, 4] });
    const scaled: Pose3D = { ...identity, scale: [2, 1, 1] };
    expect(dragBoxFace3D("x+", 4, scaled, [0, 0, 0], [2, 1, 1])).toEqual({ center: [0.5, 0, 0], size: [3, 1, 1] }); // world 2…4 → local
  });

  it("turns handle distances back into radius and height", () => {
    expect(dragSphereRadius(3, { ...identity, scale: [1, 2, 1] })).toBe(1.5);
    expect(dragCapsuleRadius(1, { ...identity, scale: [2, 5, 1] }, "y")).toBe(0.5);
    expect(dragCapsuleHeight(2, { ...identity, scale: [1, 2, 1] }, "y")).toBe(2);
  });

  it("finds where a ray passes closest to a handle's axis, and moves centres in local units", () => {
    // A ray straight down at x = 2 passes the x axis at 2.
    expect(closestOnAxis([2, 5, 0], [0, -1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(2);
    expect(closestOnAxis([0, 5, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull(); // parallel
    close(centerDelta({ ...identity, rotation: turnY90, scale: [2, 1, 1] }, [0, 0, -2]), [1, 0, 0]);
  });

  it("draws mesh colliders by their triangle edges, shared edges once", () => {
    const quad = meshWire(identity, [0, 0, 0], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    expect(quad).toHaveLength(5);
  });
});

describe("3D colliders in the editor", () => {
  let engine: Engine;

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
  });

  afterEach(() => {
    editingCollider.value = null;
    selection.value = null;
    engine.dispose();
  });

  it("outlines a new cube's box collider and shows face handles while editing it", () => {
    const scene = openScene.value!;
    const id = createNode(scene, "cube", { position: [0, 0, 0] });
    const node = scene.sync.nodeFor(id)!;
    expect(node.getBehavior(BoxCollider)).not.toBeNull();
    selection.value = id;
    const before = colliderOverlay(engine).lines.length;
    expect(before).toBeGreaterThanOrEqual(3 + 12); // the 2D colliders, and the cube's twelve edges
    editingCollider.value = { key: id, type: "engine.BoxCollider", index: 0 };
    expect(colliderOverlay(engine).handles.map((h) => h.id).sort()).toEqual(["center", "x+", "x-", "y+", "y-", "z+", "z-"]);
    scene.stack.execute(new SetField(id, "engine.BoxCollider", "size", [2, 1, 1]));
    close(colliderOverlay(engine).handles.find((h) => h.id === "x+")!.position, [1, 0, 0]);
  });

  it("adds sphere and capsule colliders with their own handles", () => {
    const scene = openScene.value!;
    const id = createNode(scene, "empty");
    scene.stack.execute(new AddComponent(id, { type: "engine.CapsuleCollider", data: { direction: "x" } }));
    selection.value = id;
    editingCollider.value = { key: id, type: "engine.CapsuleCollider", index: 0 };
    expect(colliderOverlay(engine).handles.map((h) => h.id).sort()).toEqual(["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
  });
});

describe("creating 3D nodes", () => {
  it("makes shapes with a mesh and matching collider, and lights aimed down", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const doc = openScene.value!.doc;
    expect(newNodeEntry(doc, "sphere", null).components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.MeshRenderer", "engine.SphereCollider"]);
    expect(newNodeEntry(doc, "plane", null).components![2].type).toBe("engine.MeshCollider");
    const sun = newNodeEntry(doc, "directional-light", null, [0, 0, 0]);
    expect(sun).toMatchObject({ id: "directional-light", name: "Directional Light" });
    expect(sun.components![0].data).toEqual({ position: [0, 5, 0], rotation: [-50, 30, 0] });
    expect(newNodeEntry(doc, "point-light", null).components![1].data).toEqual({ type: "point" });
    engine.dispose();
  });
});

describe("adding models from the Assets panel (ADR 0044)", () => {
  it("adds a one-mesh model as one node, and a model of several meshes as a node with a child per mesh", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    const file = (p: string) => `data:application/octet-stream;base64,${readFileSync(new URL(`../../samples/playground3d/${p}`, import.meta.url)).toString("base64")}`;
    const extra = Assets.fromObject({ "models/robot.fbx": file("models/robot.fbx"), "models/crate.obj": file("models/crate.obj"), "models/crate.mtl": file("models/crate.mtl") });
    Assets.addSource(extra);
    try {
      openSceneFile(engine, DEMO_SCENE);
      const scene = openScene.value!;
      expect(whyNotAddable(scene.doc, "models/robot.fbx")).toBeNull();
      await prepareAssets(["models/robot.fbx", "models/crate.obj"]);
      const robot = addAsset(scene, "models/robot.fbx", { position: [1, 0, 2] });
      expect(scene.doc.children(robot).map((id) => scene.doc.node(id).name)).toEqual(["Body", "Head"]);
      const head = scene.doc.children(robot)[1];
      expect(scene.doc.node(head).components!.find((c) => c.type === "engine.MeshRenderer")!.data).toEqual({ mesh: "asset:models/robot.fbx#Head" });
      const crate = addAsset(scene, "models/crate.obj");
      expect(scene.doc.children(crate)).toEqual([]);
      expect(scene.sync.nodeFor(crate)!.getBehavior(MeshRenderer)!.mesh).toBe("models/crate.obj");
      scene.stack.undo();
      expect(scene.doc.has(crate)).toBe(false);
    } finally {
      Assets.removeSource(extra);
      engine.dispose();
    }
  });
});

describe("adding a 3D collider beside a mesh (ADR 0045)", () => {
  it("fits a box, sphere or capsule around the mesh", async () => {
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    const scene = openScene.value!;
    const id = createNode(scene, "capsule");
    const node = scene.sync.nodeFor(id)!;
    expect(newComponentEntry(node, "engine.BoxCollider")).toEqual({ type: "engine.BoxCollider", data: { center: [0, 0, 0], size: [1, 2, 1] } });
    expect(newComponentEntry(node, "engine.SphereCollider").data).toEqual({ center: [0, 0, 0], radius: 1 });
    expect(newComponentEntry(node, "engine.CapsuleCollider").data).toEqual({ center: [0, 0, 0], radius: 0.5, height: 2 });
    expect(newComponentEntry(scene.sync.nodeFor("bird")!, "engine.BoxCollider")).toEqual({ type: "engine.BoxCollider" }); // no mesh
    engine.dispose();
  });
});
