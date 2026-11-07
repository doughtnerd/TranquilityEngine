import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { pbrPixelShaderWGSL } from "@babylonjs/core/ShadersWGSL/pbr.fragment.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphMaterial, graphCustomCode, REFLECTIVITY_ANCHOR, type GraphShared } from "../render/babylon/graphMaterial";
import { defaultShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import { nodePorts } from "../render/shaderGraph/nodes";

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

// The graph's physical values reach Babylon's PBR shader (ADR 0052): the plugin replaces each layer's
// uniform reads in the fragment shader, and the material switches the layers on so Babylon compiles them.
describe("physical shader graphs on Babylon", () => {
  const allFeatures = (): ShaderGraph => {
    const g = graph([node("f", "float", { inputs: { x: 0.7 } })], [["f.out", "output.clearcoat"]], { target: "physical" });
    outputOf(g).inputs = { clearcoatRoughness: 0.2, sheenColor: [1, 0.5, 0.25], sheenRoughness: 0.4, transmission: 0.8, thickness: 0.3, ior: 1.33, iridescence: 0.6, specularIntensity: 0.5 };
    return g;
  };
  /** Babylon's raw PBR WGSL with the plugin's regular-expression injections applied, as Babylon applies them. */
  const inject = (code: Record<string, string>): string => {
    let src = pbrPixelShaderWGSL.shader;
    for (const [key, value] of Object.entries(code)) {
      if (!key.startsWith("!")) continue;
      const rx = new RegExp(key.slice(1), "g");
      expect(rx.test(src), `${key} matches Babylon's PBR fragment shader`).toBe(true);
      src = src.replace(new RegExp(key.slice(1), "g"), () => value);
    }
    return src;
  };

  it("replaces every layer's uniform with the graph's values, in Babylon's own fragment shader", () => {
    const c = compileShaderGraph(allFeatures());
    expect(c.problems).toEqual([]);
    const p = c.fragment.physical!;
    expect(Object.keys(p).sort()).toEqual(["clearcoat", "clearcoatRoughness", "ior", "iridescence", "sheenColor", "sheenRoughness", "specularIntensity", "thickness", "transmission"]);
    const code = graphCustomCode(c, "fragment");
    const src = inject(code);
    expect(src).toContain(`vec2f(${p.clearcoat}, ${p.clearcoatRoughness})`);
    expect(src).not.toMatch(/uniforms\.vClearCoatParams\b/);
    expect(src).toContain(`vec4f(${p.sheenColor}, 1.0)`);
    expect(src).not.toMatch(/uniforms\.vSheenColor\b/);
    expect(src).not.toMatch(/uniforms\.vSheenRoughness\b/);
    expect(src).toContain(`vec3f(${p.transmission}, 0.0, 0.0)`);
    expect(src).toContain(`vec2f(0.0, ${p.thickness})`);
    expect(src).toContain(`1.0 / ${p.ior}`);
    expect(src).toContain(`vec4f(${p.iridescence}, uniforms.vIridescenceParams.yzw)`);
    expect(src).toContain(`vec4f(uniforms.vMetallicReflectanceFactors.rgb, ${p.specularIntensity})`);
    // The IOR also sets the base layer's F0 at the reflectivity block, beside metallic and roughness.
    expect(code[REFLECTIVITY_ANCHOR]).toContain(`${p.ior}, pow((${p.ior} - 1.0) / (${p.ior} + 1.0), 2.0)`);
    // Each value is computed in the fragment body, at the start of main, before the layers read it.
    for (const v of Object.values(p)) expect(c.fragment.body).toContain(`${v}`);
  });

  it("injects nothing for physical features the graph leaves off, and keeps the material's IOR", () => {
    const g = graph([node("f", "float", { inputs: { x: 0.7 } })], [["f.out", "output.clearcoat"]], { target: "physical" });
    const code = graphCustomCode(compileShaderGraph(g), "fragment");
    const keys = Object.keys(code).join(" ");
    expect(keys).toContain("vClearCoatParams");
    for (const k of ["vSheenColor", "vSubSurfaceIntensity", "vThicknessParam", "vRefractionInfos", "vIridescenceParams", "vMetallicReflectanceFactors"]) expect(keys).not.toContain(k);
    expect(code[REFLECTIVITY_ANCHOR]).toContain("uniforms.vReflectivityColor.zw");
    // Lit graphs have no physical part at all.
    expect(Object.keys(graphCustomCode(compileShaderGraph(defaultShaderGraph()), "fragment")).join(" ")).not.toContain("vClearCoatParams");
  });

  describe("on the NullEngine", () => {
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

    it("switches on the PBR layers the graph uses, so Babylon compiles them in", () => {
      const m = createGraphMaterial(scene, "glass", compileShaderGraph(allFeatures()), {}, shared, noTextures).material;
      expect(m.clearCoat.isEnabled).toBe(true);
      expect(m.sheen.isEnabled).toBe(true);
      expect(m.sheen.roughness).not.toBeNull();
      expect(m.subSurface.isRefractionEnabled).toBe(true);
      expect(m.iridescence.isEnabled).toBe(true);
    });

    it("leaves the layers a graph doesn't use off", () => {
      const g = graph([node("f", "float", { inputs: { x: 0.7 } })], [["f.out", "output.clearcoat"]], { target: "physical" });
      const m = createGraphMaterial(scene, "coat", compileShaderGraph(g), {}, shared, noTextures).material;
      expect(m.clearCoat.isEnabled).toBe(true);
      expect(m.sheen.isEnabled).toBe(false);
      expect(m.subSurface.isRefractionEnabled).toBe(false);
      expect(m.iridescence.isEnabled).toBe(false);
    });
  });
});
