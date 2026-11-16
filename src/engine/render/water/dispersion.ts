/**
 * How fast a water wave travels for its length (ADR 0072): the deep-water dispersion relation, the
 * speed `packWaves` gives a wave whose own speed is 0. Pure.
 */

/** Gravity for the deep-water speed, m/s². */
export const WATER_GRAVITY = 9.81;

/** The deep-water speed of a wave of `wavelength`: √(g·L/2π). */
export function deepWaterSpeed(wavelength: number): number {
  return Math.sqrt((WATER_GRAVITY * Math.max(wavelength, 1e-4)) / (Math.PI * 2));
}
