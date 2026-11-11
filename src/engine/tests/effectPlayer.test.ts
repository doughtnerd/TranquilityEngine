// ADR 0153: the effect player (render/babylon/effectPlayer.ts), one particle effect at one transform,
// headless on Babylon's NullEngine. A World's ParticleSystems (babylonParticles.test.ts), the particle
// graph editor's preview and the asset thumbnails (babylonPreviews.test.ts) all play through it.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EffectPlayer, EffectResources, type EffectHost } from "../render/babylon/effectPlayer";
import type { QuadDraw } from "../render/babylon/particleMeshes";
import { compileParticleGraph, type ParticleProgram } from "../scene/particleCompile";
import { migrateParticleEffect } from "../scene/particleGraphFormat";
import { defaultEmitter, defaultRenderer, defaultShape, type ParticleEffect, type ParticleEmitterSettings, type ParticleRenderer } from "../scene/particles";

/** A steady emitter: `rate` particles a second that live ten seconds. */
const steady = (name: string, rate = 30, renderer: Partial<ParticleRenderer> = {}): ParticleEmitterSettings => ({
  ...defaultEmitter(name),
  startLife: 10,
  startSpeed: 2,
  shape: { ...defaultShape(), type: "sphere", radius: 1 },
  emission: { rateOverTime: rate, rateOverDistance: 0, bursts: [] },
  renderer: { ...defaultRenderer(), ...renderer },
});

/** One burst of `count` particles at the start that live `life` seconds, then nothing. */
const oneShot = (name: string, count = 5, life = 0.2): ParticleEmitterSettings => ({
  ...defaultEmitter(name),
  startLife: life,
  looping: false,
  duration: 0.1,
  emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [{ time: 0, count, cycles: 1, interval: 0.1, probability: 1 }] },
});

const program = (effect: ParticleEffect): ParticleProgram => compileParticleGraph(migrateParticleEffect(effect));

