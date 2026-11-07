// ADR 0106: hand-written shader assets (WGSL and GLSL surface functions), shader keywords and their
// variants, in graphs, shader assets and material assets. Headless: the GLSL path runs on Babylon's
// NullEngine (a GLSL engine), and the injection points are checked against Babylon's shipped sources.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { pbrPixelShader } from "@babylonjs/core/Shaders/pbr.fragment.js";
import { pbrVertexShader } from "@babylonjs/core/Shaders/pbr.vertex.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphMaterial, GLSL_ALBEDO_ANCHOR, glslCustomCode, graphSupports, type GraphShared } from "../render/babylon/graphMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import { compileShaderAsset } from "../render/shaderGraph/shaderAsset";
import { formatMaterial, parseMaterial } from "../scene/material";
import { formatShaderAsset, isShaderAssetPath, parseShaderAsset } from "../scene/shaderAsset";
import { defaultShaderGraph, parseShaderGraph, shaderGraphJSON, type ShaderGraph } from "../scene/shaderGraph";
import { allKeywordDefines, keywordConstantsWgsl, keywordDefines, parseKeywords, resolveKeywords, warmKeywordVariants, type ShaderKeyword } from "../scene/shaderKeywords";

const RIM: ShaderKeyword = { name: "RIM" };
const QUALITY: ShaderKeyword = { name: "QUALITY", values: ["LOW", "MID", "HIGH"], variants: "all" };

