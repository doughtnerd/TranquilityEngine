// ADR 0075 stage 6: water surfaces on the Babylon backend. The grid mesh, its rebuilds, the node
// following and release run headless on Babylon's NullEngine; the WGSL and GLSL the material plugin
// splices into Babylon's PBR shaders are checked as text; their wave sum is `GERSTNER_SHADER` (ADR 0250),
// whose JavaScript output runs on the uniforms the plugin binds, against the physics surface.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { World } from "../core/World";
import { Assets, Engine, GameObject, Graphics, SceneManager } from "../index";
import { WaterSurface } from "../render/water/WaterSurface";
import { BabylonWater } from "../render/babylon/water";
import { GERSTNER_SHADER, MAX_WAVES, gerstner } from "../render/water/gerstner";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { WaterWake } from "../render/water/WaterWake";
import { WAKE_SHADER } from "../render/water/wakeShader";
import { MAX_WAKES, TRAIL_TEXELS, WAKE_FIELD_RESOLUTION, WAKE_FIELD_SIZE } from "../render/water/wakes";
import { waterTime } from "../render/water/WaterSurface";
import { nullEngine, shaderText, type ShaderText } from "./pbrShaderSource";

type ShaderCode = { [point: string]: string };
/** The code the water material's wave plugin gives Babylon's PBR shaders, and its uniform buffer: read through Babylon's plugin API. */
let waterCode: (shaderType: string, language?: ShaderLanguage) => ShaderCode;
let waterUbo: { name: string; size: number; type: string }[];
/** The WGSL Babylon makes for a water surface, with the plugin's code in place (ADR 0225). */
let waterText: ShaderText;
beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  const babylon = nullEngine("wgsl");
  const scene = new Scene(babylon);
  const water = new BabylonWater(scene);
  const w = GameObject.create("sea").addBehavior(WaterSurface);
  engine.step(1 / 60);
  water.sync(engine.world as unknown as World, [w]);
  const mesh = scene.meshes.find((m) => m.name === "myco-water")!;
  const plugin = (mesh.material as PBRMaterial).pluginManager!.getPlugin("MycoWater") as MaterialPluginBase;
  const code = new Map<string, ShaderCode>();
  for (const language of [ShaderLanguage.WGSL, ShaderLanguage.GLSL]) for (const type of ["vertex", "fragment"]) code.set(`${type}|${language}`, plugin.getCustomCode(type, language)!);
  waterCode = (type, language = ShaderLanguage.WGSL) => code.get(`${type}|${language}`)!;
  waterUbo = (plugin.getUniforms() as { ubo: typeof waterUbo }).ubo;
  waterText = await shaderText(mesh.material!, mesh);
  water.dispose();
  scene.dispose();
  babylon.dispose();
  engine.dispose();
});

