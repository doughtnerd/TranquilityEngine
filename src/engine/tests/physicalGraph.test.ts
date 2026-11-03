import { describe, expect, it } from "vitest";
import { defaultShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import { nodePorts } from "../render/shaderGraph/nodes";
import { createGraphMaterial, createSharedGraphUniforms, patchFragmentShader } from "../render/shaderGraph/threeMaterial";
import { ShaderLib } from "three";

const graph = (nodes: GraphNode[], edges: [string, string][], extra: Partial<ShaderGraph> = {}): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [{ id: "output", type: "output", position: [0, 0] }, ...nodes],
  edges: edges.map(([from, to]) => ({ from, to })),
  ...extra,
});
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });
const outputOf = (g: ShaderGraph): GraphNode => g.nodes.find((n) => n.type === "output")!;

describe("physical shader graphs", () => {
  it("compiles an unconnected physical graph with no physical features", () => {
    const c = compileShaderGraph({ ...defaultShaderGraph(), target: "physical" });
    expect(c.problems).toEqual([]);
    expect(c.fragment.physical).toEqual({});
  });

  it("leaves lit graphs without a physical part", () => {
    const c = compileShaderGraph(defaultShaderGraph());
    expect(c.fragment.physical).toBeNull();
  });

  it("offers the physical outputs only for the physical target", () => {
    const physical = graph([], [], { target: "physical" });
    expect(nodePorts(outputOf(physical), physical).inputs.map((p) => p.id)).toContain("clearcoat");
    const lit = graph([], []);
    expect(nodePorts(outputOf(lit), lit).inputs.map((p) => p.id)).not.toContain("clearcoat");
    const unlit = graph([], [], { target: "unlit" });
    expect(nodePorts(outputOf(unlit), unlit).inputs.map((p) => p.id)).not.toContain("transmission");
  });

  it("compiles a connected clearcoat with its roughness", () => {
    const g = graph([node("f", "float", { inputs: { x: 0.7 } })], [["f.out", "output.clearcoat"]], { target: "physical" });
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    expect(c.fragment.physical).toHaveProperty("clearcoat");
    expect(c.fragment.physical).toHaveProperty("clearcoatRoughness");
    expect(c.fragment.physical).not.toHaveProperty("transmission");
  });

  it("adds transmission and thickness when transmission is set inline", () => {
    const g = graph([], [], { target: "physical" });
    outputOf(g).inputs = { transmission: 0.5 };
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    expect(c.fragment.physical).toHaveProperty("transmission");
    expect(c.fragment.physical).toHaveProperty("thickness");
  });

  it("adds ior only when it differs from the default", () => {
    const atDefault = graph([], [], { target: "physical" });
    outputOf(atDefault).inputs = { ior: 1.5 };
    expect(compileShaderGraph(atDefault).fragment.physical).not.toHaveProperty("ior");

    const changed = graph([], [], { target: "physical" });
    outputOf(changed).inputs = { ior: 1.33 };
    expect(compileShaderGraph(changed).fragment.physical).toHaveProperty("ior");
  });
});

describe("patching and building physical materials", () => {
  const g = graph([node("f", "float", { inputs: { x: 0.4 } })], [["f.out", "output.clearcoat"]], { target: "physical" });
  outputOf(g).inputs = { sheenColor: [1, 0, 0], transmission: 0.5, iridescence: 0.3, ior: 1.33, specularIntensity: 0.8 };

  it("patches three.js's physical fragment shader with the graph's values", () => {
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    const fs = patchFragmentShader(ShaderLib.physical.fragmentShader, c);
    for (const s of [
      "material.clearcoat = saturate(",
      "material.sheenColor = ",
      "material.iridescence = saturate(",
      "material.ior = ",
      "material.specularF90 = mix(mycoSpecularIntensity",
      "material.transmission = saturate(",
      "material.thickness = max(",
    ]) expect(fs, s).toContain(s);
    expect(fs).not.toContain("#include <transmission_fragment>");
  });

  it("makes a MeshPhysicalMaterial with the features switched on", () => {
    const made = createGraphMaterial(compileShaderGraph(g), {}, createSharedGraphUniforms(), () => new Promise(() => {}));
    expect(made.material.type).toBe("MeshPhysicalMaterial");
    const m = made.material as unknown as Record<string, number>;
    expect(m.clearcoat).toBeGreaterThan(0);
    expect(m.sheen).toBeGreaterThan(0);
    expect(m.transmission).toBeGreaterThan(0);
    expect(m.iridescence).toBeGreaterThan(0);
    made.dispose();
  });

  it("leaves the features off when a physical graph uses none of them", () => {
    const made = createGraphMaterial(compileShaderGraph({ ...defaultShaderGraph(), target: "physical" }), {}, createSharedGraphUniforms(), () => new Promise(() => {}));
    expect(made.material.type).toBe("MeshPhysicalMaterial");
    const m = made.material as unknown as Record<string, number>;
    expect([m.clearcoat, m.sheen, m.transmission, m.iridescence]).toEqual([0, 0, 0, 0]);
    made.dispose();
  });
});
