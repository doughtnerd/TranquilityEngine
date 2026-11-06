// ADR 0075 stage 5: the renderer-neutral particle simulation (render/particles/simulation.ts),
// run headless with a seeded random so every run is the same.
import { describe, expect, it } from "vitest";
import { defaultEmitter, defaultShape, type ParticleBehavior, type ParticleEmitterSettings, type ParticleShape } from "../scene/particles";
import { EffectSimulation, linearRGB, trailPoint, type LiveBox, type Tint } from "../render/particles/simulation";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const WHITE: Tint = [1, 1, 1, 1];

/** A small deterministic generator (mulberry32). */
function seeded(seed = 1): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An emitter that does nothing until the test gives it something to do. */
const em = (over: Partial<ParticleEmitterSettings> = {}, name = "E"): ParticleEmitterSettings => ({
  ...defaultEmitter(name),
  startLife: 100,
  startSpeed: 0,
  startSize: 1,
  gravity: 0,
  behaviors: [],
  emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [] },
  shape: { ...defaultShape(), type: "point" },
  ...over,
});
const burst = (count: number, extra: Partial<ParticleEmitterSettings["emission"]["bursts"][number]> = {}) => ({ time: 0, count, cycles: 1, interval: 0.1, probability: 1, ...extra });
const rate = (r: number) => ({ rateOverTime: r, rateOverDistance: 0, bursts: [] });
const shape = (over: Partial<ParticleShape>): ParticleShape => ({ ...defaultShape(), ...over });

function make(emitters: ParticleEmitterSettings[], seed = 1, live?: (e: number, p: string) => LiveBox | undefined) {
  return new EffectSimulation({ emitters }, { random: seeded(seed), live });
}

function run(sim: EffectSimulation, seconds: number, opts: { dt?: number; world?: number[]; scale?: number; tint?: Tint } = {}): void {
  const dt = opts.dt ?? 1 / 60;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) sim.step(dt, opts.world ?? IDENTITY, opts.scale ?? 1, opts.tint ?? WHITE);
}

const alive = (sim: EffectSimulation, emitter = 0) => sim.emitters[emitter].pool.slice(0, sim.emitters[emitter].count);

