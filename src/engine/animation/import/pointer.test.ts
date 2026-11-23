// ADR 0371: the KHR_animation_pointer table: one case per target type, texture transforms, escapes, and unmapped ones.
import { describe, expect, it } from "vitest";
import { MATERIAL_POINTERS, parsePointer, unmappedPointerWarning } from "./pointer";

describe("KHR_animation_pointer", () => {
  it("maps node TRS, weights and visibility", () => {
    expect(parsePointer("/nodes/3/translation")).toEqual({ type: "node", node: 3, path: "translation" });
    expect(parsePointer("/nodes/0/rotation")).toEqual({ type: "node", node: 0, path: "rotation" });
    expect(parsePointer("/nodes/1/scale")).toEqual({ type: "node", node: 1, path: "scale" });
    expect(parsePointer("/nodes/1/weights")).toEqual({ type: "node", node: 1, path: "weights" });
    expect(parsePointer("/nodes/2/extensions/KHR_node_visibility/visible")).toEqual({ type: "node", node: 2, path: "visible" });
    expect(parsePointer("/meshes/4/weights")).toEqual({ type: "mesh", mesh: 4 });
  });

  it("maps every listed material property", () => {
    for (const [suffix, m] of Object.entries(MATERIAL_POINTERS)) {
      expect(parsePointer(`/materials/2/${suffix}`), suffix).toEqual({ type: "material", material: 2, field: m.field, value: m.value, textureTransform: false });
    }
    expect(parsePointer("/materials/0/pbrMetallicRoughness/baseColorFactor")).toMatchObject({ field: "color", value: { track: "color", width: 4 } });
    expect(parsePointer("/materials/0/extensions/KHR_materials_emissive_strength/emissiveStrength")).toMatchObject({ field: "emission", value: { width: 1 } });
  });

  it("maps texture transforms on any texture and flags them", () => {
    expect(parsePointer("/materials/1/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset")).toEqual({ type: "material", material: 1, field: "textureTransform.offset", value: { track: "vec2", width: 2 }, textureTransform: true });
    expect(parsePointer("/materials/1/normalTexture/extensions/KHR_texture_transform/rotation")).toMatchObject({ field: "textureTransform.rotation", value: { track: "float", width: 1 }, textureTransform: true });
    expect(parsePointer("/materials/1/extensions/KHR_materials_clearcoat/clearcoatTexture/extensions/KHR_texture_transform/scale")).toMatchObject({ field: "textureTransform.scale", textureTransform: true });
  });

  it("maps lights and cameras", () => {
    expect(parsePointer("/extensions/KHR_lights_punctual/lights/0/color")).toEqual({ type: "light", light: 0, property: "color" });
    expect(parsePointer("/extensions/KHR_lights_punctual/lights/0/intensity")).toMatchObject({ property: "intensity" });
    expect(parsePointer("/extensions/KHR_lights_punctual/lights/0/range")).toMatchObject({ property: "range" });
    expect(parsePointer("/extensions/KHR_lights_punctual/lights/1/spot/innerConeAngle")).toEqual({ type: "light", light: 1, property: "innerConeAngle" });
    expect(parsePointer("/extensions/KHR_lights_punctual/lights/1/spot/outerConeAngle")).toMatchObject({ property: "outerConeAngle" });
    expect(parsePointer("/cameras/0/perspective/yfov")).toEqual({ type: "camera", camera: 0, property: "yfov" });
    expect(parsePointer("/cameras/0/perspective/znear")).toMatchObject({ property: "znear" });
    expect(parsePointer("/cameras/0/orthographic/zfar")).toMatchObject({ property: "zfar" });
    expect(parsePointer("/cameras/0/orthographic/ymag")).toMatchObject({ property: "ymag" });
  });

  it("leaves everything else unmapped", () => {
    for (const p of ["/cameras/0/orthographic/xmag", "/cameras/0/perspective/aspectRatio", "/materials/0/doubleSided", "/nodes/x/translation", "/nodes/01/translation", "nodes/0/translation", "/asset/version", "/materials/0/extensions/KHR_materials_unknown/f", ""]) {
      expect(parsePointer(p), p).toBeNull();
    }
  });

  it("never matches an escaped segment (no listed property has / or ~ in its name)", () => {
    expect(parsePointer("/nodes/0/translation~1x")).toBeNull();
    expect(parsePointer("/extensions/KHR_lights_punctual/lights/0/spot~1innerConeAngle")).toBeNull(); // one segment, not two
  });

  it("lists unmapped pointers once each in one warning", () => {
    expect(unmappedPointerWarning([])).toBeNull();
    expect(unmappedPointerWarning(["/a/b", "/a/b"])).toBe("1 animation pointer targets properties the engine doesn't import, so it isn't animated: /a/b.");
    expect(unmappedPointerWarning(["/a", "/b"])).toMatch(/^2 animation pointers target .*: \/a, \/b\.$/);
  });
});