describe("shader keywords (ADR 0106)", () => {
  it("parses keyword lists leniently", () => {
    const problems: string[] = [];
    const list = parseKeywords([{ name: "RIM" }, { name: "rim" }, { name: "RIM" }, { name: "Q", values: ["A", "B"], variants: "all" }, { name: "BAD", values: ["ONLY"] }, { name: "V", variants: "sometimes" }], "s", problems);
    expect(list).toEqual([{ name: "RIM" }, { name: "Q", values: ["A", "B"], variants: "all" }, { name: "BAD" }, { name: "V" }]);
    expect(problems.length).toBe(4);
  });

  it("resolves values to defaults and reports bad ones", () => {
    const problems: string[] = [];
    expect(resolveKeywords([RIM, QUALITY], { RIM: true, QUALITY: "ULTRA", NOPE: true }, (m) => problems.push(m))).toEqual({ RIM: true, QUALITY: "LOW" });
    expect(problems).toHaveLength(2);
    expect(resolveKeywords([RIM, QUALITY], {})).toEqual({ RIM: false, QUALITY: "LOW" });
  });

  it("turns values into KW_ defines", () => {
    expect(allKeywordDefines([RIM, QUALITY])).toEqual(["KW_RIM", "KW_QUALITY_LOW", "KW_QUALITY_MID", "KW_QUALITY_HIGH"]);
    expect(keywordDefines([RIM, QUALITY], { RIM: true, QUALITY: "HIGH" })).toEqual(["KW_RIM", "KW_QUALITY_HIGH"]);
    expect(keywordDefines([RIM, QUALITY], {})).toEqual(["KW_QUALITY_LOW"]);
  });

  it("lists the variants warm-up compiles: the material's own first, then every 'all' combination", () => {
    const { variants, capped } = warmKeywordVariants([RIM, QUALITY], { RIM: true, QUALITY: "MID" });
    expect(variants[0]).toEqual({ RIM: true, QUALITY: "MID" });
    expect(variants.map((v) => v.QUALITY).sort()).toEqual(["HIGH", "LOW", "MID"]);
    expect(variants.every((v) => v.RIM === true)).toBe(true); // RIM is "used": stays as the material sets it
    expect(capped).toBe(false);
    const many = Array.from({ length: 5 }, (_, i): ShaderKeyword => ({ name: `K${i}`, variants: "all" }));
    const big = warmKeywordVariants(many, {});
    expect(big.variants).toHaveLength(16);
    expect(big.capped).toBe(true);
  });

  it("declares WGSL constants chosen by the defines", () => {
    const wgsl = keywordConstantsWgsl([RIM, QUALITY]);
    expect(wgsl).toContain("#ifdef KW_RIM\nconst mycoKw_RIM: bool = true;\n#else\nconst mycoKw_RIM: bool = false;\n#endif");
    expect(wgsl).toContain("#if defined(KW_QUALITY_MID)\nconst mycoKw_QUALITY: u32 = 1u;\n#elif defined(KW_QUALITY_HIGH)\nconst mycoKw_QUALITY: u32 = 2u;\n#else\nconst mycoKw_QUALITY: u32 = 0u;\n#endif");
  });

  it("round-trips a graph's keywords and compiles Keyword nodes to selects", () => {
    const graph: ShaderGraph = { ...defaultShaderGraph(), keywords: [RIM, QUALITY] };
    graph.nodes.push({ id: "k", type: "keyword", position: [0, 0], settings: { keyword: "RIM" }, inputs: { on: [1, 0, 0, 1], off: [0, 0, 1, 1] } });
    graph.nodes.push({ id: "q", type: "keyword", position: [0, 0], settings: { keyword: "QUALITY" }, inputs: { LOW: 0.1, MID: 0.5, HIGH: 0.9 } });
    graph.edges.push({ from: "k.out", to: "output.baseColor" }, { from: "q.out", to: "output.roughness" });
    const { graph: again, problems } = parseShaderGraph(shaderGraphJSON(graph), "g");
    expect(problems).toEqual([]);
    expect(again.keywords).toEqual([RIM, QUALITY]);
    const c = compileShaderGraph(again);
    expect(c.problems).toEqual([]);
    expect(c.keywords).toEqual([RIM, QUALITY]);
    expect(c.fragment.declarations).toContain("const mycoKw_RIM: bool = true;");
    expect(c.fragment.body).toMatch(/select\(.*, .*, mycoKw_RIM\)/);
    expect(c.fragment.body).toContain("mycoKw_QUALITY == 2u");
  });

  it("reports a Keyword node naming no keyword", () => {
    const graph: ShaderGraph = defaultShaderGraph();
    graph.nodes.push({ id: "k", type: "keyword", position: [0, 0], settings: { keyword: "NOPE" } });
    graph.edges.push({ from: "k.out", to: "output.alpha" });
    expect(compileShaderGraph(graph).problems.join()).toContain('no keyword "NOPE"');
  });

  it("reads and writes a material's keywords and instancing", () => {
    const { settings, problems } = parseMaterial({ format: "myco.material@1", shader: "asset:shaders/rim.shader.json", keywords: { RIM: true, QUALITY: "HIGH", BAD: 3 }, instancing: "thin" });
    expect(problems).toHaveLength(1);
    expect(settings.shader).toBe("asset:shaders/rim.shader.json");
    expect(settings.keywords).toEqual({ RIM: true, QUALITY: "HIGH" });
    expect(settings.instancing).toBe("thin");
    const text = formatMaterial(settings);
    expect(JSON.parse(text)).toMatchObject({ keywords: { RIM: true, QUALITY: "HIGH" }, instancing: "thin" });
    expect(parseMaterial({ format: "myco.material@1", instancing: "sometimes" }).problems).toHaveLength(1);
  });
});

const WGSL = `fn vertexOffset(v: MycoVertex) -> vec3f { return v.normal * 0.1 * sin(v.time); }
fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) {
  (*out).baseColor = uniforms.Tint.rgb;
#ifdef KW_RIM
  (*out).emission = vec3f(pow(1.0 - max(dot(s.normal, s.viewDir), 0.0), uniforms.Rim));
#endif
}`;

