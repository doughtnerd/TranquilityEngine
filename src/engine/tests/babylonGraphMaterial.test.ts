// ADR 0075 stage 4: shader graph materials on the Babylon backend — where the plugin puts a graph's
// WGSL in Babylon's PBR shaders, its uniforms and textures, and property overrides (ADR 0049).
// Headless on Babylon's NullEngine with a hand-made compiled graph, so it doesn't depend on the compiler.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { pbrVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/pbr.vertex.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphMaterial, graphCustomCode, graphUsesUv, graphShadowCustomCode, graphUniformBuffer, SHADOW_REMAPPED_VARIABLES, type GraphShared } from "../render/babylon/graphMaterial";
import type { CompiledShaderGraph } from "../render/shaderGraph/compile";

function compiled(overrides: Partial<CompiledShaderGraph> = {}): CompiledShaderGraph {
  return {
    language: "wgsl",
    target: "lit",
    surface: "opaque",
    doubleSided: false,
    vertex: { declarations: "varying vMycoUv: vec2f;", body: "var n1: f32 = 1.0;", offset: "vec3f(0.0, n1, 0.0)", varyings: "vertexOutputs.vMycoUv = mycoVUv;" },
    fragment: {
      declarations: "varying vMycoUv: vec2f;\nvar tex1: texture_2d<f32>;\nvar tex1Sampler: sampler;",
      body: "var n2: vec4f = uniforms.uTint;",
      baseColor: "n2.rgb",
      alpha: "n2.a",
      metalness: "0.25",
      roughness: "0.75",
      emission: "vec3f(0.0)",
      normal: null,
      physical: null,
      alphaClip: "0.5",
    },
    uniforms: [
      { name: "uTint", type: "vec4", property: "Tint", propertyType: "color", value: "#ff0000" },
      { name: "uSpeed", type: "float", property: "Speed", propertyType: "float", value: 2 },
      { name: "tex1", type: "sampler2D", value: "" },
    ],
    problems: [],
    nodeProblems: {},
    portTypes: {},
    dynamicTypes: {},
    dependencies: [],
    usesShaderLevel: false,
    key: "abc123",
    ...overrides,
  } as CompiledShaderGraph;
}

