// ADR 0415: shader graphs with sprite targets: their output ports and nodes, the compiled graph, the WGSL the graph
// plugin puts into the 2D quad material, and how 2D draws take a material shaded by one.
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../scene/Assets";
import { defaultShaderGraph, parseShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import { nodePorts } from "../render/shaderGraph/nodes";
import { spriteMaterialGraph, spriteMaterialLit, spriteMaterialProblem } from "../render/lights2D/spriteMaterial";
import { spriteGraphOverrides } from "../render/babylon/spriteGraphMaterial";
import { graphCode, graphShaders } from "./graphPluginCode";

const graph = (nodes: GraphNode[], edges: [string, string][], extra: Partial<ShaderGraph> = {}): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [{ id: "output", type: "output", position: [0, 0] }, ...nodes],
  edges: edges.map(([from, to]) => ({ from, to })),
  ...extra,
});
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });
const portsOf = (g: ShaderGraph) => nodePorts(g.nodes.find((n) => n.type === "output")!, g).inputs.map((p) => p.id);

/** Sample the sprite texture into Base Color and Alpha. */
const SPRITE_NODES: GraphNode[] = [node("tex", "spriteTexture"), node("s", "sampleTexture")];
const SPRITE_EDGES: [string, string][] = [
  ["tex.out", "s.texture"],
  ["s.rgb", "output.baseColor"],
  ["s.a", "output.alpha"],
];

afterEach(() => Assets.clearSources());

describe("sprite shader graph targets (ADR 0415)", () => {
  it("parse, and offer colour and alpha (Sprite Lit also a normal and a mask)", () => {
    for (const t of ["sprite-lit", "sprite-unlit", "sprite-custom-lit"] as const) expect(parseShaderGraph({ format: "myco.shadergraph@1", target: t }).graph.target).toBe(t);
    expect(portsOf(graph([], [], { target: "sprite-lit" }))).toEqual(["baseColor", "alpha", "normal", "mask", "alphaClip"]);
    expect(portsOf(graph([], [], { target: "sprite-unlit" }))).toEqual(["baseColor", "alpha", "alphaClip"]);
    expect(portsOf(graph([], [], { target: "sprite-custom-lit" }))).toEqual(["baseColor", "alpha", "alphaClip"]);
    expect(portsOf(graph([], []))).not.toContain("mask"); // lit keeps its own
  });

  it("read the draw's texture and secondary textures as texture properties the draw overrides", () => {
    const g = graph([...SPRITE_NODES, node("n", "secondaryTexture", { settings: { name: "_Rim" } }), node("ns", "sampleTexture")], [...SPRITE_EDGES, ["n.out", "ns.texture"], ["ns.rgba", "output.mask"]], { target: "sprite-lit" });
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    expect(c.uniforms.filter((u) => u.type === "sampler2D").map((u) => [u.name, u.property])).toEqual([
      ["uDraw_sprite", "@sprite"],
      ["uDraw_secondary_Rim", "@secondary:_Rim"],
    ]);
    expect(c.fragment.mask).toBeTruthy();
    expect(c.fragment.metalness).toBeNull();
  });

  it("report sprite nodes in a graph that isn't for 2D, and 2D light nodes outside Custom Lit", () => {
    const lit = compileShaderGraph(graph(SPRITE_NODES, SPRITE_EDGES));
    expect(lit.problems.join("\n")).toMatch(/only works in "sprite-lit", "sprite-unlit", "sprite-custom-lit" graphs/);
    const light = compileShaderGraph(graph([node("l", "lightColor2D")], [["l.out", "output.baseColor"]], { target: "sprite-lit" }));
    expect(light.problems.join("\n")).toMatch(/only works in "sprite-custom-lit" graphs; it reads zero here/);
  });

  it("put colour × tint × vertex colour into the quad material; a Sprite Lit graph's normal and mask go to the light plugin", () => {
    const g = graph([...SPRITE_NODES, node("v", "vector3", { inputs: { x: 0, y: 0.5, z: 1 } })], [...SPRITE_EDGES, ["v.out", "output.normal"]], { target: "sprite-lit" });
    const code = graphCode(compileShaderGraph(g), "fragment");
    expect(code.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain("* uniforms.vAlbedoColor.rgb;");
    expect(code.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain("fragmentInputs.vColor.rgb");
    expect(code.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain("mycoSpriteN = normalize(");
    expect(code.CUSTOM_FRAGMENT_DEFINITIONS).toContain("var<private> mycoSpriteMask: vec4f");
    expect(Object.keys(code).join(" ")).not.toMatch(/albedoBlock|REFLECTIVITY/i); // no PBR lighting of its own
  });

  it("compile a Custom Lit graph's 2D light reads into WGSL Babylon accepts", async () => {
    const g = graph([...SPRITE_NODES, node("l", "lightColor2D"), node("m", "multiply")], [["tex.out", "s.texture"], ["s.rgb", "m.a"], ["l.out", "m.b"], ["m.out", "output.baseColor"], ["s.a", "output.alpha"]], { target: "sprite-custom-lit" });
    const c = compileShaderGraph(g);
    expect(c.problems).toEqual([]);
    const { main } = await graphShaders(c);
    expect(main.fragment).toContain("mycoL2DLightColor(fragmentInputs.position.xy)");
  });
});

describe("2D draws with a sprite graph's material (ADR 0415)", () => {
  const use = (files: Record<string, unknown>) => Assets.addSource(Assets.fromObject(files));
  const LIT = { format: "myco.shadergraph@1", target: "sprite-lit" };

  it("take a material shaded by a sprite graph, or the graph itself, and report other graphs", () => {
    use({
      "lit.shadergraph.json": LIT,
      "flat.shadergraph.json": { format: "myco.shadergraph@1", target: "sprite-unlit" },
      "mesh.shadergraph.json": { format: "myco.shadergraph@1", target: "lit" },
      "glow.material.json": { format: "myco.material@1", shader: "asset:lit.shadergraph.json" },
    });
    expect(spriteMaterialProblem("glow.material.json")).toBeNull();
    expect(spriteMaterialProblem("lit.shadergraph.json")).toBeNull();
    expect(spriteMaterialProblem("mesh.shadergraph.json")).toMatch(/target "lit", which 2D draws don't take/);
    expect(spriteMaterialGraph("glow.material.json")).toBe(true);
    expect(spriteMaterialLit("flat.shadergraph.json")).toBe(false);
  });

  it("give the graph the drawn image and its secondary textures", () => {
    use({ "hero.png.meta.json": { format: "myco.import@1", secondaryTextures: { normalMap: "asset:hero_n.png", _Rim: "asset:rim.png" } }, "hero.png": "data:," });
    expect(spriteGraphOverrides("asset:hero.png")).toEqual({ "@sprite": "hero.png", "@secondary:normalMap": "asset:hero_n.png", "@secondary:_Rim": "asset:rim.png" });
  });
});
