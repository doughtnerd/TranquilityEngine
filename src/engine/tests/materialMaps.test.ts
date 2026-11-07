// ADR 0118: material assets hold every texture and value a glTF surface has (the base maps, alpha
// mode, the physical layers' textures), and physical shader graphs gain the layers' remaining inputs.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Scene } from "@babylonjs/core/scene.js";
import { pbrPixelShaderWGSL } from "@babylonjs/core/ShadersWGSL/pbr.fragment.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLEARCOAT_NORMAL_ANCHOR, SPECULAR_ANCHOR, enablePhysicalLayers, graphCustomCode } from "../render/babylon/graphMaterial";
import { applyBuiltinSettings, builtinTextureSlots } from "../render/babylon/materials";
import { compileShaderGraph } from "../render/shaderGraph/compile";
import { Color } from "../core/math";
import { MATERIAL_MAPS, defaultMaterialSettings, materialJSON, parseMaterial } from "../scene/material";
import { defaultShaderGraph, type GraphNode, type ShaderGraph } from "../scene/shaderGraph";

describe("material asset maps (ADR 0118)", () => {
  it("reads and writes every texture slot and the new values, writing only what differs", () => {
    const raw = {
      format: "myco.material@1",
      shader: "physical",
      emissionMap: "asset:t/e.png",
      clearcoatNormalMap: "asset:t/cn.png",
      anisotropyMap: "asset:t/a.png",
      emissionIntensity: 4,
      alphaMode: "mask",
      alphaCutoff: 0.3,
      attenuationColor: "#ff0000",
      attenuationDistance: 2,
      iridescenceThicknessMin: 200,
    };
    const { settings, problems } = parseMaterial(raw);
    expect(problems).toEqual([]);
    expect([settings.emissionMap, settings.clearcoatNormalMap, settings.anisotropyMap, settings.metalRoughMap]).toEqual(["asset:t/e.png", "asset:t/cn.png", "asset:t/a.png", ""]);
    expect([settings.emissionIntensity, settings.alphaMode, settings.alphaCutoff, settings.attenuationDistance, settings.iridescenceThicknessMin, settings.iridescenceThicknessMax]).toEqual([4, "mask", 0.3, 2, 200, 400]);
    expect(materialJSON(settings)).toEqual(raw);
    expect(materialJSON(defaultMaterialSettings())).toEqual({ format: "myco.material@1" });
    const bad = parseMaterial({ format: "myco.material@1", occlusionStrength: 3, alphaMode: "cutout", sheenColorMap: 4 }, "m");
    expect(bad.problems).toEqual(['m: "sheenColorMap" should be an asset path; using the default.', 'm: "occlusionStrength" should be a number from 0 to 1; using the default.', 'm: "alphaMode" should be "auto", "opaque", "blend" or "mask"; using the default.']);
  });

  describe("on Babylon", () => {
    let engine: NullEngine;
    let scene: Scene;
    beforeEach(() => {
      engine = new NullEngine();
      scene = new Scene(engine);
    });
    afterEach(() => engine.dispose());

    it("puts each slot where the shader uses it, skipping physical slots on lit materials", () => {
      const settings = defaultMaterialSettings();
      for (const m of MATERIAL_MAPS) settings[m.key] = `asset:t/${m.key}.png`;
      settings.normalMap = "asset:t/n.png";
      settings.occlusionStrength = 0.5;
      settings.clearcoatNormalScale = 0.25;
      const lit = new PBRMaterial("lit", scene);
      expect(builtinTextureSlots(lit, settings).map((s) => s.image)).toEqual(["t/n.png", "t/emissionMap.png", "t/metalRoughMap.png", "t/occlusionMap.png"]);
      settings.shader = "physical";
      const m = new PBRMaterial("physical", scene);
      const slots = builtinTextureSlots(m, settings);
      expect(slots).toHaveLength(2 + MATERIAL_MAPS.length - 1); // no base texture set; the normal map and every map
      expect(slots.find((s) => s.image === "t/sheenColorMap.png")!.srgb).toBe(true);
      expect(slots.find((s) => s.image === "t/thicknessMap.png")!.srgb).toBe(false);
      for (const s of slots) s.apply(new Texture(null, scene));
      expect(m.emissiveTexture).not.toBeNull();
      expect(m.metallicTexture && m.useRoughnessFromMetallicTextureGreen && m.useMetallnessFromMetallicTextureBlue).toBeTruthy();
      expect(m.ambientTextureStrength).toBe(0.5);
      expect(m.clearCoat.texture && m.clearCoat.textureRoughness && m.clearCoat.bumpTexture).toBeTruthy();
      expect(m.clearCoat.bumpTexture!.level).toBe(0.25);
      expect(m.sheen.texture && m.sheen.textureRoughness).toBeTruthy();
      expect(m.subSurface.refractionIntensityTexture && m.subSurface.thicknessTexture && m.subSurface.useGltfStyleTextures).toBeTruthy();
      expect(m.iridescence.texture && m.iridescence.thicknessTexture).toBeTruthy();
      expect(m.anisotropy.texture).toBeTruthy();
      expect(m.metallicReflectanceTexture && m.reflectanceTexture && m.useOnlyMetallicFromMetallicReflectanceTexture).toBeTruthy();
    });

    it("applies alpha mode, emission intensity, attenuation and the iridescence thickness range", () => {
      const s = defaultMaterialSettings();
      s.shader = "physical";
      s.alphaMode = "mask";
      s.alphaCutoff = 0.4;
      s.emission = new Color(1, 0, 0, 1);
      s.emissionIntensity = 3;
      s.attenuationDistance = 2;
      s.iridescenceThicknessMin = 200;
      s.iridescenceThicknessMax = 800;
      const m = new PBRMaterial("m", scene);
      applyBuiltinSettings(m, s);
      expect(m.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHATEST);
      expect(m.alphaCutOff).toBe(0.4);
      expect(m.emissiveColor.r).toBeCloseTo(3);
      expect(m.subSurface.tintColorAtDistance).toBe(2);
      expect([m.iridescence.minimumThickness, m.iridescence.maximumThickness]).toEqual([200, 800]);
      const opaque = new PBRMaterial("o", scene);
      const o = defaultMaterialSettings();
      o.color = new Color(1, 1, 1, 0.5);
      o.alphaMode = "opaque";
      applyBuiltinSettings(opaque, o);
      expect(opaque.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_OPAQUE);
    });
  });
});

