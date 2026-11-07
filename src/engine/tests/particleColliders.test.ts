// ADR 0096: `collisionColliders` on the CPU particle simulation, driven by a fake world raycast (a floor at y = 0).
import { describe, expect, it, vi } from "vitest";
import { defaultEmitter, defaultShape, type ParticleBehavior, type ParticleEmitterSettings } from "../scene/particles";
import { EffectSimulation, type ParticleRaycast, type Tint } from "../render/particles/simulation";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const WHITE: Tint = [1, 1, 1, 1];

/** A floor at world y = 0 facing up. */
const floor: ParticleRaycast = (ox, oy, oz, dx, dy, dz, max) => {
  if (oy < 0 || dy >= 0) return null;
  const t = oy / -dy;
  if (t > max) return null;
  return { point: [ox + dx * t, 0, oz + dz * t], normal: [0, 1, 0], distance: t };
};

const collide = (over: Partial<Extract<ParticleBehavior, { type: "collisionColliders" }>> = {}): ParticleBehavior => ({
  type: "collisionColliders",
  bounce: 0.5,
  friction: 0,
  kill: false,
  radius: 0,
  ...over,
});

const emitter = (behaviors: ParticleBehavior[], over: Partial<ParticleEmitterSettings> = {}): ParticleEmitterSettings => ({
  ...defaultEmitter("E"),
  startLife: 100,
  startSpeed: 0,
  startSize: 1,
  gravity: 0,
  behaviors,
  emission: { rateOverTime: 0, rateOverDistance: 0, bursts: [] },
  shape: { ...defaultShape(), type: "point" },
  ...over,
});

/** One particle at `pos` (sim space) with velocity `vel`, ready to step. */
function setup(behaviors: ParticleBehavior[], pos: number[], vel: number[], raycast: ParticleRaycast | undefined, over: Partial<ParticleEmitterSettings> = {}, matrix = IDENTITY) {
  const sim = new EffectSimulation({ emitters: [emitter(behaviors, over)] }, { random: () => 0.5, raycast });
  sim.configure(matrix, 1, WHITE);
  sim.emit(1);
  const p = sim.emitters[0].pool[0];
  p.x = pos[0];
  p.y = pos[1];
  p.z = pos[2];
  p.vx = vel[0];
  p.vy = vel[1];
  p.vz = vel[2];
  return { sim, p, step: (dt = 0.1, m = matrix) => sim.step(dt, m, 1, WHITE) };
}

describe("particle simulation: collider collision", () => {
  it("bounces: vy flips and scales by bounce, and the particle sits above the floor", () => {
    const { p, step } = setup([collide({ bounce: 0.5 })], [0, 0.1, 0], [1, -4, 0], floor);
    step();
    expect(p.vy).toBeCloseTo(2, 5);
    expect(p.vx).toBeCloseTo(1, 5);
    expect(p.y).toBeCloseTo(0.001, 5);
  });

  it("friction scales the tangential velocity", () => {
    const { p, step } = setup([collide({ bounce: 1, friction: 0.25 })], [0, 0.1, 0], [2, -4, 1], floor);
    step();
    expect(p.vx).toBeCloseTo(1.5, 5);
    expect(p.vz).toBeCloseTo(0.75, 5);
    expect(p.vy).toBeCloseTo(4, 5);
  });

  it("radius holds the particle off the surface and catches near misses", () => {
    const { p, step } = setup([collide({ radius: 0.2 })], [0, 0.45, 0], [0, -4, 0], floor);
    step(0.1); // the ray is 0.4 + 0.2 long and reaches the floor
    expect(p.y).toBeCloseTo(0.2, 5);
    expect(p.vy).toBeGreaterThan(0);
  });

  it("kill mode kills the particle", () => {
    const { sim, step } = setup([collide({ kill: true })], [0, 0.1, 0], [0, -4, 0], floor);
    expect(sim.count).toBe(1);
    step();
    expect(sim.count).toBe(0);
  });

  it("leaves particles that miss alone", () => {
    const { p, step } = setup([collide()], [0, 5, 0], [1, -1, 0], floor);
    step();
    expect(p.y).toBeCloseTo(4.9, 5);
    expect(p.vy).toBeCloseTo(-1, 5);
  });

  it("does nothing without a raycast", () => {
    const { sim, p, step } = setup([collide({ kill: true })], [0, 0.1, 0], [0, -4, 0], undefined);
    step();
    expect(sim.count).toBe(1);
    expect(p.y).toBeCloseTo(-0.3, 5);
    expect(p.vy).toBeCloseTo(-4, 5);
  });

  it("casts from the previous to the new world position", () => {
    const ray = vi.fn(floor);
    const { step } = setup([collide()], [0, 1, 0], [0, -1, 0], ray);
    step(0.1);
    expect(ray).toHaveBeenCalledTimes(1);
    const [ox, oy, oz, dx, dy, dz, max] = ray.mock.calls[0];
    expect([ox, oy, oz, dx, dy, dz]).toEqual([0, 1, 0, 0, -1, 0]);
    expect(max).toBeCloseTo(0.1, 5);
  });

  it("works in a local-space emitter under a moved node", () => {
    // The node sits 10 m up; a particle at local y = -9.9 is at world y = 0.1, moving down.
    const { p, step } = setup([collide({ bounce: 0.5 })], [0, -9.9, 0], [0, -4, 0], floor, { space: "local" }, at(3, 10, 0));
    step();
    expect(p.vy).toBeCloseTo(2, 5);
    expect(p.y).toBeCloseTo(-10 + 0.001, 5); // local y of the hit point, just above the floor
  });

  it("a turned local-space node reflects in world space", () => {
    // Rotated half a turn about X (local +Y is world -Y), node at the origin: local y = -0.1 is world y = 0.1.
    const flipped = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    const { p, step } = setup([collide({ bounce: 1 })], [0, -0.1, 0], [0, 4, 0], floor, { space: "local" }, flipped);
    step();
    expect(p.vy).toBeCloseTo(-4, 5); // world up is local down
  });
});
