import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../engine";
import { SceneDocument } from "./document";
import { filterHierarchy } from "./hierarchyFilter";

const F = "myco.scene@4";
const prefab = {
  format: F,
  nodes: [
    { id: "root", name: "Root", components: [{ type: "engine.Transform" }, { type: "game.Mover" }] },
    { id: "kid", name: "Kid", parent: "root", components: [{ type: "game.Kid" }] },
  ],
};

beforeEach(() => Assets.addSource(Assets.fromObject({ "prefabs/p.prefab.json": prefab })));
afterEach(() => Assets.clearSources());

const scene = (overrides: object[]) =>
  new SceneDocument({ format: F, nodes: [{ id: "plain", name: "Plain", components: [{ type: "game.Mover" }] }, { id: "inst", name: "Inst", prefab: "prefabs/p.prefab.json", overrides } as never] }, "scenes/s.scene.json");
const matches = (doc: SceneDocument, text: string) => [...(filterHierarchy(doc, text)?.matches ?? [])].sort();

describe("the hierarchy's type filter sees nodes as the game makes them (ADR 0280)", () => {
  it("matches a prefab instance's and its inner nodes' components, with added ones", () => {
    const doc = scene([{ target: ["kid"], addComponent: { type: "game.Extra" } }]);
    expect(matches(doc, "t:mover")).toEqual(["inst", "plain"]);
    expect(matches(doc, "t:extra")).toEqual(["inst/kid"]);
  });
  it("doesn't match a component an override removed", () => {
    expect(matches(scene([{ removeComponent: "game.Mover" }]), "t:mover")).toEqual(["plain"]);
    expect(matches(scene([{ target: ["kid"], removeComponent: "game.Kid" }]), "t:kid")).toEqual([]);
  });
  it("matches nodes an override added", () => {
    const doc = scene([{ target: ["kid"], addNodes: [{ id: "extra", name: "Extra", components: [{ type: "game.Added" }] }] }]);
    expect(matches(doc, "t:added")).toEqual(["inst/extra"]);
    expect(filterHierarchy(doc, "t:added")!.visible.has("inst/kid")).toBe(true);
  });
});
