import { afterEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine, GameObject, Light2D, SceneManager, ShadowCaster2D, SpriteRenderer, Vector2 } from "../../myco";
import { resolveSettings, settingsIssues } from "../core/settings";
import { layerBatches } from "../render/lights2D/layerBatches";
import { falloffExponent, freeformAttenuation, freeformMesh, pointAttenuation } from "../render/lights2D/lightShapes";
import { LIGHT2D_SHADER } from "../render/lights2D/lightShader";
import { blendStyleIndex, parseLighting2D } from "../render/lights2D/settings";
import { casterFillMesh, outlineSegments, shadowEdgeMesh, shadowFactor } from "../render/lights2D/shadowGeometry";
import { formatImportSettings, parseImportSettings } from "../scene/importSettings";

// 2D lighting's renderer-neutral parts (ADR 0399, 0400, 0401): settings, layer batches, light shapes, shadow geometry,
// the sidecar's secondary textures and outlines, and Light2D.sampleAt on a headless World.

describe("lighting2D settings", () => {
  it("defaults to one Multiply style, and reads styles leniently", () => {
    expect(resolveSettings({}).lighting2D.blendStyles).toEqual([{ name: "Multiply", mask: "none", multiply: 1, add: 0 }]);
    const { settings, problems } = parseLighting2D({
      blendStyles: [
        { name: "Multiply" },
        { name: "Rim", mask: "r", multiply: 0, add: 2 },
        { name: "Rim" },
        { name: "Bad", mask: "q", add: 9 },
        { name: "Four" },
        { name: "Five" },
      ],
    });
    expect(settings.blendStyles.map((s) => s.name)).toEqual(["Multiply", "Rim", "Bad", "Four"]);
    expect(settings.blendStyles[1]).toEqual({ name: "Rim", mask: "r", multiply: 0, add: 2 });
    expect(settings.blendStyles[2]).toEqual({ name: "Bad", mask: "none", multiply: 1, add: 0 });
    expect(problems).toHaveLength(4);
    expect(blendStyleIndex(settings, "Rim")).toBe(1);
    expect(blendStyleIndex(settings, "Nope")).toBe(0);
  });

  it("is a runtime project.json section, so its problems reach the start-up warnings", () => {
    const { problems } = settingsIssues({ lighting2D: { blendStyles: "x" } } as never);
    expect(problems.map((p) => p.field)).toContain("lighting2D");
  });
});

describe("layer batches", () => {
  const all = (style = 0, directional = false) => ({ layers: null, style, directional });
  it("puts consecutive layers with the same lights in one batch, and leaves untargeted layers unlit", () => {
    const b = layerBatches(4, [all(), { layers: [2], style: 1, directional: true }], 8);
    expect(b.batches.map((x) => x.layers)).toEqual([[0, 1], [2], [3]]);
    expect(b.batches[1]).toMatchObject({ lights: [0, 1], styles: [0, 1], directional: true });
    expect([...b.layerBatch]).toEqual([0, 0, 1, 2]);
    const gaps = layerBatches(3, [{ layers: [0, 2], style: 0, directional: false }], 8);
    expect([...gaps.layerBatch]).toEqual([0, -1, 1]);
  });

  it("merges the highest batches past the cap", () => {
    const lights = [0, 1, 2].map((l) => ({ layers: [l], style: 0, directional: false }));
    const b = layerBatches(3, lights, 2);
    expect(b.merged).toBe(1);
    expect(b.batches.map((x) => [x.layers, x.lights])).toEqual([[[0], [0]], [[1, 2], [1, 2]]]);
    expect(layerBatches(3, [], 2).batches).toEqual([]);
  });
});

describe("light shapes", () => {
  const point = { innerRadius: 1, outerRadius: 3, innerAngle: 360, outerAngle: 360, falloff: 0 };
  it("falls off a point light between its radii, and cuts its cone along +Y", () => {
    expect(pointAttenuation(point, 0.5, 0)).toBe(1);
    expect(pointAttenuation(point, 2, 0)).toBeCloseTo(0.5);
    expect(pointAttenuation(point, 3, 0)).toBe(0);
    expect(pointAttenuation({ ...point, falloff: 1 }, 2, 0)).toBeCloseTo(0.5 ** 4);
    const spot = { ...point, innerAngle: 60, outerAngle: 90 };
    expect(pointAttenuation(spot, 0, 2)).toBeCloseTo(0.5);
    expect(pointAttenuation(spot, 2, 0)).toBe(0);
    expect(pointAttenuation(spot, 0, -2)).toBe(0);
    const at40 = pointAttenuation(spot, Math.sin((40 * Math.PI) / 180) * 2, Math.cos((40 * Math.PI) / 180) * 2);
    expect(at40).toBeGreaterThan(0);
    expect(at40).toBeLessThan(0.5);
  });

  it("fills a freeform polygon and fades its band; its mesh has the band's outer ring at alpha 0", () => {
    const square: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    expect(freeformAttenuation(square, 1, 0, 0)).toBe(1);
    expect(freeformAttenuation(square, 1, 1.5, 0)).toBeCloseTo(0.5);
    expect(freeformAttenuation(square, 1, 3, 0)).toBe(0);
    const mesh = freeformMesh([...square].reverse(), 1)!;
    expect(mesh.positions.length).toBe(16);
    expect([...mesh.alpha]).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(mesh.indices.length).toBe(6 + 4 * 6);
    const outer = Math.max(...[...mesh.positions].map(Math.abs));
    expect(outer).toBeCloseTo(2); // the corner is pushed out √2 along its mitre, so the band is 1 wide along each edge
    expect(freeformMesh([[0, 0], [1, 1]], 1)).toBeNull();
  });
});

