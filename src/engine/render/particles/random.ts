// Internal (ADR 0057): the seeded random generator behind `ParticleSystem.seed`, so a seeded effect
// plays the same particles every time (replays, tests, lockstep).

/** A small, fast seeded random (mulberry32): uniform in [0, 1), the same sequence for the same integer seed. */
export function seededRandom(seed: number): () => number {
  let a = Math.trunc(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator for a component's `seed`: seeded when it is not 0, else `Math.random`. */
export function randomForSeed(seed: number): () => number {
  return Number.isFinite(seed) && Math.trunc(seed) !== 0 ? seededRandom(seed) : Math.random;
}
