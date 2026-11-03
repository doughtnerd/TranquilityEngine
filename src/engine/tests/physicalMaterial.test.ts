import { describe, expect, it } from "vitest";
import { Color } from "../core/math";
import { defaultMaterialSettings, formatMaterial, materialGraph, materialJSON, parseMaterial } from "../scene/material";

const parse = (raw: Record<string, unknown>) => parseMaterial({ format: "myco.material@1", ...raw });

describe("physical materials (ADR 0052)", () => {
  it("round-trips, writing only non-defaults", () => {
    const s = defaultMaterialSettings();
    s.shader = "physical";
    s.clearcoat = 1;
    s.clearcoatRoughness = 0.1;
    s.sheen = 0.5;
    s.sheenColor = Color.from("#ff0000");
    s.sheenRoughness = 0.3;
    s.transmission = 0.9;
    s.thickness = 2;
    s.ior = 1.33;
    s.iridescence = 1;
    s.iridescenceIOR = 1.8;
    s.anisotropy = 0.7;
    s.anisotropyRotation = 45;
    s.specularIntensity = 0.5;
    s.specularColor = Color.from("#00ff00");
    const json = materialJSON(s);
    expect(Object.keys(json).sort()).toEqual(
      ["format", "shader", "clearcoat", "clearcoatRoughness", "sheen", "sheenColor", "sheenRoughness", "transmission", "thickness", "ior", "iridescence", "iridescenceIOR", "anisotropy", "anisotropyRotation", "specularIntensity", "specularColor"].sort(),
    );
    const back = parseMaterial(JSON.parse(formatMaterial(s)));
    expect(back.problems).toEqual([]);
    expect(back.settings).toEqual(s);
    expect(materialJSON(parse({ shader: "physical", clearcoat: 0.2 }).settings)).toEqual({ format: "myco.material@1", shader: "physical", clearcoat: 0.2 });
  });

  it("defaults are not written", () => {
    const s = defaultMaterialSettings();
    s.shader = "physical";
    expect(materialJSON(s)).toEqual({ format: "myco.material@1", shader: "physical" });
  });

  it("reports bad values and uses the defaults", () => {
    const d = defaultMaterialSettings();
    const { settings, problems } = parse({ shader: "physical", clearcoat: 2, ior: 0.5, sheenColor: "red", thickness: -1, anisotropyRotation: "x" });
    expect(problems).toHaveLength(5);
    for (const key of ["clearcoat", "ior", "sheenColor", "thickness", "anisotropyRotation"]) expect(problems.some((p) => p.includes(`"${key}"`))).toBe(true);
    expect(settings.shader).toBe("physical");
    expect(settings.clearcoat).toBe(d.clearcoat);
    expect(settings.ior).toBe(d.ior);
    expect(settings.thickness).toBe(d.thickness);
    expect(settings.anisotropyRotation).toBe(d.anisotropyRotation);
    expect(settings.sheenColor.toHex()).toBe(d.sheenColor.toHex());
  });

  it("accepts any finite rotation and ior up to 2.333", () => {
    const { settings, problems } = parse({ anisotropyRotation: -720, ior: 2.333, iridescenceIOR: 1 });
    expect(problems).toEqual([]);
    expect(settings.anisotropyRotation).toBe(-720);
    expect(settings.ior).toBe(2.333);
  });

  it("is not a shader graph", () => {
    expect(materialGraph({ shader: "physical" })).toBeNull();
    expect(materialGraph({ shader: "asset:shaders/a.shadergraph.json" })).toBe("asset:shaders/a.shadergraph.json");
  });

  it("leaves a lit material's file unchanged by the new fields", () => {
    const s = defaultMaterialSettings();
    s.color = Color.from("#ff8800");
    s.metalness = 1;
    s.roughness = 0.2;
    expect(materialJSON(s)).toEqual({ format: "myco.material@1", color: "#ff8800", metalness: 1, roughness: 0.2 });
    expect(materialJSON(defaultMaterialSettings())).toEqual({ format: "myco.material@1" });
  });
});
