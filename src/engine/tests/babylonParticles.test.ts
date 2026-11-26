// ADR 0075 stage 5, 0251: particle effects on the Babylon backend (render/babylon/particles.ts), run
// headless on Babylon's NullEngine, where every system runs on the JavaScript kernel executor. The
// kernels have their own tests (particleKernel.test.ts, kernelSteps.test.ts); these check the player's
// lifecycle, commands and the draws it makes (an instanced mesh per kernel output).
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphMaterial } from "../render/babylon/graphMaterial";
import type { CompiledShaderGraph } from "../render/shaderGraph/compile";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { BabylonParticles, type BabylonParticleHost } from "../render/babylon/particles";
import { BabylonLights2D } from "../render/babylon/lights2D";
import { BabylonMaterialLibrary } from "../render/babylon/materialLibrary";
import { BabylonMaterials2D } from "../render/babylon/materials2D";
import { LIGHTS_2D_QUALITY } from "../core/graphics";
import { World } from "../core/World";
import { Assets, Engine as MycoEngine, GameObject, Light2D, SceneManager } from "../../myco";
import { ParticleSystem } from "../render/components";
import { nullEngine } from "./pbrShaderSource";
import { defaultEmitter, defaultRenderer, defaultShape, type ParticleEffect, type ParticleEmitterSettings, type ParticleRenderer, PARTICLES_FORMAT } from "../scene/particles";

/** An effect as its `myco.particles@1` file's JSON object. */
const legacyJSON = (effect: ParticleEffect): Record<string, unknown> => ({ format: PARTICLES_FORMAT, ...effect });

/** A stand-in ParticleSystem component: the fields and state the player reads and writes. */
function fakeSystem(effect: ParticleEffect, over: Partial<ParticleSystem> = {}) {
  const c = new ParticleSystem();
  // In a World the node and its activity come from the scene; here the player only reads the node's name.
  const { node = { name: "Fx" }, ...fields } = over as Record<string, unknown>;
  Object.defineProperties(c, { node: { value: node }, isActiveAndEnabled: { value: true } });
  return Object.assign(c, { embeddedEffect: legacyJSON(effect) }, fields);
}

const steady = (rate: number, max = 1000): ParticleEffect => ({
  emitters: [{ ...defaultEmitter("E"), startLife: 10, emission: { rateOverTime: rate, rateOverDistance: 0, bursts: [] }, maxParticles: max }],
});

