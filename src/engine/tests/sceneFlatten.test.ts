import { describe, expect, it } from "vitest";
import { flattenSceneNodes } from "../render/sceneFlatten";

const files: Record<string, unknown> = {
  "scene.json": {
    nodes: [
      { id: "cam", components: [{ type: "engine.Camera", data: {} }] },
      { id: "a", prefab: "p.json" },
      { id: "b", prefab: "p.json", overrides: [{ component: "engine.Transform", field: "position", value: [5, 0, 0] }, { target: ["kid"], active: false }] },
      { id: "onB", parent: "b", components: [] },
      { id: "off", active: false, components: [] },
      { id: "offKid", parent: "off", components: [] },
      { id: "missing", prefab: "nope.json" },
    ],
  },
  "p.json": {
    nodes: [
      { id: "root", components: [{ type: "engine.Transform", data: { position: [1, 2, 3], scale: [1, 1, 1] } }] },
      { id: "kid", parent: "root", components: [] },
      { id: "deep", parent: "root", prefab: "q.json" },
    ],
  },
  "q.json": { nodes: [{ id: "leaf", components: [{ type: "engine.MeshRenderer" }] }] },
};
const read = (p: string) => files[p];

describe("flattenSceneNodes", () => {
  const nodes = flattenSceneNodes("scene.json", read);
  const ids = nodes.map((n) => n.id);
  it("expands prefab instances, nested ones too, under unique ids", () => {
    expect(ids).toContain("a/root");
    expect(ids).toContain("b/root");
    expect(nodes.find((n) => n.id === "a/deep/leaf")?.parent).toBe("a/root");
    expect(ids).not.toContain("missing");
  });
  it("points a node whose parent is an instance at the instance's root", () => {
    expect(nodes.find((n) => n.id === "onB")?.parent).toBe("b/root");
  });
  it("applies field overrides without touching the source file", () => {
    const t = (id: string) => nodes.find((n) => n.id === id)!.components[0]!.data as { position: number[]; scale: number[] };
    expect(t("b/root").position).toEqual([5, 0, 0]);
    expect(t("b/root").scale).toEqual([1, 1, 1]);
    expect(t("a/root").position).toEqual([1, 2, 3]);
  });
  it("leaves out inactive nodes and their children", () => {
    expect(ids).not.toContain("off");
    expect(ids).not.toContain("offKid");
    expect(ids).not.toContain("b/kid");
    expect(ids).toContain("a/kid");
  });
  it("survives a prefab that contains itself", () => {
    const loop = { nodes: [{ id: "r" }, { id: "again", parent: "r", prefab: "loop.json" }] };
    expect(flattenSceneNodes("loop.json", (p) => (p === "loop.json" ? loop : undefined)).length).toBeLessThan(20);
  });
});
