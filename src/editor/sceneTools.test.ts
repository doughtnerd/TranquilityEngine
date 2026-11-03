import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { actionLabel, alignOffsets, distributeOffsets, runAlign, type Box } from "./align";
import { insertPoint, movePoint, pointsHandle, pointsHandles, pointsOutline, readPoints, removePoint } from "./colliderMath";
import { gizmoOptions } from "./gizmo";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { DEFAULT_SNAP, cleanSnap, gizmoPivot, gizmoSpace, sceneToolShortcut, snapActive, snapSettings, snapTo, updateSnap } from "./sceneTools";
import { openScene, sceneCamera, select, snapping, viewMode } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

const box = (x0: number, x1: number, y0 = 0, y1 = 0): Box => ({ min: [x0, y0, 0], max: [x1, y1, 0] });

describe("align and distribute math", () => {
  const boxes = [box(0, 2), box(5, 6), box(-1, 0)];

  it("aligns edges and centres to the selection's bounds", () => {
    expect(alignOffsets(boxes, 0, "min")).toEqual([-1, -6, 0]);
    expect(alignOffsets(boxes, 0, "max")).toEqual([4, 0, 6]);
    expect(alignOffsets(boxes, 0, "center")).toEqual([1.5, -3, 3]); // all centres at 2.5
    expect(alignOffsets([box(0, 0, 1, 3), box(0, 0, -2, 0)], 1, "max")).toEqual([0, 3]);
  });

  it("distributes with equal gaps, keeping the outermost two in place", () => {
    // Sorted by centre: [-1,0] [0,2] [5,6]; span 7, sizes 4, two gaps of 1.5.
    const out = distributeOffsets(boxes, 0);
    expect(out[2]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[0]).toBeCloseTo(1.5); // [0,2] → [1.5,3.5]
    expect(distributeOffsets([box(0, 0), box(9, 9), box(1, 1)], 0)).toEqual([0, 0, 3.5]); // points: equal spacing
    expect(distributeOffsets(boxes.slice(0, 2), 0)).toEqual([0, 0]); // two nodes: nothing to do
  });

  it("names actions in the 2D view's words, by axis in 3D", () => {
    expect(actionLabel({ kind: "align", axis: 1, edge: "max" }, true)).toBe("Align top");
    expect(actionLabel({ kind: "align", axis: 0, edge: "center" }, true)).toBe("Align centre");
    expect(actionLabel({ kind: "align", axis: 2, edge: "min" }, false)).toBe("Align Z min");
    expect(actionLabel({ kind: "distribute", axis: 1 }, true)).toBe("Distribute vertically");
  });
});

