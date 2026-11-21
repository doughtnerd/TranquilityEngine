import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, PolygonCollider2D } from "../../../myco";
import { AddComponent, SetField } from "../../../editor/document";
import type { EditorOverlay } from "../../../engine/editor";
import { editor, viewportTools } from "../../../editor/sdk";
import { colliderTool, type EditingCollider } from "./colliderGizmo";
import { openSceneFile } from "../../../editor/project";
import { DEMO_SCENE, demoAssets, demoSettings, sceneViewTools } from "../../../editor/testing";

/** Edit a collider, as the Inspector's Edit Collider toggle does. */
const editCollider = (editing: EditingCollider) => editor.viewport.enter(colliderTool.id, editing);
const select = (key: string | null) => editor.scene.selection.set(key ? [key] : []);

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

// The 2D frame maths (where a node's local points are in the world): engine/scene/frame2d.test.ts.
// Each collider type's outline, handles and drags are its entry in the collider shape table: colliderShapes.test.ts.

describe("the overlay with the demo scene open", () => {
  let engine: Engine;
  let view: ReturnType<typeof colliderView>;

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    openSceneFile(engine, DEMO_SCENE);
    view = colliderView(engine);
  });

  afterEach(() => {
    view.stop();
    editor.viewport.leave(colliderTool.id);
    select(null);
    engine.dispose();
  });

  it("outlines every collider, the selected one brighter, with no handles until editing", () => {
    select("bird");
    const overlay = view.overlay();
    expect(overlay.lines).toHaveLength(3); // ground, ceiling, bird
    const bird = overlay.lines.find((l) => l.points.length > 4)!;
    expect(bird.color).not.toBe(overlay.lines.find((l) => l !== bird)!.color);
    close(bird.points[0], [-4 + 0.7, 1, 0]);
    expect(overlay.handles).toEqual([]);
  });

  it("outlines a 2D character controller upright and gives it radius, height and centre handles", () => {
    const { stack, sync } = editor.scene.peekOpen()!;
    stack.execute(new AddComponent("bird", { type: "engine.CharacterController2D", data: { radius: 0.5, height: 2 } }));
    const node = sync.nodeFor("bird")!;
    stack.execute(new SetField("bird", "engine.Transform", "rotation", 90));
    const shape = view.overlay().lines.find((l) => l.points.length === 34)!;
    const ys = shape.points.map((p) => p[1]), xs = shape.points.map((p) => p[0]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * Math.abs(node.transform!.worldScale.y));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1 * Math.abs(node.transform!.worldScale.x));
    select("bird");
    editCollider({ key: "bird", type: "engine.CharacterController2D", index: 0 });
    expect(view.overlay().handles.map((h) => h.id).sort()).toEqual(["center", "height-bottom", "height-top", "radius-left", "radius-right"]);
  });

  it("adds handles for the collider being edited", () => {
    select("ground-collider");
    editCollider({ key: "ground-collider", type: "engine.BoxCollider2D", index: 0 });
    const ids = view.overlay().handles.map((h) => h.id);
    expect(ids.sort()).toEqual(["bottom", "center", "left", "right", "top"]);

    select("bird"); // selecting another node ends editing: no handles
    expect(view.overlay().handles).toEqual([]);
  });

  it("outlines polygon (closed) and edge (open) colliders, with vertex and insert handles when edited (ADR 0039)", () => {
    const { stack, sync } = editor.scene.peekOpen()!;
    stack.execute(new AddComponent("bird", { type: "engine.PolygonCollider2D", data: { points: [[0, 0], [1, 0], [0, 1]] } }));
    stack.execute(new AddComponent("bird", { type: "engine.EdgeCollider2D", data: { points: [[0, 0], [2, 0]] } }));
    const node = sync.nodeFor("bird")!;
    expect(node.getBehavior(PolygonCollider2D)!.points).toEqual([[0, 0], [1, 0], [0, 1]]);
    select("bird");
    const lines = view.overlay().lines;
    expect(lines.filter((l) => l.points.length === 3 && l.closed)).toHaveLength(1);
    expect(lines.filter((l) => l.points.length === 2 && !l.closed)).toHaveLength(1);
    editCollider({ key: "bird", type: "engine.PolygonCollider2D", index: 0 });
    const ids = view.overlay().handles.map((h) => h.id).sort();
    expect(ids).toEqual(["center", "insert:0", "insert:1", "insert:2", "vertex:0", "vertex:1", "vertex:2"]);
    stack.execute(new SetField("bird", "engine.PolygonCollider2D", "points", [[0, 0], [1, 0], [1, 1], [0, 1]]));
    expect(view.overlay().handles.filter((h) => h.id.startsWith("vertex:"))).toHaveLength(4);
  });
});

/** The collider tool on `engine`'s scene view, over a fake viewport (ADR 0128): what it draws now, and a function that removes it. */
function colliderView(engine: Engine): { overlay: () => EditorOverlay; stop: () => void } {
  const off = viewportTools.register(colliderTool);
  const view = sceneViewTools(engine);
  return { overlay: view.overlay, stop: () => (view.stop(), off()) };
}