describe("particle simulation: emission", () => {
  it("emits rateOverTime particles per second", () => {
    const sim = make([em({ emission: rate(100) })]);
    run(sim, 1);
    expect(sim.count).toBeGreaterThanOrEqual(99);
    expect(sim.count).toBeLessThanOrEqual(101);
  });

  it("scales emission by the quality and component scale", () => {
    const sim = make([em({ emission: rate(100) })]);
    run(sim, 1, { scale: 0.5 });
    expect(sim.count).toBeGreaterThanOrEqual(49);
    expect(sim.count).toBeLessThanOrEqual(51);
  });

  it("fires bursts at their time, with cycles and intervals", () => {
    const sim = make([em({ looping: false, duration: 1, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(10, { cycles: 3, interval: 0.1 })] } })]);
    run(sim, 0.05);
    expect(sim.count).toBe(10);
    run(sim, 0.1);
    expect(sim.count).toBe(20);
    run(sim, 0.4);
    expect(sim.count).toBe(30);
  });

  it("honours burst probability (0 never, 1 always)", () => {
    const never = make([em({ looping: false, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(10, { probability: 0 })] } })]);
    run(never, 1);
    expect(never.count).toBe(0);
    const always = make([em({ looping: false, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(10, { probability: 1 })] } })]);
    run(always, 1);
    expect(always.count).toBe(10);
  });

  it("repeats a burst every cycle while looping", () => {
    const sim = make([em({ duration: 1, looping: true, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(5, { time: 0.5 })] } })]);
    run(sim, 2.2);
    expect(sim.count).toBe(10);
  });

  it("finishes a one-shot effect, and keeps a looping one going", () => {
    const once = make([em({ looping: false, duration: 0.5, startLife: 0.2, emission: rate(50) })]);
    run(once, 0.3);
    expect(once.emitting).toBe(true);
    run(once, 0.4);
    expect(once.emitters[0].ended).toBe(true);
    expect(once.emitting).toBe(false);
    run(once, 0.5);
    expect(once.count).toBe(0);
    const loop = make([em({ looping: true, duration: 0.5, startLife: 0.2, emission: rate(50) })]);
    run(loop, 3);
    expect(loop.emitting).toBe(true);
    expect(loop.count).toBeGreaterThan(0);
  });

  it("waits out startDelay", () => {
    const sim = make([em({ startDelay: 0.5, emission: rate(100) })]);
    run(sim, 0.4);
    expect(sim.count).toBe(0);
    run(sim, 0.4);
    expect(sim.count).toBeGreaterThan(20);
    expect(sim.count).toBeLessThan(40);
  });

  it("prewarms a looping effect as if a whole cycle had run", () => {
    const sim = make([em({ looping: true, prewarm: true, duration: 2, emission: rate(50) })]);
    sim.step(0.001, IDENTITY, 1, WHITE);
    expect(sim.count).toBeGreaterThanOrEqual(95);
    expect(sim.count).toBeLessThanOrEqual(105);
    const cold = make([em({ looping: true, prewarm: false, duration: 2, emission: rate(50) })]);
    cold.step(0.001, IDENTITY, 1, WHITE);
    expect(cold.count).toBe(0);
  });

  it("caps live particles at maxParticles (times the scale)", () => {
    const sim = make([em({ maxParticles: 50, emission: rate(1000) })]);
    run(sim, 1);
    expect(sim.count).toBe(50);
    const scaled = make([em({ maxParticles: 50, emission: rate(1000) })]);
    run(scaled, 1, { scale: 0.5 });
    expect(scaled.count).toBe(25);
  });

  it("emits rateOverDistance by the distance the node moves", () => {
    const sim = make([em({ emission: { rateOverTime: 0, rateOverDistance: 10, bursts: [] } })]);
    sim.step(1 / 60, at(0), 1, WHITE);
    for (let i = 1; i <= 60; i++) sim.step(1 / 60, at(i / 60), 1, WHITE); // 1 metre
    expect(sim.count).toBeGreaterThanOrEqual(9);
    expect(sim.count).toBeLessThanOrEqual(11);
  });

  it("emit() adds particles at once, clear() removes them", () => {
    const sim = make([em({})]);
    sim.emit(7);
    expect(sim.count).toBe(7);
    sim.clear();
    expect(sim.count).toBe(0);
  });

  it("is the same every run with the same random", () => {
    const a = make([em({ startSpeed: { random: [1, 3] }, shape: shape({ type: "sphere" }), emission: rate(80) })], 5);
    const b = make([em({ startSpeed: { random: [1, 3] }, shape: shape({ type: "sphere" }), emission: rate(80) })], 5);
    run(a, 1);
    run(b, 1);
    expect(alive(a).map((p) => [p.wx, p.wy, p.wz])).toEqual(alive(b).map((p) => [p.wx, p.wy, p.wz]));
  });
});

