// ADR 0452: animation binding paths (node paths and field paths) through the module's interface.
import { describe, expect, it } from "vitest";
import { fieldPathValue, nodePathOf, parseFieldPath, resolveNodePath, trackBinding } from "./bindingPath";
import type { Track } from "./tracks";

interface N {
  name: string;
  parent: N | null;
  children: N[];
}
const node = (name: string, ...children: N[]): N => {
  const n: N = { name, parent: null, children };
  for (const c of children) c.parent = n;
  return n;
};

describe("node paths", () => {
  const trail = node("Trail");
  const first = node("Twin", trail);
  const second = node("Twin");
  const hero = node("Hero", first, second);
  const root = node("Root", hero, node("Lamp"));

  it("resolve by child names, \"\" and empty parts being the root, the first of same-named siblings taken", () => {
    expect(resolveNodePath(root, "")).toBe(root);
    expect(resolveNodePath(root, "Hero//Twin/Trail")).toBe(trail);
    expect(resolveNodePath(root, "Hero/Twin")).toBe(first);
    expect(resolveNodePath(root, "Hero/Nope")).toBeNull();
  });

  it("report every step taken, the missing one with no child", () => {
    const steps: string[] = [];
    resolveNodePath(root, "Hero/Nope/Deeper", (parent, part, child) => steps.push(`${parent.name}>${part}=${child?.name ?? "-"}`));
    expect(steps).toEqual(["Root>Hero=Hero", "Hero>Nope=-"]);
  });

  it("are written back relative to the root, null outside it", () => {
    expect(nodePathOf(root, trail)).toBe("Hero/Twin/Trail");
    expect(nodePathOf(root, root)).toBe("");
    expect(nodePathOf(hero, root)).toBeNull();
    expect(resolveNodePath(root, nodePathOf(root, trail)!)).toBe(trail);
  });
});

describe("field paths", () => {
  it("split into the declared field and a sub-path", () => {
    expect(parseFieldPath("intensity")).toEqual({ head: "intensity", sub: [] });
    expect(parseFieldPath("drive.target.x")).toEqual({ head: "drive", sub: ["target", "x"] });
  });

  it("name a renderer's material property, with or without a slot", () => {
    expect(parseFieldPath("material.color").material).toEqual({ name: "color" });
    expect(parseFieldPath("materials[2].roughness").material).toEqual({ name: "roughness", slot: 2 });
    expect(parseFieldPath("materials[2]").material).toBeUndefined();
    expect(parseFieldPath("materialx.color").material).toBeUndefined();
  });

  it("reach a value inside the field's value", () => {
    const drive = { target: { x: 1, y: 2 } };
    expect(fieldPathValue(drive, "drive")).toBe(drive);
    expect(fieldPathValue(drive, "drive.target")).toEqual({ x: 1, y: 2 });
    expect(fieldPathValue(drive, "drive.target.y")).toBe(2);
    expect(fieldPathValue(drive, "drive.nope.y")).toBeUndefined();
    expect(fieldPathValue(3, "speed.x")).toBeUndefined();
  });
});

describe("which tracks bind a field", () => {
  const target = { nodePath: "Lamp", component: "engine.Light", field: "intensity" };
  it("property kinds with a component do; bones, morphs, keyed kinds and unbound targets don't", () => {
    expect(trackBinding({ kind: "float", target, name: "", curves: [] } as unknown as Track)).toEqual(target);
    expect(trackBinding({ kind: "discrete", target, valueType: "bool", keys: [] } as unknown as Track)).toEqual(target);
    expect(trackBinding({ kind: "float", target: { ...target, component: "" }, name: "", curves: [] } as unknown as Track)).toBeNull();
    expect(trackBinding({ kind: "morph", target: { nodePath: "Face", component: "engine.SkinnedMeshRenderer", field: "0" }, name: "", curves: [] } as unknown as Track)).toBeNull();
    expect(trackBinding({ kind: "activation", target, keys: [] } as unknown as Track)).toBeNull();
    expect(trackBinding({ kind: "bone", bone: "Hips", translation: [], rotation: [], scale: [] } as unknown as Track)).toBeNull();
  });
});