describe("water surfaces on Babylon (ADR 0075 stage 6)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let water: BabylonWater;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    water = new BabylonWater(scene);
  });

  afterEach(() => {
    Graphics.quality = Graphics.defaultQuality; // the tier is global: leave it as other tests expect
    water.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const world = () => engine.world as unknown as World;
  /** The surfaces' meshes in the test's Babylon scene, in the order they were made. */
  const waterMeshes = () => scene.meshes.filter((m) => m.name === "myco-water") as import("@babylonjs/core/Meshes/mesh.js").Mesh[];
  const surface = (props: Partial<WaterSurface> = {}) => {
    const node = GameObject.create("sea");
    const w = node.addBehavior(WaterSurface);
    Object.assign(w, props);
    engine.step(1 / 60);
    return w;
  };

  it("draws a grid mesh of the surface's size and resolution", () => {
    const w = surface({ resolution: 16, size: 50 });
    water.sync(world(), [w]);
    expect(water.state()).toEqual({ surfaces: 1 });
    const mesh = waterMeshes()[0];
    expect(mesh.getTotalVertices()).toBe(16 * 16);
    expect(mesh.getTotalIndices()).toBe(15 * 15 * 6);
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    expect(Math.max(...pos)).toBeCloseTo(25, 6);
    expect(pos.filter((_, i) => i % 3 === 1).every((y) => y === 0)).toBe(true);
    expect(mesh.receiveShadows).toBe(true);
    expect(scene.meshes).toContain(mesh);
  });

  it("winds the grid as Babylon's left-handed default, facing +Y (right-hand-rule normal down)", () => {
    water.sync(world(), [surface({ resolution: 3, size: 2 })]);
    const mesh = waterMeshes()[0];
    const p = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const idx = mesh.getIndices()!;
    for (let t = 0; t < idx.length; t += 3) {
      const v = (i: number) => [p[idx[t + i] * 3], p[idx[t + i] * 3 + 1], p[idx[t + i] * 3 + 2]];
      const [a, b, c] = [v(0), v(1), v(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeLessThan(0); // y of e1 x e2
    }
  });

  it("rebuilds the grid when the size or resolution changes, and halves it on the low shader level", () => {
    const w = surface({ resolution: 16, size: 50 });
    water.sync(world(), [w]);
    const first = waterMeshes()[0];
    water.sync(world(), [w]);
    expect(waterMeshes()[0]).toBe(first); // unchanged: kept
    w.resolution = 32;
    water.sync(world(), [w]);
    expect(waterMeshes()[0].getTotalVertices()).toBe(32 * 32);
    expect(scene.meshes.filter((m) => m.name === "myco-water")).toHaveLength(1);
    w.size = 80;
    water.sync(world(), [w]);
    expect(Math.max(...waterMeshes()[0].getVerticesData(VertexBuffer.PositionKind)!)).toBeCloseTo(40, 6);
    Graphics._apply("Low");
    water.sync(world(), [w]);
    expect(waterMeshes()[0].getTotalVertices()).toBe(16 * 16);
  });

  it("follows the node and hides with the component", () => {
    const w = surface({ resolution: 4 });
    w.node.transform!.position.set(3, 2, -5);
    engine.step(1 / 60);
    water.sync(world(), [w]);
    const mesh = waterMeshes()[0];
    const p = mesh.getAbsolutePosition();
    expect([p.x, p.y, p.z]).toEqual([3, 2, -5]);
    expect(mesh.isEnabled()).toBe(true);
    w.enabled = false;
    water.sync(world(), [w]);
    expect(mesh.isEnabled()).toBe(false);
  });

  it("is a transparent PBR material below opacity 1 and takes the reflection probe", () => {
    const w = surface({ resolution: 4 });
    const probe = { texture: {} as never, intensity: 0.4 };
    let hit: typeof probe | null = null;
    water.dispose();
    water = new BabylonWater(scene, () => hit);
    water.sync(world(), [w]);
    const m = waterMeshes()[0].material as import("@babylonjs/core/Materials/PBR/pbrMaterial.js").PBRMaterial;
    expect(m.sideOrientation).toBeNull(); // the scene's default front face (ADR 0164)
    expect(m.maxSimultaneousLights).toBe(8);
    expect(m.transparencyMode).toBe(0);
    w.opacity = 0.5;
    hit = probe;
    water.sync(world(), [w]);
    expect(m.alpha).toBeCloseTo(0.5, 6);
    expect(m.transparencyMode).toBe(2);
    expect(m.environmentIntensity).toBeCloseTo(0.4, 6);
    expect(m.reflectionTexture).toBe(probe.texture);
    hit = null;
    water.sync(world(), [w]);
    expect(m.reflectionTexture).toBeNull();
    expect(m.environmentIntensity).toBe(1);
  });

  it("releases a surface's mesh and material, and what the World no longer lists", () => {
    const a = surface({ resolution: 4 });
    const b = surface({ resolution: 4 });
    water.sync(world(), [a, b]);
    expect(water.state().surfaces).toBe(2);
    const materials = scene.materials.length;
    water.release(a);
    expect(water.state().surfaces).toBe(1);
    expect(scene.materials.length).toBe(materials - 1);
    water.sync(world(), []);
    expect(water.state().surfaces).toBe(0);
    expect(scene.meshes.filter((m) => m.name === "myco-water")).toHaveLength(0);
  });
});

describe("the water WGSL", () => {
  let vertex: ShaderCode, fragment: ShaderCode, all: string;
  beforeAll(() => {
    vertex = waterCode("vertex");
    fragment = waterCode("fragment");
    all = [...Object.values(vertex), ...Object.values(fragment), ...Object.keys(vertex), ...Object.keys(fragment)].join("\n");
  });

  // Where each point sits in Babylon's shaders is pbrInjection.test.ts's; here, what the water puts in them.
  it("injects at Babylon's named points and at the PBR points, re-declaring what it replaces (ADR 0222)", () => {
    expect(Object.keys(vertex)).toContain("CUSTOM_VERTEX_DEFINITIONS");
    expect(Object.keys(fragment)).toEqual(expect.arrayContaining(["CUSTOM_FRAGMENT_DEFINITIONS", "CUSTOM_FRAGMENT_UPDATE_ALPHA"]));
    const { vertex: v, fragment: f } = waterText;
    expect(v.match(/var worldPos: vec4f = finalWorld \* vec4f\(positionUpdated, 1\.0\);/g)).toHaveLength(1);
    const albedo = f.indexOf("var albedoOpacityOut: albedoOpacityOutParams;");
    expect(f.lastIndexOf("mycoFoam", albedo)).toBeGreaterThan(-1);
    expect(f).toContain("reflectivityBlock(vec4f(0.0, mix(uniforms.vReflectivityColor.y, 0.9, mycoFoam), uniforms.vReflectivityColor.zw)");
  });

  it("displaces the vertex and sets the normal before the world position, with two varyings", () => {
    const body = waterText.vertex.slice(0, waterText.vertex.indexOf("var worldPos: vec4f = finalWorld"));
    expect(body.indexOf("normalUpdated =")).toBeGreaterThan(-1);
    expect(body.indexOf("positionUpdated = positionUpdated + mycoG[0]")).toBeGreaterThan(-1);
    expect(body).toContain("#ifdef NORMAL");
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS.match(/^varying /gm)).toHaveLength(2);
    expect(fragment.CUSTOM_FRAGMENT_DEFINITIONS.match(/^varying /gm)).toHaveLength(2);
  });

  it("declares no uniforms of its own and reads every packed one", () => {
    const names = waterUbo.map((u) => u.name);
    expect(names.filter((n) => n.startsWith("mycoWave")).length).toBe(MAX_WAVES);
    expect(waterUbo.every((u) => u.type === "vec4" && u.size === 4)).toBe(true);
    for (const n of names) expect(all).toContain(`uniforms.${n}`);
    expect(all).not.toMatch(/^\s*uniform /m);
  });

  it("draws wakes with WAKE_SHADER (ADR 0459): the slope after the ripples, the foam with the crest foam, the field's height before the world position", () => {
    for (const code of [vertex.CUSTOM_VERTEX_DEFINITIONS, fragment.CUSTOM_FRAGMENT_DEFINITIONS]) {
      expect(code).toContain(WAKE_SHADER.text("wgsl", { declarations: "omit" }));
      expect(code).toContain("var mycoWakeTrail: texture_2d<f32>;");
      expect(code).toContain("var mycoWakeField: texture_2d<f32>;");
    }
    const body = waterText.vertex.slice(0, waterText.vertex.indexOf("var worldPos: vec4f = finalWorld"));
    expect(body.lastIndexOf("mycoWakeHeight(")).toBeGreaterThan(body.indexOf("positionUpdated = positionUpdated + mycoG[0]"));
    const f = Object.values(fragment).join("\n");
    expect(f.indexOf("mycoWakeAt(fragmentInputs.vPositionW.xz)")).toBeGreaterThan(f.indexOf("let ripples = mycoRipples("));
    expect(f).toContain("mycoFoam = max(amounts.y, wake.z);");
  });

  it("sums the waves with GERSTNER_SHADER itself", () => {
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS).toContain(GERSTNER_SHADER.text("wgsl", { declarations: "omit" }));
    expect(waterText.vertex).toContain("mycoGerstner(px, pz, i32(uniforms.mycoWaterA.x + 0.5))");
  });

  it("is WGSL, not GLSL", () => {
    expect(all).not.toMatch(/\bvec[234]\(/);
    expect(all).not.toMatch(/\bfloat\(/);
    expect(all).not.toMatch(/\bmat3\(/);
    expect(all).not.toMatch(/\bmix\([^)]*\)\s*;\s*\/\/ glsl/);
    expect(all).not.toContain("gl_");
    expect(all).toContain("mat3x3f");
  });
});

describe("the water GLSL (WebGL2 fallback)", () => {
  let vertex: ShaderCode, fragment: ShaderCode;
  beforeAll(() => {
    vertex = waterCode("vertex", ShaderLanguage.GLSL);
    fragment = waterCode("fragment", ShaderLanguage.GLSL);
  });

  it("re-declares the lines of Babylon's GLSL PBR shaders it replaces (ADR 0222)", () => {
    expect(Object.values(vertex).some((v) => v.includes("vec4 worldPos = finalWorld * vec4(positionUpdated, 1.0);"))).toBe(true);
    expect(Object.values(fragment).some((v) => v.includes("mycoFoamK") && v.endsWith("albedoOpacityOutParams albedoOpacityOut;"))).toBe(true);
    expect(Object.values(fragment)).toContain("reflectivityBlock(vec4(0.0, mix(vReflectivityColor.y, 0.9, mycoFoamK), vReflectivityColor.zw)");
  });

  it("sums the waves with GERSTNER_SHADER itself, reads every packed uniform, and shadows none of them", () => {
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS).toContain(GERSTNER_SHADER.text("glsl", { declarations: "omit" }));
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS).toContain("mycoGerstner(px, pz, int(mycoWaterA.x + 0.5))");
    const all = [...Object.values(vertex), ...Object.values(fragment)].join("\n");
    for (const { name } of waterUbo) {
      expect(all).toMatch(new RegExp(`\\b${name}\\b`));
      expect(all).not.toMatch(new RegExp(`\\b(float|vec[234]|int) ${name}\\b`)); // a local of a uniform's name
    }
    expect(all).not.toContain("uniforms.");
    expect(all).not.toMatch(/\bvec[234]f\(/);
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS).toContain("uniform sampler2D mycoWakeField;");
    expect(all).toContain("mycoWakeAt(vPositionW.xz)");
  });
});

