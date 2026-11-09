// Field-value edits from the Inspector (fieldEdits.ts) and contributed field choices (ADR 0152), on the
// demo scene: its `bg-a` and `bg-b` are instances of the background prefab (at [0, 3, 0]; bg-b overrides
// its position to [32, 3, 0]).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Input, Quaternion, behavior, field } from "../myco";
import { listComponents, type ComponentInfo } from "../engine/editor";
import { AddComponent, type NodePath } from "./document";
import { fieldChoicesFor, listedChoices, loadFieldChoices } from "./fieldChoices";
import { eulerAnglesOf, fieldState, fieldValues, isMixed, revertField, setField, setFieldAxis } from "./fieldEdits";
import { OrbitCamera } from "./OrbitCamera";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import { openSceneFile } from "./project";
import { activatePlugin, deactivatePlugin } from "./sdk/plugins";
import { openScene, sceneCamera } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

@behavior("test.fieldEdits.Facing")
class Facing extends GameBehavior {
  @field(Quaternion) facing = new Quaternion();
}

beforeEach(async () => {
  Input.reset();
  const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, DEMO_SCENE);
});

const scene = () => openScene.value!;
const infoOf = (path: NodePath, type: string): ComponentInfo => listComponents(scene().sync.nodeFor(path)!).find((c) => c.type === type)!;
const fieldOf = (path: NodePath, type: string, name: string) => infoOf(path, type).fields.find((f) => f.name === name)!;
const TRANSFORM = { type: "engine.Transform", index: 0 };
const instances: NodePath[] = [["bg-a"], ["bg-b"]];
const positionOverride = (id: string) => scene().doc.overrides(id).find((o) => o.component === "engine.Transform" && o.field === "position")?.value;

describe("setting a field", () => {
  it("sets one axis on two prefab instances as overrides keeping their other axes, in one undo step", () => {
    const { stack, sync } = scene();
    const steps = () => stack.undoLabel;
    setFieldAxis(scene(), instances, TRANSFORM, fieldOf(["bg-a"], "engine.Transform", "position"), 1, 7);
    expect(positionOverride("bg-a")).toEqual([0, 7, 0]);
    expect(positionOverride("bg-b")).toEqual([32, 7, 0]);
    expect(sync.nodeFor("bg-b")!.transform!.position.toArray()).toEqual([32, 7, 0]);
    expect(steps()).toBe("Set position on 2 nodes");
    stack.undo();
    expect(positionOverride("bg-a")).toBeUndefined();
    expect(positionOverride("bg-b")).toEqual([32, 3, 0]);
    expect(sync.nodeFor("bg-a")!.transform!.position.toArray()).toEqual([0, 3, 0]);
  });

  it("writes a plain node's own field, and one node's edit is one undo step", () => {
    const { doc, stack } = scene();
    setField(scene(), [["bird"]], TRANSFORM, fieldOf(["bird"], "engine.Transform", "position"), [1, 2, 0]);
    expect(doc.fieldValue("bird", "engine.Transform", "position")).toEqual([1, 2, 0]);
    expect(doc.node("bird").overrides).toBeUndefined();
    stack.undo();
    expect(doc.fieldValue("bird", "engine.Transform", "position")).toEqual([-4, 1, 0]);
  });

  it("edits a quaternion as Euler degrees that read back as typed", () => {
    scene().stack.execute(new AddComponent("bird", { type: "test.fieldEdits.Facing" }));
    const FACING = { type: "test.fieldEdits.Facing", index: 0 };
    const facing = () => fieldOf(["bird"], FACING.type, "facing");
    setFieldAxis(scene(), [["bird"]], FACING, facing(), 2, 30);
    expect(eulerAnglesOf(facing().value as Quaternion)).toEqual([0, 0, 30]);
    setFieldAxis(scene(), [["bird"]], FACING, facing(), 0, 10); // keeps z
    expect(eulerAnglesOf(facing().value as Quaternion)).toEqual([10, 0, 30]);
    expect(scene().doc.fieldValue("bird", FACING.type, "facing")).toEqual([10, 0, 30]);
    expect(scene().sync.nodeFor("bird")!.getBehavior(Facing)!.facing).toBeInstanceOf(Quaternion);
  });
});

