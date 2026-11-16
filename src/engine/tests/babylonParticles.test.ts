// ADR 0075 stage 5: particle effects on the Babylon backend (render/babylon/particles.ts), run
// headless on Babylon's NullEngine. The simulation has its own tests (particleSimulation.test.ts);
// these check the player's lifecycle, commands and the Babylon particle systems it drives.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphMaterial } from "../render/babylon/graphMaterial";
import type { CompiledShaderGraph } from "../render/shaderGraph/compile";
import { Color as EngineColor } from "../core/math";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { BabylonParticles, type BabylonParticleHost } from "../render/babylon/particles";
import type { ParticleCommand, ParticleSystem } from "../render/components";
import { defaultEmitter, defaultRenderer, defaultShape, particleEffectJSON, type ParticleEffect, type ParticleEmitterSettings, type ParticleRenderer } from "../scene/particles";

/** A stand-in ParticleSystem component: the fields and state the player reads and writes. */
function fakeSystem(effect: ParticleEffect, over: Partial<ParticleSystem> = {}) {
  return {
    isActiveAndEnabled: true,
    effect: "",
    embeddedEffect: particleEffectJSON(effect),
    playOnAwake: true,
    timeScale: 1,
    tint: EngineColor.white,
    emissionScale: 1,
    destroyOnFinish: false,
    seed: 0,
    _commands: [] as ParticleCommand[],
    _state: { playing: false, paused: false, time: 0, count: 0, alive: false },
    node: { name: "Fx" },
    ...over,
  } as unknown as ParticleSystem;
}

const steady = (rate: number, max = 1000): ParticleEffect => ({
  emitters: [{ ...defaultEmitter("E"), startLife: 10, emission: { rateOverTime: rate, rateOverDistance: 0, bursts: [] }, maxParticles: max }],
});

