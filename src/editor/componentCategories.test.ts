import { describe, expect, it } from "vitest";
import "../engine";
import { componentCatalog } from "../engine/editor";
import { buildMenuTree, engineCategory, knownEngineCategory, scriptFolders } from "./componentCategories";

describe("Add Component categories", () => {
  it("puts every registered engine component in a real category, not Other", () => {
    const engine = componentCatalog().filter((t) => t.group === "Engine");
    expect(engine.length).toBeGreaterThan(10);
    expect(engine.filter((t) => knownEngineCategory(t.id) === null).map((t) => t.id)).toEqual([]);
    expect(engineCategory("engine.NavAgent")).toBe("Navigation");
    expect(engineCategory("engine.SomethingNew")).toBe("Other");
  });

  it("groups scripts by folder and data components in one Data submenu", () => {
    const scripts = new Map([
      ["scripts/behaviors/enemies/Grunt.ts", `@behavior("game.Grunt")`],
      ["scripts/behaviors/Bird.ts", `@behavior("game.Bird")`],
      ["scripts/data.ts", `defineComponent("game.Scroller", {})`],
    ]);
    expect(scriptFolders(["game.Grunt", "game.Bird"], scripts).get("game.Grunt")).toEqual(["behaviors", "enemies"]);
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
