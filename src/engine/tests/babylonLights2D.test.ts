// The 2D lighting rig on Babylon (ADR 0399, 0413), without a GPU: batching and layout from a World's lights, the light
// pass's shaders, the lit layered-quad material's compiled text (ADR 0225), and the frame graph's 2D light task.
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Light2D, SceneManager, ShadowCaster2D, Vector2 } from "../../myco";
import { LIGHTS_2D_QUALITY } from "../core/graphics";
import { World } from "../core/World";
import { BabylonFrame } from "../render/babylon/frameGraph";
import { layeredQuadMaterial, lightLayeredQuads } from "../render/babylon/layeredQuads";
import { BabylonLights2D } from "../render/babylon/lights2D";
import { LIGHT2D_PASS, LIGHT2D_PASS_DIR, SHADOW2D_PASS } from "../render/babylon/lights2DShaders";
import { nullEngine, shaderText } from "./pbrShaderSource";

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

const STYLES = [
  { name: "Multiply", mask: "none" as const, multiply: 1, add: 0 },
  { name: "Rim", mask: "r" as const, multiply: 0, add: 1 },
];

async function world(): Promise<World> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default", "Front"] }, lighting2D: { blendStyles: STYLES } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return World.require();
}

function light(fields: Partial<Light2D>, x = 0, y = 0): Light2D {
  const node = GameObject.create("light");
  node.transform!.position.set(x, y, 0);
  return Object.assign(node.addComponent(Light2D), fields);
}

const rigOn = (scene: Scene) => new BabylonLights2D({ scene, texture: () => null, textureSize: () => null });

describe("the 2D lighting rig", () => {
  it("has no layout (nothing lit) without 2D lights, or with 2D lighting off", async () => {
    const w = await world();
    const rig = rigOn(new Scene(nullEngine("glsl")));
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(rig.layout()).toBeNull();
    expect(rig.batchOfLayer("Default")).toBe(-1);
    light({ type: "global" });
    rig.enabled = false;
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(rig.layout()).toBeNull();
  });

  it("batches layers by their lights, with a texture per blend style, and changes its version only when that does", async () => {
    const w = await world();
    const rig = rigOn(new Scene(nullEngine("glsl")));
    light({ type: "global", targetSortingLayers: ["Default", "Front"] });
    const torch = light({ type: "point", blendStyle: "Rim", normalMaps: "fast", targetSortingLayers: ["Front"] }, 1, 1);
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(rig.batchOfLayer("Back")).toBe(-1);
    expect(rig.batchOfLayer("Default")).toBe(0);
    expect(rig.batchOfLayer("Front")).toBe(1);
    expect(rig.batch(1)).toEqual({ styles: [0, 1], directional: true, accurate: new Float32Array(0) });
    expect(rig.layout()).toEqual({ batches: [{ styles: 1, directional: false }, { styles: 2, directional: true }], scale: 0.5, shadowTextures: 0, lowPrecision: rig.range !== 1 });
    const v = rig.version;
    torch.node.transform!.position.set(4, 4, 0); // moving or dimming a light is draw data
    torch.intensity = 0.5;
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(rig.version).toBe(v);
    rig.sync(w, LIGHTS_2D_QUALITY.low); // no normal maps on low: no directional textures
    expect(rig.version).not.toBe(v);
    expect(rig.batch(1)?.directional).toBe(false);
  });

  it("gives shadows to the brightest, widest lights up to the tier's cap, four to a texture", async () => {
    const w = await world();
    const rig = rigOn(new Scene(nullEngine("glsl")));
    for (let i = 0; i < 6; i++) light({ type: "point", shadows: true, outerRadius: 1 + i }, i * 3, 0);
    const wall = GameObject.create("wall");
    Object.assign(wall.addComponent(ShadowCaster2D), { shape: "custom", path: [new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1)] });
    rig.sync(w, LIGHTS_2D_QUALITY.low);
    expect(rig.state()).toMatchObject({ lights: 6, shadowed: 4, unshadowed: 2, casters: 1, batches: 1 });
    expect(rig.layout()?.shadowTextures).toBe(1);
    rig.sync(w, LIGHTS_2D_QUALITY.medium);
    expect(rig.state()).toMatchObject({ shadowed: 6, unshadowed: 0 });
    expect(rig.layout()?.shadowTextures).toBe(2);
  });
});

