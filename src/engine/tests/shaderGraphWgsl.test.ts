import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../index";
import { compileShaderGraph, type CompiledShaderGraph } from "../render/shaderGraph/compile";
import { HELPERS_WGSL, NODES, nodePorts } from "../render/shaderGraph/nodes";
import { defaultShaderGraph, parseShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";

// The WGSL output of the shader graph compiler (ADR 0075; its only output since ADR 0081), written for
// Babylon.js's WGSL dialect. No WGSL parser is installed, so these are string-level checks.

const graph = (nodes: GraphNode[], edges: [string, string][], extra: Partial<ShaderGraph> = {}): ShaderGraph => ({
  ...defaultShaderGraph(),
  nodes: [{ id: "output", type: "output", position: [0, 0] }, ...nodes],
  edges: edges.map(([from, to]) => ({ from, to })),
  ...extra,
});
const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, position: [0, 0], ...extra });
const wgsl = (g: ShaderGraph, shaderLevel: "low" | "medium" | "high" = "high") => compileShaderGraph(g, { shaderLevel });

/** Every code string of a compile, to scan. */
function code(c: CompiledShaderGraph): string {
  const f = c.fragment;
  return [c.vertex.declarations, c.vertex.body, c.vertex.offset, c.vertex.varyings, f.declarations, f.body, f.baseColor, f.alpha, f.metalness, f.roughness, f.emission, f.normal, f.alphaClip, ...Object.values(f.physical ?? {})].filter(Boolean).join("\n");
}

