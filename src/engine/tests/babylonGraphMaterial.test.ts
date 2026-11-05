// ADR 0075 stage 4: shader graph materials on the Babylon backend — where the plugin puts a graph's
// WGSL in Babylon's PBR shaders, its uniforms and textures, and property overrides (ADR 0049).
// Headless on Babylon's NullEngine with a hand-made compiled graph, so it doesn't depend on the compiler.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphMaterial, graphCustomCode, graphUniformBuffer, type GraphShared } from "../render/babylon/graphMaterial";
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
    expect(graphUniformBuffer(compiled()).map((u) => u.name)).toEqual(["uMycoTime", "uMycoResolution", "uTint", "uSpeed"]);
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

  it("refuses a graph compiled to GLSL", () => {
    expect(() => createGraphMaterial(scene, "g", compiled({ language: "glsl" }), {}, shared, noTextures)).toThrow(/WGSL/);
  });
});
