import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, Quaternion, Vector3 } from "../engine";
import { composeMatrix, localPoseFromWorld, type LocalPose } from "../engine/render/gizmoMath";
import { SetField } from "./document";
import { installGizmo } from "./gizmo";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { openScene, sceneCamera, snapping, tool, viewMode } from "./state";
import { select } from "./inspectorTarget";
import { gizmoPivot, gizmoSpace, snapSettings, updateSnap } from "./sceneTools";
import { FakeRenderSurface } from "../engine/render/fakeViewport";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

const quat = (zDeg: number) => Quaternion.fromEuler(0, 0, zDeg * (Math.PI / 180));

describe("gizmo math: world pose → local Transform values", () => {
  it("is the world pose itself under the World root", () => {
    const pose = localPoseFromWorld(null, new Vector3(1, 2, 3), quat(30), new Vector3(2, 2, 1));
    expect(pose.position).toEqual([1, 2, 3]);
    expect(pose.scale).toEqual([2, 2, 1]);
    // A quaternion [x, y, z, w] (ADR 0163).
    expect(pose.rotation).toEqual([0, 0, 0.258819, 0.9659258]);
  });

  it("removes a moved, rotated and scaled parent", () => {
    const parent = composeMatrix(new Vector3(10, 0, 0), quat(90), new Vector3(2, 2, 2));
    // A child at local (1, 0, 0), rotated 10° locally, sits at world (10, 2, 0) rotated 100°, scale 2.
    const pose = localPoseFromWorld(parent, new Vector3(10, 2, 0), quat(100), new Vector3(2, 2, 2));
    expect(pose.position).toEqual([1, 0, 0]);
    expect(Quaternion.from(pose.rotation).toEuler().z).toBeCloseTo(Math.PI / 18, 4);
    expect(pose.scale).toEqual([1, 1, 1]);
  });

  it("cleans float noise and negative zero", () => {
    const pose = localPoseFromWorld(null, new Vector3(0.1 + 0.2, -0, 0), new Quaternion(), new Vector3(1, 1, 1));
    expect(pose.position).toEqual([0.3, 0, 0]);
    expect(Object.is(pose.position[1], -0)).toBe(false);
  });
});

