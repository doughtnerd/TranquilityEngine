// ADR 0049 on the Babylon backend (ADR 0075): a renderer's overrides of a built-in material go on one
// copy, set in place. A new copy per change rebuilt the renderer's meshes and recompiled its shaders
// every frame while a script faded a colour (the pirates sample's splashes hitched every volley).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBuiltinOverrides, pbr } from "../render/babylon/materials";

describe("Babylon built-in material overrides", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => engine.dispose());

  function base(): PBRMaterial {
    const m = pbr("material:splash", scene);
    m.albedoColor = new Color3(0.5, 0.25, 1);
    m.emissiveColor = new Color3(0.1, 0.2, 0.3);
    m.metallic = 0.2;
    m.roughness = 0.6;
    return m;
  }

  it("changes the copy, never the base", () => {
    const b = base();
    const copy = b.clone("material:splash:Splash");
    applyBuiltinOverrides(copy, b, { color: [1, 1, 1, 0.5], emission: "#ffffff", metalness: 1, clearcoat: 0.7 });
    expect(copy.albedoColor.asArray()).toEqual([1, 1, 1]);
    expect(copy.alpha).toBe(0.5);
    expect(copy.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHABLEND);
    expect(copy.emissiveColor.asArray()).toEqual([1, 1, 1]);
    expect(copy.metallic).toBe(1);
    expect(copy.clearCoat.isEnabled).toBe(true);
    expect(copy.clearCoat.intensity).toBe(0.7);
    expect(b.albedoColor.asArray()).toEqual([0.5, 0.25, 1]);
    expect(b.emissiveColor.asArray()).toEqual([0.1, 0.2, 0.3]);
    expect(b.alpha).toBe(1);
    expect(b.metallic).toBe(0.2);
    expect(b.clearCoat.isEnabled).toBe(false);
  });

  it("goes back to the base's values when an override is cleared", () => {
    const b = base();
    const copy = b.clone("material:splash:Splash");
    applyBuiltinOverrides(copy, b, { color: [0, 0, 0, 0.25], roughness: 0.1, sheen: 0.5 });
    applyBuiltinOverrides(copy, b, {});
    expect(copy.albedoColor.asArray()).toEqual(b.albedoColor.asArray());
    expect(copy.alpha).toBe(1);
    expect(copy.transparencyMode).toBe(b.transparencyMode);
    expect(copy.roughness).toBe(0.6);
    expect(copy.sheen.isEnabled).toBe(false);
  });

  it("converts sRGB override colours to linear, like the material asset's colours", () => {
    const b = base();
    const copy = b.clone("c");
    applyBuiltinOverrides(copy, b, { color: [0.5, 0.5, 0.5, 1] });
    const expected = new Color3(0.5, 0.5, 0.5).toLinearSpace();
    expect(copy.albedoColor.r).toBeCloseTo(expected.r, 6);
    expect(copy.transparencyMode).toBe(b.transparencyMode);
  });

  it("keeps the same colour objects across updates (no allocation per change)", () => {
    const b = base();
    const copy = b.clone("c");
    const albedo = copy.albedoColor;
    for (let i = 0; i < 10; i++) applyBuiltinOverrides(copy, b, { color: [1, 1, 1, 1 - i / 10] });
    expect(copy.albedoColor).toBe(albedo);
    expect(copy.alpha).toBeCloseTo(0.1, 6);
  });
});

describe("materialGraphOfJson", () => {
  it("names a material's shader graph, null for built-in shaders and bad JSON, and caches per JSON object", async () => {
    const { materialGraphOfJson } = await import("../scene/material");
    const graph = { format: "myco.material@1", shader: "asset:shaders/water.shadergraph.json" };
    const lit = { format: "myco.material@1", shader: "lit" };
    expect(materialGraphOfJson(graph)).toBe("asset:shaders/water.shadergraph.json");
    expect(materialGraphOfJson(lit)).toBeNull();
    expect(materialGraphOfJson({ format: "nope" })).toBeNull();
    expect(materialGraphOfJson(undefined)).toBeNull();
    graph.shader = "unlit"; // the same object: the cached answer (Assets.json hands out a new object when the file changes)
    expect(materialGraphOfJson(graph)).toBe("asset:shaders/water.shadergraph.json");
    expect(materialGraphOfJson({ ...graph })).toBeNull();
  });
});
