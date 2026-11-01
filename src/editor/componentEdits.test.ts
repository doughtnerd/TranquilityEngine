import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { componentCatalog, listComponents, type ComponentInfo } from "../engine/editor";
import { addComponentTo, inFileOrder, moveComponent, newComponentEntry, overridesWithout, removeComponentFrom, setComponentEnabled, whyNotAddable, whyNotRemovable, whyNotReorderable, whyNotToggleable } from "./componentEdits";
import { SetField, SetOverrides, type NodePath } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { bundledDemoProject, editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";

beforeEach(async () => {
  Input.reset();
  const project = bundledDemoProject();
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
const types = (key: string) => listComponents(target(key).node).map((c) => c.type);
const info = (key: string, type: string, index = 0) => listComponents(target(key).node).find((c) => c.type === type && c.index === index)!;

describe("the Add Component list", () => {
  it("offers engine components and scripts, but not Transform, engine internals or the editor's own", () => {
    const ids = componentCatalog().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["engine.BoxCollider2D", "engine.SpriteRenderer", "game.Bird"]));
    expect(ids).not.toContain("engine.Transform");
    expect(ids).not.toContain("engine.SceneInstance");
    expect(ids).not.toContain("editor.OrbitCamera");
    const groups = componentCatalog().map((t) => t.group);
    expect(groups.indexOf("Scripts")).toBeGreaterThan(groups.lastIndexOf("Engine")); // grouped, Engine first
  });

  it("refuses a second sprite, body or data component, but allows more colliders", () => {
    expect(whyNotAddable(target("bird-sprite").node, "engine.SpriteRenderer")).toMatch(/already has/);
    expect(whyNotAddable(target("bird").node, "engine.RigidBody2D")).toMatch(/already has/);
    expect(whyNotAddable(target("bg-a").node, "game.Scroller")).toMatch(/already has/); // a data component
    expect(whyNotAddable(target("bird").node, "engine.CircleCollider2D")).toBeNull();
    expect(whyNotAddable(target("bird").node, "engine.Transform")).toMatch(/managed by the engine/);
  });

  it("adds a plain component when there's no sprite to fit (or no renderer, headless)", () => {
    expect(newComponentEntry(target("ceiling").node, "engine.CircleCollider2D")).toEqual({ type: "engine.CircleCollider2D" });
  });
});

describe("on plain nodes", () => {
  it("adds to the node's components list as one undo step", () => {
    const { doc, stack } = scene();
    expect(addComponentTo(scene(), [target("ceiling")], "engine.CircleCollider2D")).toBe(1);
    expect(doc.node("ceiling").components!.map((c) => c.type)).toContain("engine.CircleCollider2D");
    expect(types("ceiling")).toContain("engine.CircleCollider2D");
    expect(stack.undoLabel).toBe("Add CircleCollider2D");
    stack.undo();
    expect(types("ceiling")).not.toContain("engine.CircleCollider2D");
  });

  it("adds to every selected node that can take it", () => {
    expect(addComponentTo(scene(), [target("ceiling"), target("bird")], "engine.RigidBody2D")).toBe(1); // Bird has one
    expect(scene().stack.undoLabel).toBe("Add RigidBody2D");
    expect(types("ceiling")).toContain("engine.RigidBody2D");
  });

  it("removes the matching entry, and undo puts it back in place", () => {
    const { doc, stack } = scene();
    const before = doc.node("bird").components!.map((c) => c.type);
    expect(removeComponentFrom(scene(), [{ ...target("bird"), info: info("bird", "engine.CircleCollider2D") }])).toBe(1);
    expect(doc.node("bird").components!.map((c) => c.type)).not.toContain("engine.CircleCollider2D");
    expect(types("bird")).not.toContain("engine.CircleCollider2D");
    expect(stack.undoLabel).toBe("Remove CircleCollider2D");
    stack.undo();
    expect(doc.node("bird").components!.map((c) => c.type)).toEqual(before);
  });

  it("never removes Transform", () => {
    expect(whyNotRemovable(scene().doc, ["bird"], info("bird", "engine.Transform"), 1)).toMatch(/every node has/);
  });
});

describe("on prefab instances", () => {
  it("adds through an override, and removing it drops that override again", () => {
    const { doc } = scene();
    addComponentTo(scene(), [target("bg-a")], "engine.BoxCollider2D");
    expect(doc.node("bg-a").overrides).toEqual([{ addComponent: { type: "engine.BoxCollider2D" } }]);
    expect(types("bg-a")).toContain("engine.BoxCollider2D");

    removeComponentFrom(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.BoxCollider2D") }]);
    expect(doc.node("bg-a").overrides).toBeUndefined();
    expect(types("bg-a")).not.toContain("engine.BoxCollider2D");
  });

  it("removes a prefab's component with an override, dropping field overrides that pointed at it", () => {
    const { doc, stack } = scene();
    stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "orderInLayer", 3));
    removeComponentFrom(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }]);
    expect(doc.node("bg-a").overrides).toEqual([{ removeComponent: "engine.SpriteRenderer" }]);
    expect(types("bg-a")).not.toContain("engine.SpriteRenderer");
    stack.undo();
    expect(doc.node("bg-a").overrides).toEqual([{ component: "engine.SpriteRenderer", field: "orderInLayer", value: 3 }]);
    expect(types("bg-a")).toContain("engine.SpriteRenderer");
  });

  it("only removes the first of a type the prefab has (an override always removes the first)", () => {
    const second = { type: "engine.BoxCollider2D", index: 1 } as ComponentInfo;
    expect(whyNotRemovable(scene().doc, ["bg-a"], second, 2)).toMatch(/only the first/);
    expect(whyNotRemovable(scene().doc, ["bg-a"], { ...second, index: 0 }, 2)).toBeNull();
  });
});

