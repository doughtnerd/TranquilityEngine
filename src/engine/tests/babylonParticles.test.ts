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
import { Color as EngineColor } from "../core/math";
import type { InstanceDraw, QuadDraw } from "../render/babylon/particleMeshes";
import { BabylonParticles, type BabylonParticleHost } from "../render/babylon/particles";
import type { ParticleCommand, ParticleSystem } from "../render/components";
import { trailPoint } from "../render/particles/simulation";
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

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    scene.useRightHandedSystem = true;
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

  function make(editor = false, selected = true, host: Partial<BabylonParticleHost> = {}) {
    const player = new BabylonParticles({
      scene,
      editor,
      worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      selected: () => selected,
      texture: () => Promise.reject(new Error("no textures here")),
      tierScale: () => 1,
      ...host,
    });
    players.push(player);
    return player;
  }
  /** The scene's Babylon particle systems. */
  const systems = () => scene.particleSystems as BabylonParticleSystem[];
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
    hidden.preview.simulateAll = true;
    frames(hidden, b, 30, 0, 1 / 60);
    expect(b._state.count).toBeGreaterThan(20);
    hidden.preview.playing = false;
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
    const d = p.drawsOf(c)[0] as InstanceDraw;
    expect(d.kind).toBe("instances");
    expect(d.mesh.thinInstanceCount).toBe(3);
    expect(d.mesh.isVisible).toBe(true);
    expect(d.mesh.material).toBeInstanceOf(StandardMaterial); // the unlit texture material
    // Turned 90° about +Y and scaled by the size (2), at the node's position.
    const m = Array.from(d.matrices.subarray(0, 16));
    expect(m[0]).toBeCloseTo(0, 5);
    expect(m[2]).toBeCloseTo(-2, 5);
    expect(m[5]).toBeCloseTo(2, 5);
    expect(m[8]).toBeCloseTo(2, 5);
    expect(m.slice(12)).toEqual([3, 4, 5, 1]);
    // #ff000080: linear red, half opaque.
    expect(Array.from(d.colors.subarray(0, 4)).map((v) => +v.toFixed(3))).toEqual([1, 0, 0, 0.502]);
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
    const d = p.drawsOf(c)[0] as QuadDraw;
    expect(d.kind).toBe("trail");
    expect(scene.particleSystems).toHaveLength(0);
    const sim = d.emitter.pool[0];
    expect(sim.trailCount).toBe(5);
    expect(d.quads).toBe(4); // one per segment
    // The particle rises along +Y; the camera looks along -Z, so the ribbon spreads along X.
    const v = (i: number) => [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]];
    const head = { x: 0, y: 0, z: 0 };
    trailPoint(sim, 0, head);
    const [a, b] = [v(0), v(1)];
    expect(a[1]).toBeCloseTo(head.y, 5);
    expect(b[1]).toBeCloseTo(head.y, 5);
    expect(Math.abs(a[0] - b[0])).toBeCloseTo(0.5, 5); // full width at the head
    expect(a[2]).toBeCloseTo(0, 5);
    expect(b[2]).toBeCloseTo(0, 5);
    // Segment 1 starts at the second point, at 3/4 of the width (u = 1/4).
    expect(Math.abs(v(4)[0] - v(5)[0])).toBeCloseTo(0.375, 5);
    // The tail (last quad's far end) has no width.
    expect(v(14)[0]).toBeCloseTo(v(15)[0], 5);
    const tail = { x: 0, y: 0, z: 0 };
    trailPoint(sim, 4, tail);
    expect(v(14)[1]).toBeCloseTo(tail.y, 5);
    expect(tail.y).toBeLessThan(head.y);
    // Coloured with the particle, U along the ribbon (1 at the head).
    expect(d.colors[3]).toBeCloseTo(sim.a, 5);
    expect(d.uvs[0]).toBeCloseTo(1, 5);
    expect(d.uvs[14 * 2]).toBeCloseTo(0, 5);
    // Fewer quads than the buffers hold make the submesh partial: it needs bounds of its own, which
    // Babylon's transparent sort reads (it threw on `boundingSphere` of undefined in the editor).
    const sub = d.mesh.subMeshes[0];
    expect(sub.IsGlobal).toBe(false);
    const bounds = sub.getBoundingInfo();
    expect(bounds).toBeDefined();
    expect(bounds.boundingBox.maximumWorld.y).toBeCloseTo(head.y, 5);
    expect(bounds.boundingBox.minimumWorld.y).toBeCloseTo(tail.y, 5);
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
    let [billboards, meshes] = p.drawsOf(c);
    expect(billboards.kind).toBe("system"); // the material isn't there: the texture and blending
    expect((meshes as InstanceDraw).mesh.material).toBeInstanceOf(StandardMaterial);
    material = new StandardMaterial("fx", scene);
    frames(p, c, 20); // the build key is checked a few times a second
    [billboards, meshes] = p.drawsOf(c);
    expect(billboards.kind).toBe("quads");
    expect((billboards as QuadDraw).mesh.material).toBe(material);
    expect((billboards as QuadDraw).quads).toBe(3);
    expect((meshes as InstanceDraw).mesh.material).toBe(material);
    expect(scene.particleSystems).toHaveLength(0);
    p.dispose();
    expect(scene.materials).toContain(material); // shared: not the draw's to dispose
    expect(scene.meshes).toHaveLength(0);
  });

  it("orders particle systems by renderOrder, and mesh draws by alphaIndex", () => {
    const p = make();
    const c = fakeSystem({
      emitters: [still("Two", { renderOrder: 2 }), still("Minus", { renderOrder: -1 }), still("Zero", {}), still("TrailBack", { mode: "trail", renderOrder: -3 }), still("MeshFront", { mode: "mesh", renderOrder: 4 }), still("MeshZero", { mode: "mesh" })],
    });
    frames(p, c, 2);
    const draws = p.drawsOf(c);
    expect(systems()).toEqual([draws[1].ps, draws[2].ps, draws[0].ps]); // -1, 0, 2
    expect((draws[3] as QuadDraw).mesh.alphaIndex).toBe(-3);
    expect((draws[4] as InstanceDraw).mesh.alphaIndex).toBe(Number.POSITIVE_INFINITY);
    expect((draws[5] as InstanceDraw).mesh.alphaIndex).toBe(Number.MAX_VALUE); // with the scene's other transparent meshes
  });

  it("blends flipbook tiles: each particle twice, on its tile and the next, weighted by the fraction", () => {
    const material = new StandardMaterial("fx", scene);
    const p = make(false, true, { material: () => material });
    const frame: ParticleEmitterSettings["behaviors"][number] = { type: "frameOverLife", frame: { curve: [[0, 0], [1, 4]] } };
    const c = fakeSystem({ emitters: [still("E", { tiles: [2, 2], blendTiles: true }, { startLife: 1, behaviors: [frame] }), still("Q", { tiles: [2, 2], blendTiles: true, material: "fx.mat" }, { startLife: 1, behaviors: [frame] })] });
    frames(p, c, 18); // 0.3 s: tile value 1.2
    const [d, q] = p.drawsOf(c);
    const sim = d.emitter.pool[0];
    expect(sim.tile).toBe(1);
    expect(sim.tileBlend).toBeCloseTo(0.2, 1);
    const list = systems()[0].particles;
    expect(list).toHaveLength(6); // 3 particles × 2
    expect(list[0].cellIndex).toBe(1);
    expect(list[0].color.a).toBeCloseTo(sim.a * (1 - sim.tileBlend), 5);
    expect(list[1].cellIndex).toBe(2);
    expect(list[1].color.a).toBeCloseTo(sim.a * sim.tileBlend, 5);
    expect(list[1].color.r).toBeCloseTo(sim.r, 5); // additive: only the opacity is weighted
    // Quads (a material asset) do the same: two quads, the second on the next tile's UVs.
    const quads = q as QuadDraw;
    expect(quads.quads).toBe(6);
    expect(quads.colors[3]).toBeCloseTo(sim.a * (1 - sim.tileBlend), 5);
    expect(quads.colors[4 * 4 + 3]).toBeCloseTo(sim.a * sim.tileBlend, 5);
    expect([quads.uvs[0], quads.uvs[1]]).toEqual([0.5, 0.5]); // tile 1: top right, its bottom-left corner
    expect([quads.uvs[8], quads.uvs[9]]).toEqual([0, 0]); // tile 2: bottom left
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

  it("gives material-asset quads and trails normals facing the camera, and plain trails none", () => {
    // A graph material that reads the normal (a Fresnel node) didn't compile without one, and the
    // invalid pipeline voided the whole frame on WebGPU.
    const material = new StandardMaterial("fx", scene);
    const p = make(false, true, { material: (path) => (path ? material : null) });
    const c = fakeSystem({ emitters: [still("Q", { material: "fx.mat" }), still("T", { mode: "trail", material: "fx.mat" }, { startSpeed: 2 }), still("Plain", { mode: "trail" }, { startSpeed: 2 })] });
    frames(p, c, 10);
    const [q, t, plain] = p.drawsOf(c) as QuadDraw[];
    expect(q.mesh.isVerticesDataPresent("normal")).toBe(true);
    // The camera is on +Z looking at the particles at the origin: billboard normals point at it.
    const n = q.normals!;
    expect(n[0]).toBeCloseTo(0, 5);
    expect(n[1]).toBeCloseTo(0, 5);
    expect(n[2]).toBeCloseTo(1, 5);
    expect(t.quads).toBeGreaterThan(0);
    expect(t.mesh.isVerticesDataPresent("normal")).toBe(true);
    const tn = t.normals!;
    const toCamera = new Vector3(0, 0, 10).subtract(new Vector3(t.positions[0], t.positions[1], t.positions[2]));
    expect(Vector3.Dot(new Vector3(tn[0], tn[1], tn[2]), toCamera)).toBeGreaterThan(0);
    expect(Math.hypot(tn[0], tn[1], tn[2])).toBeCloseTo(1, 5);
    expect(plain.normals).toBeNull();
    expect(plain.mesh.isVerticesDataPresent("normal")).toBe(false);
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
