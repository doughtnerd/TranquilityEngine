// ADR 0042: editing list and choice fields, a component's Worlds and a node's tags from the
// Inspector, on plain nodes and prefab instances.
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Input, Quaternion, RigidBody2D, Vector2, behavior, field } from "../myco";
import { getFields } from "../engine/core/registry";
import { listComponents, type FieldValue } from "../engine/editor";
import { AddComponent, AddNode, SetField, type NodePath } from "./document";
import { choicesFor, fieldTitle, itemField } from "./fieldValues";
import { fieldKind } from "./fields/kinds";
import { deleteNodes } from "./hierarchyEdit";
import { componentWorlds, effectiveWorlds, knownWorldTags, setComponentWorlds, setNodeTags, TAGS, withWorldTag, worldsBadge } from "./inspectorEdits";
import { isOverridden } from "./overrideWriter";
import { OrbitCamera } from "./OrbitCamera";
import { removeComponentFrom } from "./componentEdits";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";
import { sampleProject } from "./testing";

@behavior("test.inspector.Route")
class Route extends GameBehavior {
  @field([Vector2]) points: Vector2[] = [];
  @field([GameObject]) stops: (GameObject | null)[] = [];
  @field([String], { choices: ["slow", "fast"] }) speeds: string[] = [];
  @field(Quaternion) facing = new Quaternion();
  @field([Vector2], { description: "Where it goes <b>next</b>." }) described: Vector2[] = [];
}

beforeEach(async () => {
  Input.reset();
  const project = sampleProject();
  useProjectAssets(project);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

const scene = () => openScene.value!;
const target = (key: string) => {
  const path = key.split("/") as NodePath;
  return { path, node: scene().sync.nodeFor(path)! };
};
const info = (key: string, type: string, index = 0) => listComponents(target(key).node).find((c) => c.type === type && c.index === index)!;
const fieldOf = (key: string, type: string, name: string): FieldValue => info(key, type).fields.find((f) => f.name === name)!;
const worldsOf = (key: string, type: string) => componentWorlds(scene().doc, target(key).path, info(key, type))!;

describe("field editors (ADR 0042)", () => {
  it("picks list kinds with their item kind, and choice and quaternion kinds", () => {
    const fields = getFields(Route);
    const f = (name: string): FieldValue => ({ ...fields.find((x) => x.name === name)!, value: undefined });
    expect(fieldKind(f("points")).name).toBe("list");
    expect(fieldKind(f("points")).item?.name).toBe("vector2");
    expect(fieldKind(f("stops")).item?.name).toBe("node");
    expect(fieldKind(f("speeds")).item?.name).toBe("choice");
    expect(fieldKind(f("facing")).name).toBe("quaternion");
  });

  it("makes engine enum fields dropdowns, with layers from the project settings", () => {
    expect(fieldKind(fieldOf("bird", "engine.RigidBody2D", "bodyType")).name).toBe("choice");
    expect(choicesFor(fieldOf("bird", "engine.RigidBody2D", "bodyType"))!.map((c) => c.value)).toEqual(["dynamic", "kinematic", "static"]);
    const settings = sampleProject().settings;
    expect(choicesFor(fieldOf("bird-sprite", "engine.SpriteRenderer", "sortingLayer"), settings)!.map((c) => c.value)).toEqual(["Background", "Pipes", "Default", "Foreground", "Player"]);
    const collider = listComponents(target("bird").node).find((c) => c.type.endsWith("Collider2D"))!;
    expect(choicesFor(collider.fields.find((f) => f.name === "layer")!, settings)!.map((c) => c.value)).toContain("Player");
    expect(RigidBody2D).toBeDefined();
  });
});

describe("list fields in the document", () => {
  beforeEach(() => {
    scene().stack.execute(new AddComponent("ceiling", { type: "test.inspector.Route" }));
  });

  it("set the whole list on a plain node and the World, undoably", () => {
    const { doc, stack } = scene();
    stack.execute(new SetField("ceiling", "test.inspector.Route", "points", [[1, 2], [3, 4]]));
    expect(doc.fieldValue("ceiling", "test.inspector.Route", "points")).toEqual([[1, 2], [3, 4]]);
    const live = target("ceiling").node.getBehavior(Route)!;
    expect(live.points.map((p) => p.toArray())).toEqual([[1, 2], [3, 4]]);
    stack.undo();
    expect(target("ceiling").node.getBehavior(Route)!.points).toEqual([]);
  });

  it("resolve node items, and deleting a node sets only its items to None", () => {
    const { doc, stack } = scene();
    stack.execute(new SetField("ceiling", "test.inspector.Route", "stops", [{ $node: "bird" }, { $node: "hud" }, { $node: "bird" }]));
    expect(target("ceiling").node.getBehavior(Route)!.stops.map((n) => n?.name)).toEqual(["Bird", "HUD", "Bird"]);
    const refs = doc.references().filter((r) => r.field === "stops");
    expect(refs.map((r) => [r.to, r.element])).toEqual([["bird", 0], ["hud", 1], ["bird", 2]]);
    deleteNodes(scene(), ["bird"]);
    expect(doc.fieldValue("ceiling", "test.inspector.Route", "stops")).toEqual([null, { $node: "hud" }, null]);
    stack.undo();
    expect(doc.fieldValue("ceiling", "test.inspector.Route", "stops")).toEqual([{ $node: "bird" }, { $node: "hud" }, { $node: "bird" }]);
    // The World's references point at the restored node again.
    expect(target("ceiling").node.getBehavior(Route)!.stops[0]).toBe(target("bird").node);
  });

  it("override the whole list on a prefab instance", () => {
    const { doc, stack } = scene();
    stack.execute(new AddNode({ id: "pipes", prefab: "prefabs/pipe-pair.prefab.json" }));
    stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "sortingLayer", "Pipes"));
    expect(doc.node("bg-a").overrides).toContainEqual({ component: "engine.SpriteRenderer", field: "sortingLayer", value: "Pipes" });
  });
});

