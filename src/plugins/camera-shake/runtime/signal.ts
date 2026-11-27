/**
 * Camera shake's signal model (ADR 0435): how strong an impulse is at a distance, what an impulse shape and a noise
 * profile give at a moment, as six channels (position x, y, z in world units; rotation x, y, z in degrees). Pure
 * functions over the preset tables; the systems (`systems.ts`) decide when and where to sample them.
 */
import { evalCurve } from "../../../engine/core/curve";
import { noise1 } from "./noise";
import { IMPULSE_POSITION, IMPULSE_ROTATION, type ImpulseShape, type NoiseOctave } from "./presets";

/** Six channels: position x, y, z, then rotation x, y, z. */
export type Shake6 = [number, number, number, number, number, number];

export const zero6 = (): Shake6 => [0, 0, 0, 0, 0, 0];

/**
 * An impulse's strength at `distance` from where it started: 1 within `radius`, falling to 0 over
 * `dissipationDistance` beyond it (smoothstep), 0 further away.
 */
export function strengthAt(distance: number, radius: number, dissipationDistance: number): number {
  const r = Math.max(0, radius);
  if (distance <= r) return 1;
  const d = Math.max(0, dissipationDistance);
  if (d === 0) return 0;
  const u = Math.min(1, (distance - r) / d);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Add impulse shape `shape` to `out`, `t` seconds into an impulse lasting `duration`, with `velocity` (direction ×
 * force, in the space the caller wants the result in) scaled by `gain`. Noise channels use `seed`. Nothing outside
 * 0..duration.
 */
export function addImpulse(out: Shake6, shape: ImpulseShape, t: number, duration: number, vx: number, vy: number, vz: number, gain: number, seed: number): void {
  if (!(duration > 0) || t < 0 || t > duration) return;
  const env = evalCurve(shape.envelope, t / duration) * gain;
  if (env === 0) return;
  const force = Math.hypot(vx, vy, vz);
  if (force === 0) return;
  const mix = Math.min(1, Math.max(0, shape.noise));
  const along = (1 - mix) * env * IMPULSE_POSITION;
  // Directional part: moved along the velocity, turned toward it (pitch with up/down, yaw and a little roll with sideways).
  const nx = vx / force, ny = vy / force;
  out[0] += vx * along;
  out[1] += vy * along;
  out[2] += vz * along;
  const turn = (1 - mix) * env * force * IMPULSE_ROTATION;
  out[3] += -ny * turn;
  out[4] += nx * turn;
  out[5] += -nx * turn * 0.5;
  if (mix === 0) return;
  const amp = mix * env * force;
  const ft = t * shape.frequency;
  for (let c = 0; c < 6; c++) {
    const n = noise1(seed + c * 7919, ft + c * 0.37);
    out[c]! += n * amp * (c < 3 ? IMPULSE_POSITION : IMPULSE_ROTATION);
  }
}

/** Add noise profile `octaves` at time `t` (seconds) to `out`, amplitudes × `amplitudeGain`, frequencies × `frequencyGain`. */
export function addNoise(out: Shake6, octaves: readonly NoiseOctave[], t: number, amplitudeGain: number, frequencyGain: number, seed: number): void {
  if (amplitudeGain === 0) return;
  for (let o = 0; o < octaves.length; o++) {
    const oct = octaves[o]!;
    const ft = t * oct.frequency * frequencyGain;
    for (let c = 0; c < 6; c++) {
      const a = c < 3 ? oct.position[c]! : oct.rotation[c - 3]!;
      if (a === 0) continue;
      out[c]! += noise1(seed + o * 104729 + c * 7919, ft + c * 0.61) * a * amplitudeGain;
    }
  }
}