describe("particle simulation: shapes", () => {
  const spawned = (s: ParticleShape, speed = 1) => {
    const sim = make([em({ looping: false, startSpeed: speed, shape: s, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(300)] } })]);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    return alive(sim);
  };
  const eps = 1e-2;

  it("point: everything starts at the origin and goes up", () => {
    for (const p of spawned(shape({ type: "point" }))) {
      expect(Math.hypot(p.wx, p.wy, p.wz)).toBeLessThan(eps);
      expect(p.wvy).toBeCloseTo(1, 5);
    }
  });

  it("sphere and hemisphere stay inside the radius, the hemisphere above the pole", () => {
    for (const p of spawned(shape({ type: "sphere", radius: 2 }))) expect(Math.hypot(p.wx, p.wy, p.wz)).toBeLessThanOrEqual(2 + eps);
    const ps = spawned(shape({ type: "hemisphere", radius: 2 }));
    for (const p of ps) {
      expect(Math.hypot(p.wx, p.wy, p.wz)).toBeLessThanOrEqual(2 + eps);
      expect(p.wy).toBeGreaterThanOrEqual(-eps);
    }
  });

  it("thickness 0 puts particles on the surface; arc limits the angle", () => {
    for (const p of spawned(shape({ type: "sphere", radius: 2, thickness: 0 }))) expect(Math.hypot(p.wx, p.wy, p.wz)).toBeGreaterThan(2 - eps);
    for (const p of spawned(shape({ type: "circle", radius: 1, arc: 90 }))) {
      expect(p.wx).toBeGreaterThanOrEqual(-eps);
      expect(p.wz).toBeGreaterThanOrEqual(-eps);
    }
  });

  it("cone: starts on the base disc and leaves within the half angle", () => {
    for (const p of spawned(shape({ type: "cone", radius: 0.5, angle: 25 }))) {
      expect(Math.hypot(p.wx, p.wz)).toBeLessThanOrEqual(0.5 + eps);
      expect(Math.abs(p.wy)).toBeLessThan(eps);
      const angle = Math.acos(p.wvy / Math.hypot(p.wvx, p.wvy, p.wvz)) / (Math.PI / 180);
      expect(angle).toBeLessThanOrEqual(25 + 0.1);
    }
  });

  it("circle: on the disc in the XZ plane, emitting outwards", () => {
    for (const p of spawned(shape({ type: "circle", radius: 1.5 }))) {
      expect(Math.hypot(p.wx, p.wz)).toBeLessThanOrEqual(1.5 + eps);
      expect(Math.abs(p.wy)).toBeLessThan(eps);
      expect(Math.abs(p.wvy)).toBeLessThan(1e-6);
    }
  });

  it("donut: within the tube around the ring", () => {
    for (const p of spawned(shape({ type: "donut", radius: 2, donutRadius: 0.3 }))) {
      expect(Math.hypot(Math.hypot(p.wx, p.wz) - 2, p.wy)).toBeLessThanOrEqual(0.3 + eps);
    }
  });

  it("rectangle: inside the width and height, flat", () => {
    for (const p of spawned(shape({ type: "rectangle", width: 4, height: 2 }))) {
      expect(Math.abs(p.wx)).toBeLessThanOrEqual(2 + eps);
      expect(Math.abs(p.wz)).toBeLessThanOrEqual(1 + eps);
      expect(Math.abs(p.wy)).toBeLessThan(eps);
    }
  });

  it("grid: on the cell centres", () => {
    const xs = new Set<number>();
    for (const p of spawned(shape({ type: "grid", width: 4, height: 4, columns: 4, rows: 4 }))) {
      xs.add(Math.round(p.wx * 100) / 100);
      expect(Math.abs(p.wx)).toBeLessThanOrEqual(2);
    }
    expect([...xs].sort((a, b) => a - b)).toEqual([-1.5, -0.5, 0.5, 1.5]);
  });

  it("the shape's offset and rotation move and turn it", () => {
    const rotated = spawned(shape({ type: "point", position: [0, 3, 0], rotation: [0, 0, -90] }));
    for (const p of rotated) {
      expect(p.wy).toBeCloseTo(3, 1);
      expect(p.wvx).toBeGreaterThan(0.99); // +Y turned a quarter turn clockwise about Z points along +X
    }
  });

  it("loop mode with a spread walks round the arc in order", () => {
    const sim = make([em({ looping: true, shape: shape({ type: "circle", radius: 1, mode: "loop", spread: 0.25, thickness: 0 }), emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(4)] } })]);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    const angles = alive(sim).map((p) => Math.round((Math.atan2(p.wz, p.wx) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 2)) % 4);
    expect(new Set(angles).size).toBe(4);
  });
});

