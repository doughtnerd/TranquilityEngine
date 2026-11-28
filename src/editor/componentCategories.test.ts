import { describe, expect, it } from "vitest";
import { Component, component } from "../engine";
import { runtimeActivator, type RuntimePlugin } from "../plugins/runtimeContext";
import { componentCatalog } from "./componentEdits";
import { buildMenuTree } from "./componentCategories";

@component("test.Wobble")
class Wobble extends Component {}
@component("acme.Gizmo")
class Gizmo extends Component {}
@component("acme.Plain")
class Plain extends Component {}
@component("acme.Odd")
class Odd extends Component {}

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

  it("puts a plugin's Components where its manifest says, a new label after the engine's, before Other", () => {
    const plugin: RuntimePlugin = {
      manifest: { name: "test.categories", version: "1.0.0", componentCategories: { Rendering: ["test.Wobble"], Gadgets: ["acme.Gizmo"] } },
      activate: (ctx) => ctx.registerComponents([Wobble, Gizmo, Plain]),
    };
    runtimeActivator.activate(plugin);
    try {
      const items = [
        { id: "engine.Camera", name: "Camera", group: "Engine" as const },
        { id: "engine.SomethingNew", name: "SomethingNew", group: "Engine" as const },
        { id: "test.Wobble", name: "Wobble", group: "Scripts" as const },
        { id: "acme.Gizmo", name: "Gizmo", group: "Scripts" as const },
        { id: "acme.Plain", name: "Plain", group: "Scripts" as const },
      ];
      const tree = buildMenuTree(items, new Map());
      expect(tree.map((n) => [n.label, n.items.map((i) => i.name)])).toEqual([
        ["Rendering", ["Camera", "Wobble"]],
        ["Gadgets", ["Gizmo"]],
        ["Other", ["SomethingNew"]],
        ["Scripts", ["Plain"]],
      ]);
    } finally {
      runtimeActivator.deactivate("test.categories");
    }
  });

  it("joins a declared label that names a fixed submenu (Other) instead of making a second one", () => {
    const plugin: RuntimePlugin = { manifest: { name: "test.fixedLabel", version: "1.0.0", componentCategories: { Other: ["acme.Odd"] } }, activate: (ctx) => ctx.registerComponents([Odd]) };
    runtimeActivator.activate(plugin);
    try {
      const items = [
        { id: "engine.SomethingNew", name: "SomethingNew", group: "Engine" as const },
        { id: "acme.Odd", name: "Odd", group: "Scripts" as const },
      ];
      expect(buildMenuTree(items, new Map()).map((n) => [n.label, n.items.map((i) => i.name)])).toEqual([["Other", ["SomethingNew", "Odd"]]]);
    } finally {
      runtimeActivator.deactivate("test.fixedLabel");
    }
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