describe("a component's Worlds (ADR 0033 §3)", () => {
  it("on a plain node, writes the entry's worlds and resets it", () => {
    const { doc, stack } = scene();
    expect(worldsOf("bird", "engine.RigidBody2D")).toEqual({ own: undefined, inherited: undefined });
    setComponentWorlds(scene(), [{ ...target("bird"), info: info("bird", "engine.RigidBody2D") }], ["server"]);
    const entry = doc.node("bird").components!.find((c) => c.type === "engine.RigidBody2D")!;
    expect(Object.keys(entry).slice(0, 2)).toEqual(["type", "worlds"]);
    expect(entry.worlds).toEqual(["server"]);
    expect(worldsBadge(effectiveWorlds(worldsOf("bird", "engine.RigidBody2D")))).toBe("server");
    expect(stack.undoLabel).toBe("Set Worlds");
    setComponentWorlds(scene(), [{ ...target("bird"), info: info("bird", "engine.RigidBody2D") }], undefined);
    expect(entry.worlds).toBeUndefined();
    stack.undo();
    stack.undo();
    expect(doc.node("bird").components!.find((c) => c.type === "engine.RigidBody2D")).not.toHaveProperty("worlds");
  });

  it("on a prefab instance, writes an override, dropped again when its component is removed", () => {
    const { doc } = scene();
    setComponentWorlds(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }], ["client"]);
    expect(doc.node("bg-a").overrides).toContainEqual({ component: "engine.SpriteRenderer", worlds: ["client"] });
    expect(worldsOf("bg-a", "engine.SpriteRenderer").own).toEqual(["client"]);
    expect(target("bg-a").node.getBehavior(Object.getPrototypeOf(info("bg-a", "engine.SpriteRenderer").component!).constructor)).not.toBeNull(); // the editor World has everything
    removeComponentFrom(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }]);
    expect(doc.node("bg-a").overrides!.some((o) => o.worlds !== undefined)).toBe(false);
  });

  it("drops a node's own setting where it matches what the component inherits, and leaves unchanged ones alone", () => {
    const { stack } = scene();
    const rb = (key: string) => ({ ...target(key), info: info(key, "engine.RigidBody2D") });
    const own = () => worldsOf("bird", "engine.RigidBody2D").own;
    const before = stack.undoLabel;
    expect(setComponentWorlds(scene(), [rb("bird")], ["*"])).toBe(0); // every World is what it inherits
    expect(own()).toBeUndefined();
    expect(stack.undoLabel).toBe(before);
    setComponentWorlds(scene(), [rb("bird")], ["server", "client"]);
    expect(setComponentWorlds(scene(), [rb("bird")], ["client", "server"])).toBe(0); // the same tags in another order
    expect(setComponentWorlds(scene(), [rb("bird")], ["*"], "Set Worlds of RigidBody2D")).toBe(1);
    expect(own()).toBeUndefined();
    expect(stack.undoLabel).toBe("Set Worlds of RigidBody2D");
    stack.undo();
    expect(own()).toEqual(["server", "client"]);
  });

  it("with a function, ticks or unticks a tag on each node's own Worlds, as one undo step", () => {
    const { stack } = scene();
    const box = (key: string) => ({ ...target(key), info: info(key, "engine.BoxCollider2D") });
    setComponentWorlds(scene(), [box("ground-collider")], ["server"]);
    setComponentWorlds(scene(), [box("ceiling")], ["client"]);
    expect(setComponentWorlds(scene(), [box("ground-collider"), box("ceiling")], (cur) => withWorldTag(cur, "lobby", true), "Add lobby")).toBe(2);
    expect(worldsOf("ground-collider", "engine.BoxCollider2D").own).toEqual(["server", "lobby"]);
    expect(worldsOf("ceiling", "engine.BoxCollider2D").own).toEqual(["client", "lobby"]);
    expect(stack.undoLabel).toBe("Add lobby");
    setComponentWorlds(scene(), [box("ground-collider"), box("ceiling")], (cur) => withWorldTag(cur, "server", false));
    expect(worldsOf("ground-collider", "engine.BoxCollider2D").own).toEqual(["lobby"]);
    expect(worldsOf("ceiling", "engine.BoxCollider2D").own).toEqual(["client", "lobby"]);
    stack.undo();
    stack.undo();
    expect(worldsOf("ground-collider", "engine.BoxCollider2D").own).toEqual(["server"]);
    expect(worldsOf("ceiling", "engine.BoxCollider2D").own).toEqual(["client"]);
  });

  it("ticks and unticks a World tag", () => {
    expect(withWorldTag(undefined, "server", true)).toEqual(["server"]);
    expect(withWorldTag(["*"], "server", false)).toEqual([]);
    expect(withWorldTag(["client", "server"], "client", false)).toEqual(["server"]);
  });

  it("offers client, server and the project's World tags", () => {
    expect(knownWorldTags({ bootstrap: { worlds: [{ name: "A", tags: ["lobby", "editor"] }], templates: { bot: { tags: ["ai"] } } } } as never, ["extra", "*"])).toEqual(["client", "server", "lobby", "ai", "extra"]);
  });
});

