import { describe, expect, it } from "vitest";
import { formatMaterial, materialGraph, parseMaterial, defaultMaterialSettings } from "../scene/material";
import { defaultShaderGraph, formatShaderGraph, parseShaderGraph, SHADER_GRAPH_FORMAT, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";
import { compileShaderGraph, convert, glslFloat, linearColor, shaderGraphListing } from "../render/shaderGraph/compile";
import { NODES, nodePorts } from "../render/shaderGraph/nodes";

const graph = (nodes: GraphNode[], edges: [string, string][], extra: Partial<ShaderGraph> = {}): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [{ id: "output", type: "output", position: [0, 0] }, ...nodes],
  edges: edges.map(([from, to]) => ({ from, to })),
  ...extra,
});
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });

describe("shader graph files", () => {
  it("round-trips through the file format", () => {
    const g = graph([node("n1", "multiply", { inputs: { b: 2 } }), node("n2", "property", { settings: { property: "Tint" } })], [["n2.out", "n1.a"], ["n1.out", "output.baseColor"]], {
      properties: [{ name: "Tint", type: "color", value: "#ff8800" }],
      target: "unlit",
    });
    const text = formatShaderGraph(g);
    expect(text).toContain('{ "id": "n1", "type": "multiply", "position": [0, 0], "inputs": { "b": 2 } }');
    const { graph: back, problems } = parseShaderGraph(JSON.parse(text));
    expect(problems).toEqual([]);
    expect(back).toEqual(g);
  });

  it("skips bad parts and keeps the rest", () => {
    const { graph: g, problems } = parseShaderGraph({
      format: SHADER_GRAPH_FORMAT,
      target: "toon",
      properties: [{ name: "A", type: "float", value: "x" }, { name: "A", type: "float" }, { type: "float" }],
      nodes: [node("a.b", "add"), node("n1", "add"), node("n1", "add")],
      edges: [{ from: "n1.out", to: "output.baseColor" }, { from: "n1.out", to: "output.baseColor" }, { from: "zz.out", to: "output.alpha" }],
    });
    expect(g.target).toBe("lit");
    expect(g.properties).toEqual([{ name: "A", type: "float", value: 0 }]);
    expect(g.nodes.map((n) => n.id)).toEqual(["output", "n1"]); // an output node is added
    expect(g.edges).toHaveLength(1);
    expect(problems.length).toBe(8);
  });

  it("refuses another format", () => {
    expect(() => parseShaderGraph({ format: "myco.material@1" })).toThrow(/unknown format/);
  });
});

describe("materials naming a shader graph", () => {
  it("reads and writes a graph shader and its property values", () => {
    const raw = { format: "myco.material@1", shader: "asset:shaders/water.shadergraph.json", properties: { Tint: "#ff0000", Speed: 2, Offset: [1, 2] } };
    const { settings, problems } = parseMaterial(raw);
    expect(problems).toEqual([]);
    expect(materialGraph(settings)).toBe("asset:shaders/water.shadergraph.json");
    expect(JSON.parse(formatMaterial(settings))).toEqual(raw);
    expect(materialGraph(defaultMaterialSettings())).toBeNull();
  });

  it("warns about a shader that isn't lit, unlit or a graph", () => {
    const { settings, problems } = parseMaterial({ format: "myco.material@1", shader: "water", properties: { A: {} } });
    expect(settings.shader).toBe("lit");
    expect(problems).toHaveLength(2);
  });
});

