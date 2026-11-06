// ADR 0075 stage 6: water surfaces on the Babylon backend. The grid mesh, its rebuilds, the node
// following and release run headless on Babylon's NullEngine; the WGSL and GLSL the material plugin
// splices into Babylon's PBR shaders are checked as text, and their wave functions are translated to
// JavaScript and run on the uniforms the plugin binds, against the physics surface.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { World } from "../core/World";
import { Assets, Engine, GameObject, Graphics, SceneManager, WaterSurface } from "../index";
import { BabylonWater, babylonWaterResolution, waterCustomCode, waterGridData, waterUniformBuffer } from "../render/babylon/water";
import { GERSTNER_BODY, MAX_WAVES, gerstner, gerstnerBodyJS } from "../render/water/gerstner";
import { waterTime } from "../render/water/WaterSurface";
import { ALBEDO_ANCHOR } from "../render/babylon/graphMaterial";

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
    scene.useRightHandedSystem = true;
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
    const mesh = water.meshes()[0];
    expect(mesh.getTotalVertices()).toBe(16 * 16);
    expect(mesh.getTotalIndices()).toBe(15 * 15 * 6);
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    expect(Math.max(...pos)).toBeCloseTo(25, 6);
    expect(pos.filter((_, i) => i % 3 === 1).every((y) => y === 0)).toBe(true);
    expect(mesh.receiveShadows).toBe(true);
    expect(scene.meshes).toContain(mesh);
  });

  it("winds the grid counter-clockwise seen from above, facing +Y", () => {
    const d = waterGridData(2, 3);
    const p = d.positions as Float32Array;
    const idx = d.indices as Uint32Array;
    for (let t = 0; t < idx.length; t += 3) {
      const v = (i: number) => [p[idx[t + i] * 3], p[idx[t + i] * 3 + 1], p[idx[t + i] * 3 + 2]];
      const [a, b, c] = [v(0), v(1), v(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeGreaterThan(0); // y of e1 x e2
    }
  });

  it("rebuilds the grid when the size or resolution changes, and halves it on the low shader level", () => {
    const w = surface({ resolution: 16, size: 50 });
    water.sync(world(), [w]);
    const first = water.meshes()[0];
    water.sync(world(), [w]);
    expect(water.meshes()[0]).toBe(first); // unchanged: kept
    w.resolution = 32;
    water.sync(world(), [w]);
    expect(water.meshes()[0].getTotalVertices()).toBe(32 * 32);
    expect(scene.meshes.filter((m) => m.name === "myco-water")).toHaveLength(1);
    w.size = 80;
    water.sync(world(), [w]);
    expect(Math.max(...water.meshes()[0].getVerticesData(VertexBuffer.PositionKind)!)).toBeCloseTo(40, 6);
    expect(babylonWaterResolution(128, "high")).toBe(128);
    expect(babylonWaterResolution(128, "low")).toBe(64);
    Graphics._apply("Low");
    water.sync(world(), [w]);
    expect(water.meshes()[0].getTotalVertices()).toBe(16 * 16);
  });

  it("follows the node and hides with the component", () => {
    const w = surface({ resolution: 4 });
    w.node.transform!.position.set(3, 2, -5);
    engine.step(1 / 60);
    water.sync(world(), [w]);
    const mesh = water.meshes()[0];
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
    const m = water.meshes()[0].material as import("@babylonjs/core/Materials/PBR/pbrMaterial.js").PBRMaterial;
    expect(m.sideOrientation).toBe(1);
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
  const vertex = waterCustomCode("vertex");
  const fragment = waterCustomCode("fragment");
  const all = [...Object.values(vertex), ...Object.values(fragment), ...Object.keys(vertex), ...Object.keys(fragment)].join("\n");

  it("goes in the injection points Babylon's PBR shaders have", () => {
    expect(Object.keys(vertex)).toContain("CUSTOM_VERTEX_DEFINITIONS");
    expect(Object.keys(vertex).some((k) => k.startsWith("!var\\s+worldPos"))).toBe(true);
    expect(Object.keys(fragment)).toEqual(expect.arrayContaining(["CUSTOM_FRAGMENT_DEFINITIONS", "CUSTOM_FRAGMENT_UPDATE_ALPHA", ALBEDO_ANCHOR, "!reflectivityBlock\\(\\s*uniforms\\.vReflectivityColor"]));
    // The vertex regex matches Babylon's own line.
    const key = Object.keys(vertex).find((k) => k.startsWith("!"))!;
    expect(new RegExp(key.slice(1)).test("var worldPos: vec4f = finalWorld * vec4f(positionUpdated, 1.0);")).toBe(true);
  });

  it("displaces the vertex and sets the normal before the world position, with two varyings", () => {
    const body = Object.entries(vertex).find(([k]) => k.startsWith("!"))![1];
    expect(body.indexOf("normalUpdated =")).toBeGreaterThan(-1);
    expect(body.indexOf("positionUpdated = positionUpdated + mycoG[0]")).toBeLessThan(body.indexOf("var worldPos"));
    expect(body).toContain("#ifdef NORMAL");
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS.match(/^varying /gm)).toHaveLength(2);
    expect(fragment.CUSTOM_FRAGMENT_DEFINITIONS.match(/^varying /gm)).toHaveLength(2);
  });

  it("declares no uniforms of its own and reads every packed one", () => {
    const names = waterUniformBuffer().map((u) => u.name);
    expect(names.filter((n) => n.startsWith("mycoWave")).length).toBe(MAX_WAVES);
    expect(waterUniformBuffer().every((u) => u.type === "vec4" && u.size === 4)).toBe(true);
    for (const n of names) expect(all).toContain(`uniforms.${n}`);
    expect(all).not.toMatch(/^\s*uniform /m);
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
  const vertex = waterCustomCode("vertex", ShaderLanguage.GLSL);
  const fragment = waterCustomCode("fragment", ShaderLanguage.GLSL);

  it("matches the lines of Babylon's GLSL PBR shaders it replaces", () => {
    const pos = Object.keys(vertex).find((k) => k.startsWith("!"))!;
    expect(new RegExp(pos.slice(1)).test("vec4 worldPos=finalWorld*vec4(positionUpdated,1.0);vPositionW=vec3(worldPos);")).toBe(true);
    const keys = Object.keys(fragment).filter((k) => k.startsWith("!"));
    expect(keys.some((k) => new RegExp(k.slice(1)).test("albedoOpacityOutParams albedoOpacityOut;"))).toBe(true);
    expect(keys.some((k) => new RegExp(k.slice(1)).test("reflectivityOut=reflectivityBlock(\nvReflectivityColor"))).toBe(true);
  });

  it("sums the waves with GERSTNER_BODY itself, reads every packed uniform, and shadows none of them", () => {
    expect(vertex.CUSTOM_VERTEX_DEFINITIONS).toContain(GERSTNER_BODY.replace(/\$float/g, "float").replace(/\$int/g, "int"));
    const all = [...Object.values(vertex), ...Object.values(fragment)].join("\n");
    for (const { name } of waterUniformBuffer()) {
      expect(all).toMatch(new RegExp(`\\b${name}\\b`));
      expect(all).not.toMatch(new RegExp(`\\b(float|vec[234]|int) ${name}\\b`)); // a local of a uniform's name
    }
    expect(all).not.toContain("uniforms.");
    expect(all).not.toMatch(/\bvec[234]f\(/);
  });
});

type V4 = { x: number; y: number; z: number; w: number };

/** The wave function a shader's CUSTOM_VERTEX_DEFINITIONS declares, translated to JavaScript: (rest x, rest z, uniforms) → displacement. */
function shaderWaves(language: ShaderLanguage): (px: number, pz: number, u: Record<string, V4>) => number[] {
  const defs = waterCustomCode("vertex", language).CUSTOM_VERTEX_DEFINITIONS;
  const start = defs.search(/(fn|void) mycoGerstner/);
  let src = defs.slice(start, defs.indexOf("\n}\n", defs.search(/disp = vec3\(|return mat3x3f/)) + 2);
  src = src.replace(/uniforms\./g, "").replace(/\b(mycoWave\d|mycoPhase\d|mycoWaterA)\b/g, "u.$1");
  if (language === ShaderLanguage.WGSL) {
    src = src
      .replace(/^fn mycoGerstner\(.*\{/, "")
      .replace(/array<\w+, \d+>\(([^;]*)\);/g, "[$1];")
      .replace(/\bi32\(/g, "Math.trunc(")
      .replace(/: i32/g, "")
      .replace(/\b(var|let) /g, "let ")
      .replace(/(\w) \+= (vec3f\(.*\));/g, "$1 = add($1, $2);")
      .replace(/return mat3x3f\(g, t, b\);/, "return g;");
  } else {
    src = src
      .replace(/^void mycoGerstner\(.*\{/, "let disp;")
      .replace(/\w+ (\w+)\[\d+\] = \w+\[\d+\]\(([^;]*)\);/g, "let $1 = [$2];")
      .replace(/float (\w+)\[(\d+)\];/g, "let $1 = new Array($2).fill(0);")
      .replace(/\bint\(/g, "Math.trunc(")
      .replace(/\b(float|int) (?=\w+ ?[=;])/g, "let ")
      .replace(/\bvec3\(([^()]*)\)/g, "[$1]")
      .replace(/\b(tangent|binormal) = .*;/g, "")
      .replace(/\n\}\n?$/, "\nreturn disp;\n}");
  }
  src = src.replace(/\b(sin|cos)\(/g, "Math.$1(").replace(/\n\}\n?$/, "\n");
  const vec3f = (...a: number[]) => (a.length === 1 ? [a[0], a[0], a[0]] : a);
  const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
  const fn = new Function("px", "pz", "u", "vec3f", "add", src);
  return (px, pz, u) => fn(px, pz, u, vec3f, add) as number[];
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
    scene.useRightHandedSystem = true;
    water = new BabylonWater(scene);
  });

  afterEach(() => {
    water.dispose();
    scene.dispose();
    babylon.dispose();
    engine.dispose();
  });

  const world = () => engine.world as unknown as World;

  /** The uniforms the material's wave plugin binds for a draw, by name. */
  function bound(material: PBRMaterial): Record<string, V4> {
    const plugin = material.pluginManager?.getPlugin("MycoWater") as MaterialPluginBase | null | undefined;
    expect(plugin, "the water material has no wave plugin: it draws a flat plane").toBeTruthy();
    const out: Record<string, V4> = {};
    const ubo = { updateFloat4: (name: string, x: number, y: number, z: number, w: number) => (out[name] = { x, y, z, w }) };
    plugin!.bindForSubMesh(ubo as never, scene, babylon, null as never);
    return out;
  }

  it("adds the wave plugin on the WebGL2 (GLSL) material too, not only on WebGPU", () => {
    const w = GameObject.create("sea").addBehavior(WaterSurface);
    engine.step(1 / 60);
    water.sync(world(), [w]);
    const m = water.meshes()[0].material as PBRMaterial;
    expect(m.shaderLanguage).toBe(ShaderLanguage.GLSL); // NullEngine compiles GLSL, as WebGL2 does
    const plugin = m.pluginManager?.getPlugin("MycoWater");
    expect(plugin).toBeTruthy();
    expect(plugin!.isCompatible(ShaderLanguage.GLSL)).toBe(true);
    expect(plugin!.isCompatible(ShaderLanguage.WGSL)).toBe(true);
  });

  it("draws the height WaterSurface.sample reports, in GLSL and WGSL", () => {
    const node = GameObject.create("sea");
    const w = node.addBehavior(WaterSurface);
    w.waveScale = 1.7;
    node.transform!.position.set(3, 2, -5);
    for (let i = 0; i < 200; i++) engine.step(1 / 60); // seconds in: the phases have moved on
    const time = waterTime(world());
    expect(time).toBeGreaterThan(1);
    water.sync(world(), [w]);
    const u = bound(water.meshes()[0].material as PBRMaterial);

    const packed = w._pack(time);
    for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const drawn = shaderWaves(language);
      for (const [px, pz] of [[0, 0], [7.3, -4.1], [-30, 22], [55, 61]]) {
        const d = drawn(px, pz, u);
        const cpu = gerstner(packed, px, pz);
        const at = `${ShaderLanguage[language]} at rest (${px}, ${pz})`;
        expect(d[1], at).toBeCloseTo(cpu.dy, 4);
        expect(d[0], at).toBeCloseTo(cpu.dx, 4);
        expect(d[2], at).toBeCloseTo(cpu.dz, 4);
        // The physics truth: where the drawn vertex lands in the world, the sampled surface is at its height.
        expect(w.sample(px + d[0] + 3, pz + d[2] - 5).height, at).toBeCloseTo(d[1] + 2, 3);
      }
    }
  });
});
