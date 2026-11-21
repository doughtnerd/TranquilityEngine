import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoxCollider, Engine } from "../../../myco";
import { centerDelta, closestOnAxis, rotate, type Pose3D } from "./collider3dMath";
import type { EditorOverlay } from "../../../engine/editor";
import { editor, viewportTools } from "../../../editor/sdk";
import { EDITABLE_COLLIDERS, colliderTool, type EditingCollider } from "./colliderGizmo";
import { AddComponent, SetField } from "../../../editor/document";
import { openSceneFile } from "../../../editor/project";
import { DEMO_SCENE, demoAssets, demoSettings, insertNew, sceneViewTools } from "../../../editor/testing";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
const identity: Pose3D = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const turnY90: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
/** Edit a collider, as the Inspector's Edit Collider toggle does. */
const editCollider = (editing: EditingCollider) => editor.viewport.enter(colliderTool.id, editing);
const select = (key: string | null) => editor.scene.selection.set(key ? [key] : []);

// Each collider type's wireframe, handles and drags are its entry in the collider shape table: colliderShapes.test.ts.
describe("the 3D pose maths (ADR 0045)", () => {
  it("turns vectors by quaternions", () => {
    close(rotate(turnY90, [1, 0, 0]), [0, 0, -1]);
    close(rotate(turnY90, [0, 0, 1]), [1, 0, 0]);
  });

  it("finds where a ray passes closest to a handle's axis, and moves centres in local units", () => {
    // A ray straight down at x = 2 passes the x axis at 2.
    expect(closestOnAxis([2, 5, 0], [0, -1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(2);
    expect(closestOnAxis([0, 5, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull(); // parallel
    close(centerDelta({ ...identity, rotation: turnY90, scale: [2, 1, 1] }, [0, 0, -2]), [1, 0, 0]);
  });
});

describe("3D colliders in the editor", () => {
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

  it("outlines a new cube's box collider and shows face handles while editing it", () => {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "cube", { position: [0, 0, 0] });
    const node = scene.sync.nodeFor(id)!;
    expect(node.getBehavior(BoxCollider)).not.toBeNull();
    select(id);
    const before = view.overlay().lines.length;
    expect(before).toBeGreaterThanOrEqual(3 + 12); // the 2D colliders, and the cube's twelve edges
    editCollider({ key: id, type: "engine.BoxCollider", index: 0 });
    expect(view.overlay().handles.map((h) => h.id).sort()).toEqual(["center", "x+", "x-", "y+", "y-", "z+", "z-"]);
    scene.stack.execute(new SetField(id, "engine.BoxCollider", "size", [2, 1, 1]));
    close(view.overlay().handles.find((h) => h.id === "x+")!.position, [1, 0, 0]);
  });

  it("adds sphere and capsule colliders with their own handles", () => {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "empty");
    scene.stack.execute(new AddComponent(id, { type: "engine.CapsuleCollider", data: { direction: "x" } }));
    select(id);
    editCollider({ key: id, type: "engine.CapsuleCollider", index: 0 });
    expect(view.overlay().handles.map((h) => h.id).sort()).toEqual(["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
  });
});

describe("character controller and mesh collider gizmos", () => {
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

  it("draws the controller's capsule upright even when the node is turned, and puts handles on it", () => {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "empty", { position: [1, 2, 3] });
    scene.stack.execute(new SetField(id, "engine.Transform", "rotation", [0, 0, 90]));
    const before = view.overlay().lines.length; // the 2D colliders
    scene.stack.execute(new AddComponent(id, { type: "engine.CharacterController", data: { center: [0, 0.5, 0], radius: 0.5, height: 2 } }));
    select(id);
    const wire = view.overlay().lines.slice(before).map((l) => l.points); // the controller's capsule, drawn after them
    expect(wire.length).toBeGreaterThan(0);
    const shapes = [{ wire }];
    const ys = shapes[0].wire.flat().map((p) => p[1]);
    close([Math.min(...ys), Math.max(...ys)], [2.5 - 1, 2.5 + 1]); // centre y 2.5, half the 2 height each way
    const xs = shapes[0].wire.flat().map((p) => p[0]);
    close([Math.min(...xs), Math.max(...xs)], [0.5, 1.5]); // radius 0.5 around x = 1
    editCollider({ key: id, type: "engine.CharacterController", index: 0 });
    const handles = Object.fromEntries(view.overlay().handles.map((h) => [h.id, h.position]));
    expect(Object.keys(handles).sort()).toEqual(["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
    close(handles.center, [1, 2.5, 3]);
    close(handles["height+"], [1, 3.5, 3]);
  });

  it("edits a mesh collider's centre only", () => {
    const scene = editor.scene.peekOpen()!;
    const id = insertNew(scene, "plane");
    select(id);
    expect(EDITABLE_COLLIDERS.has("engine.MeshCollider")).toBe(true);
    editCollider({ key: id, type: "engine.MeshCollider", index: 0 });
    scene.stack.execute(new SetField(id, "engine.MeshCollider", "center", [0, 1, 0]));
    const handles = view.overlay().handles;
    expect(handles.map((h) => h.id)).toEqual(["center"]);
    expect(EDITABLE_COLLIDERS.has("engine.CharacterController2D")).toBe(true);
  });
});

/** The collider tool on `engine`'s scene view, over a fake viewport (ADR 0128): what it draws now, and a function that removes it. */
function colliderView(engine: Engine): { overlay: () => EditorOverlay; stop: () => void } {
  const off = viewportTools.register(colliderTool);
  const view = sceneViewTools(engine);
  return { overlay: view.overlay, stop: () => (view.stop(), off()) };
}