describe("renumbering overrides after a removal", () => {
  it("drops the removed component's field overrides and shifts later ones down", () => {
    const t = "engine.BoxCollider2D";
    const list = [
      { component: t, field: "isTrigger", value: true }, // index 0
      { component: t, index: 1, field: "isTrigger", value: true },
      { component: t, index: 2, field: "isTrigger", value: false },
      { target: ["top"], component: t, field: "isTrigger", value: true }, // another node
      { addComponent: { type: t } }, // the live node's third box
    ];
    // Three live boxes: two from the prefab, then the one the override added. Remove the added one:
    // its addComponent override and its field override go.
    expect(overridesWithout(list, [], t, 2, 3)).toEqual([list[0], list[1], list[3]]);
    // Remove the first (from the prefab): its field override goes, the others shift, and a removeComponent override is added.
    expect(overridesWithout(list, [], t, 0, 3)).toEqual([
      { component: t, field: "isTrigger", value: true },
      { component: t, index: 1, field: "isTrigger", value: false },
      list[3],
      list[4],
      { removeComponent: t },
    ]);
  });
});

describe("switching components on and off", () => {
  const on = (key: string, type: string) => info(key, type).enabled;

  it("writes enabled: false on a plain node, and drops the key when switched back on", () => {
    const { doc, stack } = scene();
    const circle = () => doc.node("bird").components!.find((c) => c.type === "engine.CircleCollider2D")!;
    expect(setComponentEnabled(scene(), [{ ...target("bird"), info: info("bird", "engine.CircleCollider2D") }], false)).toBe(1);
    expect(circle().enabled).toBe(false);
    expect(on("bird", "engine.CircleCollider2D")).toBe(false);
    expect(stack.undoLabel).toBe("Disable CircleCollider2D");
    setComponentEnabled(scene(), [{ ...target("bird"), info: info("bird", "engine.CircleCollider2D") }], true);
    expect("enabled" in circle()).toBe(false);
    stack.undo();
    expect(circle().enabled).toBe(false);
  });

  it("overrides a prefab's component, and switching it back removes the override", () => {
    const { doc } = scene();
    setComponentEnabled(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }], false);
    expect(doc.node("bg-a").overrides).toEqual([{ component: "engine.SpriteRenderer", enabled: false }]);
    expect(on("bg-a", "engine.SpriteRenderer")).toBe(false); // the loader applies it
    setComponentEnabled(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }], true);
    expect(doc.node("bg-a").overrides).toBeUndefined();
    expect(on("bg-a", "engine.SpriteRenderer")).toBe(true);
  });

  it("flags a component added in this scene on its own entry", () => {
    addComponentTo(scene(), [target("bg-a")], "engine.BoxCollider2D");
    setComponentEnabled(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.BoxCollider2D") }], false);
    expect(scene().doc.node("bg-a").overrides).toEqual([{ addComponent: { type: "engine.BoxCollider2D", enabled: false } }]);
    expect(on("bg-a", "engine.BoxCollider2D")).toBe(false);
  });

  it("removing a component drops its enabled override too", () => {
    setComponentEnabled(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }], false);
    removeComponentFrom(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.SpriteRenderer") }]);
    expect(scene().doc.node("bg-a").overrides).toEqual([{ removeComponent: "engine.SpriteRenderer" }]);
  });

  it("leaves Transform and data components always on", () => {
    expect(whyNotToggleable(scene().doc, ["bird"], info("bird", "engine.Transform"), 1)).toMatch(/always on/);
    expect(whyNotToggleable(scene().doc, ["bg-a"], info("bg-a", "game.Scroller"), 1)).toMatch(/always on/);
  });
});

