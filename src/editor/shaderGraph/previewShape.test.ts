import { describe, expect, it } from "vitest";
import { defaultShaderGraph, formatShaderGraph, nodePreviewShape, parseShaderGraph } from "../../engine/scene/shaderGraph";
import { setGraphPreviewShape, setNodePreviewShape } from "./graphEdit";

describe("node preview shapes (ADR 0117)", () => {
  const base = () => ({ ...defaultShaderGraph(), nodes: [{ id: "output", type: "output", position: [0, 0] as [number, number] }, { id: "a", type: "add", position: [0, 0] as [number, number] }] });
  it("falls back from the node to the graph default to a quad", () => {
    let g = base();
    expect(nodePreviewShape(g, g.nodes[1]!)).toBe("quad");
    g = setGraphPreviewShape(g, "sphere");
    expect(nodePreviewShape(g, g.nodes[1]!)).toBe("sphere");
    g = setNodePreviewShape(g, "a", "cube");
    expect(nodePreviewShape(g, g.nodes[1]!)).toBe("cube");
    g = setNodePreviewShape(g, "a", null);
    expect(nodePreviewShape(g, g.nodes[1]!)).toBe("sphere");
  });
  it("round-trips through the file and leaves quads unwritten", () => {
    let g = setNodePreviewShape(setGraphPreviewShape(base(), "cube"), "a", "quad");
    const back = parseShaderGraph(JSON.parse(formatShaderGraph(g))).graph;
    expect(back.previewShape).toBe("cube");
    expect(back.nodes[1]!.previewShape).toBe("quad");
    expect(formatShaderGraph(setGraphPreviewShape(g, "quad"))).not.toContain('"previewShape": "cube"');
    expect(parseShaderGraph({ format: "myco.shadergraph@1", previewShape: "bogus" }).graph.previewShape).toBeUndefined();
  });
});