describe("particle simulation: motion and behaviours", () => {
  it("gravity pulls down (world -Y x 9.81 x gravity)", () => {
    const sim = make([em({ gravity: 1 })]);
    sim.emit(1);
    run(sim, 1);
    const p = alive(sim)[0];
    expect(p.wvy).toBeCloseTo(-9.81, 1);
    expect(p.wy).toBeCloseTo(-4.9, 0);
    const half = make([em({ gravity: 0.5 })]);
    half.emit(1);
    run(half, 1);
    expect(alive(half)[0].wvy).toBeCloseTo(-4.905, 1);
  });

  it("forceOverLife integrates acceleration", () => {
    const sim = make([em({ behaviors: [{ type: "forceOverLife", x: 0, y: 2, z: 0 }] })]);
    sim.emit(1);
    run(sim, 1);
    expect(alive(sim)[0].wvy).toBeCloseTo(2, 1);
  });

  it("size over life follows its curve", () => {
    const sim = make([em({ startLife: 1, startSize: 2, behaviors: [{ type: "sizeOverLife", size: { curve: [[0, 1], [1, 0]] } }] })]);
    sim.emit(1);
    run(sim, 0.5);
    expect(alive(sim)[0].size).toBeCloseTo(1, 1);
  });

  it("colour over life follows its gradient, in linear light", () => {
    const sim = make([
      em({
        startLife: 1,
        startColor: "#808080",
        behaviors: [{ type: "colorOverLife", color: { gradient: { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 0]] } } }],
      }),
    ]);
    sim.emit(1);
    run(sim, 0.5);
    const p = alive(sim)[0];
    const [lin] = linearRGB(128 / 255, 128 / 255, 128 / 255);
    expect(p.r).toBeCloseTo(lin, 3);
    expect(p.a).toBeCloseTo(0.5, 1);
  });

  it("random and randomCurves start values stay in their ranges", () => {
    const sim = make([
      em({
        startSize: { randomCurves: [[[0, 1], [1, 1]], [[0, 3], [1, 3]]] },
        startLife: { random: [5, 6] },
        emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(100)] },
      }),
    ]);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    for (const p of alive(sim)) {
      expect(p.size).toBeGreaterThanOrEqual(1);
      expect(p.size).toBeLessThanOrEqual(3);
      expect(p.life).toBeGreaterThanOrEqual(5);
      expect(p.life).toBeLessThanOrEqual(6);
    }
  });

  it("speedOverLife scales the motion", () => {
    const fast = make([em({ startSpeed: 10, startLife: 2 })]);
    const slow = make([em({ startSpeed: 10, startLife: 2, behaviors: [{ type: "speedOverLife", speed: 0.5 }] })]);
    for (const s of [fast, slow]) {
      s.emit(1);
      run(s, 1);
    }
    expect(alive(fast)[0].wy).toBeCloseTo(10, 0);
    expect(alive(slow)[0].wy).toBeCloseTo(5, 0);
  });

  it("limitSpeed caps the speed", () => {
    const sim = make([em({ startSpeed: 10, behaviors: [{ type: "limitSpeed", speed: 2, dampen: 1 }] })]);
    sim.emit(1);
    run(sim, 0.5);
    expect(Math.hypot(alive(sim)[0].wvx, alive(sim)[0].wvy, alive(sim)[0].wvz)).toBeCloseTo(2, 1);
  });

  it("colorBySpeed and sizeBySpeed read the speed", () => {
    const behaviors: ParticleBehavior[] = [
      { type: "sizeBySpeed", size: { curve: [[0, 1], [1, 3]] }, min: 0, max: 10 },
      { type: "colorBySpeed", color: { gradient: { colors: [[0, "#000000"], [1, "#ffffff"]], alphas: [[0, 1], [1, 1]] } }, min: 0, max: 10 },
    ];
    const sim = make([em({ startSpeed: 10, behaviors })]);
    sim.emit(1);
    run(sim, 0.1);
    const p = alive(sim)[0];
    expect(p.size).toBeCloseTo(3, 1);
    expect(p.r).toBeGreaterThan(0.95);
    const still = make([em({ startSpeed: 0, behaviors })]);
    still.emit(1);
    run(still, 0.1);
    expect(alive(still)[0].size).toBeCloseTo(1, 2);
    expect(alive(still)[0].r).toBeLessThan(0.01);
  });

  it("collision bounces off the plane, or kills", () => {
    const base = { gravity: 1, shape: shape({ type: "point", position: [0, 1, 0] }) };
    const bounce = make([em({ ...base, behaviors: [{ type: "collision", height: 0, bounce: 0.5, kill: false }] })]);
    bounce.emit(1);
    let up = false;
    let min = Infinity;
    for (let i = 0; i < 180; i++) {
      bounce.step(1 / 60, IDENTITY, 1, WHITE);
      const p = alive(bounce)[0];
      min = Math.min(min, p.wy);
      if (p.wvy > 0) up = true;
    }
    expect(min).toBeGreaterThanOrEqual(-1e-6);
    expect(up).toBe(true);
    const kill = make([em({ ...base, behaviors: [{ type: "collision", height: 0, bounce: 0.5, kill: true }] })]);
    kill.emit(1);
    run(kill, 1);
    expect(kill.count).toBe(0);
  });

  it("orbit turns particles around the axis, noise moves them, gravityPoint pulls", () => {
    const orbit = make([em({ startSpeed: 0, shape: shape({ type: "point", position: [1, 0, 0] }), behaviors: [{ type: "orbit", speed: 90, axis: [0, 1, 0] }] })]);
    orbit.emit(1);
    run(orbit, 1);
    const p = alive(orbit)[0];
    expect(Math.hypot(p.wx, p.wz)).toBeCloseTo(1, 2);
    expect(Math.abs(p.wx)).toBeLessThan(0.05); // a quarter turn
    const pulled = make([em({ startSpeed: 0, shape: shape({ type: "point", position: [4, 0, 0] }), behaviors: [{ type: "gravityPoint", center: [0, 0, 0], strength: 4 }] })]);
    pulled.emit(1);
    run(pulled, 1);
    expect(alive(pulled)[0].wx).toBeLessThan(4);
    const noisy = make([em({ startSpeed: 0, behaviors: [{ type: "noise", frequency: 2, power: 1, positionAmount: 1, rotationAmount: 1 }] })]);
    noisy.emit(1);
    run(noisy, 1);
    expect(Math.hypot(alive(noisy)[0].wx, alive(noisy)[0].wy, alive(noisy)[0].wz)).toBeGreaterThan(0);
    const turb = make([em({ startSpeed: 0, behaviors: [{ type: "turbulence", scale: [1, 1, 1], octaves: 2, velocity: [5, 5, 5], timeScale: [1, 1, 1] }] })]);
    turb.emit(1);
    run(turb, 1);
    expect(Math.hypot(alive(turb)[0].wvx, alive(turb)[0].wvy, alive(turb)[0].wvz)).toBeGreaterThan(0);
  });

  it("flipbook: the start tile, and frame over life", () => {
    const renderer = { ...defaultEmitter().renderer, tiles: [2, 2] as [number, number], startTile: 3 };
    const sim = make([em({ renderer })]);
    sim.emit(1);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    expect(alive(sim)[0].tile).toBe(3);
    const anim = make([em({ startLife: 1, renderer: { ...renderer, startTile: 0 }, behaviors: [{ type: "frameOverLife", frame: { curve: [[0, 0], [1, 3]] } }] })]);
    anim.emit(1);
    run(anim, 0.5);
    expect(alive(anim)[0].tile).toBe(1);
  });

  it("stretched particles get a length from speed and size", () => {
    const renderer = { ...defaultEmitter().renderer, mode: "stretched" as const, speedScale: 0.5, lengthScale: 2 };
    const sim = make([em({ startSpeed: 4, startSize: 1, renderer })]);
    sim.emit(1);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    expect(alive(sim)[0].length).toBeCloseTo(1 * 2 + 4 * 0.5, 3);
  });

  it("trails keep a history of up to trailLength points", () => {
    const renderer = { ...defaultEmitter().renderer, mode: "trail" as const, trailLength: 5 };
    const sim = make([em({ startSpeed: 1, renderer })]);
    sim.emit(1);
    run(sim, 0.5);
    const p = alive(sim)[0];
    expect(p.trailCount).toBe(5);
    const head = { x: 0, y: 0, z: 0 };
    trailPoint(p, 0, head);
    expect(head.y).toBeCloseTo(p.wy, 4);
    const tail = { x: 0, y: 0, z: 0 };
    trailPoint(p, 4, tail);
    expect(tail.y).toBeLessThan(head.y);
  });
});

