import { describe, expect, it } from "vitest";
import { defaultShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import type { ShaderLevel } from "../core/graphics";

const graph = (nodes: GraphNode[], edges: [string, string][], extra: Partial<ShaderGraph> = {}): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [{ id: "output", type: "output", position: [0, 0] }, ...nodes],
  edges: edges.map(([from, to]) => ({ from, to })),
  ...extra,
});
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });

const LEVELS: ShaderLevel[] = ["low", "medium", "high"];

/** Low <- Float 1, Medium <- Sine(Float 2), High <- Gradient Noise. */
const branchGraph = (highVec3 = false) =>
  graph(
    [
      node("lowv", "float", { inputs: { x: 1 } }),
      node("two", "float", { inputs: { x: 2 } }),
      node("sin", "sine"),
      node("noise", "gradientNoise"),
      ...(highVec3 ? [node("v3", "vector3")] : []),
      node("qb", "qualityBranch"),
    ],
    [
      ["lowv.out", "qb.low"],
      ["two.out", "sin.in"],
      ["sin.out", "qb.medium"],
      [highVec3 ? "v3.out" : "noise.out", "qb.high"],
      ["qb.out", "output.baseColor"],
    ],
  );

describe("Quality Branch", () => {
  it("picks the input for each shader level", () => {
    const low = compileShaderGraph(branchGraph(), { shaderLevel: "low" });
    const medium = compileShaderGraph(branchGraph(), { shaderLevel: "medium" });
    const high = compileShaderGraph(branchGraph(), { shaderLevel: "high" });
    for (const c of [low, medium, high]) expect(c.problems).toEqual([]);
    expect(low.fragment.body).toContain("= 1.0;");
    expect(low.fragment.body).not.toContain("sin(");
    expect(medium.fragment.body).toContain("sin(");
    expect(medium.fragment.body).not.toContain("mycoGradientNoise");
    expect(high.fragment.body).toContain("mycoGradientNoise(");
    expect(high.fragment.body).not.toContain("sin(");
  });

  it("does not compute or declare the unchosen branches", () => {
    const low = compileShaderGraph(branchGraph(), { shaderLevel: "low" });
    expect(low.fragment.body).not.toContain("mycoGradientNoise");
    expect(low.fragment.declarations).not.toContain("mycoGradientNoise");
    expect(low.fragment.declarations).not.toContain("mycoGradientDir");
    const high = compileShaderGraph(branchGraph(), { shaderLevel: "high" });
    expect(high.fragment.declarations).toContain("mycoGradientNoise");
  });

  it("reports usesShaderLevel and keys differ per level", () => {
    const keys = LEVELS.map((l) => {
      const c = compileShaderGraph(branchGraph(), { shaderLevel: l });
      expect(c.usesShaderLevel).toBe(true);
      return c.key;
    });
    expect(new Set(keys).size).toBe(3);
  });

  it("leaves a graph without the node unchanged by level", () => {
    const g = graph([node("n", "float", { inputs: { x: 0.5 } })], [["n.out", "output.baseColor"]]);
    const keys = LEVELS.map((l) => {
      const c = compileShaderGraph(g, { shaderLevel: l });
      expect(c.usesShaderLevel).toBe(false);
      return c.key;
    });
    expect(new Set(keys).size).toBe(1);
  });

  it("resolves the output type to the widest input at every level", () => {
    for (const l of LEVELS) {
      const c = compileShaderGraph(branchGraph(true), { shaderLevel: l });
      expect(c.problems).toEqual([]);
      expect(c.portTypes["qb.out"]).toBe("vec3");
      expect(c.dynamicTypes["qb"]).toBe("vec3");
      expect(c.fragment.body).toMatch(/var m\w+: vec3f/);
    }
    const low = compileShaderGraph(branchGraph(true), { shaderLevel: "low" });
    expect(low.fragment.body).toContain("var m6_out: vec3f = vec3f(m1_out);");
  });

  it("defaults to the high level", () => {
    const d = compileShaderGraph(branchGraph());
    const h = compileShaderGraph(branchGraph(), { shaderLevel: "high" });
    expect(d.key).toBe(h.key);
    expect(d.fragment.body).toContain("mycoGradientNoise(");
  });
});