describe("the light shader's maths (KSL, ADR 0250)", () => {
  it("draws point lights by the rule sampleAt reads", () => {
    const atten = LIGHT2D_SHADER.js().fn("myco2DPointAtten");
    const shapes = [
      { innerRadius: 0, outerRadius: 3, innerAngle: 360, outerAngle: 360, falloff: 0.5 },
      { innerRadius: 1, outerRadius: 4, innerAngle: 40, outerAngle: 100, falloff: 0 },
      { innerRadius: 2, outerRadius: 2, innerAngle: 0, outerAngle: 30, falloff: 1 },
    ];
    for (const s of shapes) {
      const outer = Math.min(Math.max(s.outerAngle, 0), 360);
      const vec = [s.innerRadius, s.outerRadius, outer >= 360 ? 180 : Math.min(Math.max(s.innerAngle, 0), outer) / 2, outer >= 360 ? 180 : outer / 2];
      for (const [x, y] of [[0, 0], [0.5, 0.5], [0, 2], [1.5, 1.5], [-1, -2.5], [0.3, 3.9], [3, 0]] as const) {
        expect(atten([x, y], vec, falloffExponent(s.falloff)) as number).toBeCloseTo(pointAttenuation(s, x, y), 5);
      }
    }
  });

  it("composes blend styles, masks and directional light", () => {
    const p = LIGHT2D_SHADER.js();
    expect(p.fn("myco2DCompose")([0.5, 0.5, 0.5], [2, 1, 0], [0, 0, 0.25])).toEqual([1, 0.5, 0.25]);
    expect(p.fn("myco2DMask")([0.1, 0.2, 0.3, 0.4], -1)).toBe(1);
    expect(p.fn("myco2DMask")([0.1, 0.2, 0.3, 0.4], 2)).toBeCloseTo(0.3);
    const facing = p.fn("myco2DDirectional")([1, 1, 1], [0, 0, 2], [0, 0, 1]) as number[];
    expect(facing[0]).toBeCloseTo(1);
    const away = p.fn("myco2DDirectional")([1, 1, 1], [-1, 0, 0], [1, 0, 0]) as number[];
    expect(away[0]).toBe(0);
    const dir = p.fn("myco2DLightDir")([3, 4], 0, [0, 0]) as number[];
    expect(dir[0]).toBeCloseTo(0.6);
  });
});

describe("shadow geometry", () => {
  const box: [number, number][] = [[1, -1], [2, -1], [2, 1], [1, 1]];
  it("makes a quad per edge with its far end extruded, and fills loops", () => {
    const segs = outlineSegments([box], [[[0, 5], [1, 5], [2, 6]]]);
    expect(segs.length / 4).toBe(4 + 2);
    const mesh = shadowEdgeMesh(segs);
    expect(mesh.edges).toBe(6);
    expect([...mesh.extrude.slice(0, 4)]).toEqual([0, 0, 1, 1]);
    expect(mesh.indices.length).toBe(36);
    expect(casterFillMesh([box])!.indices.length).toBe(6);
  });

  it("shadows a point behind a caster, but not one inside it unless it self-shadows", () => {
    const caster = { segments: outlineSegments([box], []), loops: [box], selfShadows: false };
    expect(shadowFactor(0, 0, 3, 0, [caster])).toBe(0);
    expect(shadowFactor(0, 0, 0, 3, [caster])).toBe(1);
    expect(shadowFactor(0, 0, 1.5, 0, [caster])).toBe(1);
    expect(shadowFactor(0, 0, 1.5, 0, [{ ...caster, selfShadows: true }])).toBe(0);
  });
});