/** Tokens that only GLSL has. */
const GLSL_ONLY: [string, RegExp][] = [
  ["unsuffixed vector constructor", /\bvec[234]\s*\(/],
  ["float(", /\bfloat\s*\(/],
  ["texture(", /\btexture\s*\(/],
  ["mat2(/mat3(", /\bmat[234]\s*\(/],
  ["gl_", /\bgl_/],
  ["mod(", /\bmod\s*\(/],
  ["sampler2D", /sampler2D/],
  ["ternary", / \? .* : /],
  ["uniform declaration", /^uniform /m],
  ["int i", /\bint [a-z]/],
  ["GLSL varying type", /\bvarying (vec|float)/],
  ["#define", /#define/],
];

/** Balanced brackets, and every declaration and parameter typed. */
function checkShape(text: string, label: string): void {
  const stripped = text.replace(/\/\/.*$/gm, "");
  for (const [open, close] of [["(", ")"], ["{", "}"], ["[", "]"]]) expect(stripped.split(open).length, `${label}: ${open}${close}`).toBe(stripped.split(close).length);
  for (const m of stripped.matchAll(/^\s*(?:var|let)\s+(\w+)\s*([:=])/gm)) expect(m[2], `${label}: ${m[1]} needs a type`).toBe(":");
  for (const m of stripped.matchAll(/\bfn\s+(\w+)\(([^)]*)\)/g)) for (const p of m[2].split(",").filter((x) => x.trim())) expect(p, `${label}: ${m[1]} parameter`).toMatch(/^\s*\w+\s*:\s*\S/);
}

function expectWgsl(c: CompiledShaderGraph, label: string): void {
  const text = code(c);
  for (const [name, re] of GLSL_ONLY) expect(text, `${label}: ${name}`).not.toMatch(re);
  checkShape(c.vertex.declarations + c.vertex.body + c.vertex.varyings, `${label} vertex`);
  checkShape(c.fragment.declarations + c.fragment.body, `${label} fragment`);
}

const sampleDir = "samples/playground3d/shaders/";
const useSampleAssets = () => {
  Assets.clearSources();
  const subs = readdirSync(sampleDir).filter((x) => x.endsWith(".shadersubgraph.json"));
  Assets.addSource(Assets.fromObject(Object.fromEntries(subs.map((x) => [`shaders/${x}`, JSON.parse(readFileSync(sampleDir + x, "utf8"))]))));
};

describe("WGSL output of the shader graph compiler", () => {
  afterEach(() => Assets.clearSources());

  it("compiles the default graph without problems, to the same key each time", () => {
    const g = defaultShaderGraph();
    const w = wgsl(g);
    expect(wgsl(g).key).toBe(w.key);
    expect(w.problems).toEqual([]);
    expectWgsl(w, "default");
  });

  it("has every helper a node asks for, every function typed", () => {
    expect(Object.keys(HELPERS_WGSL).sort()).toEqual(["gradientNoise", "hsv", "mainLight", "random", "rotate", "simpleNoise", "tangentFrame", "valueNoise", "voronoi"]);
    for (const [name, text] of Object.entries(HELPERS_WGSL)) {
      checkShape(text, name);
      for (const m of text.matchAll(/\bfn\s+\w+\([^)]*\)\s*(->)?/g)) expect(m[1], `${name}: ${m[0]}`).toBe("->");
    }
  });

  it("compiles every node type, in the fragment and (where allowed) the vertex stage", () => {
    for (const def of NODES) {
      if (def.type === "output" || def.type === "subgraph" || def.type === "customFunction") continue;
      const n = node("n", def.type, def.type === "property" ? { settings: { property: "P" } } : {});
      const g = graph([n], [], { properties: [{ name: "P", type: "vector3", value: [1, 2, 3] }] });
      const out = nodePorts(n, g).outputs.find((p) => p.type !== "texture");
      if (!out) continue;
      for (const to of ["baseColor", "normal", ...(def.fragmentOnly ? [] : ["vertexOffset"])]) {
        const c = wgsl({ ...g, edges: [{ from: `n.${out.id}`, to: `output.${to}` }] });
        expect(c.problems, `${def.type} -> ${to}`).toEqual([]);
        expectWgsl(c, `${def.type} -> ${to}`);
        expect(to === "vertexOffset" ? c.vertex.body : c.fragment.body, def.type).toContain("var m1_");
      }
    }
  });

  it("compiles every node's every output at once, for each target and shader level", () => {
    const nodes: GraphNode[] = [];
    for (const def of NODES) {
      if (def.type === "output" || def.type === "subgraph" || def.type === "customFunction") continue;
      nodes.push(node(`n_${def.type}`, def.type, def.type === "property" ? { settings: { property: "P" } } : {}));
    }
    const g = graph(nodes, [], { properties: [{ name: "P", type: "vector3", value: [1, 2, 3] }] });
    const used = nodes.flatMap((n) => nodePorts(n, g).outputs.filter((o) => o.type !== "texture").map((o) => `${n.id}.${o.id}`));
    g.nodes[0].inputs = { alphaClip: 0.5, clearcoat: 1 };
    // Chain every output through Add nodes, so each is reached.
    let prev = "";
    used.forEach((from, i) => {
      const id = `sum${i}`;
      g.nodes.push(node(id, "add"));
      g.edges.push({ from, to: `${id}.a` });
      if (prev) g.edges.push({ from: prev, to: `${id}.b` });
      prev = `${id}.out`;
    });
    for (const to of ["baseColor", "emission", "normal", "alpha", "metalness", "roughness", "clearcoat"]) g.edges.push({ from: prev, to: `output.${to}` });
    for (const target of ["lit", "unlit", "physical"] as const)
      for (const level of ["low", "medium", "high"] as const) {
        // Lit-only and physical-only inputs exist only on their targets.
        const edges = g.edges.filter((e) => !(target !== "physical" && e.to === "output.clearcoat") && !(target === "unlit" && /output\.(emission|normal|metalness|roughness)$/.test(e.to)));
        const c = wgsl({ ...g, edges, target }, level);
        expectWgsl(c, `${target}/${level}`);
        expect(c.problems, `${target}/${level}`).toEqual([]);
      }
  });

  it("has no GLSL in the sample graphs, and reads their uniforms as uniforms.<name>", () => {
    for (const f of readdirSync(sampleDir).filter((x) => x.endsWith(".shadergraph.json"))) {
      const { graph: g } = parseShaderGraph(JSON.parse(readFileSync(sampleDir + f, "utf8")));
      useSampleAssets();
      const c = wgsl(g);
      expect(c.problems, f).toEqual([]);
      expectWgsl(c, f);
      for (const u of c.uniforms.filter((v) => v.type !== "sampler2D")) expect(code(c), f).not.toMatch(new RegExp(`(?<!uniforms\\.)\\b${u.name}\\b`));
    }
  });

  it("reads graph and shared uniforms from the uniforms struct and declares none", () => {
    const g = graph([node("p", "property", { settings: { property: "Tint" } }), node("t", "time"), node("s", "screenPosition")], [["p.out", "output.baseColor"], ["t.time", "output.alpha"], ["s.out", "output.emission"]], { properties: [{ name: "Tint", type: "color", value: "#ff0000" }] });
    const c = wgsl(g);
    expect(c.fragment.body).toContain("var m1_out: vec4f = uniforms.uP0_Tint;");
    expect(c.fragment.body).toContain("uniforms.uMycoTime");
    expect(c.fragment.body).toContain("fragmentInputs.position.xy / uniforms.uMycoResolution");
    expect(c.fragment.declarations).not.toMatch(/uniform|uP0_Tint|uMyco/);
    expect(c.uniforms.map((u) => u.name)).toEqual(["uP0_Tint"]);
  });

  it("declares textures once with a sampler, and samples them", () => {
    const g = graph(
      [node("a", "sampleTexture", { settings: { texture: "asset:a.png" } }), node("b", "sampleTexture", { settings: { texture: "asset:b.png", type: "normal" } }), node("p", "property", { settings: { property: "T" } }), node("c", "sampleTexture")],
      [["a.rgb", "output.baseColor"], ["b.rgb", "output.normal"], ["p.out", "c.texture"], ["c.r", "output.alpha"]],
      { properties: [{ name: "T", type: "texture", value: "asset:t.png" }] },
    );
    const c = wgsl(g);
    expect(c.problems).toEqual([]);
    const decl = c.fragment.declarations;
    expect(c.uniforms.length).toBe(3);
    for (const u of c.uniforms) {
      expect(u.type).toBe("sampler2D");
      expect(decl.split(`var ${u.name}: texture_2d<f32>;`).length - 1, u.name).toBe(1);
      expect(decl.split(`var ${u.name}Sampler: sampler;`).length - 1, u.name).toBe(1);
    }
    expect(c.fragment.body).toContain("textureSample(uTex0, uTex0Sampler, fragmentInputs.vMycoUv)");
    expect(c.fragment.body).toContain("textureSample(uP0_T, uP0_TSampler, fragmentInputs.vMycoUv)");
    expect(c.fragment.body).toContain("(textureSample(uTex1, uTex1Sampler, fragmentInputs.vMycoUv).rgb * 2.0 - 1.0)");
    expect(c.uniforms.find((u) => u.name === "uTex1")?.linear).toBe(true);
    expect(c.vertex.declarations).not.toContain("texture_2d");
  });

  it("samples textures in the vertex stage at mip level 0 and declares them there", () => {
    const g = graph([node("a", "sampleTexture", { settings: { texture: "asset:h.png" } }), node("m", "multiply", { inputs: { b: 0.5 } })], [["a.r", "m.a"], ["m.out", "output.vertexOffset"]]);
    const c = wgsl(g);
    expect(c.problems).toEqual([]);
    expect(c.vertex.body).toContain("textureSampleLevel(uTex0, uTex0Sampler, mycoVUv, 0.0)");
    expect(c.vertex.declarations).toContain("var uTex0: texture_2d<f32>;");
    expect(c.vertex.declarations).toContain("var uTex0Sampler: sampler;");
    expect(c.fragment.declarations).toContain("var uTex0: texture_2d<f32>;");
    expect(c.vertex.offset).toBe("mOut_vertexOffset");
  });

  it("emits no varyings for a graph the fragment stage reads none for", () => {
    const c = wgsl(graph([node("v", "vector3", { inputs: { x: 1 } })], [["v.out", "output.baseColor"]]));
    for (const d of [c.vertex.declarations, c.fragment.declarations]) expect(d).not.toContain("varying ");
    expect(c.vertex.varyings).toBe("");
    expect(c.fragment.declarations).toContain("fn mycoFaceNormal(n: vec3f) -> vec3f { return normalize(n); }");
  });

  it("emits only the varyings the fragment stage reads, assigned in the vertex stage", () => {
    const uv = wgsl(graph([node("u", "uv")], [["u.out", "output.baseColor"]]));
    for (const d of [uv.vertex.declarations, uv.fragment.declarations]) {
      expect(d).toContain("varying vMycoUv: vec2f;");
      expect(d).not.toMatch(/vMycoObj|vMycoWorld/);
    }
    expect(uv.vertex.varyings).toBe("vertexOutputs.vMycoUv = mycoVUv;");
    const g = graph([node("p", "position"), node("n", "normal", { settings: { space: "object" } }), node("o", "normal")], [["p.out", "output.baseColor"], ["n.out", "output.emission"], ["o.out", "output.vertexOffset"]]);
    const c = wgsl(g);
    expect(c.fragment.declarations).toContain("varying vMycoObjPos: vec3f;");
    expect(c.fragment.declarations).toContain("varying vMycoObjNormal: vec3f;");
    expect(c.fragment.declarations).not.toContain("vMycoUv");
    expect(c.vertex.varyings).toContain("var mycoTransformed: vec3f = mycoVPos + mOut_vertexOffset;");
    expect(c.vertex.varyings).toContain("vertexOutputs.vMycoObjPos = mycoTransformed;");
    expect(c.vertex.varyings).toContain("vertexOutputs.vMycoObjNormal = mycoVNormal;");
    expect(c.vertex.varyings).not.toContain("vMycoUv");
    // mycoTransformed is only built when the object position is read.
    expect(wgsl(graph([node("n", "normal", { settings: { space: "object" } })], [["n.out", "output.baseColor"]])).vertex.varyings).toBe("vertexOutputs.vMycoObjNormal = mycoVNormal;");
  });

  it("keeps the UV varying when a Normal output is connected", () => {
    const c = wgsl(graph([node("v", "vector3", { inputs: { z: 1 } })], [["v.out", "output.normal"]]));
    expect(c.fragment.normal).not.toBeNull();
    expect(c.vertex.declarations).toContain("varying vMycoUv: vec2f;");
    expect(c.fragment.declarations).toContain("varying vMycoUv: vec2f;");
    expect(c.vertex.varyings).toContain("vertexOutputs.vMycoUv = mycoVUv;");
  });

  it("never declares or assigns world position or normal varyings", () => {
    const g = graph([node("w", "position", { settings: { space: "world" } }), node("n", "normal")], [["w.out", "output.baseColor"], ["n.out", "output.emission"]]);
    const c = wgsl(g);
    expect(code(c)).not.toMatch(/vMycoWorld/);
  });

  it("uses Babylon's built-ins in each stage", () => {
    const g = graph([node("w", "position", { settings: { space: "world" } }), node("v", "viewDirection"), node("nv", "normal", { settings: { space: "view" } }), node("nw", "normal"), node("pv", "position", { settings: { space: "view" } })], [["w.out", "output.baseColor"], ["v.out", "output.emission"], ["nv.out", "output.normal"], ["nw.out", "output.alpha"], ["pv.out", "output.roughness"]]);
    const c = wgsl(g);
    expect(c.fragment.body).toContain("fragmentInputs.vPositionW");
    expect(c.fragment.body).toContain("mycoFaceNormal(fragmentInputs.vNormalW)");
    expect(c.fragment.body).toContain("normalize(scene.vEyePosition.xyz - fragmentInputs.vPositionW)");
    expect(c.fragment.body).toContain("normalize((scene.view * vec4f(mycoFaceNormal(fragmentInputs.vNormalW), 0.0)).xyz)");
    expect(c.fragment.body).toContain("(scene.view * vec4f(fragmentInputs.vPositionW, 1.0)).xyz");
    const vg = graph([node("w", "position", { settings: { space: "view" } })], [["w.out", "output.vertexOffset"]]);
    expect(wgsl(vg).vertex.body).toContain("(scene.view * (finalWorld * vec4f(mycoVPos, 1.0))).xyz");
  });

  it("reads the particle colour (vertex times instance colour) in either stage, as RGBA, RGB and alpha", () => {
    const g = graph([node("pc", "particleColor")], [["pc.rgba", "output.emission"], ["pc.rgb", "output.baseColor"], ["pc.a", "output.alpha"]]);
    const c = wgsl(g);
    expect(c.fragment.body).toContain("mycoVColor");
    expect(c.fragment.body).toContain("mycoVColor.rgb");
    expect(c.fragment.body).toContain("mycoVColor.a");
    expect(code(c)).not.toMatch(/\bvColor\b/); // the plugin defines mycoVColor from Babylon's varying
    const vg = graph([node("pc", "particleColor")], [["pc.rgb", "output.vertexOffset"]]);
    expect(wgsl(vg).vertex.body).toContain("mycoVColor.rgb");
  });

  it("writes modulo, negate, saturate, dot and normalize in WGSL's terms", () => {
    const g = graph(
      [node("m", "modulo", { inputs: { a: [1, 2, 3], b: 2 } }), node("neg", "negate", { inputs: { in: -1 } }), node("sat", "saturate", { inputs: { in: [1, 2, 3] } }), node("d", "dot", { inputs: { a: 2, b: 3 } }), node("nm", "normalize", { inputs: { in: 2 } })],
      [["m.out", "output.baseColor"], ["neg.out", "output.alpha"], ["sat.out", "output.emission"], ["d.out", "output.metalness"], ["nm.out", "output.roughness"]],
    );
    const c = wgsl(g);
    expect(c.problems).toEqual([]);
    expect(c.fragment.body).toContain("floor(");
    expect(c.fragment.body).toContain("(-(-1.0))");
    expect(c.fragment.body).toContain("saturate(vec3f(1.0, 2.0, 3.0))");
    expect(c.fragment.body).toContain("(2.0 * 3.0)");
    expect(c.fragment.body).toContain("sign(2.0)");
  });

  it("uses integer loop counters with float casts in the noise helpers", () => {
    const g = graph([node("a", "simpleNoise"), node("b", "voronoi"), node("c", "gradientNoise"), node("h", "hue"), node("r", "rotate")], [["a.out", "output.alpha"], ["b.out", "output.roughness"], ["c.out", "output.metalness"], ["h.out", "output.baseColor"], ["r.out", "output.emission"]]);
    const d = wgsl(g).fragment.declarations;
    expect(d).toContain("for (var i: i32 = 0; i < 3; i++)");
    expect(d).toContain("f32(i)");
    expect(d).toContain("mat2x2f(");
    expect(d).toContain("fn mycoRandom(uv: vec2f) -> f32");
    for (const name of ["valueNoise", "gradientNoise", "voronoi", "hsv", "random", "simpleNoise"] as const) expect(d, name).toContain(HELPERS_WGSL[name]);
  });

  it("emits the main light and tangent-frame helpers", () => {
    const g = graph([node("l", "lambert"), node("lc", "mainLightColor"), node("nm", "sampleTexture", { settings: { texture: "asset:n.png", type: "normal" } })], [["l.out", "output.alpha"], ["lc.out", "output.emission"], ["nm.rgb", "output.normal"]]);
    const c = wgsl(g);
    expect(c.fragment.declarations).toContain("fn mycoMainLightDirection() -> vec3f");
    expect(c.fragment.declarations).toContain("fn mycoMainLightColor() -> vec3f");
    expect(c.fragment.declarations).toContain("fn mycoTangentFrame(eyePos: vec3f, n: vec3f, uv: vec2f) -> mat3x3f");
    expect(c.fragment.declarations).toContain("select(inverseSqrt(det), 0.0, det == 0.0)");
    expect(c.fragment.normal).toBe("mOut_normal");
  });

  it("previews a sub-graph's texture output", () => {
    const { graph: tex } = parseShaderGraph({ format: "myco.shadersubgraph@1", outputs: [{ name: "T", type: "texture" }], nodes: [{ id: "output", type: "output", position: [0, 0] }, { id: "a", type: "textureAsset", position: [0, 0], settings: { texture: "x.png" } }], edges: [{ from: "a.out", to: "output.T" }] });
    const c = wgsl(tex);
    expect(c.problems).toEqual([]);
    expect(c.fragment.body).toContain("var mOut_base: vec3f = textureSample(uTex0, uTex0Sampler, fragmentInputs.vMycoUv).rgb;");
  });

  it("expands a sub-graph whose Custom Function has WGSL code (the ripple sample)", () => {
    useSampleAssets();
    const g = graph([node("s", "subgraph", { settings: { subgraph: "asset:shaders/ripple.shadersubgraph.json" } })], [["s.Height", "output.alpha"]]);
    const c = wgsl(g);
    expect(c.problems).toEqual([]);
    expectWgsl(c, "ripple");
    expect(c.fragment.declarations).toMatch(/struct ripple_\w+_Out \{ height: f32 \}/);
    expect(c.fragment.declarations).toMatch(/fn ripple_\w+\(uv: vec2f, t: f32, rings: f32, speed: f32\) -> ripple_\w+_Out \{\n {2}var height: f32 = 0\.0;\nlet d: f32 = length\(uv - vec2f\(0\.5\)\);/);
    expect(c.fragment.body).toMatch(/var m\w+_ret: ripple_\w+_Out = ripple_\w+\(/);
  });

  it("reports a Custom Function without WGSL code (GLSL only, or none) and reads its outputs as defaults", () => {
    const f = { name: "wave", inputs: [{ name: "x", type: "float" as const }], outputs: [{ name: "y", type: "vec3" as const }], body: "y = vec3(sin(x));" };
    const g = graph([node("t", "time"), node("f", "customFunction", { function: f })], [["t.time", "f.x"], ["f.y", "output.baseColor"]]);
    const c = wgsl(g);
    expect(c.problems).toEqual(["Custom Function (f): this Custom Function has only GLSL code, which nothing compiles since the three.js backend went (ADR 0081): write it in WGSL; its outputs read their defaults"]);
    expect(c.fragment.body).toContain("var m2_y: vec3f = vec3f(0.0);");
    expect(code(c)).not.toContain("sin(x)");
    const none = wgsl(graph([node("t", "time"), node("f", "customFunction", { function: { ...f, body: undefined } })], [["t.time", "f.x"], ["f.y", "output.baseColor"]]));
    expect(none.problems).toEqual(["Custom Function (f): this Custom Function has no WGSL code; its outputs read their defaults"]);
    const ok = wgsl(graph([node("t", "time"), node("f", "customFunction", { function: { ...f, wgsl: "y = vec3f(sin(x));" } })], [["t.time", "f.x"], ["f.y", "output.baseColor"]]));
    expect(ok.problems).toEqual([]);
    expect(ok.fragment.declarations).toContain("fn wave_2(x: f32) -> wave_2_Out {\n  var y: vec3f = vec3f(0.0);\ny = vec3f(sin(x));\n  return wave_2_Out(y);\n}");
  });

  it("round-trips a Custom Function's WGSL code through the file format", () => {
    const raw = { format: "myco.shadergraph@1", nodes: [{ id: "output", type: "output", position: [0, 0] }, { id: "f", type: "customFunction", position: [0, 0], function: { name: "w", inputs: [], outputs: [{ name: "y", type: "float" }], body: "y = 1.0;", wgsl: "y = 1.0;" } }], edges: [] };
    const { graph: g, problems } = parseShaderGraph(raw);
    expect(problems).toEqual([]);
    expect(g.nodes[1].function?.wgsl).toBe("y = 1.0;");
  });
});
