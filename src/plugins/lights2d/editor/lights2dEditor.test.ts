// The Lights 2D plugin's editor models (ADR 0399, 0413, 0414): the gizmo's lines, handles and drags, outline point editing,
// the 2D Lighting settings edits, which fields each light type shows, and the lit preview.
import { describe, expect, it } from "vitest";
import { tangents2D } from "../../../engine/render/lights2D/tangents";
import { dragLight, lightHandles, lightLines, pointHandles, pressPoints, type LightGizmoFields } from "./lightGizmoModel";
import { hiddenLightFields, LIGHT_FIELDS } from "./lightFields";
import { litPreview } from "./litPreview";
import { customRows, newTextureName, removeTexture, renameProblem, renameTexture } from "./secondaryTexturesModel";
import { addBlendStyle, blendStylesOf, blendStyleNames, moveBlendStyle, removeBlendStyle, renameBlendStyle, setBlendStyle } from "./lights2dSettingsModel";

const point = (over: Partial<LightGizmoFields> = {}): LightGizmoFields => ({ type: "point", innerRadius: 1, outerRadius: 3, innerAngle: 360, outerAngle: 360, shape: [], falloffSize: 0.5, ...over });

describe("the 2D light gizmo", () => {
  it("draws a point light's circles, or its cone when under 360°", () => {
    const full = lightLines(point());
    expect(full).toHaveLength(2);
    expect(full[1]!.dim).toBe(true);
    expect(Math.hypot(...full[0]!.points[0]!)).toBeCloseTo(3);
    const cone = lightLines(point({ innerAngle: 30, outerAngle: 90 }));
    expect(cone[0]!.points[0]).toEqual([0, 0]);
    expect(cone.length).toBe(4); // outer wedge, inner arc, two inner-cone edges
  });

  it("drags radii and angles, keeping inner within outer", () => {
    const f = point();
    expect(Object.keys(lightHandles(f))).toEqual(["outerRadius", "innerRadius", "outerAngle", "innerAngle"]);
    expect(dragLight(f, "outerRadius", [0, 5])).toEqual({ outerRadius: 5 });
    expect(dragLight(f, "outerRadius", [0, 0.5])).toEqual({ outerRadius: 1 });
    expect(dragLight(f, "innerRadius", [9, 0])).toEqual({ innerRadius: 3 });
    const narrowed = dragLight(f, "outerAngle", [1, 1])!;
    expect(narrowed.outerAngle).toBeCloseTo(90);
    expect(narrowed.innerAngle).toBeCloseTo(90); // the inner cone narrows with it
    expect(dragLight(f, "outerAngle", [0.001, -1])).toEqual({ outerAngle: 360 });
    expect(dragLight(point({ outerAngle: 60 }), "innerAngle", [1, 0])).toEqual({ innerAngle: 60 });
  });

  it("edits a freeform light's points, and draws its falloff band", () => {
    const f: LightGizmoFields = { ...point(), type: "freeform", shape: [[0, 0], [2, 0], [2, 2], [0, 2]] };
    expect(lightLines(f)).toHaveLength(2);
    const handles = lightHandles(f);
    expect(handles["p:2"]).toEqual([2, 2]);
    expect(handles["insert:3"]).toEqual([0, 1]);
    expect(dragLight(f, "p:1", [3, -1])).toEqual({ shape: [[0, 0], [3, -1], [2, 2], [0, 2]] });
  });

  it("adds a point mid-edge, removes one with Ctrl (not below three), and drags", () => {
    const tri: [number, number][] = [[0, 0], [2, 0], [1, 2]];
    expect(pressPoints(tri, "insert:0", false)).toEqual({ drag: 1, points: [[0, 0], [1, 0], [2, 0], [1, 2]] });
    expect(pressPoints(tri, "p:1", true)).toEqual({ refused: "An outline needs at least 3 points." });
    expect(pressPoints([...tri, [0, 1]], "p:3", true)).toEqual({ removed: tri });
    expect(pressPoints(tri, "p:0", false)).toMatchObject({ drag: 0 });
    expect(pressPoints(tri, "nope", false)).toBeNull();
    expect(Object.keys(pointHandles(tri, false))).toEqual(["p:0", "p:1", "p:2", "insert:0", "insert:1"]);
  });
});