describe("particles on the Babylon backend (ADR 0075 stage 5)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let players: BabylonParticles[];
  /** A fresh engine, its materials in `language`, and scene, with the camera. */
  function setUp(language: "wgsl" | "glsl"): void {
    engine = nullEngine(language);
    scene = new Scene(engine);
    // Sorted outputs sort for the active camera: on +Z, looking at the origin.
    const camera = new TargetCamera("camera", new Vector3(0, 0, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    players = [];
  }
  beforeEach(() => setUp("glsl"));

  afterEach(() => {
    for (const p of players) p.dispose();
    scene.dispose();
    engine.dispose();
  });

  /** Each editor player's preview policy (ADR 0154: the playback settings are part of it). */
  const previews = new Map<BabylonParticles, { playing: boolean; speed: number; simulateAll: boolean }>();
  function make(editor = false, selected = true, host: Partial<BabylonParticleHost> = {}) {
    const preview = { playing: true, speed: 1, simulateAll: false, restarts: 0, selected: () => selected };
    const player = new BabylonParticles({
      scene,
      particlePreview: () => (editor ? preview : null),
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      texture: () => Promise.reject(new Error("no textures here")),
      tierScale: () => 1,
      ...host,
    });
    players.push(player);
    previews.set(player, preview);
    return player;
  }
  /** The meshes drawing the "Fx" node's effect, one per system output, in the order the systems were built. */
  const drawn = () => scene.meshes.filter((m) => m.name.startsWith("particles:Fx:")) as Mesh[];
  /** The texture a kernel draw shades with. */
  const textureOf = (m: Mesh) => (m.material as ShaderMaterial).getActiveTextures()[0];
  const frames = (p: BabylonParticles, c: ParticleSystem, n: number, dt = 1 / 60, unscaled = dt) => {
    for (let i = 0; i < n; i++) p.sync([c], dt, unscaled);
  };

  it("draws each system with an instanced mesh per output, holding its capacity, and counts particles exactly", () => {
    const p = make();
    const c = fakeSystem(steady(100, 50));
    frames(p, c, 60);
    expect(c.particleCount).toBe(50); // a full system stops spawning (ADR 0126's dead list)
    expect(c.isPlaying).toBe(true);
    expect(c.playTime).toBeCloseTo(1, 1);
    expect(scene.particleSystems).toHaveLength(0);
    const [mesh] = drawn();
    expect(mesh.forcedInstanceCount).toBe(50);
    expect(mesh.material).toBeInstanceOf(ShaderMaterial);
    expect(p.state()).toMatchObject({ systems: 1, emitters: 1, batches: 1, particles: 50 });
  });

  it("clamps bursts to the particle limit", () => {
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), startLife: 10, maxParticles: 10, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [{ time: 0, count: 200, cycles: 1, interval: 0.1, probability: 1 }] } }] };
    const c = fakeSystem(effect);
    frames(p, c, 10);
    expect(c.particleCount).toBe(10);
  });

  it("scales emission with emissionScale and the tier, and pauses with the World's time", () => {
    const p = make(false, true, { tierScale: () => 0.5 });
    const c = fakeSystem(steady(100), { emissionScale: 0.5 } as Partial<ParticleSystem>);
    frames(p, c, 60);
    expect(c.particleCount).toBeGreaterThan(20);
    expect(c.particleCount).toBeLessThan(30);
    const before = c.particleCount;
    frames(p, c, 30, 0, 1 / 60); // timeScale 0
    expect(c.particleCount).toBe(before);
  });

  it("runs script commands: pause, play, stop, emit and clear", () => {
    const p = make();
    const c = fakeSystem(steady(0), { playOnAwake: false } as Partial<ParticleSystem>);
    frames(p, c, 1);
    expect(c.isPlaying).toBe(false);
    c.play();
    c.emit(25);
    frames(p, c, 1);
    expect(c.isPlaying).toBe(true);
    expect(c.particleCount).toBe(25);
    c.pause();
    frames(p, c, 1);
    expect(c.isPlaying).toBe(false); // paused: not playing, and the clock holds still
    const t = c.playTime;
    frames(p, c, 5);
    expect(c.playTime).toBe(t);
    c.play();
    frames(p, c, 1);
    expect(c.isPlaying).toBe(true);
    c.stop();
    frames(p, c, 1);
    expect(c.isPlaying).toBe(false);
    expect(c.isAlive).toBe(true); // particles live out their lives
    c.clear();
    frames(p, c, 1);
    expect(c.particleCount).toBe(0);
  });

  it("restart removes the particles and starts over", () => {
    const p = make();
    const c = fakeSystem(steady(60));
    frames(p, c, 30);
    expect(c.particleCount).toBeGreaterThan(10);
    c.restart();
    frames(p, c, 1);
    expect(c.playTime).toBeCloseTo(1 / 60, 3);
    expect(c.particleCount).toBeLessThan(3);
  });

  it("finishes a one-shot effect", () => {
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), looping: false, duration: 0.5, startLife: 0.2, emission: { rateOverTime: 50, rateOverDistance: 0, bursts: [] } }] };
    const c = fakeSystem(effect);
    frames(p, c, 90);
    expect(c.isPlaying).toBe(false);
    expect(c.isAlive).toBe(false);
  });

  it("rebuilds when the effect changes and releases systems that are gone", () => {
    const p = make();
    const c = fakeSystem(steady(10));
    frames(p, c, 1);
    expect(drawn()).toHaveLength(1);
    (c as { embeddedEffect: unknown }).embeddedEffect = legacyJSON({ emitters: [defaultEmitter("A"), defaultEmitter("B")] });
    frames(p, c, 1);
    expect(p.state().emitters).toBe(2);
    expect(drawn()).toHaveLength(2);
    p.sync([], 1 / 60, 1 / 60);
    expect(p.state()).toMatchObject({ systems: 0, emitters: 0, batches: 0 });
    expect(drawn()).toHaveLength(0);
  });

  it("release() and dispose() remove the draws", () => {
    const p = make();
    const a = fakeSystem(steady(10));
    const b = fakeSystem(steady(10), { node: { name: "Gx" } } as Partial<ParticleSystem>);
    p.sync([a, b], 1 / 60, 1 / 60);
    const ours = () => scene.meshes.filter((m) => m.name.startsWith("particles:"));
    expect(ours()).toHaveLength(2);
    p.release(a);
    expect(ours().map((m) => m.name)).toEqual([expect.stringMatching(/^particles:Gx:/)]);
    p.dispose();
    expect(ours()).toHaveLength(0);
  });

  it("editor: plays only selected systems, at the preview speed", () => {
    const shown = make(true, true);
    const a = fakeSystem(steady(60));
    frames(shown, a, 30, 0, 1 / 60);
    expect(a.particleCount).toBeGreaterThan(20);
    const hidden = make(true, false);
    const b = fakeSystem(steady(60));
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b.particleCount).toBe(0);
    previews.get(hidden)!.simulateAll = true;
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b.particleCount).toBeGreaterThan(20);
    previews.get(hidden)!.playing = false;
    const n = b.particleCount;
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b.particleCount).toBe(n);
  });

  it("waits for a texture to load, then builds with it", async () => {
    let resolve!: (t: RawTexture) => void;
    const loaded = new Promise<RawTexture>((r) => (resolve = r));
    const p = make(false, true, { texture: () => loaded });
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), renderer: { ...defaultEmitter().renderer, texture: "spark.png" } }] };
    const c = fakeSystem(effect);
    frames(p, c, 3);
    expect(drawn()).toHaveLength(0);
    const tex = new RawTexture(new Uint8Array(16), 2, 2, 5, scene);
    resolve(tex);
    await loaded;
    await Promise.resolve();
    frames(p, c, 3);
    expect(drawn()).toHaveLength(1);
    expect(textureOf(drawn()[0])).toBe(tex);
  });

  it("draws with the default dot when a texture fails to load, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), renderer: { ...defaultEmitter().renderer, texture: "missing.png" } }] };
    const c = fakeSystem(effect);
    frames(p, c, 1);
    await new Promise((r) => setTimeout(r, 0));
    frames(p, c, 5);
    expect(drawn()).toHaveLength(1);
    expect(textureOf(drawn()[0])!.name).toBe("particle dot");
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("missing.png"))).toHaveLength(1);
    warn.mockRestore();
  });

  /** One still particle, born at the node, of a fixed size and colour (no behaviours unless given). */
  const still = (name: string, renderer: Partial<ParticleRenderer>, over: Partial<ParticleEmitterSettings> = {}): ParticleEmitterSettings => ({
    ...defaultEmitter(name),
    startLife: 10,
    startSpeed: 0,
    startSize: 2,
    startColor: "#ff000080",
    shape: { ...defaultShape(), radius: 0, angle: 0 },
    behaviors: [],
    emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [{ time: 0, count: 3, cycles: 1, interval: 0.1, probability: 1 }] },
    renderer: { ...defaultRenderer(), ...renderer },
    ...over,
  });

  it("draws mesh outputs with the model instanced, and trails as a strip of two vertices a history point", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = make();
    const c = fakeSystem({ emitters: [still("M", { mode: "mesh", mesh: "builtin:cube" }), still("T", { mode: "trail", trailLength: 5 }, { startSpeed: 1 })] });
    frames(p, c, 10);
    const [mesh, trail] = drawn();
    expect(mesh.getTotalVertices()).toBe(24); // the cube model's vertices
    expect(mesh.forcedInstanceCount).toBe(1000);
    expect((mesh.material as ShaderMaterial).disableDepthWrite).toBe(false); // meshes write depth
    expect(trail.getTotalVertices()).toBe(10);
    expect(trail.getTotalIndices()).toBe(4 * 6); // a quad per segment
    expect((trail.material as ShaderMaterial).disableDepthWrite).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("gives a graph material's kernel draws the per-particle colour it reads, as the vertex colour", () => {
    // White vertex colours switch on VERTEXCOLOR, which the placement plugin sets to the particle's and
    // the Particle Color node (mycoVColor) reads. (On this GLSL engine the graph's own plugin, WGSL only,
    // stays off: the vertex colour doesn't depend on it.)
    const make2 = (name: string) => createGraphMaterial(scene, name, colorGraph(), {}, { time: 0, resolution: [1, 1] }, () => Promise.reject(new Error("no textures")));
    const graphMaterial = make2("fx").material;
    const p = make(false, true, {
      material: () => graphMaterial,
      materialCopy: (_path, name) => {
        const m = make2(name).material;
        return { material: m, dispose: () => m.dispose() };
      },
    });
    const c = fakeSystem({ emitters: [still("Q", { material: "fx.mat" }), still("M", { mode: "mesh", material: "fx.mat" })] });
    frames(p, c, 20);
    for (const mesh of drawn()) {
      expect(mesh.material).toBeInstanceOf(PBRMaterial);
      expect(mesh.material).not.toBe(graphMaterial); // each output draws its own copy
      mesh.material!.isReadyForSubMesh(mesh, mesh.subMeshes[0]);
      const defines = mesh.subMeshes[0].materialDefines as unknown as Record<string, unknown>;
      expect(defines.VERTEXCOLOR).toBe(true);
      expect(defines.VERTEXALPHA).toBe(true);
    }
  });

  it("draws with an output's material asset once it's there, with the texture and blending until then", () => {
    let material: PBRMaterial | null = null;
    const asked: string[] = [];
    const p = make(false, true, {
      material: (path) => {
        asked.push(path);
        return material;
      },
    });
    const c = fakeSystem({ emitters: [still("E", { material: "fx.mat" }), still("M", { mode: "mesh", material: "fx.mat" })] });
    frames(p, c, 2);
    expect(asked).toContain("fx.mat");
    for (const m of drawn()) expect(m.material).toBeInstanceOf(ShaderMaterial); // the material isn't there: the texture and blending
    material = new PBRMaterial("fx", scene);
    frames(p, c, 20); // the build key is checked a few times a second
    const [billboards, meshes] = drawn();
    for (const m of [billboards, meshes]) {
      expect(m.material).toBeInstanceOf(PBRMaterial);
      expect(m.material).not.toBe(material); // an unshared copy, with the placement plugin
    }
    expect(meshes.getTotalVertices()).toBe(24); // the cube, with its own normals and UVs
    p.dispose();
    expect(scene.materials).toContain(material); // shared: not the draw's to dispose
    expect(scene.meshes).toHaveLength(0);
  });

  it("falls back to the texture for a material asset that isn't PBR, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const material = new StandardMaterial("plain", scene);
    const p = make(false, true, { material: () => material });
    frames(p, fakeSystem({ emitters: [still("E", { material: "plain.mat" })] }), 2);
    expect(drawn()[0].material).toBeInstanceOf(ShaderMaterial);
    expect(warn.mock.calls.some(([m]) => /isn't a PBR material/.test(String(m)))).toBe(true);
    warn.mockRestore();
  });

  it("orders draws by renderOrder through alphaIndex", () => {
    const p = make();
    const c = fakeSystem({
      emitters: [still("Two", { renderOrder: 2 }), still("Minus", { renderOrder: -1 }), still("Zero", {}), still("TrailBack", { mode: "trail", renderOrder: -3 }), still("MeshZero", { mode: "mesh" })],
    });
    frames(p, c, 2);
    // Negative orders under the scene's other transparent meshes, 0 among them, positive over them.
    expect(drawn().map((m) => m.alphaIndex)).toEqual([Number.POSITIVE_INFINITY, -1, Number.MAX_VALUE, -3, Number.MAX_VALUE]);
  });

  it("draws a 2D system at its sorting layer's order, lit by 2D lights through the 2D quad material (ADR 0415)", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    const game = await MycoEngine.create({ headless: true, project: { render: { sortingLayers: ["Back", "Default"] } } });
    try {
      await SceneManager.load("s.json");
      GameObject.create("sun").addComponent(Light2D).type = "global"; // lights every layer
      const rig = new BabylonLights2D({ scene, texture: () => null, textureSize: () => null });
      rig.sync(World.require(), LIGHTS_2D_QUALITY.high);
      const materials2D = new BabylonMaterials2D({ scene, library: new BabylonMaterialLibrary(scene) });
      const p = make(false, true, { sortOrder: (layer, order) => ["Back", "Default"].indexOf(layer) * 10000 + order, materials2D });
      const c = fakeSystem({ emitters: [still("E", {})] }, { sortingLayer: "Default", orderInLayer: 3 });
      frames(p, c, 2);
      const lit = drawn()[0]!;
      expect(lit.alphaIndex).toBe(10003);
      expect(lit.material).toBeInstanceOf(PBRMaterial);
      expect(lit.material!.pluginManager?.getPlugin("MycoLight2D")).toBeTruthy();
      c.orderInLayer = 5; // a new order moves the draw, the same mesh
      frames(p, c, 1);
      expect(drawn()[0]).toBe(lit);
      expect(lit.alphaIndex).toBe(10005);
      const count = c._state.count;
      c.sortingLayer = ""; // 3D again: the instanced shader draw at its render order, the particles kept
      frames(p, c, 1);
      expect(drawn()[0]!.material).toBeInstanceOf(ShaderMaterial);
      expect(drawn()[0]!.alphaIndex).toBe(Number.MAX_VALUE);
      expect(c._state.count).toBeGreaterThanOrEqual(count);
      rig.dispose();
    } finally {
      game.dispose();
      Assets.clearSources();
    }
  });

  it("loads every particle texture as other textures are loaded (flipped), flipbooks and trails too", async () => {
    const asked: unknown[][] = [];
    const tex = new RawTexture(new Uint8Array(16), 2, 2, 5, scene);
    const p = make(false, true, {
      texture: (...args: unknown[]) => {
        asked.push(args);
        return Promise.resolve(tex);
      },
    });
    const c = fakeSystem({
      emitters: [still("Plain", { texture: "plain.png" }), still("Sheet", { texture: "sheet.png", tiles: [4, 4] }), still("Trail", { texture: "trail.png", tiles: [4, 1], mode: "trail" })],
    });
    for (let i = 0; i < 4; i++) {
      frames(p, c, 1);
      await Promise.resolve();
    }
    expect(new Set(asked.map((a) => JSON.stringify(a)))).toEqual(new Set([["plain.png"], ["sheet.png"], ["trail.png"]].map((a) => JSON.stringify(a))));
    expect(drawn()).toHaveLength(3);
    for (const m of drawn()) expect(textureOf(m)).toBe(tex);
  });

  it("gives material-asset quads and trails normals (the placement plugin turns them to the camera)", () => {
    // A graph material that reads the normal (a Fresnel node) didn't compile without one, and the
    // invalid pipeline voided the whole frame on WebGPU.
    const material = new PBRMaterial("fx", scene);
    const p = make(false, true, { material: (path) => (path ? material : null) });
    const c = fakeSystem({ emitters: [still("Q", { material: "fx.mat" }), still("T", { mode: "trail", material: "fx.mat" }, { startSpeed: 2 })] });
    frames(p, c, 10);
    const [q, t] = drawn();
    for (const m of [q, t]) {
      expect(m.material).toBeInstanceOf(PBRMaterial);
      expect(m.isVerticesDataPresent("normal")).toBe(true);
    }
  });

  it("sets up blending and depth writes on each kernel draw's material", () => {
    const base = defaultEmitter().renderer;
    const p = make();
    const effect: ParticleEffect = {
      emitters: [
        { ...defaultEmitter("Add"), renderer: { ...base, blending: "additive" } },
        { ...defaultEmitter("Alpha"), renderer: { ...base, blending: "alpha", mode: "stretched" } },
        { ...defaultEmitter("Flat"), renderer: { ...base, mode: "horizontal", tiles: [2, 2] } },
        { ...defaultEmitter("Upright"), renderer: { ...base, mode: "vertical", blending: "premultiplied" } },
      ],
    };
    frames(p, fakeSystem(effect), 3);
    const [add, alpha, flat, upright] = drawn().map((m) => m.material as ShaderMaterial);
    expect(add.alphaMode).toBe(Constants.ALPHA_ADD);
    expect(alpha.alphaMode).toBe(Constants.ALPHA_COMBINE);
    expect(flat.alphaMode).toBe(Constants.ALPHA_ADD); // the default blending
    expect(upright.alphaMode).toBe(Constants.ALPHA_PREMULTIPLIED);
    for (const m of [add, alpha, flat, upright]) {
      expect(m.disableDepthWrite).toBe(true);
      expect(m.backFaceCulling).toBe(false);
    }
  });
});

/** A minimal compiled graph that reads the particle colour. */
function colorGraph(): CompiledShaderGraph {
  return {
    language: "wgsl",
    target: "unlit",
    surface: "transparent",
    doubleSided: true,
    vertex: { declarations: "", body: "", offset: null, varyings: "" },
    fragment: { declarations: "", body: "", baseColor: "mycoVColor.rgb", alpha: "mycoVColor.a", metalness: null, roughness: null, emission: null, normal: null, physical: null, alphaClip: null },
    uniforms: [],
    problems: [],
    nodeProblems: {},
    portTypes: {},
    dynamicTypes: {},
    dependencies: [],
    usesShaderLevel: false,
    key: "particlecolor",
  } as unknown as CompiledShaderGraph;
}