describe("snap settings", () => {
  it("rounds to steps without float noise", () => {
    expect(snapTo(0.37, 0.25)).toBe(0.25);
    expect(snapTo(0.3, 0.1)).toBe(0.3);
    expect(snapTo(-1.13, 0.5)).toBe(-1);
    expect(snapTo(1.234, 0)).toBe(1.234);
  });

  it("falls back to defaults for unusable stored values", () => {
    expect(cleanSnap(null)).toEqual(DEFAULT_SNAP);
    expect(cleanSnap({ move: -1, rotate: Number.NaN, grid: 2, showGrid: "yes" as never })).toEqual({ ...DEFAULT_SNAP, grid: 2 });
  });

  it("snaps while Ctrl is held or always, and passes the steps, space and pivot to the gizmo", () => {
    snapSettings.value = { ...DEFAULT_SNAP };
    snapping.value = false;
    expect(snapActive.value).toBe(false);
    snapping.value = true;
    expect(snapActive.value).toBe(true);
    snapping.value = false;
    updateSnap({ always: true, move: 0.5, rotate: 45 });
    expect(snapActive.value).toBe(true);
    gizmoSpace.value = "local";
    gizmoPivot.value = "pivot";
    viewMode.value = "2d";
    const o = gizmoOptions("translate", ["a", "b", "c"], "b");
    expect(o).toMatchObject({ snap: true, snapSteps: { move: 0.5, rotate: 45, scale: 0.1 }, space: "local", pivot: "pivot", planar: true, activeIndex: 1 });
    expect(gizmoOptions("rotate", ["a", "b"], "child-of-a").activeIndex).toBe(1); // active isn't a target: the last one
    snapSettings.value = { ...DEFAULT_SNAP };
    gizmoSpace.value = "world";
    gizmoPivot.value = "center";
    viewMode.value = "3d";
  });

  it("X and Z toggle space and pivot; with Ctrl, Z stays undo", () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => sceneToolShortcut({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
    expect(k("x")).toBe("space");
    expect(k("Z")).toBe("pivot");
    expect(k("z", { ctrlKey: true })).toBeNull();
    expect(k("x", { shiftKey: true })).toBeNull();
  });
});

describe("polygon and edge collider handles", () => {
  const identity = { position: [0, 0, 0] as const, rotation: 0, scale: [1, 1] as const };
  const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];

  it("has a vertex handle per point and an insert handle per edge (the closing edge only when closed)", () => {
    const closed = pointsHandles(identity, [1, 0], square, true);
    expect(closed["vertex:1"]).toEqual([3, 0, 0]); // offset by the centre
    expect(closed["insert:3"]).toEqual([1, 1, 0]); // the closing edge's middle
    expect(Object.keys(pointsHandles(identity, [0, 0], square, false)).filter((k) => k.startsWith("insert:"))).toHaveLength(3);
    expect(pointsOutline({ ...identity, scale: [2, 1] }, [0, 0], [[1, 1]])).toEqual([[2, 1, 0]]);
  });

  it("parses handle ids", () => {
    expect(pointsHandle("vertex:12")).toEqual({ kind: "vertex", index: 12 });
    expect(pointsHandle("insert:0")).toEqual({ kind: "insert", index: 0 });
    expect(pointsHandle("center")).toEqual({ kind: "center" });
    expect(pointsHandle("left")).toBeNull();
  });

  it("moves, inserts and removes points, keeping a minimum", () => {
    expect(movePoint(square, 2, [3, 3])[2]).toEqual([3, 3]);
    expect(insertPoint(square, 3)).toEqual([[0, 0], [2, 0], [2, 2], [0, 2], [0, 1]]);
    expect(insertPoint(square, 0)[1]).toEqual([1, 0]);
    expect(removePoint(square, 0, true)).toEqual([[2, 0], [2, 2], [0, 2]]);
    expect(removePoint(square.slice(0, 3), 0, true)).toBeNull();
    expect(removePoint(square.slice(0, 2), 0, false)).toBeNull();
    expect(readPoints([[1, 2], { x: 3, y: 4 }, ["a", 1], null])).toEqual([[1, 2], [3, 4]]);
  });
});

describe("align on the open scene", () => {
  beforeEach(async () => {
    Input.reset();
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, DEMO_SCENE);
  });

  it("lines nodes up in one undo step, with overrides on prefab instances", () => {
    const { doc, stack, sync } = openScene.value!;
    select(["bird", "bg-a"]);
    const x = (id: string) => sync.nodeFor(id)!.transform!.worldPosition.x;
    const before = JSON.stringify(doc.toJSON());
    const left = Math.min(x("bird"), x("bg-a"));
    expect(runAlign({ kind: "align", axis: 0, edge: "min" }, true)).toBeGreaterThan(0);
    expect(x("bird")).toBeCloseTo(left, 4);
    expect(x("bg-a")).toBeCloseTo(left, 4);
    expect(doc.isPrefabInstance("bg-a")).toBe(true);
    expect(stack.undoLabel).toBe("Align left (2 nodes)");
    stack.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it("needs enough nodes", () => {
    select(["bird"]);
    expect(runAlign({ kind: "align", axis: 0, edge: "min" }, true)).toBe(0);
    select(["bird", "bg-a"]);
    expect(runAlign({ kind: "distribute", axis: 0 }, true)).toBe(0);
  });
});