describe("the Light2D Inspector's fields by type", () => {
  it("hides what a type doesn't use", () => {
    const all = [...new Set(Object.values(LIGHT_FIELDS).flat())];
    expect(hiddenLightFields("global", all)).toContain("outerRadius");
    expect(hiddenLightFields("global", all)).toContain("shadows");
    expect(hiddenLightFields("point", all)).toEqual(["shape", "falloffSize", "sprite"]);
    expect(hiddenLightFields("sprite", all)).not.toContain("sprite");
  });
});

describe("the 2D Lighting settings", () => {
  it("adds, renames, sets, moves and removes blend styles, at most four and never none", () => {
    let d: Record<string, unknown> = {};
    expect(blendStylesOf(d).map((s) => s.name)).toEqual(["Multiply"]);
    d = addBlendStyle(d);
    expect(blendStylesOf(d)[1]).toEqual({ name: "Style", mask: "none", multiply: 0, add: 1 });
    d = renameBlendStyle(d, 1, "Rim");
    expect(renameBlendStyle(d, 1, "Multiply")).toBe(d); // a name in use
    d = setBlendStyle(d, 1, { mask: "r", add: 9 });
    expect(blendStylesOf(d)[1]).toEqual({ name: "Rim", mask: "r", multiply: 0, add: 4 });
    d = moveBlendStyle(d, 1, -1);
    expect(blendStyleNames.names(d)).toEqual(["Rim", "Multiply"]);
    d = addBlendStyle(addBlendStyle(d));
    expect(addBlendStyle(d)).toBe(d);
    let one: Record<string, unknown> = removeBlendStyle(removeBlendStyle(removeBlendStyle(d, 0), 0), 0);
    expect(blendStylesOf(one)).toHaveLength(1);
    expect(removeBlendStyle(one, 0)).toBe(one);
    one = {};
    expect(blendStyleNames.fields).toEqual([{ component: "engine.Light2D", field: "blendStyle" }]);
  });
});

describe("the Secondary Textures tool's lit preview", () => {
  it("lights flat pixels by the angle to the light, and a normal map tilts them", () => {
    const albedo = { width: 2, height: 1, data: new Uint8ClampedArray([200, 200, 200, 255, 200, 200, 200, 255]) };
    const flat = litPreview(albedo, null, { x: 0, y: 0, height: 1000 });
    expect(flat[0]).toBeGreaterThan(195);
    // A normal facing +X (right): the pixel lit from its left gets darker than flat.
    const right = { width: 2, height: 1, data: new Uint8ClampedArray([255, 128, 128, 255, 255, 128, 128, 255]) };
    const fromLeft = litPreview(albedo, right, { x: -100, y: 0, height: 1 });
    const fromRight = litPreview(albedo, right, { x: 100, y: 0, height: 1 });
    expect(fromRight[4]).toBeGreaterThan(fromLeft[4]!);
  });
});

describe("custom secondary textures (ADR 0415)", () => {
  const textures = { normalMap: "asset:n.png", _Rim: "asset:r.png" };
  it("lists custom rows after the built-in maps, with ones not given a texture yet", () => {
    expect(customRows(textures, ["_Glow", "_Rim"])).toEqual(["_Rim", "_Glow"]);
    expect(newTextureName(textures, [])).toBe("_Texture");
    expect(newTextureName({ ...textures, _Texture: "asset:t.png" }, ["_Texture2"])).toBe("_Texture3");
  });

  it("renames in place to a free name graphs can read, and removes", () => {
    expect(Object.keys(renameTexture({ _A: "a", normalMap: "n", _B: "b" }, [], "_A", "_Z"))).toEqual(["_Z", "normalMap", "_B"]);
    expect(renameProblem(textures, [], "_Rim", "normalMap")).toBe("There's already a texture named normalMap.");
    expect(renameProblem(textures, [], "_Rim", "rim light")).toMatch(/letters, digits and _/);
    expect(renameTexture(textures, [], "_Rim", "2nd")).toEqual(textures);
    expect(removeTexture(textures, "_Rim")).toEqual({ normalMap: "asset:n.png" });
  });
});

describe("2D tangents (normal maps on deforming meshes)", () => {
  it("point along the texture's +U, turned with the mesh", () => {
    const quad = { p: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], uv: [0, 0, 1, 0, 1, 1, 0, 1], i: [0, 1, 2, 0, 2, 3] };
    expect([...tangents2D(quad.p, quad.uv, quad.i)].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    // Turned 90° counter-clockwise: +U now points up.
    const turned = [0, 0, 0, 0, 1, 0, -1, 1, 0, -1, 0, 0];
    expect([...tangents2D(turned, quad.uv, quad.i)].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });
});
