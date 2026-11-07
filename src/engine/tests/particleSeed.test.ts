// ParticleSystem.seed (ADR 0057): the seeded generator, and simulations driven by it.
import { describe, expect, it } from "vitest";
import { randomForSeed, seededRandom } from "../render/particles/random";
import { EffectSimulation } from "../render/particles/simulation";
import { defaultEmitter, defaultShape } from "../scene/particles";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Step an effect of randomly shot particles for a second; return every live particle's position. */
function play(random: () => number): string[] {
  const emitter = {
    ...defaultEmitter("E"),
    startLife: 5,
    startSpeed: 3,
    shape: { ...defaultShape(), type: "sphere" as const, radius: 1 },
    emission: { rateOverTime: 60, rateOverDistance: 0, bursts: [] },
  };
  const sim = new EffectSimulation({ emitters: [emitter] }, { random });
  for (let i = 0; i < 60; i++) sim.step(1 / 60, IDENTITY, 1, [1, 1, 1, 1]);
  const e = sim.emitters[0];
  return e.pool.slice(0, e.count).map((p) => [p.wx, p.wy, p.wz].map((v) => v.toFixed(6)).join(","));
}

describe("seeded particle random", () => {
  it("repeats for the same seed and differs for another", () => {
    expect(seededRandom(7)()).toBe(seededRandom(7)());
    expect(seededRandom(7)()).not.toBe(seededRandom(8)());
    const a = play(seededRandom(7));
    expect(a.length).toBeGreaterThan(10);
    expect(play(seededRandom(7))).toEqual(a);
    expect(play(seededRandom(8))).not.toEqual(a);
  });

  it("randomForSeed: 0 is Math.random, anything else is seeded", () => {
    expect(randomForSeed(0)).toBe(Math.random);
    expect(randomForSeed(3)()).toBe(seededRandom(3)());
    expect(play(randomForSeed(0))).not.toEqual(play(randomForSeed(0)));
  });
});
