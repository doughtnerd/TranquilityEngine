// ADR 0464: one layer table maps physics layers to collision groups.
import { describe, expect, it } from "vitest";
import { MAX_PHYSICS_LAYERS } from "../core/settings";
import { filterOf, layerTable } from "../physics/layers";

/** Whether a collider with groups `a` and one with `b` interact (both ways, as Rapier tests them). */
const interact = (a: number, b: number) => ((a >>> 16) & filterOf(b)) !== 0 && ((b >>> 16) & filterOf(a)) !== 0;

describe("layerTable", () => {
  it("every layer collides with every layer without a matrix; the matrix is symmetric", () => {
    const open = layerTable({ layers: ["A", "B"] });
    expect(interact(open.groupsOf("A"), open.groupsOf("B"))).toBe(true);
    const t = layerTable({ layers: ["A", "B", "C"], collisionMatrix: { A: ["B"] } });
    expect(interact(t.groupsOf("A"), t.groupsOf("B"))).toBe(true);
    expect(interact(t.groupsOf("B"), t.groupsOf("A"))).toBe(true);
    expect(interact(t.groupsOf("A"), t.groupsOf("C"))).toBe(false);
    expect(interact(t.groupsOf("A"), t.groupsOf("A"))).toBe(false);
  });

  it("a repeated name is the first layer of that name, for its bit and its filter", () => {
    const t = layerTable({ layers: ["Default", "Enemy", "Enemy", "Wall"], collisionMatrix: { Enemy: ["Wall"] } });
    expect(t.indexOf("Enemy")).toBe(1);
    expect(t.groupsOf("Enemy") >>> 16).toBe(1 << 1);
    expect(interact(t.groupsOf("Enemy"), t.groupsOf("Wall"))).toBe(true);
    expect(filterOf(t.queryGroups(["Enemy"])!)).toBe(1 << 1);
  });

  it("a query with an unknown layer leaves it out and warns; only unknown layers match nothing", () => {
    const warnings: string[] = [];
    const t = layerTable({ layers: ["Default", "Walls"] }, (key) => warnings.push(key));
    expect(t.queryGroups(undefined)).toBeUndefined();
    expect(t.queryGroups(null)).toBeUndefined();
    expect(t.queryGroups([])).toBeUndefined();
    const none = t.queryGroups(["Nope"])!;
    expect(filterOf(none)).toBe(0);
    expect(interact(none, t.groupsOf("Default"))).toBe(false);
    expect(warnings).toEqual(["query-layer:Nope"]);
    const walls = t.queryGroups(["Nope", "Walls"])!;
    expect(interact(walls, t.groupsOf("Walls"))).toBe(true);
    expect(interact(walls, t.groupsOf("Default"))).toBe(false);
  });

  it("a collider on an unknown layer warns and uses the first layer", () => {
    const warnings: string[] = [];
    const t = layerTable({ layers: ["Default", "Walls"] }, (key, message) => warnings.push(`${key}|${message}`));
    expect(t.groupsOf("Nope")).toBe(t.groupsOf("Default"));
    expect(warnings).toEqual(['layer:Nope|unknown physics layer "Nope"; using "Default".']);
  });

  it("refuses more than MAX_PHYSICS_LAYERS layers and a matrix naming an unknown layer", () => {
    const max = Array.from({ length: MAX_PHYSICS_LAYERS }, (_, i) => `L${i}`);
    expect(layerTable({ layers: max }).indexOf(`L${MAX_PHYSICS_LAYERS - 1}`)).toBe(MAX_PHYSICS_LAYERS - 1);
    expect(() => layerTable({ layers: [...max, "extra"] })).toThrow(/at most/i);
    expect(() => layerTable({ layers: ["A"], collisionMatrix: { A: ["Z"] } })).toThrow(/unknown layer "Z"/);
  });
});