describe("particle simulation: sub-emitters", () => {
  const child = em({ looping: false, duration: 1, startLife: 5, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(5)] } }, "Child");

  it("a death trigger spawns in the child where the parent died; the child doesn't emit alone", () => {
    const parent = em({ looping: false, duration: 1, startLife: 0.5, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(1)] }, subEmitters: [{ emitter: "Child", trigger: "death", probability: 1, inheritVelocity: false }] }, "Parent");
    const sim = make([parent, { ...child, emission: { rateOverTime: 50, rateOverDistance: 0, bursts: [burst(5)] } }]);
    run(sim, 0.4);
    expect(sim.emitters[1].count).toBe(0);
    run(sim, 0.4);
    expect(sim.emitters[0].count).toBe(0);
    expect(sim.emitters[1].count).toBeGreaterThanOrEqual(5);
  });

  it("a birth trigger spawns at once; probability 0 never does; inheritVelocity carries the parent's velocity", () => {
    const parent = (probability: number, inheritVelocity = false) =>
      em({ looping: false, startSpeed: 3, startLife: 5, emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [burst(1)] }, subEmitters: [{ emitter: "Child", trigger: "birth", probability, inheritVelocity }] }, "Parent");
    const sim = make([parent(1, true), child]);
    run(sim, 0.1);
    expect(sim.emitters[1].count).toBe(5);
    expect(alive(sim, 1)[0].wvy).toBeGreaterThan(2.9);
    const none = make([parent(0), child]);
    run(none, 0.1);
    expect(none.emitters[1].count).toBe(0);
  });
});

