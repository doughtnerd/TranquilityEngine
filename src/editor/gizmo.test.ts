import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, Quaternion, Vector3 } from "../engine";
import { composeMatrix, localPoseFromWorld, type LocalPose } from "../engine/render/gizmoMath";
import { SetField } from "./document";
import { gizmoEdit, gizmoMode } from "./gizmo";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { shortcutFor } from "./shortcuts";
import { openScene, sceneCamera } from "./state";
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

describe("gizmo edits (ADR 0026)", () => {
  beforeEach(async () => {
    Input.reset();
    const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, DEMO_SCENE);
  });

  const z45 = Quaternion.rotateZ(Math.PI / 4).toArray();
  const asPose = (): LocalPose => ({ position: [2, 3, 0], rotation: z45, scale: [1.5, 1.5, 1] });

  it("each mode edits its own Transform field", () => {
    const { doc } = openScene.value!;
    expect(gizmoEdit(doc, "bird", "translate", asPose()).field).toBe("position");
    expect(gizmoEdit(doc, "bird", "rotate", asPose()).field).toBe("rotation");
    expect(gizmoEdit(doc, "bird", "scale", asPose()).value).toEqual([1.5, 1.5, 1]);
  });

  it("a drag is one undo step that moves the node in the World", () => {
    const { doc, stack, sync } = openScene.value!;
    const before = JSON.stringify(doc.toJSON());
    stack.beginGroup("Move Bird");
    for (const y of [1.5, 2, 2.5]) stack.execute(gizmoEdit(doc, "bird", "translate", { ...asPose(), position: [-4, y, 0] }));
    stack.endGroup();
    expect(sync.nodeFor("bird")!.transform!.position.toArray()).toEqual([-4, 2.5, 0]);
    expect(stack.undoLabel).toBe("Move Bird");
    stack.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it("writes a rotation as a quaternion, 2D ones too (ADR 0163)", () => {
    const { doc, stack, sync } = openScene.value!;
    stack.execute(gizmoEdit(doc, "bird", "rotate", asPose()));
    expect(doc.fieldValue("bird", "engine.Transform", "rotation")).toEqual([0, 0, 0.3826834, 0.9238795]);
    expect(sync.nodeFor("bird")!.transform!.rotation2D).toBeCloseTo(Math.PI / 4, 4);
    // A file that still says a single angle is rewritten as a quaternion by the next rotate.
    stack.execute(new SetField("bird", "engine.Transform", "rotation", 10));
    expect(gizmoEdit(doc, "bird", "rotate", asPose()).value).toEqual([0, 0, 0.3826834, 0.9238795]);
  });

  it("on a prefab instance the drag writes an override", () => {
    const { doc, stack } = openScene.value!;
    stack.execute(gizmoEdit(doc, "bg-a", "translate", { ...asPose(), position: [5, 3, 0] }));
    expect(doc.overrides("bg-a").some((o) => o.field === "position")).toBe(true);
  });
});

describe("tool shortcuts", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
    shortcutFor({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

  it("maps Q/W/E/R to tools, ignoring modified keys", () => {
    expect(key("q")).toBe("tool:select");
    expect(key("w")).toBe("tool:move");
    expect(key("E")).toBe("tool:rotate");
    expect(key("r")).toBe("tool:scale");
    expect(key("r", { ctrlKey: true })).toBeNull();
    expect(key("w", { altKey: true })).toBeNull();
    expect(key("z", { ctrlKey: true })).toBe("undo");
  });

  it("select shows no gizmo; the others pick a mode", () => {
    expect(gizmoMode("select")).toBeNull();
    expect(gizmoMode("move")).toBe("translate");
    expect(gizmoMode("rotate")).toBe("rotate");
    expect(gizmoMode("scale")).toBe("scale");
  });
});
