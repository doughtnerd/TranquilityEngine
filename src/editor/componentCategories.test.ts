import { describe, expect, it } from "vitest";
import "../engine";
import { componentCatalog } from "./componentEdits";
import { buildMenuTree } from "./componentCategories";

/** The Add Component submenu an engine component id lands in. */
const categoryOf = (id: string) => buildMenuTree([{ id, name: id, group: "Engine" as const }], new Map())[0]!.label;

describe("Add Component categories", () => {
  it("puts every registered engine component in a real category, not Other", () => {
    const engine = componentCatalog().filter((t) => t.group === "Engine");
    expect(engine.length).toBeGreaterThan(10);
    expect(engine.filter((t) => categoryOf(t.id) === "Other").map((t) => t.id)).toEqual([]);
    expect(categoryOf("engine.NavAgent")).toBe("Navigation");
    expect(categoryOf("engine.SomethingNew")).toBe("Other");
  });

  it("groups scripts by folder and data components in one Data submenu", () => {
    const scripts = new Map([
      ["scripts/behaviors/enemies/Grunt.ts", `@behavior("game.Grunt")`],
      ["scripts/behaviors/Bird.ts", `@behavior("game.Bird")`],
      ["scripts/data.ts", `defineComponent("game.Scroller", {})`],
    ]);
    const items = [
      { id: "engine.Camera", name: "Camera", group: "Engine" as const },
      { id: "game.Grunt", name: "Grunt", group: "Scripts" as const },
      { id: "game.Bird", name: "Bird", group: "Scripts" as const },
      { id: "game.Scroller", name: "Scroller", group: "Data" as const },
    ];
    const tree = buildMenuTree(items, scripts);
    expect(tree.map((n) => n.label)).toEqual(["Rendering", "Scripts", "Data"]);
    const behaviors = tree[1]!.children[0]!;
    expect(behaviors.path).toEqual(["Scripts", "behaviors"]);
    expect(behaviors.items.map((i) => i.name)).toEqual(["Bird"]);
    expect(behaviors.children[0]!.items.map((i) => i.name)).toEqual(["Grunt"]);
  });
});
