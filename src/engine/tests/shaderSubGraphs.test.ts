import { afterEach, describe, expect, it } from "vitest";
import { Assets, Color, MeshRenderer } from "../index";
import { compileShaderGraph, nodePreviewGraph } from "../render/shaderGraph/compile";
import { nodePorts } from "../render/shaderGraph/nodes";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph, parseShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";

// Sub-graphs, custom functions, normal maps and node previews (ADR 0048), and per-renderer
// material properties (ADR 0049).

const graph = (nodes: GraphNode[], edges: [string, string][], extra: Partial<ShaderGraph> = {}): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [{ id: "output", type: "output", position: [0, 0] }, ...nodes],
  edges: edges.map(([from, to]) => ({ from, to })),
  ...extra,
});
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });

/** A sub-graph file: Out = Scale * 2. */
const subgraph = (extra: Partial<ShaderGraph> = {}): Record<string, unknown> =>
  JSON.parse(
    formatShaderGraph({
      ...defaultShaderSubGraph(),
      properties: [{ name: "Scale", type: "float", value: 4 }],
      nodes: [
        { id: "output", type: "output", position: [0, 0] },
        { id: "p", type: "property", position: [0, 0], settings: { property: "Scale" } },
        { id: "m", type: "multiply", position: [0, 0], inputs: { b: 2 } },
      ],
      edges: [
        { from: "p.out", to: "m.a" },
        { from: "m.out", to: "output.Out" },
      ],
      ...extra,
    }),
  );

const useAssets = (files: Record<string, unknown>) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
};
afterEach(() => Assets.clearSources());