describe("compiling shader graphs to GLSL", () => {
  it("compiles the default graph to a white surface", () => {
    const c = compileShaderGraph(defaultShaderGraph());
    expect(c.problems).toEqual([]);
    expect(c.fragment.body).toContain("vec3 mOut_baseColor = vec3(1.0, 1.0, 1.0);");
    expect(c.fragment.body).toContain("float mOut_roughness = 0.5;");
    expect(c.vertex.offset).toBeNull();
    expect(c.fragment.normal).toBeNull();
    expect(c.fragment.alphaClip).toBeNull();
    expect(c.fragment.declarations).toContain("#define MYCO_LIT");
  });

  it("unlit graphs have no lit outputs", () => {
    const c = compileShaderGraph({ ...defaultShaderGraph(), target: "unlit" });
    expect([c.fragment.metalness, c.fragment.roughness, c.fragment.emission]).toEqual([null, null, null]);
    expect(c.fragment.declarations).not.toContain("MYCO_LIT");
  });

  it("emits nodes in dependency order, each once, with properties as uniforms", () => {
    const g = graph(
      [node("tint", "property", { settings: { property: "Tint" } }), node("t", "time"), node("m", "multiply"), node("s", "sine")],
      [["t.time", "s.in"], ["tint.out", "m.a"], ["s.out", "m.b"], ["m.out", "output.baseColor"], ["s.out", "output.alpha"]],
      { properties: [{ name: "Tint", type: "color", value: "#ff0000" }] },
    );
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    expect(c.uniforms).toEqual([{ name: "uP0_Tint", type: "vec4", property: "Tint", propertyType: "color", value: "#ff0000" }]);
    const body = c.fragment.body.split("\n");
    const at = (prefix: string) => body.findIndex((l) => l.startsWith(prefix));
    expect(at("float m2_time")).toBeLessThan(at("float m4_out = sin(m2_time)"));
    expect(at("vec4 m1_out = uP0_Tint;")).toBeGreaterThanOrEqual(0);
    expect(at("float m4_out")).toBeLessThan(at("vec4 m3_out = (m1_out * vec4(m4_out))"));
    expect(body.filter((l) => l.startsWith("float m4_out"))).toHaveLength(1); // used twice, computed once
    expect(c.fragment.body).toContain("vec3 mOut_baseColor = m3_out.xyz;");
    expect(c.dynamicTypes.m).toBe("vec4");
    expect(c.portTypes["m.out"]).toBe("vec4");
    expect(c.fragment.declarations).toContain("uniform vec4 uP0_Tint;");
  });

  it("resolves dynamic types from inline vectors", () => {
    const c = compileShaderGraph(graph([node("a", "add", { inputs: { a: [1, 0, 0], b: 0.5 } })], [["a.out", "output.baseColor"]]));
    expect(c.fragment.body).toContain("vec3 m1_out = (vec3(1.0, 0.0, 0.0) + vec3(0.5));");
  });

  it("converts between vector sizes", () => {
    expect(convert("v", "float", "vec3")).toBe("vec3(v)");
    expect(convert("v", "vec4", "vec2")).toBe("v.xy");
    expect(convert("v", "vec3", "float")).toBe("v.x");
    expect(convert("v", "vec3", "vec4")).toBe("vec4(v, 1.0)");
    expect(convert("v", "vec2", "vec4")).toBe("vec4(v, 0.0, 1.0)");
    expect(convert("v", "vec2", "vec3")).toBe("vec3(v, 0.0)");
    expect(glslFloat(2)).toBe("2.0");
    expect(glslFloat(-0.25)).toBe("-0.25");
    expect(glslFloat(1e-7)).toBe("1e-7");
  });

  it("colour inputs are sRGB inline and linear in the shader", () => {
    const c = compileShaderGraph(graph([], [], { nodes: [{ id: "output", type: "output", position: [0, 0], inputs: { baseColor: [1, 0.5, 0] } }] }));
    const lin = linearColor("#ff8000")[1];
    expect(c.fragment.body).toMatch(/vec3 mOut_baseColor = vec3\(1\.0, 0\.21\d*, 0\.0\);/);
    expect(lin).toBeCloseTo(0.2158, 3);
  });

  it("reports loops and unknown nodes and uses defaults", () => {
    const c = compileShaderGraph(graph([node("a", "add"), node("b", "add"), node("x", "wobble")], [["a.out", "b.a"], ["b.out", "a.a"], ["a.out", "output.alpha"], ["x.out", "output.roughness"]]));
    expect(c.nodeProblems.a.join()).toMatch(/loop/);
    expect(c.problems.join("\n")).toMatch(/connection x\.out → output\.roughness goes to a port that isn't there/);
    expect(c.fragment.body).toContain("float mOut_roughness = 0.5;");
  });

  it("refuses textures into number ports", () => {
    const c = compileShaderGraph(graph([node("t", "property", { settings: { property: "Tex" } })], [["t.out", "output.alpha"]], { properties: [{ name: "Tex", type: "texture", value: "" }] }));
    expect(c.nodeProblems.output.join()).toMatch(/can't take a texture/);
  });

  it("samples textures through uniforms, sharing one per path", () => {
    const g = graph(
      [node("s1", "sampleTexture", { settings: { texture: "asset:images/a.png" } }), node("s2", "sampleTexture", { settings: { texture: "asset:images/a.png" } }), node("m", "multiply")],
      [["s1.rgb", "m.a"], ["s2.rgb", "m.b"], ["m.out", "output.baseColor"]],
    );
    const c = compileShaderGraph(g);
    expect(c.uniforms).toEqual([{ name: "uTex0", type: "sampler2D", value: "asset:images/a.png" }]);
    expect(c.fragment.body).toContain("vec3 m1_rgb = texture(uTex0, vMycoUv).rgb;");
  });

  it("computes the vertex offset in the vertex stage and refuses per-pixel nodes there", () => {
    const g = graph([node("n", "normal", { settings: { space: "object" } }), node("f", "fresnel"), node("m", "multiply", { inputs: { b: 0.1 } })], [["n.out", "m.a"], ["m.out", "output.vertexOffset"], ["f.out", "output.emission"]]);
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    expect(c.vertex.offset).toBe("mOut_vertexOffset");
    expect(c.vertex.body).toContain("vec3 m1_out = normalize(normal);");
    expect(c.fragment.body).toContain("mycoFaceNormal(vMycoWorldNormal)");
    const bad = compileShaderGraph(graph([node("f", "fresnel")], [["f.out", "output.vertexOffset"]]));
    expect(bad.nodeProblems.f.join()).toMatch(/can't feed Vertex Offset/);
  });

  it("adds a tangent frame only for a connected normal, and clipping only when set", () => {
    const g = graph([node("v", "vector3", { inputs: { z: 1 } })], [["v.out", "output.normal"]]);
    g.nodes[0].inputs = { alphaClip: 0.5 };
    const c = compileShaderGraph(g);
    expect(c.fragment.normal).toBe("mOut_normal");
    expect(c.fragment.declarations).toContain("mat3 mycoTangentFrame");
    expect(c.fragment.alphaClip).toBe("mOut_alphaClip");
    expect(shaderGraphListing(c)).toContain("if (diffuseColor.a < mOut_alphaClip) discard;");
  });

  it("changes the key only when the code changes", () => {
    const g = graph([node("p", "property", { settings: { property: "A" } })], [["p.out", "output.alpha"]], { properties: [{ name: "A", type: "float", value: 1 }] });
    const k = compileShaderGraph(g).key;
    expect(compileShaderGraph({ ...g, properties: [{ name: "A", type: "float", value: 2 }] }).key).toBe(k);
    expect(compileShaderGraph({ ...g, target: "unlit" }).key).not.toBe(k);
  });

  it("compiles every node type without problems", () => {
    for (const def of NODES) {
      if (def.type === "output" || def.type === "subgraph" || def.type === "customFunction") continue; // they need files or code of their own (tested below)
      const n = node("n", def.type, def.type === "property" ? { settings: { property: "P" } } : {});
      const g = graph([n], [], { properties: [{ name: "P", type: "vector3", value: [1, 2, 3] }] });
      const out = nodePorts(n, g).outputs.find((p) => p.type !== "texture");
      if (!out) continue; // texture-only nodes (Texture 2D Asset) are tested with Sample Texture 2D
      g.edges.push({ from: `n.${out.id}`, to: "output.baseColor" });
      const c = compileShaderGraph(g);
      expect(c.problems, def.type).toEqual([]);
      expect(c.fragment.body, def.type).toContain("m1_");
    }
  });
});