describe("the effect player (ADR 0153)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let resources: EffectResources;
  let warnings: string[];

  const make = (host: Partial<EffectHost> = {}) => {
    resources = new EffectResources({ scene, texture: () => Promise.reject(new Error("no textures here")), ...host }, (m) => warnings.push(m));
    return resources;
  };

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    warnings = [];
  });

  afterEach(() => {
    resources?.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("starts the On Play systems on its own and the event-started ones on their event", () => {
    const graph = migrateParticleEffect({ emitters: [steady("A"), steady("B")] });
    graph.nodes.push({ id: "n1", type: "event.custom", position: [0, 0], settings: { name: "boom" } });
    graph.events.push({ from: "n1", to: `${graph.systems[1].id}.start` });
    const p = compileParticleGraph(graph);
    expect(p.autoStart).toEqual([true, false]);
    const player = new EffectPlayer(make(), p, { name: "fx" });
    expect(player.build()).toBe(true);
    for (let i = 0; i < 30; i++) player.step(1 / 60);
    const [a, b] = player.sim!.emitters;
    expect(a.count).toBeGreaterThan(0);
    expect(b.count).toBe(0);
    player.event("boom");
    for (let i = 0; i < 30; i++) player.step(1 / 60);
    expect(b.count).toBeGreaterThan(0);
    // A restart puts the event-started system back to waiting.
    player.restart();
    for (let i = 0; i < 30; i++) player.step(1 / 60);
    expect(player.sim!.emitters[1].count).toBe(0);
    player.dispose();
  });

  it("starts stopped when asked, plays from the start on play(), and stops with or without clearing", () => {
    const player = new EffectPlayer(make(), program({ emitters: [steady("A")] }), { name: "fx", state: "stopped" });
    player.build();
    player.step(0.5);
    expect(player.count).toBe(0);
    expect(player.state).toBe("stopped");
    player.play();
    player.step(0.5);
    expect(player.count).toBeGreaterThan(0);
    expect(player.started).toBe(true);
    player.pause();
    const t = player.time;
    player.step(0.5);
    expect(player.time).toBe(t);
    player.play();
    player.stop();
    expect(player.state).toBe("stopped");
    expect(player.count).toBeGreaterThan(0); // the particles out live on
    player.stop(true);
    expect(player.count).toBe(0);
    player.dispose();
  });

  it("holds the build while a texture loads, then builds with it; a failed texture draws the dot", async () => {
    let resolve!: (t: RawTexture) => void;
    const loading = new Promise<RawTexture>((r) => (resolve = r));
    const res = make({ texture: (path) => (path === "spark.png" ? loading : Promise.reject(new Error("missing"))) });
    const waiting = new EffectPlayer(res, program({ emitters: [steady("A", 30, { texture: "spark.png" })] }), { name: "fx" });
    expect(waiting.build()).toBe(false);
    const spark = new RawTexture(new Uint8Array(16), 2, 2, 5, scene);
    resolve(spark);
    await loading;
    expect(waiting.build()).toBe(true);
    expect((waiting.draws[0].ps as unknown as BabylonParticleSystem).particleTexture).toBe(spark);

    const failing = new EffectPlayer(res, program({ emitters: [steady("B", 30, { texture: "missing.png" })] }), { name: "fx" });
    expect(failing.build()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.build()).toBe(true);
    expect((failing.draws[0].ps as unknown as BabylonParticleSystem).particleTexture).toBe(res.dotTexture());
    expect(warnings.filter((w) => w.includes("missing.png"))).toHaveLength(1);
    waiting.dispose();
    failing.dispose();
  });

  it("draws with the texture until its material asset is there, then rebuilds with the material", () => {
    let material: StandardMaterial | null = null;
    const res = make({ material: () => material });
    const player = new EffectPlayer(res, program({ emitters: [steady("A", 30, { material: "fx.mat" })] }), { name: "fx" });
    expect(player.build()).toBe(true);
    expect(player.draws[0].kind).toBe("system"); // a Babylon particle system with the texture (the dot) and blending
    expect(player.build()).toBe(true); // nothing changed: no rebuild
    material = new StandardMaterial("fx", scene);
    player.step(0.2);
    expect(player.build()).toBe(true);
    expect(player.draws[0].kind).toBe("quads");
    expect((player.draws[0] as QuadDraw).mesh.material).toBe(material);
    expect(player.state).toBe("playing"); // the rebuild kept it playing
    player.dispose();
  });

  it("repeats a seeded effect exactly on every restart", () => {
    const fx = program({ emitters: [steady("A", 40)] });
    const positions = (p: EffectPlayer) => p.sim!.emitters[0].pool.slice(0, p.sim!.emitters[0].count).map((q) => `${q.wx.toFixed(4)},${q.wy.toFixed(4)}`);
    const player = new EffectPlayer(make(), fx, { name: "fx", seed: 7 });
    player.build();
    for (let i = 0; i < 30; i++) player.step(1 / 30);
    const first = positions(player);
    expect(first.length).toBeGreaterThan(10);
    player.restart();
    for (let i = 0; i < 30; i++) player.step(1 / 30);
    expect(positions(player)).toEqual(first);
    // Another player with the same seed matches too; another seed doesn't.
    const twin = new EffectPlayer(resources, fx, { name: "twin", seed: 7 });
    twin.build();
    for (let i = 0; i < 30; i++) twin.step(1 / 30);
    expect(positions(twin)).toEqual(first);
    const other = new EffectPlayer(resources, fx, { name: "other", seed: 8 });
    other.build();
    for (let i = 0; i < 30; i++) other.step(1 / 30);
    expect(positions(other)).not.toEqual(first);
    for (const p of [player, twin, other]) p.dispose();
  });

  it("plays a finished one-shot effect again after the gap, while looping", () => {
    const player = new EffectPlayer(make(), program({ emitters: [oneShot("A")] }), { name: "fx" });
    player.build();
    player.step(1 / 60);
    expect(player.count).toBe(5);
    let restarted = false;
    for (let i = 0; i < 120 && !restarted; i++) {
      const before = player.time;
      player.step(1 / 30);
      player.repeatWhenFinished(1 / 30, 0.5);
      restarted = player.time < before;
    }
    expect(restarted).toBe(true);
    expect(player.state).toBe("playing");
    player.step(1 / 60);
    expect(player.count).toBe(5);
    // Not looping: it stays finished.
    for (let i = 0; i < 120; i++) {
      player.step(1 / 30);
      player.repeatWhenFinished(1 / 30, 0.5, false);
    }
    expect(player.alive).toBe(false);
    player.dispose();
  });
});
