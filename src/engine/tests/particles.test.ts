import { Color, MeshBasicMaterial, Matrix4, Scene } from "three";
import { describe, expect, it } from "vitest";
import { Color as EngineColor } from "../core/math";
import { ParticleRenderer, type ParticleHost } from "../render/particles/ParticleRenderer";
import { buildEffect, curveGen, linearColor, numberGen, PlaneCollision } from "../render/particles/quarksEffect";
import {
  defaultEmitter,
  defaultParticleEffect,
  evalCurve,
  evalGradient,
  formatParticleEffect,
  parseParticleEffect,
  particleEffectJSON,
  subEmitterNames,
  type ParticleEffect,
} from "../scene/particles";
import type { ParticleCommand, ParticleSystem } from "../render/components";

describe("particle effect format (ADR 0057)", () => {
  it("round-trips the default effect", () => {
    const effect = defaultParticleEffect();
    const { effect: back, problems } = parseParticleEffect(JSON.parse(formatParticleEffect(effect)));
    expect(problems).toEqual([]);
    expect(back).toEqual(effect);
  });

  it("fills missing fields with defaults and reports bad values without failing", () => {
    const { effect, problems } = parseParticleEffect({
      format: "myco.particles@1",
      emitters: [{ name: "A", duration: "long", startSize: { curve: [[1, 2], [0, 1]] }, shape: { type: "blob" }, behaviors: [{ type: "wobble" }, { type: "sizeOverLife", size: 3 }], renderer: { tiles: [0, 2] } }],
    });
    const e = effect.emitters[0];
    expect(e.duration).toBe(defaultEmitter().duration);
    expect(e.startSize).toEqual({ curve: [[0, 1], [1, 2]] }); // keys sorted by t
    expect(e.shape.type).toBe("cone");
    expect(e.behaviors).toEqual([{ type: "sizeOverLife", size: 3 }]);
    expect(e.renderer.tiles).toEqual([1, 1]);
    expect(problems.join("\n")).toMatch(/duration/);
    expect(problems.join("\n")).toMatch(/wobble/);
    expect(problems.join("\n")).toMatch(/blob|type/);
    expect(problems.join("\n")).toMatch(/tiles/);
  });

  it("rejects other formats and non-objects", () => {
    expect(() => parseParticleEffect({ format: "myco.material@1" })).toThrow(/format/);
    expect(() => parseParticleEffect(3)).toThrow();
  });

  it("warns about sub-emitters that name no emitter, and lists the ones that do", () => {
    const { effect, problems } = parseParticleEffect({ emitters: [{ name: "Rocket", subEmitters: [{ emitter: "Burst" }, { emitter: "Nope" }] }, { name: "Burst" }] });
    expect(problems.some((p) => p.includes("Nope"))).toBe(true);
    expect([...subEmitterNames(effect)].sort()).toEqual(["Burst", "Nope"]);
  });

  it("evaluates curves and gradients", () => {
    expect(evalCurve([[0, 0], [1, 10]], 0.25)).toBeCloseTo(2.5);
    expect(evalCurve([[0.5, 4]], 0)).toBe(4);
    expect(evalCurve([[0, 1], [0.5, 3]], 0.9)).toBe(3);
    const [r, , b, a] = evalGradient({ colors: [[0, "#ff0000"], [1, "#0000ff"]], alphas: [[0, 1], [1, 0]] }, 0.5);
    expect(r).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.5);
    expect(a).toBeCloseTo(0.5);
  });

  it("writes the format tag and keeps editor-only data", () => {
    const json = particleEffectJSON({ emitters: [], editor: { layout: 1 } });
    expect(json).toEqual({ format: "myco.particles@1", emitters: [], editor: { layout: 1 } });
  });
});