describe("sprite sidecars (ADR 0401)", () => {
  it("reads and writes secondary textures, the normal map convention and slice outlines", () => {
    const raw = {
      format: "myco.import@1",
      secondaryTextures: { normalMap: "asset:hero_n.png", maskMap: "asset:hero_m.png", _Custom: "asset:c.png" },
      normalMapGreen: "down",
      sprites: [{ name: "a", rect: [0, 0, 8, 8], pivot: [0.5, 0.5], outline: [[[0, 0], [8, 0], [4, 8]], [[1, 1]]] }],
    };
    const { settings, problems } = parseImportSettings(raw);
    expect(settings.secondaryTextures).toEqual(raw.secondaryTextures);
    expect(settings.normalMapGreen).toBe("down");
    expect(settings.sprites[0]!.outline).toEqual([[[0, 0], [8, 0], [4, 8]]]);
    expect(problems).toEqual(['import settings: secondaryTextures["_Custom"] isn\'t a name lit sprites read (normalMap, maskMap); kept.']);
    const again = parseImportSettings(JSON.parse(formatImportSettings(settings)));
    expect(again.settings.secondaryTextures).toEqual(settings.secondaryTextures);
    expect(again.settings.sprites[0]!.outline).toEqual(settings.sprites[0]!.outline);
    expect(again.settings.normalMapGreen).toBe("down");
    expect(formatImportSettings(parseImportSettings({ format: "myco.import@1" }).settings)).not.toContain("secondaryTextures");
  });
});

describe("Light2D.sampleAt", () => {
  const engines: Engine[] = [];
  afterEach(() => {
    for (const e of engines.splice(0)) e.dispose();
    Assets.clearSources();
  });
  async function headless(): Promise<void> {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default"] }, lighting2D: { blendStyles: [{ name: "Multiply", mask: "none", multiply: 1, add: 0 }, { name: "Glow", mask: "none", add: 1, multiply: 0 }] } } });
    engines.push(engine);
    await SceneManager.load("s.json");
  }
  const light = (fields: Partial<Light2D>, x = 0, y = 0) => {
    const node = GameObject.create("light");
    node.transform!.position.set(x, y, 0);
    return Object.assign(node.addComponent(Light2D), fields);
  };

  it("adds global and point lights on the targeted layer and blend style, in linear light", async () => {
    await headless();
    light({ type: "global", intensity: 0.5 });
    light({ type: "point", innerRadius: 0, outerRadius: 2, falloff: 0 }, 4, 0);
    light({ type: "global", intensity: 2, targetSortingLayers: ["Back"] });
    light({ type: "global", intensity: 3, blendStyle: "Glow" });
    expect(Light2D.sampleAt(new Vector2(0, 0)).r).toBeCloseTo(0.5);
    expect(Light2D.sampleAt(new Vector2(3, 0)).r).toBeCloseTo(1);
    expect(Light2D.sampleAt(new Vector2(0, 0), "Back").r).toBeCloseTo(2.5);
    expect(Light2D.sampleAt(new Vector2(0, 0), "Default", "Glow").g).toBeCloseTo(3);
    const red = light({ type: "global", intensity: 1 });
    red.color = new Color(0.5, 0, 0, 1);
    expect(Light2D.sampleAt(new Vector2(0, 0)).r).toBeCloseTo(0.5 + 0.214, 2); // sRGB 0.5 is linear 0.214
  });

  it("shadows a point behind a ShadowCaster2D from a light with shadows", async () => {
    await headless();
    light({ type: "point", innerRadius: 10, outerRadius: 20, shadows: true, shadowStrength: 0.75 });
    const wall = GameObject.create("wall");
    wall.transform!.position.set(2, 0, 0);
    Object.assign(wall.addComponent(ShadowCaster2D), { shape: "custom", path: [new Vector2(-0.5, -1), new Vector2(0.5, -1), new Vector2(0.5, 1), new Vector2(-0.5, 1)] });
    expect(Light2D.sampleAt(new Vector2(4, 0)).r).toBeCloseTo(0.25);
    expect(Light2D.sampleAt(new Vector2(0, 4)).r).toBeCloseTo(1);
    expect(Light2D.sampleAt(new Vector2(2, 0)).r).toBeCloseTo(1); // its own face stays lit
  });

  it("casts from a sprite's rectangle when the shape is auto and there's nothing better", async () => {
    await headless();
    light({ type: "point", innerRadius: 10, outerRadius: 20, shadows: true });
    const crate = GameObject.create("crate");
    crate.transform!.position.set(2, 0, 0);
    Object.assign(crate.addComponent(SpriteRenderer), { size: new Vector2(1, 1) });
    crate.addComponent(ShadowCaster2D);
    expect(Light2D.sampleAt(new Vector2(4, 0)).r).toBeCloseTo(0);
    expect(Light2D.sampleAt(new Vector2(4, 3)).r).toBeCloseTo(1);
  });
});
