// Find in a shader graph (ADR 0117) as the panel runs it: the graph's find items through the graph
// layer's matcher, with the graph document's notes and groups (ADR 0259).
import { describe, expect, it } from "vitest";
import { defaultShaderGraph, type ShaderGraph } from "../../../../engine/scene/shaderGraph";
import { findInGraph } from "../../../../editor/sdk";
import { shaderGraphEdits } from "./graphEdit";
import { shaderFindItems } from "./graphSearch";

const graph = (): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [
    { id: "output", type: "output", position: [0, 0] },
    { id: "a", type: "multiply", position: [0, 0] },
    { id: "b", type: "property", position: [0, 0], settings: { property: "Tint Colour" } },
    { id: "c", type: "add", position: [0, 0] },
    { id: "f", type: "customFunction", position: [0, 0], function: { name: "ripple", inputs: [], outputs: [] } },
  ],
  notes: [{ id: "n1", position: [0, 0], size: [100, 50], text: "Rim light\nfalloff tweak" }],
  groups: [{ id: "g1", title: "Fresnel stuff", nodes: ["a", "c"] }],
});

const find = (g: ShaderGraph, query: string) => findInGraph(shaderFindItems(g), shaderGraphEdits.notes(g), shaderGraphEdits.groups(g), query);

describe("find in a shader graph", () => {
  it("matches node types and titles case-insensitively", () => {
    expect(find(graph(), "MULT").map((x) => x.id)).toEqual(["a"]);
  });
  it("matches property names, shown by the property node's title", () => {
    const m = find(graph(), "tint");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "node", id: "b", label: "Tint Colour", frame: ["b"] });
  });
  it("matches a Custom Function's name", () => {
    expect(find(graph(), "ripple").map((x) => x.id)).toEqual(["f"]);
  });
  it("matches note text and group titles, framing a group's members", () => {
    expect(find(graph(), "falloff")[0]).toMatchObject({ kind: "note", id: "n1", label: "Rim light" });
    expect(find(graph(), "fresnel")[0]).toMatchObject({ kind: "group", id: "g1", frame: ["a", "c"] });
  });
});