describe("particle simulation: spaces, tint and live values", () => {
  it("world space keeps particles where they were born; local space carries them with the node", () => {
    for (const [space, expected] of [["world", 0], ["local", 5]] as const) {
      const sim = make([em({ space })]);
      sim.emit(1);
      sim.step(1e-3, IDENTITY, 1, WHITE);
      sim.step(1e-3, at(5), 1, WHITE);
      expect(alive(sim)[0].wx).toBeCloseTo(expected, 2);
    }
  });

  it("local-space gravity still pulls world down when the node is turned", () => {
    // Rotated half a turn about X: local +Y is world -Y.
    const flipped = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    const sim = make([em({ space: "local", gravity: 1 })]);
    sim.configure(flipped, 1, WHITE);
    sim.emit(1);
    run(sim, 0.5, { world: flipped });
    expect(alive(sim)[0].wvy).toBeCloseTo(-9.81 * 0.5, 1);
  });

  it("the tint multiplies start colours", () => {
    const sim = make([em({ startColor: "#ffffffff" })]);
    sim.configure(IDENTITY, 1, [0.5, 0.25, 1, 0.5]);
    sim.emit(1);
    sim.step(1e-4, IDENTITY, 1, [0.5, 0.25, 1, 0.5]);
    const p = alive(sim)[0];
    expect([p.r, p.g, p.b, p.a]).toEqual([0.5, 0.25, 1, 0.5].map((v) => expect.closeTo(v, 5)));
  });

  it("live boxes change values as they are read", () => {
    const box: LiveBox = { value: 0.3 };
    const rateBox: LiveBox = { value: 0 };
    const sim = make([em({ emission: rate(0) })], 1, (_e, path) => (path === "startSize" ? box : path === "emission.rateOverTime" ? rateBox : undefined));
    sim.emit(1);
    box.value = 0.9;
    sim.emit(1);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    expect(alive(sim).map((p) => Math.round(p.size * 10) / 10)).toEqual([0.3, 0.9]);
    run(sim, 1);
    expect(sim.count).toBe(2);
    rateBox.value = 60;
    run(sim, 1);
    expect(sim.count).toBeGreaterThan(55);
  });

  it("a live colour box replaces the start colour", () => {
    const box: LiveBox = { value: [0.2, 0.4, 0.6, 0.8] };
    const sim = make([em({})], 1, (_e, path) => (path === "startColor" ? box : undefined));
    sim.emit(1);
    sim.step(1e-4, IDENTITY, 1, WHITE);
    expect(alive(sim)[0].g).toBeCloseTo(0.4, 5);
  });

  it("restart clears and starts over; endEmit stops emission but lets particles live", () => {
    const sim = make([em({ emission: rate(100), startLife: 0.3 })]);
    run(sim, 0.5);
    sim.endEmit();
    run(sim, 0.05);
    const n = sim.count;
    expect(n).toBeGreaterThan(0);
    expect(sim.emitting).toBe(false);
    run(sim, 0.5);
    expect(sim.count).toBe(0);
    sim.restart();
    expect(sim.count).toBe(0);
    run(sim, 0.2);
    expect(sim.count).toBeGreaterThan(10);
  });
});
