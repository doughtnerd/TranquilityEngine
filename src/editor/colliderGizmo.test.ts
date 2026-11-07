import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, PolygonCollider2D } from "../engine";
import { AddComponent, SetField } from "./document";
import { colliderOverlay, colliderShapes } from "./colliderGizmo";
import { MIN_EXTENT, capsule2DHandles, capsule2DPoints, dragCapsule2DHeight, dragCapsule2DRadius, boxCorners, boxHandles, circleHandles, circlePoints, dragBoxEdge, dragCircleRadius, pointInPolygon, polygonArea, toLocal, toWorld, type Pose2D } from "./colliderMath";
import { openSceneFile } from "./project";
import { editingCollider, openScene, selection } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
const identity: Pose2D = { position: [0, 0, 0], rotation: 0, scale: [1, 1] };
const posed: Pose2D = { position: [2, 1, -3], rotation: 90, scale: [2, 3] };

describe("collider shapes in world space", () => {
  it("scales, rotates and offsets local points, and maps them back", () => {
    close(toWorld(posed, [1, 0]), [2, 3, -3]); // x scaled by 2, then turned to +y
    close(toWorld(posed, [0, 1]), [-1, 1, -3]); // y scaled by 3, then turned to -x
    close(toLocal(posed, toWorld(posed, [0.4, -1.2])), [0.4, -1.2]);
  });

  it("puts box corners and edge handles around the offset centre", () => {
    const corners = boxCorners(identity, [1, 0], [4, 2]);
    expect(corners).toEqual([[-1, -1, 0], [3, -1, 0], [3, 1, 0], [-1, 1, 0]]);
    const handles = boxHandles({ ...identity, scale: [2, 1] }, [0, 0], [4, 2]);
    expect(handles).toMatchObject({ left: [-4, 0, 0], right: [4, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], center: [0, 0, 0] });
  });

  it("sizes circles by the larger scale axis, like the physics backend", () => {
    const pose: Pose2D = { ...identity, scale: [1, 3] };
    const points = circlePoints(pose, [0, 0], 0.5, 4);
    close(points[0], [1.5, 0, 0]);
    close(points[1], [0, 1.5, 0]);
    const handles = circleHandles({ ...pose, rotation: 90 }, [0, 0], 0.5);
    close(handles["radius-right"], [0, 1.5, 0]); // rim handles turn with the node
  });
});

describe("upright 2D capsule", () => {
  it("sizes by |scale.x| for the radius and |scale.y| for the height, and ignores rotation", () => {
    const pose: Pose2D = { position: [1, 2, 0], rotation: 0, scale: [2, 1] };
    const h = capsule2DHandles(pose, [0, 0], 0.5, 4);
    close(h["radius-right"], [2, 2, 0]);
    close(h["height-top"], [1, 4, 0]);
    close(h["height-bottom"], [1, 0, 0]);
    const pts = capsule2DPoints(pose, [0, 0], 0.5, 4);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(4);
    expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(0);
  });

  it("turns handle drags into radius and height", () => {
    expect(dragCapsule2DRadius([0.7, 3], [0, 0])).toBeCloseTo(0.7);
    expect(dragCapsule2DHeight([0, -1.5], [0, 0])).toBeCloseTo(3);
    expect(dragCapsule2DRadius([0, 0], [0, 0])).toBe(MIN_EXTENT);
  });
});

describe("points in collider outlines", () => {
  it("tests containment and area in the XY plane, rotated outlines too", () => {
    const box = boxCorners({ ...identity, rotation: 45 }, [0, 0], [2, 2]);
    expect(pointInPolygon([0, 1.3], box)).toBe(true); // inside the turned box's top corner
    expect(pointInPolygon([0.95, 0.95], box)).toBe(false); // outside it, though inside the unturned box
    expect(polygonArea(box)).toBeCloseTo(4);
    expect(polygonArea(circlePoints(identity, [0, 0], 1, 96))).toBeCloseTo(Math.PI, 2);
  });
});