describe("node tags", () => {
  it("edit a plain node's tags, and undo restores them", () => {
    const { doc, stack } = scene();
    expect(doc.node("bird").tags).toEqual(["Player"]);
    setNodeTags(scene(), [["bird"]], (cur) => [...cur, "hero"]);
    expect(doc.node("bird").tags).toEqual(["Player", "hero"]);
    expect(target("bird").node.hasTag("hero")).toBe(true);
    setNodeTags(scene(), [["bird"]], () => []);
    expect(doc.node("bird").tags).toBeUndefined(); // an empty list leaves the key out
    setNodeTags(scene(), [["ceiling"]], () => ["roof"]);
    expect(Object.keys(doc.node("ceiling")).indexOf("tags")).toBe(Object.keys(doc.node("ceiling")).indexOf("name") + 1);
    stack.undo();
    stack.undo();
    stack.undo();
    expect(doc.node("bird").tags).toEqual(["Player"]);
    expect(target("bird").node.tags).toEqual(["Player"]);
  });

  it("override the tags of an instance and of a node inside one, and revert", () => {
    const { doc, stack } = scene();
    stack.execute(new AddNode({ id: "pipes", prefab: "prefabs/pipe-pair.prefab.json" }));
    setNodeTags(scene(), [["pipes"], ["pipes", "top"]], (cur) => [...cur, "hazard"]);
    expect(doc.node("pipes").tags).toEqual(["hazard"]);
    expect(doc.node("pipes").overrides).toEqual([{ target: ["top"], tags: ["hazard"] }]);
    expect(target("pipes/top").node.tags).toEqual(["hazard"]);
    expect(isOverridden(doc, ["pipes", "top"], TAGS)).toBe(true);
    setNodeTags(scene(), [["pipes"], ["pipes", "top"]], () => undefined, "Revert tags");
    expect(doc.node("pipes").tags).toBeUndefined();
    expect(doc.node("pipes").overrides).toBeUndefined();
    expect(target("pipes/top").node.tags).toEqual([]);
    stack.undo();
    expect(target("pipes/top").node.tags).toEqual(["hazard"]);
  });
});

describe("field descriptions (ADR 0159)", () => {
  const described = (): FieldValue => {
    const f = getFields(Route).find((x) => x.name === "described")!;
    return { ...f, value: [] };
  };

  it("are kept by the registry and reach the Inspector's field list", () => {
    expect(getFields(Route).find((x) => x.name === "described")!.options?.description).toBe("Where it goes <b>next</b>.");
    scene().stack.execute(new AddComponent("ceiling", { type: "test.inspector.Route" }));
    expect(fieldOf("ceiling", "test.inspector.Route", "described").options?.description).toBe("Where it goes <b>next</b>.");
  });

  it("is the label's title as plain text, falling back to the name", () => {
    expect(fieldTitle(described())).toBe("Where it goes <b>next</b>.");
    expect(fieldTitle({ name: "points", type: [Vector2], value: [] })).toBe("points");
  });

  it("shows once on a list, not on each item", () => {
    const item = itemField(described(), 0, [1, 2]);
    expect(item.options?.description).toBeUndefined();
    expect(fieldTitle(item)).toBe("described[0]");
    // Other options still reach the item.
    const speeds = getFields(Route).find((x) => x.name === "speeds")!;
    expect(itemField({ ...speeds, value: [] }, 0, "slow").options?.choices).toEqual(["slow", "fast"]);
  });

  it("isn't saved in the scene", () => {
    const { doc, stack } = scene();
    stack.execute(new AddComponent("ceiling", { type: "test.inspector.Route" }));
    stack.execute(new SetField("ceiling", "test.inspector.Route", "described", [[1, 2]]));
    expect(JSON.stringify(doc.toJSON())).not.toContain("Where it goes");
  });
});