describe("reordering components", () => {
  it("moves a component before or after another on a plain node, as one undo step", () => {
    const { doc, stack } = scene();
    const order = () => doc.node("bird").components!.map((c) => c.type.replace(/^[^.]*\./, ""));
    const before = order();
    expect(before.slice(1)).toEqual(["RigidBody2D", "CircleCollider2D", "Bird"]);
    expect(moveComponent(scene(), ["bird"], target("bird").node, info("bird", "game.Bird"), info("bird", "engine.RigidBody2D"), false)).toBe(true);
    expect(order().slice(1)).toEqual(["Bird", "RigidBody2D", "CircleCollider2D"]);
    expect(types("bird").slice(1)).toEqual(["game.Bird", "engine.RigidBody2D", "engine.CircleCollider2D"]); // the live node follows
    expect(moveComponent(scene(), ["bird"], target("bird").node, info("bird", "game.Bird"), info("bird", "engine.CircleCollider2D"), true)).toBe(true);
    expect(order().slice(1)).toEqual(["RigidBody2D", "CircleCollider2D", "Bird"]);
    expect(stack.undoLabel).toBe("Reorder components");
    stack.undo();
    stack.undo();
    expect(order()).toEqual(before);
  });

  it("does nothing for a move onto itself or into the same place", () => {
    expect(moveComponent(scene(), ["bird"], target("bird").node, info("bird", "game.Bird"), info("bird", "game.Bird"), false)).toBe(false);
    expect(moveComponent(scene(), ["bird"], target("bird").node, info("bird", "game.Bird"), info("bird", "engine.CircleCollider2D"), true)).toBe(false);
  });

  it("keeps Transform first, and a prefab instance's data components where the prefab has them", () => {
    expect(whyNotReorderable(scene().doc, ["bird"], info("bird", "engine.Transform"))).toMatch(/first/);
    expect(whyNotReorderable(scene().doc, ["bg-a"], info("bg-a", "game.Scroller"))).toMatch(/stay where the prefab/);
    expect(whyNotReorderable(scene().doc, ["bg-a"], info("bg-a", "engine.SpriteRenderer"))).toBeNull();
  });

  it("moves data components among the rest on a plain node, and lists components in file order", () => {
    const { doc } = scene();
    // Ceiling: Transform, BoxCollider2D. Give it a data component (the demo's Scroller) and a script.
    addComponentTo(scene(), [target("ceiling")], "game.Scroller");
    addComponentTo(scene(), [target("ceiling")], "game.Bird");
    const listed = () => inFileOrder(doc, "ceiling", listComponents(target("ceiling").node)).map((c) => c.type);
    expect(listed()).toEqual(["engine.Transform", "engine.BoxCollider2D", "game.Scroller", "game.Bird"]);
    expect(moveComponent(scene(), ["ceiling"], target("ceiling").node, info("ceiling", "game.Scroller"), info("ceiling", "engine.BoxCollider2D"), false)).toBe(true);
    expect(doc.node("ceiling").components!.map((c) => c.type)).toEqual(["engine.Transform", "game.Scroller", "engine.BoxCollider2D", "game.Bird"]);
    expect(listed()).toEqual(["engine.Transform", "game.Scroller", "engine.BoxCollider2D", "game.Bird"]);
    expect(types("ceiling").slice(-1)).toEqual(["game.Scroller"]); // live, data components sit apart
  });

  it("reorders a prefab instance's components with an order override the loader applies", () => {
    const { doc, stack } = scene();
    addComponentTo(scene(), [target("bg-a")], "engine.BoxCollider2D");
    const behaviors = () => listComponents(target("bg-a").node).filter((c) => c.kind === "behavior").map((c) => c.type);
    expect(behaviors()).toEqual(["engine.SpriteRenderer", "engine.BoxCollider2D"]);
    expect(moveComponent(scene(), ["bg-a"], target("bg-a").node, info("bg-a", "engine.BoxCollider2D"), info("bg-a", "engine.SpriteRenderer"), false)).toBe(true);
    expect(doc.node("bg-a").overrides!.at(-1)).toEqual({ order: ["engine.BoxCollider2D", "engine.SpriteRenderer"] });
    expect(behaviors()).toEqual(["engine.BoxCollider2D", "engine.SpriteRenderer"]);
    // Back in the prefab's own order (its sprite, then the added box): the override goes.
    moveComponent(scene(), ["bg-a"], target("bg-a").node, info("bg-a", "engine.BoxCollider2D"), info("bg-a", "engine.SpriteRenderer"), true);
    expect(doc.node("bg-a").overrides).toEqual([{ addComponent: { type: "engine.BoxCollider2D" } }]);
    expect(behaviors()).toEqual(["engine.SpriteRenderer", "engine.BoxCollider2D"]);
    stack.undo();
    expect(behaviors()).toEqual(["engine.BoxCollider2D", "engine.SpriteRenderer"]);
    // Removing a component takes it out of the order too.
    stack.execute(new SetOverrides("bg-a", "two", [{ addComponent: { type: "engine.CircleCollider2D" } }, ...doc.node("bg-a").overrides!]));
    removeComponentFrom(scene(), [{ ...target("bg-a"), info: info("bg-a", "engine.BoxCollider2D") }]);
    expect(doc.node("bg-a").overrides).toEqual([{ addComponent: { type: "engine.CircleCollider2D" } }, { order: ["engine.SpriteRenderer"] }]);
  });

  it("orders hooks within a node by the new order", () => {
    addComponentTo(scene(), [target("bg-a")], "engine.BoxCollider2D");
    moveComponent(scene(), ["bg-a"], target("bg-a").node, info("bg-a", "engine.BoxCollider2D"), info("bg-a", "engine.SpriteRenderer"), false);
    const [box, sprite] = listComponents(target("bg-a").node).filter((c) => c.kind === "behavior").map((c) => c.component as unknown as { _seq: number });
    expect(box._seq).toBeLessThan(sprite._seq);
  });
});