describe("shader sub-graphs", () => {
  it("round-trip with functions, collapsed previews, groups and notes", () => {
    const g: ShaderGraph = {
      ...defaultShaderSubGraph(),
      nodes: [
        { id: "output", type: "output", position: [0, 0] },
        { id: "f", type: "customFunction", position: [1, 2], preview: false, function: { name: "wave", inputs: [{ name: "x", type: "float" }], outputs: [{ name: "y", type: "vec3" }], body: "y = vec3(sin(x));" } },
      ],
      groups: [{ id: "g1", title: "Waves", nodes: ["f"] }],
      notes: [{ id: "n1", position: [10, 20], size: [200, 80], text: "Hello" }],
    };
    const text = formatShaderGraph(g);
    expect(text).toContain('"format": "myco.shadersubgraph@1"');
    expect(text).not.toContain('"target"');
    const { graph: back, problems } = parseShaderGraph(JSON.parse(text));
    expect(problems).toEqual([]);
    expect(back).toEqual(g);
  });

  it("refuse bad function and output names", () => {
    const { graph: g, problems } = parseShaderGraph({
      format: "myco.shadersubgraph@1",
      outputs: [{ name: "a b", type: "vec3" }, { name: "Out", type: "texture" }],
      nodes: [{ id: "f", type: "customFunction", function: { name: "gl_x", body: "" } }],
    });
    expect(g.subgraph!.outputs).toEqual([{ name: "Out", type: "texture" }]); // texture outputs are allowed
    expect(g.nodes.find((n) => n.id === "f")!.function).toBeUndefined();
    expect(problems).toHaveLength(2);
  });

  it("expand inline, binding their properties to the node's inputs", () => {
    useAssets({ "shaders/double.shadersubgraph.json": subgraph() });
    const g = graph([node("s", "subgraph", { settings: { subgraph: "asset:shaders/double.shadersubgraph.json" }, inputs: { Scale: 3 } })], [["s.Out", "output.baseColor"]]);
    expect(nodePorts(g.nodes[1], g)).toMatchObject({ inputs: [{ id: "Scale", type: "float", default: 4 }], outputs: [{ id: "Out", type: "vec4" }] });
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    expect(c.dependencies).toEqual(["shaders/double.shadersubgraph.json"]);
    expect(c.fragment.body).toContain("var m1s1_out: f32 = 3.0;"); // the sub-graph's property node reads the input
    expect(c.fragment.body).toContain("var m1_Out: vec4f = vec4f(m1s2_out);");
    expect(c.uniforms).toEqual([]); // a sub-graph's properties aren't uniforms
  });

  it("give each use its own locals", () => {
    useAssets({ "a.shadersubgraph.json": subgraph() });
    const two = compileShaderGraph(
      graph([node("s1", "subgraph", { settings: { subgraph: "a.shadersubgraph.json" } }), node("s2", "subgraph", { settings: { subgraph: "a.shadersubgraph.json" } }), node("add", "add")], [["s1.Out", "add.a"], ["s2.Out", "add.b"], ["add.out", "output.baseColor"]]),
    );
    expect(two.problems).toEqual([]);
    expect(two.fragment.body).toContain("m1s2_out");
    expect(two.fragment.body).toContain("m2s2_out");
  });

  it("report a sub-graph that contains itself when it's used", () => {
    // self.shadersubgraph.json's output is fed by a Sub Graph node of itself.
    const self = {
      format: "myco.shadersubgraph@1",
      outputs: [{ name: "Out", type: "vec4" }],
      properties: [],
      nodes: [
        { id: "output", type: "output", position: [0, 0] },
        { id: "s", type: "subgraph", position: [0, 0], settings: { subgraph: "self.shadersubgraph.json" } },
      ],
      edges: [{ from: "s.Out", to: "output.Out" }],
    };
    useAssets({ "self.shadersubgraph.json": self });
    const c = compileShaderGraph(graph([node("s", "subgraph", { settings: { subgraph: "self.shadersubgraph.json" } })], [["s.Out", "output.baseColor"]]));
    expect(c.nodeProblems.s.join()).toMatch(/contains itself/);
    // Without its file a Sub Graph node has no ports, so its connections are reported.
    const gone = compileShaderGraph(graph([node("s", "subgraph", { settings: { subgraph: "gone.shadersubgraph.json" } })], [["s.Out", "output.baseColor"]]));
    expect(gone.problems.join()).toMatch(/port that isn't there/);
  });

  it("output textures by passing the texture's uniform through", () => {
    // tex.shadersubgraph.json: Texture = its Texture 2D Asset node; Map = its Map input.
    const sub = {
      format: "myco.shadersubgraph@1",
      outputs: [{ name: "Texture", type: "texture" }, { name: "Map", type: "texture" }],
      properties: [{ name: "Map", type: "texture", value: "asset:images/default.png" }],
      nodes: [
        { id: "output", type: "output", position: [0, 0] },
        { id: "asset", type: "textureAsset", position: [0, 0], settings: { texture: "asset:images/a.png" } },
        { id: "map", type: "property", position: [0, 0], settings: { property: "Map" } },
      ],
      edges: [{ from: "asset.out", to: "output.Texture" }, { from: "map.out", to: "output.Map" }],
    };
    useAssets({ "tex.shadersubgraph.json": sub });
    const g = graph(
      [
        node("s", "subgraph", { settings: { subgraph: "tex.shadersubgraph.json" } }),
        node("a", "sampleTexture"),
        node("b", "sampleTexture", { settings: { type: "normal" } }),
        node("p", "property", { settings: { property: "Mine" } }),
        node("s2", "subgraph", { settings: { subgraph: "tex.shadersubgraph.json" } }),
        node("c", "sampleTexture"),
      ],
      [["s.Texture", "a.texture"], ["s.Map", "b.texture"], ["a.rgb", "output.baseColor"], ["b.rgb", "output.normal"], ["p.out", "s2.Map"], ["s2.Map", "c.texture"], ["c.r", "output.alpha"]],
      { properties: [{ name: "Mine", type: "texture", value: "asset:images/mine.png" }] },
    );
    expect(nodePorts(g.nodes[1], g).outputs.map((o) => o.type)).toEqual(["texture", "texture"]);
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    const uniform = (value: string) => c.uniforms.find((u) => u.value === value)!;
    const own = uniform("asset:images/a.png").name;
    expect(c.fragment.body).toContain(`textureSample(${own}, ${own}Sampler, fragmentInputs.vMycoUv)`); // the sub-graph's own texture
    expect(uniform("asset:images/default.png").linear).toBe(true); // an unconnected input reads the property's default, here as a normal map
    expect(c.fragment.body).toContain("textureSample(uP0_Mine, uP0_MineSampler, fragmentInputs.vMycoUv)"); // a connected input passes the graph's property through
  });

  it("preview a first texture output as the texture", () => {
    const { graph: sub } = parseShaderGraph({ format: "myco.shadersubgraph@1", outputs: [{ name: "T", type: "texture" }], nodes: [{ id: "output", type: "output", position: [0, 0] }, { id: "a", type: "textureAsset", position: [0, 0], settings: { texture: "x.png" } }], edges: [{ from: "a.out", to: "output.T" }] });
    const c = compileShaderGraph(sub);
    expect(c.problems).toEqual([]);
    expect(c.fragment.body).toContain("var mOut_base: vec3f = textureSample(uTex0, uTex0Sampler, fragmentInputs.vMycoUv).rgb;");
  });

  it("compile on their own as their first output, unlit", () => {
    const { graph: sub } = parseShaderGraph(subgraph());
    const c = compileShaderGraph(sub);
    expect(c.target).toBe("unlit");
    expect(c.problems).toEqual([]);
    expect(c.fragment.baseColor).toBe("mOut_base");
    expect(c.uniforms.map((u) => u.property)).toEqual(["Scale"]);
  });
});

describe("custom function nodes", () => {
  it("emit a function and call it with the node's inputs", () => {
    const f = { name: "wave", inputs: [{ name: "x", type: "float" as const }], outputs: [{ name: "y", type: "vec3" as const }], wgsl: "y = vec3f(sin(x));" };
    const c = compileShaderGraph(graph([node("t", "time"), node("f", "customFunction", { function: f })], [["t.time", "f.x"], ["f.y", "output.baseColor"]]));
    expect(c.problems).toEqual([]);
    expect(c.fragment.declarations).toContain("fn wave_2(x: f32) -> wave_2_Out {\n  var y: vec3f = vec3f(0.0);\ny = vec3f(sin(x));\n  return wave_2_Out(y);\n}");
    expect(c.fragment.body).toContain("var m2_ret: wave_2_Out = wave_2(m1_time);\nvar m2_y: vec3f = m2_ret.y;");
  });
});

describe("normal maps", () => {
  it("sample linear data and unpack it", () => {
    const c = compileShaderGraph(graph([node("s", "sampleTexture", { settings: { texture: "asset:n.png", type: "normal" } })], [["s.rgb", "output.normal"]]));
    expect(c.uniforms).toEqual([{ name: "uTex0", type: "sampler2D", value: "asset:n.png", linear: true }]);
    expect(c.fragment.body).toContain("(textureSample(uTex0, uTex0Sampler, fragmentInputs.vMycoUv).rgb * 2.0 - 1.0)");
  });

  it("report a texture property sampled both ways, which reads as colour", () => {
    const both = compileShaderGraph(
      graph([node("p", "property", { settings: { property: "T" } }), node("a", "sampleTexture", { settings: { type: "normal" } }), node("b", "sampleTexture")], [["p.out", "a.texture"], ["p.out", "b.texture"], ["a.rgb", "output.normal"], ["b.rgb", "output.baseColor"]], {
        properties: [{ name: "T", type: "texture", value: "" }],
      }),
    );
    expect(both.problems.join()).toMatch(/both as a colour and as a normal map/);
    expect(both.uniforms[0].linear).toBeUndefined();
  });
});

describe("node previews", () => {
  it("feed the node's first output to Base Color of an unlit graph", () => {
    const g = graph([node("t", "time"), node("s", "sine")], [["t.time", "s.in"], ["s.out", "output.alpha"]]);
    const p = nodePreviewGraph(g, "s")!;
    expect(p.target).toBe("unlit");
    expect(p.edges).toEqual([{ from: "t.time", to: "s.in" }, { from: "s.out", to: "output.baseColor" }]);
    expect(compileShaderGraph(p).problems).toEqual([]);
    expect(nodePreviewGraph(g, "output")).toBeNull();
  });
});

describe("MeshRenderer material properties", () => {
  it("store copies of overrides and bump a version for the render backend", () => {
    const r = new MeshRenderer();
    const c = Color.from("#ff0000");
    r.setMaterialProperty("Tint", c);
    c.r = 0;
    expect((r.getMaterialProperty("Tint") as Color).r).toBe(1);
    const v = r._materialPropertiesVersion;
    r.setMaterialProperty("Speed", 2);
    expect(r._materialPropertiesVersion).toBe(v + 1);
    r.clearMaterialProperty("Speed");
    expect(r.getMaterialProperty("Speed")).toBeUndefined();
    r.clearMaterialProperties();
    expect(r._materialProperties.size).toBe(0);
  });
});