const GLSL = `vec3 vertexOffset(MycoVertex v) { return v.normal * 0.1 * sin(v.time); }
void surface(MycoSurfaceInput s, inout MycoSurface o) {
  o.baseColor = Tint.rgb * texture(Albedo, s.uv).rgb;
  o.normal = vec3(0.0, 0.0, 1.0);
#ifdef KW_RIM
  o.emission = vec3(pow(1.0 - max(dot(s.normal, s.viewDir), 0.0), Rim));
#endif
}`;

const ASSET = {
  format: "myco.shader@1",
  properties: [
    { name: "Tint", type: "color", value: "#ff8800" },
    { name: "Rim", type: "float", value: 2 },
    { name: "Albedo", type: "texture", value: "" },
  ],
  keywords: [{ name: "RIM" }],
  wgsl: "asset:shaders/rim.wgsl",
  glsl: { code: GLSL },
};

describe("hand-written shader assets (ADR 0106)", () => {
  it("parses and formats the asset", () => {
    expect(isShaderAssetPath("asset:shaders/rim.shader.json")).toBe(true);
    const { shader, problems } = parseShaderAsset(ASSET);
    expect(problems).toEqual([]);
    expect(shader.wgsl).toEqual({ file: "asset:shaders/rim.wgsl" });
    expect(shader.glsl).toEqual({ code: GLSL });
    expect(shader.properties.map((p) => p.name)).toEqual(["Tint", "Rim", "Albedo"]);
    expect(parseShaderAsset(JSON.parse(formatShaderAsset(shader))).shader).toEqual(shader);
    expect(parseShaderAsset({ format: "myco.shader@1", properties: [{ name: "two words", type: "float" }] }).problems.length).toBe(2); // bad name, no code
    expect(() => parseShaderAsset({ format: "nope" })).toThrow();
  });

  it("compiles to the graph form: uniforms named as the properties, surface outputs, vertex offset", () => {
    const { shader } = parseShaderAsset(ASSET);
    const c = compileShaderAsset(shader, { wgsl: WGSL, glsl: GLSL }, ["shaders/rim.wgsl"]);
    expect(c.problems).toEqual([]);
    expect(c.uniforms.map((u) => [u.name, u.type])).toEqual([["Tint", "vec4"], ["Rim", "float"], ["Albedo", "sampler2D"]]);
    expect(c.vertex.offset).toBe("mycoOffset");
    expect(c.vertex.body).toContain("vertexOffset(MycoVertex(mycoVPos, mycoVNormal, mycoVUv, uniforms.uMycoTime))");
    expect(c.fragment.declarations).toContain("var Albedo: texture_2d<f32>;");
    expect(c.fragment.declarations).toContain(WGSL);
    expect(c.fragment.body).toContain("surface(MycoSurfaceInput(");
    expect(c.fragment.baseColor).toBe("mycoS.baseColor");
    expect(c.fragment.normal).toBeNull(); // the WGSL never sets .normal
    expect(c.glsl?.fragment.normal).toBe("mycoS.normal"); // the GLSL does
    expect(c.keywords).toEqual([RIM]);
    expect(c.dependencies).toEqual(["shaders/rim.wgsl"]);
    expect(c.noWgsl).toBeUndefined();
    // Unlit shaders leave metalness, roughness and emission to Babylon.
    const unlit = compileShaderAsset({ ...shader, target: "unlit" }, { wgsl: WGSL });
    expect([unlit.fragment.metalness, unlit.fragment.emission]).toEqual([null, null]);
    expect(unlit.key).not.toBe(c.key);
  });

  it("reports code without a surface function, and marks GLSL-only shaders", () => {
    const { shader } = parseShaderAsset(ASSET);
    expect(compileShaderAsset(shader, { wgsl: "fn other() {}" }).problems.join()).toContain("no `fn surface");
    const glslOnly = compileShaderAsset(shader, { glsl: GLSL });
    expect(glslOnly.noWgsl).toBe(true);
    expect(graphSupports(glslOnly, ShaderLanguage.WGSL)).toBe(false);
    expect(graphSupports(glslOnly, ShaderLanguage.GLSL)).toBe(true);
    expect(graphSupports(compileShaderAsset(shader, { wgsl: WGSL }), ShaderLanguage.GLSL)).toBe(false);
  });

  it("puts GLSL where Babylon's GLSL PBR shaders have the anchors", () => {
    const { shader } = parseShaderAsset(ASSET);
    const c = compileShaderAsset(shader, { wgsl: WGSL, glsl: GLSL });
    const vertex = glslCustomCode(c, "vertex");
    const [vx, inject] = Object.entries(vertex).find(([k]) => k.startsWith("!"))!;
    expect(new RegExp(vx.slice(1)).test(pbrVertexShader.shader)).toBe(true);
    expect(inject).toContain("positionUpdated = positionUpdated + (mycoOffset);");
    expect(inject.indexOf("mycoOffset =")).toBeLessThan(inject.indexOf("vec4 worldPos"));
    const fragment = glslCustomCode(c, "fragment");
    for (const k of Object.keys(fragment).filter((k) => k.startsWith("!"))) expect(new RegExp(k.slice(1)).test(pbrPixelShader.shader), k).toBe(true);
    expect(Object.keys(fragment)).toContain(GLSL_ALBEDO_ANCHOR);
    for (const point of ["CUSTOM_FRAGMENT_DEFINITIONS", "CUSTOM_FRAGMENT_MAIN_BEGIN", "CUSTOM_FRAGMENT_UPDATE_ALPHA", "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION"]) expect(pbrPixelShader.shader).toContain(`#define ${point}`);
    expect(fragment.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toBe("finalEmissive = mycoS.emission;");
  });
});

describe("shader asset materials on the GLSL engine (ADR 0106)", () => {
  let engine: NullEngine;
  let scene: Scene;
  const shared: GraphShared = { time: 0, resolution: [1, 1] };
  const noTextures = () => Promise.reject(new Error("no textures in tests"));

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  const effectOf = (mesh: ReturnType<typeof CreateBox>): Effect | null => {
    scene.incrementRenderId(); // Babylon answers readiness once per frame
    mesh.material!.isReadyForSubMesh(mesh, mesh.subMeshes[0], true);
    return mesh.subMeshes[0].effect;
  };

  it("injects the GLSL and switches keyword variants with defines", () => {
    const { shader } = parseShaderAsset(ASSET);
    const c = compileShaderAsset(shader, { wgsl: WGSL, glsl: GLSL });
    const g = createGraphMaterial(scene, "rim", c, {}, shared, noTextures);
    g.material.allowShaderHotSwapping = false; // at run time the old variant draws until the new one is ready
    const mesh = CreateBox("box", {}, scene);
    mesh.material = g.material;
    const off = effectOf(mesh);
    expect(off).toBeTruthy();
    expect(off!.defines).not.toContain("#define KW_RIM");
    expect(off!.defines).toContain("MYCO_GRAPH_"); // the plugin is on for GLSL
    g.setKeywords({ RIM: true });
    expect(g.keywords).toEqual({ RIM: true });
    const on = effectOf(mesh);
    expect(on!.defines).toContain("#define KW_RIM");
    expect(on).not.toBe(off);
    g.setKeywords({ RIM: false });
    expect(effectOf(mesh)).toBe(off); // the engine's effect cache hands the first variant back
    g.dispose();
  });

  it("draws plain PBR when the shader has no GLSL", () => {
    const { shader } = parseShaderAsset(ASSET);
    const g = createGraphMaterial(scene, "rim", compileShaderAsset(shader, { wgsl: WGSL }), {}, shared, noTextures);
    const mesh = CreateBox("box", {}, scene);
    mesh.material = g.material;
    expect(effectOf(mesh)!.defines).not.toContain("MYCO_GRAPH");
    g.dispose();
  });
});