describe("dragging handles", () => {
  it("moves one box edge and keeps the opposite edge where it was", () => {
    expect(dragBoxEdge("right", [3, 5], [0, 0], [2, 2])).toEqual({ center: [1, 0], size: [4, 2] });
    expect(dragBoxEdge("bottom", [0, -3], [0, 0], [2, 2])).toEqual({ center: [0, -1], size: [2, 4] });
  });

  it("moves both edges with symmetric (Alt) dragging", () => {
    expect(dragBoxEdge("left", [-3, 0], [1, 0], [2, 2], true)).toEqual({ center: [1, 0], size: [8, 2] });
  });

  it("never flips or collapses a box past its opposite edge", () => {
    const r = dragBoxEdge("right", [-5, 0], [0, 0], [2, 2]);
    expect(r.size[0]).toBeCloseTo(MIN_EXTENT);
    expect(r.center[0]).toBeCloseTo(-1 + MIN_EXTENT / 2);
  });

  it("sets a circle radius from the pointer distance, undoing the node's scale", () => {
    const pose: Pose2D = { ...identity, scale: [2, 2] };
    expect(dragCircleRadius(pose, toLocal(pose, [3, 4]), [0, 0])).toBeCloseTo(2.5);
    expect(dragCircleRadius(identity, [0, 0], [0, 0])).toBe(MIN_EXTENT);
  });
});

describe("the overlay with the demo scene open", () => {
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

  it("outlines every collider, the selected one brighter, with no handles until editing", () => {
    selection.value = "bird";
    const overlay = colliderOverlay(engine);
    expect(overlay.lines).toHaveLength(3); // ground, ceiling, bird
    const bird = overlay.lines.find((l) => l.points.length > 4)!;
    expect(bird.color).not.toBe(overlay.lines.find((l) => l !== bird)!.color);
    close(bird.points[0], [-4 + 0.7, 1, 0]);
    expect(overlay.handles).toEqual([]);
  });

  it("outlines a 2D character controller upright and gives it radius, height and centre handles", () => {
    const { stack, sync } = openScene.value!;
    stack.execute(new AddComponent("bird", { type: "engine.CharacterController2D", data: { radius: 0.5, height: 2 } }));
    const node = sync.nodeFor("bird")!;
    stack.execute(new SetField("bird", "engine.Transform", "rotation", 90));
    const shape = colliderShapes(engine).filter((s) => s.node === node).find((s) => s.points.length === 34)!;
    const ys = shape.points.map((p) => p[1]), xs = shape.points.map((p) => p[0]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * Math.abs(node.transform!.worldScale.y));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1 * Math.abs(node.transform!.worldScale.x));
    selection.value = "bird";
    editingCollider.value = { key: "bird", type: "engine.CharacterController2D", index: 0 };
    expect(colliderOverlay(engine).handles.map((h) => h.id).sort()).toEqual(["center", "height-bottom", "height-top", "radius-left", "radius-right"]);
  });

  it("adds handles for the collider being edited", () => {
    selection.value = "ground-collider";
    editingCollider.value = { key: "ground-collider", type: "engine.BoxCollider2D", index: 0 };
    const ids = colliderOverlay(engine).handles.map((h) => h.id);
    expect(ids.sort()).toEqual(["bottom", "center", "left", "right", "top"]);

    selection.value = "bird"; // a stale edit target draws nothing
    expect(colliderOverlay(engine).handles).toEqual([]);
  });

  it("outlines polygon (closed) and edge (open) colliders, with vertex and insert handles when edited (ADR 0039)", () => {
    const { stack, sync } = openScene.value!;
    stack.execute(new AddComponent("bird", { type: "engine.PolygonCollider2D", data: { points: [[0, 0], [1, 0], [0, 1]] } }));
    stack.execute(new AddComponent("bird", { type: "engine.EdgeCollider2D", data: { points: [[0, 0], [2, 0]] } }));
    const node = sync.nodeFor("bird")!;
    expect(node.getBehavior(PolygonCollider2D)!.points).toEqual([[0, 0], [1, 0], [0, 1]]);
    selection.value = "bird";
    const lines = colliderOverlay(engine).lines;
    expect(lines.filter((l) => l.points.length === 3 && l.closed)).toHaveLength(1);
    expect(lines.filter((l) => l.points.length === 2 && !l.closed)).toHaveLength(1);
    editingCollider.value = { key: "bird", type: "engine.PolygonCollider2D", index: 0 };
    const ids = colliderOverlay(engine).handles.map((h) => h.id).sort();
    expect(ids).toEqual(["center", "insert:0", "insert:1", "insert:2", "vertex:0", "vertex:1", "vertex:2"]);
    stack.execute(new SetField("bird", "engine.PolygonCollider2D", "points", [[0, 0], [1, 0], [1, 1], [0, 1]]));
    expect(colliderOverlay(engine).handles.filter((h) => h.id.startsWith("vertex:"))).toHaveLength(4);
  });
});
