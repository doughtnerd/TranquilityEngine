import { afterEach, describe, expect, it } from "vitest";
import { nodeCreateTree } from "./createMenuTree";
import type { MenuEntry } from "./menuBar";
import { hierarchyCreateEntries, type HierarchyCreateContribution } from "./sdk/contributions";

/** The tree as text: "-" a separator, "Category: a, b" a submenu. */
const shape = (entries: readonly MenuEntry[]) => entries.map((e) => (e.separator ? "-" : e.submenu ? `${e.label}: ${e.submenu.map((i) => i.label).join(", ")}` : e.label));
const tree = () => shape(nodeCreateTree((_, label) => ({ label })));

const entry = (id: string, more: Partial<HierarchyCreateContribution> = {}): HierarchyCreateContribution => ({ id, label: id, name: id, components: () => [], ...more });

let undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo) u();
  undo = [];
});

describe("the node Create tree (ADR 0383)", () => {
  it("is Empty and Camera, then a sorted submenu per category with its kinds sorted", () => {
    expect(tree()).toEqual([
      "Empty",
      "Camera",
      "-",
      "2D: Sprite",
      "3D Object: Capsule, Cube, Cylinder, Plane, Sphere",
      "Effects: Fog, Water",
      "Light: Ambient Light, Directional Light, Point Light, Reflection Probe, Spot Light",
      "UI: UI View",
    ]);
  });

  it("puts a plugin's entry in the category it names, else its `after` entry's, else Other", () => {
    undo.push(hierarchyCreateEntries.register(entry("Boids", { category: "Effects" })));
    undo.push(hierarchyCreateEntries.register(entry("Tile", { after: "sprite" })));
    undo.push(hierarchyCreateEntries.register(entry("Gadget")));
    undo.push(hierarchyCreateEntries.register(entry("Vehicle", { category: "Vehicles" })));
    const t = tree();
    expect(t).toContain("2D: Sprite, Tile");
    expect(t).toContain("Effects: Boids, Fog, Water");
    expect(t.slice(-2)).toEqual(["Vehicles: Vehicle", "Other: Gadget"]);
  });

  it("makes each kind's entry with the label it shows", () => {
    const made: string[] = [];
    nodeCreateTree((k, label) => (made.push(`${k.kind}=${label}`), { label }));
    expect(made).toContain("ui-view=UI View");
    expect(made).toContain("directional-light=Directional Light");
  });
});