describe("translation to three.quarks", () => {
  const ctx = (scale = 1) => ({ material: () => new MeshBasicMaterial(), geometry: () => null, scale: { value: scale }, tint: { value: [1, 1, 1, 1] as [number, number, number, number] } });

  it("turns curves into piecewise Béziers that pass through the keys", () => {
    const c = curveGen([[0.2, 1], [0.6, 5]]);
    expect(c.genValue([], 0)).toBeCloseTo(1); // flat before the first key
    expect(c.genValue([], 0.4)).toBeCloseTo(3);
    expect(c.genValue([], 1)).toBeCloseTo(5); // flat after the last
    expect(numberGen(90, Math.PI / 180).genValue([], 0)).toBeCloseTo(Math.PI / 2);
    const rc = numberGen({ randomCurves: [[[0, 0]], [[0, 10]]] });
    const v = rc.genValue([], 0.5);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(10);
  });

  it("converts sRGB hex colours to linear", () => {
    const c = linearColor("#80808080");
    expect(c.x).toBeCloseTo(new Color().setStyle("#808080").r, 3); // three's linear conversion
    expect(c.w).toBeCloseTo(128 / 255);
  });

  it("builds one system per enabled emitter, and links sub-emitters", () => {
    const effect: ParticleEffect = {
      emitters: [
        { ...defaultEmitter("Rocket"), subEmitters: [{ emitter: "Burst", trigger: "death", probability: 1, inheritVelocity: false }] },
        defaultEmitter("Burst"),
        { ...defaultEmitter("Off"), enabled: false },
      ],
    };
    const built = buildEffect(effect, ctx())!;
    expect(built.map((b) => b.name)).toEqual(["Rocket", "Burst"]);
    expect(built[1].subEmitter).toBe(true);
    expect(built[1].system.onlyUsedByOther).toBe(true);
    expect(built[0].system.behaviors.some((b) => b.type === "EmitSubParticleSystem")).toBe(true);
  });

  it("waits while a material is loading, without building the emitters that are ready", () => {
    expect(buildEffect(defaultParticleEffect(), { ...ctx(), material: () => null })).toBeNull();
    let asked = 0;
    const two: ParticleEffect = { emitters: [defaultEmitter("A"), { ...defaultEmitter("B"), renderer: { ...defaultEmitter().renderer, texture: "slow.png" } }] };
    const material = new MeshBasicMaterial();
    expect(buildEffect(two, { ...ctx(), material: (r) => (asked++, r.texture ? null : material) })).toBeNull();
    expect(asked).toBe(2); // checked both before building either
  });

  it("bounces particles off the collision plane, or kills them there", () => {
    const p = { position: { y: -0.5 }, velocity: { y: -2 }, age: 0, life: 3 };
    new PlaneCollision(0, 0.5, false).update(p as never);
    expect(p.position.y).toBe(0);
    expect(p.velocity.y).toBe(1);
    const q = { position: { y: -0.5 }, velocity: { y: -2 }, age: 0, life: 3 };
    new PlaneCollision(0, 0.5, true).update(q as never);
    expect(q.age).toBe(3);
  });
});

/** A stand-in ParticleSystem component: the fields and state the renderer reads and writes. */
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

function makeRenderer(editor = false, selected = true) {
  const scene = new Scene();
  const material = new MeshBasicMaterial(); // the backend caches materials; a new one each call would rebuild every frame
  const host: ParticleHost = { scene, editor, material: () => material, geometry: () => null, worldMatrix: (_c, out) => out.copy(new Matrix4()), selected: () => selected };
  return { scene, renderer: new ParticleRenderer(host) };
}

const steady = (rate: number, max = 1000): ParticleEffect => ({
  emitters: [{ ...defaultEmitter("E"), startLife: 10, emission: { rateOverTime: rate, rateOverDistance: 0, bursts: [] }, maxParticles: max }],
});

