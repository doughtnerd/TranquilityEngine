import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoxCollider, Engine } from "../../../myco";
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
  MESH_WIRE_TRIANGLES,
  meshOutline,
  meshWire,
  rotate,
  sphereHandles3D,
  type Pose3D,
} from "./collider3dMath";
import { EDITABLE_COLLIDERS, collider3dShapes, colliderOverlay, editingCollider } from "./colliderGizmo";
import { AddComponent, SetField } from "../../../editor/document";
import { createNode } from "../../../editor/nodeCreate";
import { openSceneFile } from "../../../editor/project";
import { openScene } from "../../../editor/state";
import { DEMO_SCENE, demoAssets, demoSettings } from "../../../editor/testing";
import { select } from "../../../editor/inspectorTarget";

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

  it("draws mesh colliders by their triangle edges, shared edges once, or their bounds when big", () => {
    expect(meshOutline([0, 0, 0, 2, 0, 0, 2, 4, 0], Array.from({ length: (MESH_WIRE_TRIANGLES + 1) * 3 }, (_, i) => i % 3))).toEqual({ boxCenter: [1, 2, 0], boxSize: [2, 4, 0] });
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
    select([]);
    engine.dispose();
  });

  it("outlines a new cube's box collider and shows face handles while editing it", () => {
    const scene = openScene.value!;
    const id = createNode(scene, "cube", { position: [0, 0, 0] });
    const node = scene.sync.nodeFor(id)!;
    expect(node.getBehavior(BoxCollider)).not.toBeNull();
    select([id]);
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
    select([id]);
    editingCollider.value = { key: id, type: "engine.CapsuleCollider", index: 0 };
    expect(colliderOverlay(engine).handles.map((h) => h.id).sort()).toEqual(["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
  });
});

describe("character controller and mesh collider gizmos", () => {
  let engine: Engine;

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
  });

  afterEach(() => {
    editingCollider.value = null;
    select([]);
    engine.dispose();
  });

  it("draws the controller's capsule upright even when the node is turned, and puts handles on it", () => {
    const scene = openScene.value!;
    const id = createNode(scene, "empty", { position: [1, 2, 3] });
    scene.stack.execute(new SetField(id, "engine.Transform", "rotation", [0, 0, 90]));
    scene.stack.execute(new AddComponent(id, { type: "engine.CharacterController", data: { center: [0, 0.5, 0], radius: 0.5, height: 2 } }));
    select([id]);
    const node = scene.sync.nodeFor(id)!;
    const shapes = collider3dShapes(engine).filter((s) => s.node === node);
    expect(shapes).toHaveLength(1);
    const ys = shapes[0].wire.flat().map((p) => p[1]);
    close([Math.min(...ys), Math.max(...ys)], [2.5 - 1, 2.5 + 1]); // centre y 2.5, half the 2 height each way
    const xs = shapes[0].wire.flat().map((p) => p[0]);
    close([Math.min(...xs), Math.max(...xs)], [0.5, 1.5]); // radius 0.5 around x = 1
    editingCollider.value = { key: id, type: "engine.CharacterController", index: 0 };
    const handles = Object.fromEntries(colliderOverlay(engine).handles.map((h) => [h.id, h.position]));
    expect(Object.keys(handles).sort()).toEqual(["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
    close(handles.center, [1, 2.5, 3]);
    close(handles["height+"], [1, 3.5, 3]);
  });

  it("matches capsuleWire with an upright pose", () => {
    const turned: Pose3D = { position: [0, 0, 0], rotation: turnY90, scale: [1, 1, 1] };
    const upright = capsuleWire({ ...turned, rotation: [0, 0, 0, 1] }, [0, 0, 0], 0.5, 2, "y");
    expect(upright.flat().every((p) => Math.abs(p[1]) <= 1 + 1e-9)).toBe(true);
  });

  it("edits a mesh collider's centre only", () => {
    const scene = openScene.value!;
    const id = createNode(scene, "plane");
    select([id]);
    expect(EDITABLE_COLLIDERS.has("engine.MeshCollider")).toBe(true);
    editingCollider.value = { key: id, type: "engine.MeshCollider", index: 0 };
    scene.stack.execute(new SetField(id, "engine.MeshCollider", "center", [0, 1, 0]));
    const handles = colliderOverlay(engine).handles;
    expect(handles.map((h) => h.id)).toEqual(["center"]);
    expect(EDITABLE_COLLIDERS.has("engine.CharacterController2D")).toBe(true);
  });
});
