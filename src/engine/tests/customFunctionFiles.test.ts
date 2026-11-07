import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import { parseShaderGraph, shaderGraphJSON, type ShaderGraph } from "../scene/shaderGraph";

const graph = (file: string | undefined, wgsl?: string): ShaderGraph => {
  const { graph: g } = parseShaderGraph({
    format: "myco.shadergraph@1",
    nodes: [
      { id: "output", type: "output" },
      { id: "f", type: "customFunction", function: { name: "wave", inputs: [{ name: "x", type: "float" }], outputs: [{ name: "y", type: "float" }], ...(file ? { file } : {}), ...(wgsl ? { wgsl } : {}) } },
    ],
    edges: [{ from: "f.y", to: "output.baseColor" }],
  });
  return g;
};
const useAssets = (files: Record<string, unknown>) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
};
afterEach(() => Assets.clearSources());

describe("Custom Function body files", () => {
  it("compiles the file's body, wins over inline, and lists the file as a dependency", () => {
    useAssets({ "shaders/wave.wgsl": "  y = sin(x) * 0.5;" });
    const c = compileShaderGraph(graph("asset:shaders/wave.wgsl", "  y = 1.0;"));
    expect(c.problems).toEqual([]);
    const text = JSON.stringify(c);
    expect(text).toContain("y = sin(x) * 0.5;");
    expect(text).not.toContain("y = 1.0;");
    expect(c.dependencies).toEqual(["shaders/wave.wgsl"]);
  });

  it("reports a missing file and falls back to zero outputs", () => {
    useAssets({});
    const c = compileShaderGraph(graph("asset:shaders/none.wgsl"));
    expect(c.problems.some((p) => p.includes("none.wgsl"))).toBe(true);
    expect(c.dependencies).toEqual(["shaders/none.wgsl"]);
  });

  it("round-trips the file field and ignores a non-string", () => {
    const g = graph("asset:shaders/wave.wgsl");
    const again = parseShaderGraph(JSON.parse(JSON.stringify(shaderGraphJSON(g)))).graph;
    expect(again.nodes.find((n) => n.id === "f")!.function!.file).toBe("asset:shaders/wave.wgsl");
    const bad = parseShaderGraph({ format: "myco.shadergraph@1", nodes: [{ id: "f", type: "customFunction", function: { name: "w", file: 3 } }] });
    expect(bad.graph.nodes.find((n) => n.id === "f")!.function!.file).toBeUndefined();
    expect(bad.problems.length).toBeGreaterThan(0);
  });
});
