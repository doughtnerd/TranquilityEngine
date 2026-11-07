import { describe, expect, it } from "vitest";
import { defaultShaderGraph, type ShaderGraph } from "../../engine/scene/shaderGraph";
import { cycleIndex, searchGraph } from "./graphSearch";

const graph = (): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [
    { id: "output", type: "output", position: [0, 0] },
    { id: "a", type: "multiply", position: [0, 0] },
    { id: "b", type: "property", position: [0, 0], settings: { property: "Tint Colour" } },
    { id: "c", type: "add", position: [0, 0] },
  ],
  notes: [{ id: "n1", position: [0, 0], size: [100, 50], text: "Rim light\nfalloff tweak" }],
  groups: [{ id: "g1", title: "Fresnel stuff", nodes: ["a", "c"] }],
});

describe("searchGraph", () => {
  it("matches nothing for an empty query", () => {
    expect(searchGraph(graph(), "  ")).toEqual([]);
  });
  it("matches node types and titles case-insensitively", () => {
    const m = searchGraph(graph(), "MULT");
    expect(m.map((x) => x.id)).toEqual(["a"]);
  });
  it("matches property names", () => {
    const m = searchGraph(graph(), "tint");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "node", id: "b", label: "Tint Colour", frame: ["b"] });
  });
  it("matches note text and group titles, framing a group's members", () => {
    expect(searchGraph(graph(), "falloff")[0]).toMatchObject({ kind: "note", id: "n1", label: "Rim light" });
    expect(searchGraph(graph(), "fresnel")[0]).toMatchObject({ kind: "group", id: "g1", frame: ["a", "c"] });
  });
  it("needs every word to match", () => {
    expect(searchGraph(graph(), "tint colour")).toHaveLength(1);
    expect(searchGraph(graph(), "tint nothing")).toHaveLength(0);
  });
});

describe("cycleIndex", () => {
  it("wraps both ways and starts from the ends", () => {
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });
});