type V4 = { x: number; y: number; z: number; w: number };

/** The wave sum both shaders compile (`GERSTNER_SHADER`), run as JavaScript on the uniforms a draw binds: (rest x, rest z) → displacement. */
function shaderWaves(u: Record<string, V4>): (px: number, pz: number) => number[] {
  const uniforms = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, [v.x, v.y, v.z, v.w]]));
  const sum = GERSTNER_SHADER.js({ uniforms }).fn("mycoGerstner");
  return (px, pz) => (sum(px, pz, Math.trunc(u.mycoWaterA.x + 0.5)) as number[][])[0];
}

describe("the water Babylon draws is the water physics samples (pirates: hulls under a flat sea)", () => {
  let engine: Engine;
  let babylon: NullEngine;
  let scene: Scene;
  let water: BabylonWater;

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    babylon = new NullEngine();
    scene = new Scene(babylon);
    water = new BabylonWater(scene);
  });

  afterEach(() => {
    water.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const world = () => engine.world as unknown as World;
  /** The surfaces' meshes in the test's Babylon scene, in the order they were made. */
  const waterMeshes = () => scene.meshes.filter((m) => m.name === "myco-water") as import("@babylonjs/core/Meshes/mesh.js").Mesh[];

  /** The uniforms the material's wave plugin binds for a draw, by name, and the textures (`textures`). */
  function bound(material: PBRMaterial, textures: Record<string, BaseTexture> = {}): Record<string, V4> {
    const plugin = material.pluginManager?.getPlugin("MycoWater") as MaterialPluginBase | null | undefined;
    expect(plugin, "the water material has no wave plugin: it draws a flat plane").toBeTruthy();
    const out: Record<string, V4> = {};
    const ubo = {
      updateFloat4: (name: string, x: number, y: number, z: number, w: number) => (out[name] = { x, y, z, w }),
      setTexture: (name: string, t: BaseTexture) => (textures[name] = t),
    };
    plugin!.bindForSubMesh(ubo as never, scene, babylon, null as never);
    return out;
  }

  it("binds the World's wakes (ADR 0459): the trail texture in trail mode, the height field and its area in field mode, nothing off", () => {
    const sea = GameObject.create("sea").addBehavior(WaterSurface);
    const boat = GameObject.create("boat");
    boat.addComponent(WaterWake, { fullSpeed: 6 });
    const sail = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        boat.transform!.position.z += 0.1;
        engine.step(1 / 60);
        water.sync(world(), [sea]);
      }
    };
    sail(1);
    const plugin = (waterMeshes()[0].material as PBRMaterial).pluginManager!.getPlugin("MycoWater") as MaterialPluginBase;
    const samplers: string[] = [];
    plugin.getSamplers(samplers);
    expect(samplers).toEqual(["mycoWakeTrail", "mycoWakeField"]);
    let tex: Record<string, BaseTexture> = {};
    let u = bound(waterMeshes()[0].material as PBRMaterial, tex);
    expect([u.mycoWake.x, u.mycoWake.y]).toEqual([1, 1]);
    expect(tex.mycoWakeTrail.getSize()).toEqual({ width: TRAIL_TEXELS, height: MAX_WAKES });
    expect(tex.mycoWakeField.getSize()).toEqual({ width: 1, height: 1 });

    sea.wakeMode = "field";
    sail(0.5);
    tex = {};
    u = bound(waterMeshes()[0].material as PBRMaterial, tex);
    expect(u.mycoWake.x).toBe(2);
    expect(tex.mycoWakeField.getSize()).toEqual({ width: WAKE_FIELD_RESOLUTION, height: WAKE_FIELD_RESOLUTION });
    expect([u.mycoWakeArea.z, u.mycoWakeArea.w]).toEqual([WAKE_FIELD_SIZE, WAKE_FIELD_RESOLUTION]);
    // The field is centred near the boat (no camera here: on the first wake).
    expect(Math.abs(u.mycoWakeArea.y + WAKE_FIELD_SIZE / 2 - boat.transform!.position.z)).toBeLessThan(WAKE_FIELD_SIZE / 8);

    sea.wakeMode = "off";
    sail(0.1);
    u = bound(waterMeshes()[0].material as PBRMaterial);
    expect(u.mycoWake.x).toBe(0);
  });

  it("adds the wave plugin on the WebGL2 (GLSL) material too, not only on WebGPU", () => {
    const w = GameObject.create("sea").addBehavior(WaterSurface);
    engine.step(1 / 60);
    water.sync(world(), [w]);
    const m = waterMeshes()[0].material as PBRMaterial;
    expect(m.shaderLanguage).toBe(ShaderLanguage.GLSL); // NullEngine compiles GLSL, as WebGL2 does
    const plugin = m.pluginManager?.getPlugin("MycoWater");
    expect(plugin).toBeTruthy();
    expect(plugin!.isCompatible(ShaderLanguage.GLSL)).toBe(true);
    expect(plugin!.isCompatible(ShaderLanguage.WGSL)).toBe(true);
  });

  it("draws the height WaterSurface.sample reports", () => {
    const node = GameObject.create("sea");
    const w = node.addBehavior(WaterSurface);
    w.waveScale = 1.7;
    node.transform!.position.set(3, 2, -5);
    for (let i = 0; i < 200; i++) engine.step(1 / 60); // seconds in: the phases have moved on
    const time = waterTime(world());
    expect(time).toBeGreaterThan(1);
    water.sync(world(), [w]);
    const u = bound(waterMeshes()[0].material as PBRMaterial);

    const packed = w._pack(time);
    {
      const drawn = shaderWaves(u);
      for (const [px, pz] of [[0, 0], [7.3, -4.1], [-30, 22], [55, 61]]) {
        const d = drawn(px, pz);
        const cpu = gerstner(packed, px, pz);
        const at = `at rest (${px}, ${pz})`;
        expect(d[1], at).toBeCloseTo(cpu.dy, 4);
        expect(d[0], at).toBeCloseTo(cpu.dx, 4);
        expect(d[2], at).toBeCloseTo(cpu.dz, 4);
        // The physics truth: where the drawn vertex lands in the world, the sampled surface is at its height.
        expect(w.sample(px + d[0] + 3, pz + d[2] - 5).height, at).toBeCloseTo(d[1] + 2, 3);
      }
    }
  });
});
