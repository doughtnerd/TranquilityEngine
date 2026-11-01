import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { colliderOverlay } from "./colliderGizmo";
import { MIN_EXTENT, boxCorners, boxHandles, circleHandles, circlePoints, dragBoxEdge, dragCircleRadius, toLocal, toWorld, type Pose2D } from "./colliderMath";
import { DEMO_SCENE, demoAssets, demoSettings, openSceneFile } from "./project";
import { editingCollider, selection } from "./state";

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

  it("adds handles for the collider being edited", () => {
    selection.value = "ground-collider";
    editingCollider.value = { key: "ground-collider", type: "engine.BoxCollider2D", index: 0 };
    const ids = colliderOverlay(engine).handles.map((h) => h.id);
    expect(ids.sort()).toEqual(["bottom", "center", "left", "right", "top"]);

    selection.value = "bird"; // a stale edit target draws nothing
    expect(colliderOverlay(engine).handles).toEqual([]);
  });
});