describe("ParticleRenderer", () => {
  it("emits at the effect's rate on the World's time, and caps at max particles", () => {
    const { renderer } = makeRenderer();
    const c = fakeSystem(steady(100, 50));
    for (let i = 0; i < 60; i++) renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.count).toBeGreaterThanOrEqual(50);
    expect(c._state.count).toBeLessThanOrEqual(52);
    expect(c._state.playing).toBe(true);
    expect(c._state.time).toBeCloseTo(1, 1);
  });

  it("clamps bursts to the particle limit", () => {
    const { renderer } = makeRenderer();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), startLife: 10, maxParticles: 10, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [{ time: 0, count: 200, cycles: 1, interval: 0.1, probability: 1 }] } }] };
    const c = fakeSystem(effect);
    for (let i = 0; i < 10; i++) renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.count).toBe(10);
  });

  it("applies a changed tint to new particles without rebuilding the effect", () => {
    const { renderer } = makeRenderer();
    const c = fakeSystem(steady(60));
    for (let i = 0; i < 30; i++) renderer.sync([c], 1 / 60, 1 / 60);
    const before = c._state.count;
    (c as { tint: EngineColor }).tint = new EngineColor(1, 0, 0, 1);
    for (let i = 0; i < 30; i++) renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.count).toBeGreaterThan(before); // kept going: not restarted
    const inst = (renderer as unknown as { instances: Map<unknown, { emitters: { system: { particles: { color: { y: number } }[]; particleNum: number } }[] }> }).instances.get(c)!;
    const s = inst.emitters[0].system;
    expect(s.particles[s.particleNum - 1].color.y).toBe(0); // the newest particle is red
  });

  it("scales emission with emissionScale and pauses with the World's time", () => {
    const { renderer } = makeRenderer();
    const c = fakeSystem(steady(100), { emissionScale: 0.5 } as Partial<ParticleSystem>);
    for (let i = 0; i < 60; i++) renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.count).toBeGreaterThan(40);
    expect(c._state.count).toBeLessThan(60);
    const before = c._state.count;
    for (let i = 0; i < 30; i++) renderer.sync([c], 0, 1 / 60); // timeScale 0
    expect(c._state.count).toBe(before);
  });

  it("runs script commands: stop, play, emit and clear", () => {
    const { renderer } = makeRenderer();
    const c = fakeSystem(steady(0), { playOnAwake: false } as Partial<ParticleSystem>);
    renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.playing).toBe(false);
    c._commands.push({ op: "play" }, { op: "emit", count: 25 });
    renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.playing).toBe(true);
    expect(c._state.count).toBe(25);
    c._commands.push({ op: "stop", clear: false });
    renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.playing).toBe(false);
    expect(c._state.alive).toBe(true); // particles live out their lives
    c._commands.push({ op: "clear" });
    renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.count).toBe(0);
  });

  it("finishes a one-shot effect", () => {
    const { renderer } = makeRenderer();
    const effect: ParticleEffect = { emitters: [{ ...defaultEmitter("E"), looping: false, duration: 0.5, startLife: 0.2, emission: { rateOverTime: 50, rateOverDistance: 0, bursts: [] } }] };
    const c = fakeSystem(effect);
    for (let i = 0; i < 90; i++) renderer.sync([c], 1 / 60, 1 / 60);
    expect(c._state.playing).toBe(false);
    expect(c._state.alive).toBe(false);
  });

  it("rebuilds when the effect changes and releases systems that are gone", () => {
    const { renderer, scene } = makeRenderer();
    const c = fakeSystem(steady(10));
    renderer.sync([c], 1 / 60, 1 / 60);
    const emitters = scene.children.length;
    (c as { embeddedEffect: unknown }).embeddedEffect = particleEffectJSON({ emitters: [defaultEmitter("A"), defaultEmitter("B")] });
    renderer.sync([c], 1 / 60, 1 / 60);
    expect(renderer.state().emitters).toBe(2);
    expect(scene.children.length).toBe(emitters + 1);
    renderer.sync([], 1 / 60, 1 / 60);
    expect(renderer.state()).toMatchObject({ systems: 0, emitters: 0 });
  });

  it("editor: plays only selected systems, at the preview speed", () => {
    const shown = makeRenderer(true, true);
    const a = fakeSystem(steady(60));
    for (let i = 0; i < 30; i++) shown.renderer.sync([a], 0, 1 / 60);
    expect(a._state.count).toBeGreaterThan(20);
    const hidden = makeRenderer(true, false);
    const b = fakeSystem(steady(60));
    for (let i = 0; i < 30; i++) hidden.renderer.sync([b], 0, 1 / 60);
    expect(b._state.count).toBe(0);
    hidden.renderer.preview.simulateAll = true;
    for (let i = 0; i < 30; i++) hidden.renderer.sync([b], 0, 1 / 60);
    expect(b._state.count).toBeGreaterThan(20);
  });
});
