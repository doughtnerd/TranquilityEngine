import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, Vector3 } from "../engine";
import { SpriteRenderer } from "../engine/render/components";
import { listComponents } from "../engine/editor";
import { RenameNode, SetActive, SetField } from "./document";
import { parseNumber } from "./fieldValues";
import { FIELD_KINDS, noNodeRefs } from "./fields/kinds";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { openScene, sceneCamera } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

describe("number boxes", () => {
  it("parses numbers and simple arithmetic, rejecting anything else", () => {
    expect(parseNumber("1.5")).toBe(1.5);
    expect(parseNumber(" 2*3 ")).toBe(6);
    expect(parseNumber("-4/2")).toBe(-2);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("alert(1)")).toBeNull();
    expect(parseNumber("pi / 2")).toBeCloseTo(Math.PI / 2, 12);
    expect(parseNumber("-π")).toBeCloseTo(-Math.PI, 12);
    expect(parseNumber("pie")).toBeNull();
  });
});

describe("editing the open demo scene (ADR 0026)", () => {
  let engine: Engine;

  beforeEach(async () => {
    Input.reset();
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, DEMO_SCENE);
  });

  it("writes a field to the document and the World, and undo restores both", () => {
    const { doc, stack, sync } = openScene.value!;
    const before = JSON.stringify(doc.toJSON());
    stack.execute(new SetField("bird", "engine.Transform", "position", FIELD_KINDS.vector3.toJSON(new Vector3(2, 3, 0), noNodeRefs)));
    expect(doc.fieldValue("bird", "engine.Transform", "position")).toEqual([2, 3, 0]);
    expect(sync.nodeFor("bird")!.transform!.position.toArray()).toEqual([2, 3, 0]);
    expect(stack.dirty).toBe(true);

    stack.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(stack.dirty).toBe(false);
  });

  it("edits a prefab instance as an override", () => {
    const { doc, stack, sync } = openScene.value!;
    const instance = "bg-a"; // instance of background.prefab.json, whose root has a SpriteRenderer
    const node = sync.nodeFor(instance)!;
    expect(listComponents(node).some((c) => c.type === "engine.SpriteRenderer")).toBe(true);
    stack.execute(new SetField(instance, "engine.SpriteRenderer", "color", "#00ff00"));
    expect(doc.overrides(instance).length).toBeGreaterThan(0);
    expect(node.getBehavior(SpriteRenderer)!.color.toHex()).toBe("#00ff00");
  });

  it("renames and toggles active through commands, grouped scrubs undo in one step", () => {
    const { doc, stack, sync } = openScene.value!;
    stack.execute(new RenameNode("bird", "Hero"));
    stack.execute(new SetActive("bird", false));
    expect(doc.node("bird").name).toBe("Hero");
    expect(sync.nodeFor("bird")!.active).toBe(false);

    const reasons: string[] = [];
    stack.subscribe((e) => reasons.push(e.reason));
    stack.beginGroup("Drag mass");
    for (const m of [1.1, 1.2, 1.3]) stack.execute(new SetField("bird", "engine.RigidBody2D", "mass", m));
    expect(stack.canUndo).toBe(false); // the group is still open
    stack.endGroup();
    expect(reasons.at(-1)).toBe("group"); // closing the group notifies, so the toolbar can update
    expect(stack.undoLabel).toBe("Drag mass");
    expect(doc.fieldValue("bird", "engine.RigidBody2D", "mass")).toBe(1.3);
    stack.undo();
    expect(doc.fieldValue("bird", "engine.RigidBody2D", "mass")).not.toBe(1.1);
    expect(doc.node("bird").active).toBe(false); // only the drag was undone
  });
});
