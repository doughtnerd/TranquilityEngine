import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { componentCatalog, listComponents, type ComponentInfo } from "../engine/editor";
import { addComponentTo, newComponentEntry, overridesWithout, removeComponentFrom, whyNotAddable, whyNotRemovable } from "./componentEdits";
import { SetField, type NodePath } from "./document";
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