describe("shader graph materials on Babylon (ADR 0075 stage 4)", () => {
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

  it("puts the vertex code before the world position, with the graph's inputs and offset", () => {
    const code = graphCustomCode(compiled(), "vertex");
    expect(code.CUSTOM_VERTEX_DEFINITIONS).toContain("varying vMycoUv");
    const [rx, inject] = Object.entries(code).find(([k]) => k.startsWith("!"))!;
    expect(new RegExp(rx.slice(1)).test("var worldPos: vec4f=finalWorld* vec4f(positionUpdated,1.0);")).toBe(true);
    expect(inject).toContain("let mycoVUv: vec2f");
    expect(inject).toContain("positionUpdated = positionUpdated + (vec3f(0.0, n1, 0.0));");
    expect(inject.indexOf("var n1")).toBeLessThan(inject.indexOf("var worldPos"));
    expect(inject).toContain("vertexOutputs.vMycoUv = mycoVUv;");
  });

  it("sets the surface from the fragment code: albedo, alpha, clip, metallic, roughness, emission", () => {
    const code = graphCustomCode(compiled(), "fragment");
    expect(code.CUSTOM_FRAGMENT_MAIN_BEGIN).toBe("var n2: vec4f = uniforms.uTint;");
    expect(code.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain("surfaceAlbedo = n2.rgb;");
    expect(code.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain("if (alpha < 0.5) { discard; }");
    expect(code["!reflectivityBlock\\(\\s*uniforms\\.vReflectivityColor"]).toBe("reflectivityBlock(vec4f(0.25, 0.75, uniforms.vReflectivityColor.zw)");
    expect(code.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toBe("finalEmissive = vec3f(0.0);");
  });

  it("draws an unlit graph's colour directly, without the lit hooks", () => {
    const m = createGraphMaterial(scene, "g", compiled({ target: "unlit" }), {}, shared, noTextures);
    expect(m.material.unlit).toBe(true);
    const code = graphCustomCode(compiled({ target: "unlit" }), "fragment");
    expect(Object.keys(code).some((k) => k.startsWith("!reflectivity"))).toBe(false);
    expect(code.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toBeUndefined();
  });

  it("leaves the plugin off a GLSL material (the WebGL2 fallback draws plain PBR) instead of throwing", () => {
    const m = createGraphMaterial(scene, "g", compiled(), {}, shared, noTextures); // NullEngine materials are GLSL
    expect(m.material.pluginManager?.getPlugin("MycoGraph") ?? null).toBeNull();
  });

  it("registers its uniforms with the shared time and resolution, and gives each texture slot a texture", () => {
    expect(graphUniformBuffer(compiled()).map((u) => u.name)).toEqual(["uMycoTime", "uMycoResolution", "uMycoMainLightDir", "uMycoMainLightColor", "uTint", "uSpeed"]);
    const m = createGraphMaterial(scene, "g", compiled(), {}, shared, noTextures);
    expect(m.state.textures.has("tex1")).toBe(true); // white until a texture loads
  });

  it("takes property values from the material, over the graph's defaults, and changes them without recompiling (ADR 0049)", () => {
    const m = createGraphMaterial(scene, "g", compiled(), { Speed: 5 }, shared, noTextures);
    const p = m.state;
    expect(p.numbers.get("uSpeed")).toEqual([5]);
    expect(p.numbers.get("uTint")).toEqual([1, 0, 0, 1]); // #ff0000, linear
    m.setProperties({ Tint: "#000000" });
    expect(p.numbers.get("uTint")).toEqual([0, 0, 0, 1]);
    expect(p.numbers.get("uSpeed")).toEqual([2]); // back to the graph's default
  });

  it("asks for the mesh's UVs when the graph reads them, even with no texture (the ripple preview drew flat)", () => {
    (engine as unknown as { _isWebGPU: boolean })._isWebGPU = true; // a WGSL material, so the plugin attaches
    const noTexture = { uniforms: [], fragment: { ...compiled().fragment, declarations: "varying vMycoUv: vec2f;" } };
    const reads = compiled({ ...noTexture, vertex: { ...compiled().vertex, offset: null } });
    const ignores = compiled({ ...noTexture, key: "def456", vertex: { declarations: "", body: "", offset: null, varyings: "" } });
    expect(graphUsesUv(reads)).toBe(true);
    expect(graphUsesUv(ignores)).toBe(false);
    const uv1 = (c: CompiledShaderGraph) => {
      const mesh = CreatePlane(`p${c.key}`, { size: 1 }, scene); // has UVs
      mesh.material = createGraphMaterial(scene, "g", c, {}, shared, noTextures).material;
      mesh.material.isReadyForSubMesh(mesh, mesh.subMeshes[0]);
      return (mesh.subMeshes[0].materialDefines as unknown as Record<string, unknown> | null)?.UV1;
    };
    expect(uv1(reads)).toBe(true);
    expect(uv1(ignores)).toBe(false);
  });

  describe("shadows follow the vertex offset", () => {
    /** Materials made after this are WGSL (NullEngine materials are otherwise GLSL); nothing compiles. */
    const asWebGPU = () => ((engine as unknown as { _isWebGPU: boolean })._isWebGPU = true);
    const plugin = (m: PBRMaterial) =>
      m.pluginManager?.getPlugin("MycoGraph") as unknown as { getCustomCode(t: string, l: ShaderLanguage): Record<string, string> | null; _pluginDefineNames?: Record<string, unknown> } | null;

    it("gives a graph with an offset a standalone shadow-depth wrapper whose material runs the graph's vertex code", () => {
      asWebGPU();
      const m = createGraphMaterial(scene, "g", compiled(), {}, shared, noTextures);
      const wrapper = m.material.shadowDepthWrapper!;
      expect(wrapper).not.toBeNull();
      expect(wrapper.standalone).toBe(true);
      const depth = wrapper.baseMaterial as PBRMaterial;
      expect(depth).not.toBe(m.material);
      expect(depth.unlit).toBe(true);
      const vertex = plugin(depth)!.getCustomCode("vertex", ShaderLanguage.WGSL)!;
      expect(vertex.CUSTOM_VERTEX_DEFINITIONS).toContain("varying vMycoUv");
      const inject = Object.entries(vertex).find(([k]) => k.startsWith("!"))![1];
      expect(inject).toContain("positionUpdated = positionUpdated + (vec3f(0.0, n1, 0.0));");
      // No surface code in the shadow pass: only the declarations.
      const fragment = plugin(depth)!.getCustomCode("fragment", ShaderLanguage.WGSL)!;
      expect(Object.keys(fragment)).toEqual(["CUSTOM_FRAGMENT_DEFINITIONS"]);
      expect(fragment.CUSTOM_FRAGMENT_DEFINITIONS).toContain("var tex1: texture_2d<f32>;");
      // Its own define: Babylon caches effects by defines, so it never shares the drawing material's program.
      expect(Object.keys(plugin(depth)!._pluginDefineNames ?? {})).toEqual(["MYCO_GRAPH_DEPTH_abc123"]);
      expect(Object.keys(plugin(m.material)!._pluginDefineNames ?? {})).toEqual(["MYCO_GRAPH_abc123"]);
      m.dispose();
      expect(scene.materials.includes(depth)).toBe(false);
    });

    it("leaves graphs without an offset, and the WebGL2 fallback, to Babylon's own shadow shader", () => {
      const glsl = createGraphMaterial(scene, "g", compiled(), {}, shared, noTextures);
      expect(glsl.material.shadowDepthWrapper).toBeNull();
      asWebGPU();
      const still = createGraphMaterial(scene, "g", compiled({ vertex: { ...compiled().vertex, offset: null } }), {}, shared, noTextures);
      expect(plugin(still.material)).not.toBeNull();
      expect(still.material.shadowDepthWrapper).toBeNull();
    });

    it("compiles one shadow program for every mesh and shadow generator, not one each", () => {
      asWebGPU();
      const m = createGraphMaterial(scene, "g", compiled(), {}, shared, noTextures);
      const wrapper = m.material.shadowDepthWrapper!;
      const internals = wrapper as unknown as { _subMeshToEffect: Map<unknown, [unknown, number]>; _subMeshToDepthWrapper: { mm: Map<unknown, Map<unknown, unknown>> }; _makeEffect(s: unknown, d: string[], g: unknown, p: number): unknown };
      // The depth material's effect, as Babylon records it when the effect is made (no GPU here).
      const base = {
        uniqueId: 42,
        isReady: () => true,
        defines: "#define NORMAL",
        shaderLanguage: ShaderLanguage.WGSL,
        vertexSourceCodeBeforeMigration: "@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\n#define CUSTOM_VERTEX_UPDATE_WORLDPOS\n}",
        fragmentSourceCodeBeforeMigration: "@fragment\nfn main(input: FragmentInputs) -> FragmentOutputs {\n}",
        getUniformNames: () => [],
        getAttributesNames: () => ["position"],
        getUniformBuffersNames: () => [],
        getSamplers: () => [],
        getIndexParameters: () => ({}),
      };
      const tokens: string[] = [];
      const made = { isReady: () => true };
      let vertexSource = "";
      vi.spyOn(engine, "createEffect").mockImplementation(((source: { vertexToken: string; vertexSource: string }) => (tokens.push(source.vertexToken), (vertexSource = source.vertexSource), made)) as never);
      const subMesh = () => ({ _getDrawWrapper: () => undefined });
      const a = subMesh();
      const b = subMesh();
      internals._subMeshToEffect.set(a, [base, 0]);
      internals._subMeshToEffect.set(b, [base, 0]);
      const live = { getShadowMap: () => ({}) };
      const disposed = { getShadowMap: () => null };
      internals._makeEffect(a, ["#define SM_FLOAT 1"], disposed, 1);
      internals._makeEffect(a, ["#define SM_FLOAT 1"], live, 1);
      internals._makeEffect(b, ["#define SM_FLOAT 1"], live, 1);
      expect(tokens).toEqual(["myco-graph-shadow-42", "myco-graph-shadow-42", "myco-graph-shadow-42"]);
      // Babylon's normal bias, reading the PBR shader's world normal.
      expect(vertexSource).toContain("#include<shadowMapVertexNormalBias>(vNormalW,vertexOutputs.vNormalW)");
      // Meeting a new generator drops the disposed one's entry.
      expect([...internals._subMeshToDepthWrapper.mm.get(a)!.keys()]).toEqual([live]);
      // Once made, the next draws reuse it.
      internals._makeEffect(b, ["#define SM_FLOAT 1"], live, 1);
      expect(tokens.length).toBe(3);
    });

    it("finds the spots Babylon's shadow-map code goes in the PBR vertex shader, after the graph's offset", () => {
      const graph = new RegExp(Object.keys(graphShadowCustomCode(compiled(), "vertex")).find((k) => k.startsWith("!"))!.slice(1));
      const src = pbrVertexShaderWGSL.shader;
      const at = src.search(graph);
      expect(at).toBeGreaterThan(-1);
      // The normal bias goes at CUSTOM_VERTEX_UPDATE_WORLDPOS, reading the world normal varying.
      expect(src.indexOf("#define CUSTOM_VERTEX_UPDATE_WORLDPOS")).toBeGreaterThan(at);
      expect(src.indexOf("vertexOutputs.vNormalW=")).toBeGreaterThan(at);
      expect(SHADOW_REMAPPED_VARIABLES).toEqual(["vNormalW", "vertexOutputs.vNormalW"]);
      // No SHADOWDEPTH_METRIC: the metric code goes at the end of main, after the position is final.
      expect(src).not.toContain("SHADOWDEPTH_METRIC");
      expect(src.trimEnd().endsWith("}")).toBe(true);
    });
  });
});