describe("the gizmo on the selection, over a fake viewport (ADR 0128)", () => {
  let surface: FakeRenderSurface;
  let stop: () => void;
  /** The page's window, where the gizmo listens for Escape (Vitest runs without a DOM). */
  let page: EventTarget;

  beforeEach(async () => {
    Input.reset();
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    surface = new FakeRenderSurface();
    engine.world.render = surface;
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, DEMO_SCENE);
    page = new EventTarget();
    Object.defineProperty(globalThis, "window", { value: page, configurable: true, writable: true });
    stop = installGizmo(engine);
    return () => {
      stop();
      delete (globalThis as { window?: unknown }).window;
      tool.value = "move";
      engine.world.render = null;
    };
  });

  const z45 = Quaternion.rotateZ(Math.PI / 4).toArray();
  const at = (y: number): LocalPose => ({ position: [-4, y, 0], rotation: z45, scale: [1, 1, 1] });
  const escape = () => page.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));

  it("makes a drag one undo step that moves the node in the World", () => {
    const { doc, stack, sync } = openScene.value!;
    select(["bird"]);
    tool.value = "move";
    const before = JSON.stringify(doc.toJSON());
    const handlers = surface.adapter.gizmo!.handlers!;
    handlers.onStart();
    for (const y of [1.5, 2, 2.5]) handlers.onChange([at(y)]);
    handlers.onEnd();
    expect(sync.nodeFor("bird")!.transform!.position.toArray()).toEqual([-4, 2.5, 0]);
    expect(stack.undoLabel).toBe("Move Bird");
    stack.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it("each tool edits its own Transform field; a rotation is written as a quaternion, 2D ones too (ADR 0163)", () => {
    const { doc, stack, sync } = openScene.value!;
    select(["bird"]);
    const handlers = surface.adapter.gizmo!.handlers!;
    const drag = (pose: LocalPose) => (handlers.onStart(), handlers.onChange([pose]), handlers.onEnd());
    const pose: LocalPose = { position: [2, 3, 0], rotation: z45, scale: [1.5, 1.5, 1] };
    tool.value = "scale";
    drag(pose);
    expect(doc.fieldValue("bird", "engine.Transform", "scale")).toEqual([1.5, 1.5, 1]);
    expect(stack.undoLabel).toBe("Scale Bird");
    tool.value = "rotate";
    drag(pose);
    expect(doc.fieldValue("bird", "engine.Transform", "rotation")).toEqual([0, 0, 0.3826834, 0.9238795]);
    expect(sync.nodeFor("bird")!.transform!.rotation2D).toBeCloseTo(Math.PI / 4, 4);
    expect(doc.fieldValue("bird", "engine.Transform", "position")).not.toEqual([2, 3, 0]); // one node turns in place
    // A file that still says a single angle is rewritten as a quaternion by the next rotate.
    stack.execute(new SetField("bird", "engine.Transform", "rotation", 10));
    drag(pose);
    expect(doc.fieldValue("bird", "engine.Transform", "rotation")).toEqual([0, 0, 0.3826834, 0.9238795]);
  });

  it("on a prefab instance the drag writes an override", () => {
    const { doc } = openScene.value!;
    select(["bg-a"]);
    tool.value = "move";
    const handlers = surface.adapter.gizmo!.handlers!;
    handlers.onStart();
    handlers.onChange([{ position: [5, 3, 0], rotation: z45, scale: [1, 1, 1] }]);
    handlers.onEnd();
    expect(doc.overrides("bg-a").some((o) => o.field === "position")).toBe(true);
  });

  it("puts the nodes back on Escape during a drag, recording nothing", () => {
    const { doc, stack, sync } = openScene.value!;
    select(["bird"]);
    tool.value = "move";
    const before = JSON.stringify(doc.toJSON()), undoBefore = stack.undoLabel;
    const position = sync.nodeFor("bird")!.transform!.position.toArray();
    const handlers = surface.adapter.gizmo!.handlers!;
    handlers.onStart();
    handlers.onChange([at(1.5)]);
    expect(escape()).toBe(false); // consumed
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(sync.nodeFor("bird")!.transform!.position.toArray()).toEqual(position);
    // The handle was let go: what the renderer still reports of the drag changes nothing.
    handlers.onChange([at(3)]);
    handlers.onEnd();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(stack.undoLabel).toBe(undoBefore);
    expect(surface.adapter.gizmo?.nodes.map((n) => n.name)).toEqual([sync.nodeFor("bird")!.name]); // shown again
    expect(escape()).toBe(true); // no drag: Escape is left to others
  });

  it("select shows no gizmo; the others pick a mode", () => {
    select(["bird"]);
    tool.value = "select";
    expect(surface.adapter.gizmo).toBeNull();
    tool.value = "move";
    expect(surface.adapter.gizmo?.options.mode).toBe("translate");
    tool.value = "rotate";
    expect(surface.adapter.gizmo?.options.mode).toBe("rotate");
    tool.value = "scale";
    expect(surface.adapter.gizmo?.options.mode).toBe("scale");
  });

  it("passes the snap steps, space and pivot, and the active node among the topmost targets", () => {
    const fresh = { ...snapSettings.value };
    snapping.value = false;
    updateSnap({ always: true, move: 0.5, rotate: Math.PI / 4 });
    gizmoSpace.value = "local";
    gizmoPivot.value = "pivot";
    viewMode.value = "2d";
    select(["bird", "ground-a", "bg-a"]);
    expect(surface.adapter.gizmo?.options).toMatchObject({ snap: true, snapSteps: { move: 0.5, rotate: Math.PI / 4, scale: 0.1 }, space: "local", pivot: "pivot", planar: true, activeIndex: 2 });
    select(["bird", "ground-a", "bird-sprite"]); // the active node is a child of a target, not one itself: the last target
    expect(surface.adapter.gizmo?.options.activeIndex).toBe(1);
    snapSettings.value = fresh;
    gizmoSpace.value = "world";
    gizmoPivot.value = "center";
    viewMode.value = "3d";
  });
});