describe("physical shader graph layer inputs (ADR 0118)", () => {
  const graph = (inputs: Record<string, unknown>, edges: [string, string][] = [], nodes: GraphNode[] = []): ShaderGraph => ({
    ...defaultShaderGraph(),
    target: "physical",
    nodes: [{ id: "output", type: "output", position: [0, 0], inputs: inputs as GraphNode["inputs"] }, ...nodes],
    edges: edges.map(([from, to]) => ({ from, to })),
  });
  /** Babylon's raw PBR WGSL with the plugin's injections applied, checking each anchor matches. */
  const inject = (code: Record<string, string>): string => {
    let src = pbrPixelShaderWGSL.shader;
    for (const [key, value] of Object.entries(code)) {
      if (!key.startsWith("!")) continue;
      expect(new RegExp(key.slice(1), "g").test(src), `${key} matches Babylon's PBR fragment shader`).toBe(true);
      src = src.replace(new RegExp(key.slice(1), "g"), () => value);
    }
    return src;
  };

  it("compiles specular colour, iridescence thickness, anisotropy and its direction into Babylon's shader", () => {
    const c = compileShaderGraph(graph({ specularColor: [1, 0.5, 0], iridescence: 1, iridescenceThickness: 250, anisotropy: 0.7, anisotropyDirection: [0, 1] }));
    expect(c.problems).toEqual([]);
    const p = c.fragment.physical!;
    expect(Object.keys(p).sort()).toEqual(["anisotropy", "anisotropyDirection", "iridescence", "iridescenceThickness", "specularColor"]);
    const code = graphCustomCode(c, "fragment");
    expect(code[SPECULAR_ANCHOR]).toBe(`var metallicReflectanceFactors: vec4f = vec4f(${p.specularColor}, uniforms.vMetallicReflectanceFactors.a);`);
    const src = inject(code);
    expect(src).toContain(`vec4f(${p.iridescence}, uniforms.vIridescenceParams.y, ${p.iridescenceThickness}, ${p.iridescenceThickness})`);
    expect(src).toContain(`vec3f(${p.anisotropyDirection}, ${p.anisotropy})`);
    expect(src).not.toMatch(/uniforms\.vAnisotropy\b/);
  });

  it("leaves iridescence thickness out without iridescence, and turns anisotropy on in the material", () => {
    expect(compileShaderGraph(graph({ iridescenceThickness: 250 })).fragment.physical).toEqual({});
    const engine = new NullEngine();
    try {
      const m = new PBRMaterial("m", new Scene(engine));
      enablePhysicalLayers(m, { anisotropy: "a" });
      expect(m.anisotropy.isEnabled).toBe(true);
      expect(m.anisotropy.legacy).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it("hands a connected clearcoat normal to the clear coat block, with the tangent frame", () => {
    const c = compileShaderGraph(graph({ clearcoat: 1 }, [["n.out", "output.clearcoatNormal"]], [{ id: "n", type: "vector3", position: [0, 0], inputs: { x: 0, y: 0.2, z: 1 } }]));
    expect(c.problems).toEqual([]);
    expect(c.fragment.physical).toHaveProperty("clearcoatNormal");
    const code = graphCustomCode(c, "fragment");
    expect(code.CUSTOM_FRAGMENT_DEFINITIONS).toContain("fn mycoBabylonTangentFrame");
    expect(c.vertex.varyings).toContain("vMycoUv");
    const src = inject(code);
    expect(code[CLEARCOAT_NORMAL_ANCHOR]).toContain(`* (${c.fragment.physical!.clearcoatNormal})`);
    expect(src).toContain("clearcoatOut = clearcoatBlock(fragmentInputs.vPositionW, normalize(mycoBabylonTangentFrame(");
    // Unconnected, it compiles nothing.
    expect(compileShaderGraph(graph({ clearcoat: 1 })).fragment.physical).not.toHaveProperty("clearcoatNormal");
  });
});