describe("reporting and reverting", () => {
  it("tells differing values apart, quaternions by their rounded angles", () => {
    expect(fieldState(scene(), instances, TRANSFORM, "position").mixed).toBe(true);
    expect(isMixed(scene(), [Quaternion.fromEuler(0, 0, 30), Quaternion.fromEuler(0, 0, 30.000001)])).toBe(false);
    expect(isMixed(scene(), [Quaternion.fromEuler(0, 0, 30), Quaternion.fromEuler(0, 0, 31)])).toBe(true);
    setFieldAxis(scene(), instances, TRANSFORM, fieldOf(["bg-a"], "engine.Transform", "position"), 0, 5);
    expect(fieldValues(scene(), instances, TRANSFORM, "position").map((v) => (v as { toArray(): number[] }).toArray())).toEqual([
      [5, 3, 0],
      [5, 3, 0],
    ]);
    expect(fieldState(scene(), instances, TRANSFORM, "position").mixed).toBe(false);
  });

  it("reports overrides and reverts them on every instance in one undo step", () => {
    const { stack } = scene();
    expect(fieldState(scene(), [["bg-a"]], TRANSFORM, "position").overridden).toBe(false);
    expect(fieldState(scene(), instances, TRANSFORM, "position").overridden).toBe(true); // bg-b's
    setFieldAxis(scene(), instances, TRANSFORM, fieldOf(["bg-a"], "engine.Transform", "position"), 1, 7);
    revertField(scene(), [...instances, ["bird"]], TRANSFORM, "position"); // the plain node is skipped
    expect(positionOverride("bg-a")).toBeUndefined();
    expect(positionOverride("bg-b")).toBeUndefined();
    expect(scene().sync.nodeFor("bg-b")!.transform!.position.toArray()).toEqual([0, 3, 0]);
    expect(fieldState(scene(), instances, TRANSFORM, "position").overridden).toBe(false);
    expect(stack.undoLabel).toBe("Revert position");
    stack.undo();
    expect(positionOverride("bg-a")).toEqual([0, 7, 0]);
    expect(positionOverride("bg-b")).toEqual([32, 7, 0]);
  });
});

describe("contributed field choices (ADR 0152)", () => {
  const plugin = {
    manifest: { name: "test.choices", version: "1" },
    activate(ctx: Parameters<Parameters<typeof activatePlugin>[0]["activate"]>[0]) {
      ctx.registerFieldChoices({
        id: "test.sprite-layer",
        type: "engine.SpriteRenderer",
        field: "sortingLayer",
        none: { label: "Default", value: "" },
        key: (info) => String(info.fields.find((f) => f.name === "sprite")?.value ?? ""),
        choices: async (info) => (String(info.fields.find((f) => f.name === "sprite")?.value).includes("background") ? [{ label: "Far", value: "far" }] : []),
      });
    },
  };
  afterEach(() => deactivatePlugin("test.choices"));

  it("finds the contribution for its field only while its plugin is active", () => {
    expect(fieldChoicesFor("engine.SpriteRenderer", "sortingLayer")).toBeUndefined();
    activatePlugin(plugin);
    expect(fieldChoicesFor("engine.SpriteRenderer", "sortingLayer")?.id).toBe("test.sprite-layer");
    expect(fieldChoicesFor("engine.SpriteRenderer", "sprite")).toBeUndefined();
    deactivatePlugin("test.choices");
    expect(fieldChoicesFor("engine.SpriteRenderer", "sortingLayer")).toBeUndefined();
  });

  it("lists `none` then the loaded choices, and hides an unset field with none to offer", async () => {
    activatePlugin(plugin);
    const c = fieldChoicesFor("engine.SpriteRenderer", "sortingLayer")!;
    const loaded = await loadFieldChoices(c, infoOf(["bg-a"], "engine.SpriteRenderer"));
    expect(listedChoices(c, loaded, "far", false)).toEqual([
      { label: "Default", value: "" },
      { label: "Far", value: "far" },
    ]);
    expect(listedChoices(c, [], "", false)).toBeNull();
    expect(listedChoices(c, [], "", true)).toEqual([{ label: "Default", value: "" }]);
    expect(listedChoices(c, [], "far", false)).toEqual([{ label: "Default", value: "" }]); // a stale value can be cleared
  });

  it("the Meshes plugin supplies MeshRenderer.variant's choices, none for a built-in mesh", async () => {
    activatePlugin(meshesEditorPlugin);
    try {
      const c = fieldChoicesFor("engine.MeshRenderer", "variant")!;
      expect(c.none).toEqual({ label: "Default", value: "" });
      const info = { type: "engine.MeshRenderer", fields: [{ name: "mesh", type: String, value: "builtin:cube" }] } as unknown as ComponentInfo;
      expect(c.key(info)).toBe("builtin:cube");
      expect(await loadFieldChoices(c, info)).toEqual([]);
    } finally {
      deactivatePlugin(meshesEditorPlugin.manifest.name);
    }
  });

  it("counts a failing contribution as offering nothing", async () => {
    const c = { id: "x", type: "t", field: "f", key: () => "", choices: () => Promise.reject(new Error("no model")) };
    expect(await loadFieldChoices(c, infoOf(["bird"], "engine.Transform"))).toEqual([]);
  });
});