describe("accurate normal maps (ADR 0415)", () => {
  it("light point lights per light, up to the tier's cap a batch (the rest as fast), out of the light textures", async () => {
    const w = await world();
    const rig = rigOn(new Scene(nullEngine("glsl")));
    const lamps = Array.from({ length: 10 }, (_, i) => light({ type: "point", normalMaps: "accurate", outerRadius: 1 + i, height: 2 }, i, 0));
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    const b = rig.batch(0)!;
    expect(b.accurate.length / 24).toBe(8); // the high tier's cap
    expect(b.directional).toBe(true); // the two left over light as fast
    // Packed brightest × widest first: the light at x = 9, radius 10, height 2.
    expect(Array.from(b.accurate.slice(0, 4))).toEqual([9, 0, 2, -1]);
    expect(Array.from(b.accurate.slice(12, 14))).toEqual([0, 10]); // its radii
    const v = rig.version;
    for (const l of lamps.slice(2)) l.enabled = false;
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    expect(rig.version).not.toBe(v); // the material's light count changed
    expect(rig.batch(0)).toMatchObject({ directional: false });
    expect(rig.batch(0)!.accurate.length / 24).toBe(2);
    rig.sync(w, LIGHTS_2D_QUALITY.medium); // no accurate lights on medium: fast
    expect(rig.batch(0)).toMatchObject({ directional: true, accurate: new Float32Array(0) });
  });

  it("packs the light's world-to-local map, so a turned or scaled light falls off in its own space", async () => {
    const w = await world();
    const rig = rigOn(new Scene(nullEngine("glsl")));
    const l = light({ type: "point", normalMaps: "accurate" }, 1, 2);
    l.node.transform!.scale.set(2, 2, 1);
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    const a = rig.batch(0)!.accurate;
    expect(Array.from(a.slice(4, 8)).map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([0.5, 0, 0, 0.5]);
  });
});

describe("the light pass's shaders", () => {
  it("are registered in GLSL and WGSL with the KSL light maths", () => {
    for (const name of [LIGHT2D_PASS, LIGHT2D_PASS_DIR, SHADOW2D_PASS]) {
      for (const store of [ShaderStore.ShadersStore, ShaderStore.ShadersStoreWGSL]) {
        expect(store[`${name}VertexShader`]).toBeTruthy();
        expect(store[`${name}PixelShader`]).toBeTruthy();
      }
    }
    expect(ShaderStore.ShadersStore[`${LIGHT2D_PASS}PixelShader`]).toContain("myco2DPointAtten");
    expect(ShaderStore.ShadersStoreWGSL[`${LIGHT2D_PASS}PixelShader`]).toContain("fn myco2DPointAtten");
    // The directional pass writes three targets.
    expect(ShaderStore.ShadersStore[`${LIGHT2D_PASS_DIR}PixelShader`]).toContain("layout(location = 2) out vec4 mycoOut2;");
    expect(ShaderStore.ShadersStoreWGSL[`${LIGHT2D_PASS_DIR}PixelShader`]).toContain("fragmentOutputs.fragData2");
    // Overlap (ADR 0415): an alpha blend light writes its brightness as alpha (premultiplied blending), an additive one 0.
    expect(ShaderStore.ShadersStore[`${LIGHT2D_PASS}PixelShader`]).toContain("float a = vExtra.z > 0.5 ? lv.w : 0.0;");
    expect(ShaderStore.ShadersStoreWGSL[`${LIGHT2D_PASS}PixelShader`]).toContain("let a = select(0.0, lv.w, fragmentInputs.vExtra.z > 0.5);");
  });
});

describe("the lit layered-quad material (ADR 0225: the text Babylon compiles)", () => {
  for (const language of ["wgsl", "glsl"] as const) {
    it(`reads its layer batch's light textures and composes the blend styles, with normal and mask maps (${language})`, async () => {
      const w = await world();
      const scene = new Scene(nullEngine(language));
      const rig = rigOn(scene);
      light({ type: "global" });
      light({ type: "point", blendStyle: "Rim", normalMaps: "fast" });
      rig.sync(w, LIGHTS_2D_QUALITY.high);
      // Loaded maps (a NullEngine's raw textures never finish loading; the plugin only asks whether they're ready).
      const map = { isReady: () => true } as unknown as Texture;
      const m = layeredQuadMaterial("lit", scene, null);
      lightLayeredQuads(m, { batch: 0, normal: map, mask: map, greenDown: false });
      const text = await shaderText(m);
      for (const d of ["MYCO_L2D", "MYCO_L2D_DIR", "MYCO_L2D_NORMAL", "MYCO_L2D_MASK"]) expect(text.defines).toContain(`#define ${d}\n`);
      expect(text.defines).toContain("#define MYCO_L2D_STYLES 2");
      expect(text.fragment).toContain("mycoL2DFlat1");
      expect(text.fragment).toContain("mycoL2DDirVec0");
      expect(text.fragment).toContain("finalDiffuse = myco2DCompose(mycoBase, mycoMul, mycoAdd);");
      // Before the colour is composed from the diffuse and ambient terms.
      expect(text.fragment.indexOf("myco2DCompose(mycoBase")).toBeLessThan(text.fragment.lastIndexOf("finalAmbient +"));
      expect(text.vertex).toContain("vMycoL2DFrame");
    });
  }

  for (const language of ["wgsl", "glsl"] as const) {
    it(`lights a normal-mapped draw by each accurate light, with its shadow (${language})`, async () => {
      const w = await world();
      const scene = new Scene(nullEngine(language));
      const rig = rigOn(scene);
      light({ type: "point", normalMaps: "accurate", shadows: true });
      light({ type: "point", normalMaps: "accurate" }, 3, 0);
      rig.sync(w, LIGHTS_2D_QUALITY.high);
      const map = { isReady: () => true } as unknown as Texture;
      const lit = layeredQuadMaterial("lit", scene, null);
      lightLayeredQuads(lit, { batch: 0, normal: map, mask: null, greenDown: false });
      const text = await shaderText(lit);
      expect(text.defines).toContain("#define MYCO_L2D_ACC 2");
      expect(text.defines).toContain("#define MYCO_L2D_NORMAL\n");
      expect(text.fragment).toContain("mycoL2DAcc1_5");
      expect(text.fragment).toContain("myco2DShadow(mycoUv");
      // Without a normal map they still light it (they're in no light texture), as if it faced the viewer.
      const flat = layeredQuadMaterial("flat", scene, null);
      lightLayeredQuads(flat, { batch: 0, normal: null, mask: null, greenDown: false });
      const flatText = await shaderText(flat);
      expect(flatText.defines).toContain("#define MYCO_L2D_ACC 2");
      expect(flatText.defines).not.toContain("#define MYCO_L2D_NORMAL\n");
    });
  }

  it("gives a Sprite Custom Lit graph its light reads and leaves the colour to it (ADR 0415)", async () => {
    const w = await world();
    const scene = new Scene(nullEngine("wgsl"));
    const rig = rigOn(scene);
    light({ type: "global" });
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    const m = layeredQuadMaterial("custom", scene, null);
    lightLayeredQuads(m, { batch: 0, normal: null, mask: null, greenDown: false, graph: { normal: false, mask: false, custom: true } });
    const text = await shaderText(m);
    expect(text.defines).toContain("#define MYCO_L2D_CUSTOM\n");
    expect(text.fragment).toContain("fn mycoL2DLightColor(frag: vec2f) -> vec3f");
    expect(text.fragment).toContain("fn mycoL2DLightDirection(frag: vec2f) -> vec3f");
    // The compose sits behind the custom define (the text is before Babylon's preprocessor).
    expect(text.fragment.lastIndexOf("#ifndef MYCO_L2D_CUSTOM", text.fragment.indexOf("finalDiffuse = myco2DCompose("))).toBeGreaterThan(-1);
    // With no light on its layer the reads are white and toward the viewer.
    const dark = layeredQuadMaterial("dark", scene, null);
    lightLayeredQuads(dark, { batch: 5, normal: null, mask: null, greenDown: false, graph: { normal: false, mask: false, custom: true } });
    const darkText = await shaderText(dark);
    expect(darkText.defines).not.toContain("#define MYCO_L2D\n");
    expect(darkText.fragment).toContain("return vec3f(1.0);");
  });

  it("draws unlit while its layer batch has no lights", async () => {
    const w = await world();
    const scene = new Scene(nullEngine("glsl"));
    const rig = rigOn(scene);
    rig.sync(w, LIGHTS_2D_QUALITY.high);
    const m = layeredQuadMaterial("lit", scene, null);
    lightLayeredQuads(m, { batch: 0, normal: null, mask: null, greenDown: false });
    const text = await shaderText(m);
    expect(text.defines).not.toContain("#define MYCO_L2D\n");
  });
});

describe("the frame graph's 2D light task (ADR 0274)", () => {
  it("draws a camera's 2D light textures before its render pass, and rebuilds only when their layout changes", async () => {
    const w = await world();
    const engine = nullEngine("glsl");
    (engine as unknown as { buildTextureLayout(): number[] }).buildTextureLayout = () => [];
    const scene = new Scene(engine);
    const camera = new TargetCamera("c", Vector3.Zero(), scene);
    const frame = new BabylonFrame(scene);
    const rig = rigOn(scene);
    const view = { camera, viewport: { x: 0, y: 0, width: 1, height: 1 }, clear: new Color4(0, 0, 0, 1), effects: null, toneMapping: "none" as const, exposure: 1 };
    const added = vi.spyOn(FrameGraph.prototype, "addTask");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {}); // the GPU build itself fails on NullEngine
    const frameNames = async (): Promise<string[]> => {
      added.mockClear();
      rig.sync(w, LIGHTS_2D_QUALITY.high);
      frame.render([view], [], [], 1, rig);
      await new Promise((r) => setTimeout(r, 0));
      return added.mock.calls.map(([task]) => task.name);
    };
    try {
      expect(await frameNames()).not.toContain("lights2d0");
      const l = light({ type: "point" });
      const names = await frameNames();
      expect(names).toContain("lights2d0");
      expect(names.indexOf("lights2d0")).toBeLessThan(names.indexOf("render0"));
      l.node.transform!.position.set(3, 0, 0);
      expect(await frameNames()).toEqual([]); // moved: same layout, no rebuild
      l.shadows = true;
      expect(await frameNames()).toContain("lights2d0"); // a shadow texture now: rebuilt
    } finally {
      added.mockRestore();
      logged.mockRestore();
      rig.dispose();
      frame.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
