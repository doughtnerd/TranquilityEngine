// ADR 0075 stage 5: particle effects on the Babylon backend (render/babylon/particles.ts), run
// headless on Babylon's NullEngine. The simulation has its own tests (particleSimulation.test.ts);
// these check the player's lifecycle, commands and the Babylon particle systems it drives.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color as EngineColor } from "../core/math";
import { BabylonParticles, type BabylonParticleHost } from "../render/babylon/particles";
import type { ParticleCommand, ParticleSystem } from "../render/components";
import { defaultEmitter, particleEffectJSON, type ParticleEffect } from "../scene/particles";

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

  it("warns once about the trail mode and draws billboards", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = make();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), renderer: { ...defaultEmitter().renderer, mode: "trail" } }] };
    const c = fakeSystem(effect);
    frames(p, c, 5);
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("trail"))).toHaveLength(1);
    expect(scene.particleSystems[0].billboardMode).toBe(7);
    warn.mockRestore();
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
