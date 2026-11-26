// Component id aliases (ADR 0423): `engine.TilemapCollider2D`, renamed `engine.ShapeCollider2D`, still loads from
// scenes, prefabs and overrides, and documents save the new id.
import { describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, ShapeCollider2D, TilemapCollider2D, getComponentClass, getComponentId, registerComponentAlias, resolveComponentId } from "../../myco";
import { SceneDocument } from "../../editor/document/SceneDocument";
import type { SceneFile } from "../scene/SceneLoader";

const OLD = "engine.TilemapCollider2D", NEW = "engine.ShapeCollider2D";

const oldScene = (): SceneFile =>
  ({
    format: "myco.scene@5",
    settings: { physics: "2d" },
    nodes: [
      { id: "map", name: "Map", components: [{ type: "engine.Transform" }, { type: OLD, data: { mode: "outline" } }] },
      {
        id: "inst",
        name: "Inst",
        prefab: "map.prefab.json",
        overrides: [
          { component: OLD, field: "isTrigger", value: true },
          { component: OLD, index: 0, enabled: false },
          { order: [OLD, "engine.Transform"] },
          { addNodes: [{ id: "extra", name: "Extra", components: [{ type: OLD, data: { mode: "outline" } }] }] },
        ],
      },
      { id: "gone", name: "Gone", prefab: "map.prefab.json", overrides: [{ removeComponent: OLD }] },
      { id: "legacy", name: "Legacy", prefab: "legacy.prefab.json", overrides: [{ component: NEW, field: "mode", value: "outline" }] },
    ],
  }) as unknown as SceneFile;

const prefab = (type: string) => ({ format: "myco.scene@5", nodes: [{ id: "root", name: "Root", components: [{ type: "engine.Transform" }, { type, data: {} }] }] });

/** The node named `name` under `root`, depth first. */
function named(root: GameObject, name: string): GameObject | null {
  for (const child of root.children) {
    if (child.name === name) return child;
    const found = named(child, name);
    if (found) return found;
  }
  return null;
}

describe("component id aliases (ADR 0423)", () => {
  it("the old id and the deprecated class name resolve to ShapeCollider2D", () => {
    expect(TilemapCollider2D).toBe(ShapeCollider2D);
    expect(getComponentId(ShapeCollider2D)).toBe(NEW);
    expect(getComponentClass(OLD)).toBe(ShapeCollider2D);
    expect(resolveComponentId(OLD)).toBe(NEW);
    expect(resolveComponentId(NEW)).toBe(NEW);
  });

  it("an alias can be registered and undone, and can't loop", () => {
    const undo = registerComponentAlias("test.alias.Old", NEW);
    expect(getComponentClass("test.alias.Old")).toBe(ShapeCollider2D);
    expect(() => registerComponentAlias(NEW, "test.alias.Old")).toThrow(/cycle/);
    undo();
    expect(getComponentClass("test.alias.Old")).toBeUndefined();
  });

  it("an old scene and its prefab instances load the old id as ShapeCollider2D, overrides included", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": oldScene(), "map.prefab.json": prefab(NEW), "legacy.prefab.json": prefab(OLD) }));
    const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } } });
    await SceneManager.load("s.json");
    const node = (name: string) => named(engine.world.root, name);
    const collider = (name: string) => node(name)?.getBehavior(ShapeCollider2D) ?? null;
    expect(collider("Map")?.mode).toBe("outline");
    // Overrides naming the old id apply to the prefab's new-id component.
    const inst = collider("Inst")!;
    expect(inst.isTrigger).toBe(true);
    expect(inst.enabled).toBe(false);
    expect(collider("Extra")?.mode).toBe("outline");
    expect(node("Gone")).not.toBeNull();
    expect(collider("Gone")).toBeNull(); // removed by the old id
    // A prefab written with the old id, overridden with the new one.
    expect(collider("Legacy")?.mode).toBe("outline");
    engine.dispose();
  });

  it("a document read with the old id saves the new one everywhere", () => {
    const saved = JSON.stringify(new SceneDocument(oldScene(), "s.scene.json").toJSON());
    expect(saved).not.toContain(OLD);
    const out = JSON.parse(saved) as SceneFile;
    expect(out.nodes[0]!.components![1]).toEqual({ type: NEW, data: { mode: "outline" } });
    expect(out.nodes[1]!.overrides).toEqual([
      { component: NEW, field: "isTrigger", value: true },
      { component: NEW, index: 0, enabled: false },
      { order: [NEW, "engine.Transform"] },
      { addNodes: [{ id: "extra", name: "Extra", components: [{ type: NEW, data: { mode: "outline" } }] }] },
    ]);
    expect(out.nodes[2]!.overrides).toEqual([{ removeComponent: NEW }]);
  });
});
