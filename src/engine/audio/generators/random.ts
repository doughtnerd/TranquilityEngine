/**
 * The generators' seeded random source (ADR 0360 §7): mulberry32, the same generator the playlist runtime's World uses,
 * so the blip randomiser gives the same parameters for the same seed on every machine.
 *
 * Pure; no plugin, no DOM.
 */

/** A draw in [0, 1). */
export type Draw = () => number;

/** The largest seed (seeds are u32, as the GEN record carries them). */
export const MAX_SEED = 0xffffffff;

/** mulberry32: uniform draws in [0, 1), the same sequence for the same u32 seed. */
export function mulberry32(seed: number): Draw {
  let a = Math.trunc(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A u32 seed from a draw. */
export const seedFrom = (draw: Draw): number => Math.floor(draw() * 4294967296) >>> 0;