describe("particles on the Babylon backend (ADR 0075 stage 5)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let players: BabylonParticles[];
  /** What the draws last sent each GPU vertex buffer (the NullEngine keeps no copy of a partial update). */
  let uploads: WeakMap<object, Float32Array>;

  beforeEach(() => {
    engine = new NullEngine();
    uploads = new WeakMap();
    const upload = engine.updateDynamicVertexBuffer.bind(engine);
    engine.updateDynamicVertexBuffer = (buffer, vertices, ...rest) => {
      uploads.set(buffer, vertices as Float32Array);
      upload(buffer, vertices, ...rest);
    };
    scene = new Scene(engine);
    // Trails and material-asset quads face the active camera: on +Z, looking at the origin.
    const camera = new TargetCamera("camera", new Vector3(0, 0, 10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    players = [];
  });

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
  /** The scene's Babylon particle systems. */
  const systems = () => scene.particleSystems as BabylonParticleSystem[];
  /** The meshes drawing the "Fx" node's effect, in the order its emitters were built. */
  const drawn = () => scene.meshes.filter((m) => m.name.startsWith("particles:Fx:")) as Mesh[];
  /** Quads a mesh built on the CPU draws (its submesh's indices, six a quad). */
  const quadsOf = (m: Mesh) => (m.isVisible ? m.subMeshes[0].indexCount / 6 : 0);
  /** A mesh's vertex data of one kind (thin-instance buffers included), as last sent to the GPU. */
  const data = (m: Mesh, kind: string) => uploads.get(m.getVertexBuffer(kind)!.getWrapperBuffer().getBuffer()!)!;
  const frames = (p: BabylonParticles, c: ParticleSystem, n: number, dt = 1 / 60, unscaled = dt) => {
    for (let i = 0; i < n; i++) p.sync([c], dt, unscaled);
  };

  it("draws each emitter with one Babylon particle system, mirroring the simulation", () => {
    const p = make();
    const c = fakeSystem(steady(100, 50));
    frames(p, c, 60);
    expect(c._state.count).toBeGreaterThanOrEqual(50);
    expect(c._state.count).toBeLessThanOrEqual(52);
    expect(c._state.playing).toBe(true);
    expect(c._state.time).toBeCloseTo(1, 1);
    expect(scene.particleSystems).toHaveLength(1);
    expect(systems()[0].particles).toHaveLength(c._state.count);
    expect(p.state()).toMatchObject({ systems: 1, emitters: 1, batches: 1 });
    // A drawn particle carries the simulation's size and colour.
    const b = systems()[0].particles[0];
    expect(b.size).toBe(1);
    expect(b.scale.x).toBeGreaterThan(0);
    expect(b.color.a).toBeGreaterThan(0);
  });

  describe("seed", () => {
    const randomFx = (): ParticleEffect => ({ emitters: [{ ...defaultEmitter("E"), startLife: 10, startSpeed: 3, shape: { ...defaultShape(), type: "sphere", radius: 1 }, emission: { rateOverTime: 50, rateOverDistance: 0, bursts: [] } }] });
    /** Where the particles `c` draws are (several players share the scene: its own system, found as the variant report does). */
    const snapshot = (p: BabylonParticles, c: ParticleSystem) => {
      const own = systems().find((s) => p.ownerOf(s) === c)!;
      return own.particles.map((q) => q.position.asArray().map((v) => v.toFixed(5)).join(","));
    };
    const play = (seed: number) => {
      const p = make();
      const c = fakeSystem(randomFx(), { seed } as Partial<ParticleSystem>);
      frames(p, c, 30);
      return { p, c, at: snapshot(p, c) };
    };

    it("plays the same particles for the same seed, and a restart repeats them", () => {
      const a = play(12);
      expect(a.at.length).toBeGreaterThan(10);
      expect(play(12).at).toEqual(a.at);
      expect(play(13).at).not.toEqual(a.at);
      a.c._commands.push({ op: "restart" } as ParticleCommand);
      frames(a.p, a.c, 30);
      expect(snapshot(a.p, a.c)).toEqual(a.at);
    });

    it("plays differently every time with seed 0", () => {
      expect(play(0).at).not.toEqual(play(0).at);
    });
  });

  it("clamps bursts to the particle limit", () => {
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), startLife: 10, maxParticles: 10, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [{ time: 0, count: 200, cycles: 1, interval: 0.1, probability: 1 }] } }] };
    const c = fakeSystem(effect);
    frames(p, c, 10);
    expect(c._state.count).toBe(10);
  });

  it("scales emission with emissionScale and the tier, and pauses with the World's time", () => {
    const p = make(false, true, { tierScale: () => 0.5 });
    const c = fakeSystem(steady(100), { emissionScale: 0.5 } as Partial<ParticleSystem>);
    frames(p, c, 60);
    expect(c._state.count).toBeGreaterThan(20);
    expect(c._state.count).toBeLessThan(30);
    const before = c._state.count;
    frames(p, c, 30, 0, 1 / 60); // timeScale 0
    expect(c._state.count).toBe(before);
  });

  it("runs script commands: pause, play, stop, emit and clear", () => {
    const p = make();
    const c = fakeSystem(steady(0), { playOnAwake: false } as Partial<ParticleSystem>);
    frames(p, c, 1);
    expect(c._state.playing).toBe(false);
    c._commands.push({ op: "play" }, { op: "emit", count: 25 });
    frames(p, c, 1);
    expect(c._state.playing).toBe(true);
    expect(c._state.count).toBe(25);
    c._commands.push({ op: "pause" });
    frames(p, c, 1);
    expect(c._state.paused).toBe(true);
    const t = c._state.time;
    frames(p, c, 5);
    expect(c._state.time).toBe(t);
    c._commands.push({ op: "play" });
    frames(p, c, 1);
    expect(c._state.playing).toBe(true);
    c._commands.push({ op: "stop", clear: false });
    frames(p, c, 1);
    expect(c._state.playing).toBe(false);
    expect(c._state.alive).toBe(true); // particles live out their lives
    c._commands.push({ op: "clear" });
    frames(p, c, 1);
    expect(c._state.count).toBe(0);
    expect(systems()[0].particles).toHaveLength(0);
  });

  it("restart removes the particles and starts over", () => {
    const p = make();
    const c = fakeSystem(steady(60));
    frames(p, c, 30);
    expect(c._state.count).toBeGreaterThan(10);
    c._commands.push({ op: "restart" });
    frames(p, c, 1);
    expect(c._state.time).toBeCloseTo(1 / 60, 3);
    expect(c._state.count).toBeLessThan(3);
  });

  it("finishes a one-shot effect", () => {
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), looping: false, duration: 0.5, startLife: 0.2, emission: { rateOverTime: 50, rateOverDistance: 0, bursts: [] } }] };
    const c = fakeSystem(effect);
    frames(p, c, 90);
    expect(c._state.playing).toBe(false);
    expect(c._state.alive).toBe(false);
  });

  it("rebuilds when the effect changes and releases systems that are gone", () => {
    const p = make();
    const c = fakeSystem(steady(10));
    frames(p, c, 1);
    expect(scene.particleSystems).toHaveLength(1);
    (c as { embeddedEffect: unknown }).embeddedEffect = particleEffectJSON({ emitters: [defaultEmitter("A"), defaultEmitter("B")] });
    frames(p, c, 1);
    expect(p.state().emitters).toBe(2);
    expect(scene.particleSystems).toHaveLength(2);
    p.sync([], 1 / 60, 1 / 60);
    expect(p.state()).toMatchObject({ systems: 0, emitters: 0, batches: 0 });
    expect(scene.particleSystems).toHaveLength(0);
  });

  it("release() and dispose() remove the Babylon particle systems", () => {
    const p = make();
    const a = fakeSystem(steady(10));
    const b = fakeSystem(steady(10));
    p.sync([a, b], 1 / 60, 1 / 60);
    expect(scene.particleSystems).toHaveLength(2);
    p.release(a);
    expect(scene.particleSystems).toHaveLength(1);
    p.dispose();
    expect(scene.particleSystems).toHaveLength(0);
  });

  it("editor: plays only selected systems, at the preview speed", () => {
    const shown = make(true, true);
    const a = fakeSystem(steady(60));
    frames(shown, a, 30, 0, 1 / 60);
    expect(a._state.count).toBeGreaterThan(20);
    const hidden = make(true, false);
    const b = fakeSystem(steady(60));
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b._state.count).toBe(0);
    previews.get(hidden)!.simulateAll = true;
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b._state.count).toBeGreaterThan(20);
    previews.get(hidden)!.playing = false;
    const n = b._state.count;
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b._state.count).toBe(n);
  });

  it("waits for a texture to load, then builds with it", async () => {
    let resolve!: (t: RawTexture) => void;
    const loaded = new Promise<RawTexture>((r) => (resolve = r));
    const p = make(false, true, { texture: () => loaded });
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), renderer: { ...defaultEmitter().renderer, texture: "spark.png" } }] };
    const c = fakeSystem(effect);
    frames(p, c, 3);
    expect(scene.particleSystems).toHaveLength(0);
    resolve(new RawTexture(new Uint8Array(16), 2, 2, 5, scene));
    await loaded;
    await Promise.resolve();
    frames(p, c, 3);
    expect(scene.particleSystems).toHaveLength(1);
    expect(scene.particleSystems[0].particleTexture).toBeTruthy();
  });

  it("draws with the default dot when a texture fails to load, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), renderer: { ...defaultEmitter().renderer, texture: "missing.png" } }] };
    const c = fakeSystem(effect);
    frames(p, c, 1);
    await new Promise((r) => setTimeout(r, 0));
    frames(p, c, 5);
    expect(scene.particleSystems).toHaveLength(1);
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

  it("draws the mesh mode as thin instances posed and tinted by each particle", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = make(false, true, { worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1] });
    const c = fakeSystem({ emitters: [still("E", { mode: "mesh", mesh: "builtin:cube" }, { startRotation: 90 })] });
    frames(p, c, 3);
    expect(scene.particleSystems).toHaveLength(0);
    const [mesh] = drawn();
    expect(mesh.thinInstanceCount).toBe(3);
    expect(mesh.isVisible).toBe(true);
    expect(mesh.material).toBeInstanceOf(StandardMaterial); // the unlit texture material
    // Turned 90° about +Y and scaled by the size (2), at the node's position.
    const m = Array.from(mesh.thinInstanceGetWorldMatrices()[0].m);
    expect(m[0]).toBeCloseTo(0, 5);
    expect(m[2]).toBeCloseTo(-2, 5);
    expect(m[5]).toBeCloseTo(2, 5);
    expect(m[8]).toBeCloseTo(2, 5);
    expect(m.slice(12)).toEqual([3, 4, 5, 1]);
    // #ff000080: linear red, half opaque.
    expect(Array.from(data(mesh, "instanceColor").slice(0, 4)).map((v) => +v.toFixed(3))).toEqual([1, 0, 0, 0.502]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("draws trails as camera-facing ribbons, as wide as size × width over length", () => {
    const p = make();
    const emitter = still(
      "T",
      { mode: "trail", trailLength: 5 },
      { startSpeed: 1, startSize: 0.5, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [{ time: 0, count: 1, cycles: 1, interval: 0.1, probability: 1 }] }, behaviors: [{ type: "widthOverLength", width: { curve: [[0, 1], [1, 0]] } }] },
    );
    const c = fakeSystem({ emitters: [emitter] });
    frames(p, c, 10);
    const [mesh] = drawn();
    expect(scene.particleSystems).toHaveLength(0);
    expect(quadsOf(mesh)).toBe(4); // one per segment of its five trail points
    // The particle rises along +Y; the camera looks along -Z, so the ribbon spreads along X.
    const positions = data(mesh, "position");
    const colors = data(mesh, "color");
    const uvs = data(mesh, "uv");
    const v = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const [a, b] = [v(0), v(1)];
    const head = { y: a[1] };
    expect(b[1]).toBeCloseTo(head.y, 5); // across the ribbon at the head
    expect(Math.abs(a[0] - b[0])).toBeCloseTo(0.5, 5); // full width at the head
    expect(a[2]).toBeCloseTo(0, 5);
    expect(b[2]).toBeCloseTo(0, 5);
    // Segment 1 starts at the second point, at 3/4 of the width (u = 1/4).
    expect(Math.abs(v(4)[0] - v(5)[0])).toBeCloseTo(0.375, 5);
    // The tail (last quad's far end) has no width.
    expect(v(14)[0]).toBeCloseTo(v(15)[0], 5);
    const tail = { y: v(14)[1] };
    expect(v(15)[1]).toBeCloseTo(tail.y, 5);
    expect(tail.y).toBeLessThan(head.y);
    // Coloured with the particle all along, U along the ribbon (1 at the head).
    expect(colors[3]).toBeGreaterThan(0);
    expect(colors[14 * 4 + 3]).toBeCloseTo(colors[3], 5);
    expect(uvs[0]).toBeCloseTo(1, 5);
    expect(uvs[14 * 2]).toBeCloseTo(0, 5);
    // Fewer quads than the buffers hold make the submesh partial: it needs bounds of its own, which
    // Babylon's transparent sort reads (it threw on `boundingSphere` of undefined in the editor).
    const sub = mesh.subMeshes[0];
    expect(sub.IsGlobal).toBe(false);
    const bounds = sub.getBoundingInfo();
    expect(bounds).toBeDefined();
    expect(bounds.boundingBox.maximumWorld.y).toBeCloseTo(head.y, 5);
    expect(bounds.boundingBox.minimumWorld.y).toBeCloseTo(tail.y, 5);
  });

  it("gives a graph material's particle draws the per-particle colours it reads", () => {
    // Quads carry a vertex colour buffer, mesh instances a thin-instance colour buffer: Babylon defines
    // VERTEXCOLOR / INSTANCESCOLOR from them, which the Particle Color node (mycoVColor) reads.
    (engine as unknown as { _isWebGPU: boolean })._isWebGPU = true;
    const graphMaterial = createGraphMaterial(scene, "fx", colorGraph(), {}, { time: 0, resolution: [1, 1] }, () => Promise.reject(new Error("no textures"))).material;
    const p = make(false, true, { material: () => graphMaterial });
    const c = fakeSystem({ emitters: [still("Q", { material: "fx.mat" }), still("M", { mode: "mesh", material: "fx.mat" })] });
    frames(p, c, 20);
    const [q, m] = drawn();
    for (const mesh of [q, m]) expect(mesh.material).toBe(graphMaterial);
    const defines = (mesh: typeof q) => {
      graphMaterial.isReadyForSubMesh(mesh, mesh.subMeshes[0]);
      return mesh.subMeshes[0].materialDefines as unknown as Record<string, unknown>;
    };
    expect(defines(q).VERTEXCOLOR).toBe(true);
    expect(defines(q).VERTEXALPHA).toBe(true);
    expect(m.hasVertexAlpha).toBe(true);
    expect(defines(m).INSTANCESCOLOR).toBe(true);
  });

  it("draws with an emitter's material asset once it's there, with the texture and blending until then", () => {
    let material: StandardMaterial | null = null;
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
    expect(scene.particleSystems).toHaveLength(1); // the material isn't there: the texture and blending
    let [meshes] = drawn();
    expect(meshes.material).toBeInstanceOf(StandardMaterial);
    material = new StandardMaterial("fx", scene);
    frames(p, c, 20); // the build key is checked a few times a second
    expect(scene.particleSystems).toHaveLength(0);
    let billboards: Mesh;
    [billboards, meshes] = drawn();
    expect(billboards.material).toBe(material);
    expect(quadsOf(billboards)).toBe(3);
    expect(meshes.material).toBe(material);
    p.dispose();
    expect(scene.materials).toContain(material); // shared: not the draw's to dispose
    expect(scene.meshes).toHaveLength(0);
  });

  it("orders particle systems by renderOrder, and mesh draws by alphaIndex", () => {
    const p = make();
    const c = fakeSystem({
      emitters: [
        still("Two", { renderOrder: 2 }, { startSize: 3 }),
        still("Minus", { renderOrder: -1 }, { startSize: 1 }),
        still("Zero", {}, { startSize: 2 }),
        still("TrailBack", { mode: "trail", renderOrder: -3 }),
        still("MeshFront", { mode: "mesh", renderOrder: 4 }),
        still("MeshZero", { mode: "mesh" }),
      ],
    });
    frames(p, c, 2);
    expect(systems().map((s) => s.particles[0].scale.x)).toEqual([1, 2, 3]); // Minus (-1), Zero (0), Two (2)
    expect(drawn().map((m) => m.alphaIndex)).toEqual([-3, Number.POSITIVE_INFINITY, Number.MAX_VALUE]); // MeshZero with the scene's other transparent meshes
  });

  it("blends flipbook tiles: each particle twice, on its tile and the next, weighted by the fraction", () => {
    const material = new StandardMaterial("fx", scene);
    const p = make(false, true, { material: () => material });
    const frame: ParticleEmitterSettings["behaviors"][number] = { type: "frameOverLife", frame: { curve: [[0, 0], [1, 4]] } };
    const c = fakeSystem({ emitters: [still("E", { tiles: [2, 2], blendTiles: true }, { startLife: 1, behaviors: [frame] }), still("Q", { tiles: [2, 2], blendTiles: true, material: "fx.mat" }, { startLife: 1, behaviors: [frame] })] });
    frames(p, c, 18); // 0.3 s: tile value 1.2
    const list = systems()[0].particles;
    expect(list).toHaveLength(6); // 3 particles × 2
    expect(list[0].cellIndex).toBe(1);
    expect(list[1].cellIndex).toBe(2);
    // The opacity split by the tile value's fraction (0.2): 0.8 on its tile, 0.2 on the next.
    const [a0, a1] = [list[0].color.a, list[1].color.a];
    expect(a1 / (a0 + a1)).toBeCloseTo(0.2, 1);
    expect(list[1].color.r).toBeCloseTo(list[0].color.r, 5); // additive: only the opacity is weighted
    // Quads (a material asset) do the same: two quads, the second on the next tile's UVs.
    const [q] = drawn();
    const colors = data(q, "color");
    const uvs = data(q, "uv");
    expect(quadsOf(q)).toBe(6);
    expect(colors[3]).toBeCloseTo(a0, 5);
    expect(colors[4 * 4 + 3]).toBeCloseTo(a1, 5);
    expect([uvs[0], uvs[1]]).toEqual([0.5, 0.5]); // tile 1: top right, its bottom-left corner
    expect([uvs[8], uvs[9]]).toEqual([0, 0]); // tile 2: bottom left
  });

  it("loads a flipbook's texture unflipped for Babylon's sprite sheet, and other particle textures flipped", async () => {
    // Babylon's particle shader reads a sheet's cells with V 0 at the image's top; loaded flipped like
    // other textures, every flipbook showed the mirrored row's tile, upside down.
    const asked: [string, boolean][] = [];
    const tex = new RawTexture(new Uint8Array(16), 2, 2, 5, scene);
    const p = make(false, true, {
      texture: (path, sheet) => {
        asked.push([path, !!sheet]);
        return Promise.resolve(tex);
      },
    });
    const c = fakeSystem({
      emitters: [still("Plain", { texture: "plain.png" }), still("Sheet", { texture: "sheet.png", tiles: [4, 4] }), still("Trail", { texture: "trail.png", tiles: [4, 1], mode: "trail" })],
    });
    for (let i = 0; i < 4; i++) {
      frames(p, c, 1); // the build waits on each texture in turn
      await Promise.resolve();
    }
    expect(asked).toContainEqual(["plain.png", false]);
    expect(asked).toContainEqual(["sheet.png", true]);
    expect(asked).toContainEqual(["trail.png", false]); // trails are quads with their own UVs, on the flipped texture
    expect(asked.some(([path, sheet]) => path === "sheet.png" && !sheet)).toBe(false);
  });

  it("lays horizontal quads flat with their top towards +Z, as the GPU path does, wound to face up (ADR 0164)", () => {
    // Drawn by the engine's own quads (a material asset); plain ones are Babylon's particle system.
    const material = new StandardMaterial("fx", scene);
    const p = make(false, true, { material: (path) => (path ? material : null) });
    const c = fakeSystem({ emitters: [still("H", { mode: "horizontal", material: "fx.mat" })] });
    frames(p, c, 10);
    const [d] = drawn();
    expect(quadsOf(d)).toBeGreaterThan(0);
    const positions = data(d, "position");
    const v = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const [c0, c1, c2, c3] = [v(0), v(1), v(2), v(3)];
    for (const k of [c0, c1, c2, c3]) expect(k[1]).toBeCloseTo(c0[1], 5); // flat
    expect(c3[2]).toBeGreaterThan(c0[2]); // V 1 (the image's top) towards +Z
    expect(c1[0]).toBeGreaterThan(c0[0]); // U along +X
    // Babylon's left-handed front face: the right-hand-rule normal points away from a viewer above.
    const e1 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]], e2 = [c2[0] - c0[0], c2[1] - c0[1], c2[2] - c0[2]];
    expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeLessThan(0);
  });

  it("gives material-asset quads and trails normals facing the camera, and plain trails none", () => {
    // A graph material that reads the normal (a Fresnel node) didn't compile without one, and the
    // invalid pipeline voided the whole frame on WebGPU.
    const material = new StandardMaterial("fx", scene);
    const p = make(false, true, { material: (path) => (path ? material : null) });
    const c = fakeSystem({ emitters: [still("Q", { material: "fx.mat" }), still("T", { mode: "trail", material: "fx.mat" }, { startSpeed: 2 }), still("Plain", { mode: "trail" }, { startSpeed: 2 })] });
    frames(p, c, 10);
    const [q, t, plain] = drawn();
    expect(q.isVerticesDataPresent("normal")).toBe(true);
    // The camera is on +Z looking at the particles at the origin: billboard normals point at it.
    const n = data(q, "normal");
    expect(n[0]).toBeCloseTo(0, 5);
    expect(n[1]).toBeCloseTo(0, 5);
    expect(n[2]).toBeCloseTo(1, 5);
    expect(quadsOf(t)).toBeGreaterThan(0);
    expect(t.isVerticesDataPresent("normal")).toBe(true);
    const tn = data(t, "normal");
    const tp = data(t, "position");
    const toCamera = new Vector3(0, 0, 10).subtract(new Vector3(tp[0], tp[1], tp[2]));
    expect(Vector3.Dot(new Vector3(tn[0], tn[1], tn[2]), toCamera)).toBeGreaterThan(0);
    expect(Math.hypot(tn[0], tn[1], tn[2])).toBeCloseTo(1, 5);
    expect(plain.isVerticesDataPresent("normal")).toBe(false);
  });

  it("sets up blending, billboard modes and flipbooks on the Babylon system", () => {
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
    const [add, alpha, flat, upright] = systems();
    expect(add.blendMode).toBe(2); // BLENDMODE_ADD
    expect(alpha.blendMode).toBe(1); // BLENDMODE_STANDARD
    expect(alpha.billboardMode).toBe(8); // stretched
    expect(flat.isBillboardBased).toBe(false);
    expect(flat.isAnimationSheetEnabled).toBe(true);
    expect(flat.spriteCellWidth).toBe(32); // 64 px dot, two columns
    expect(upright.billboardMode).toBe(2); // Y
    expect(upright.blendMode).toBe(7); // premultiplied
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
