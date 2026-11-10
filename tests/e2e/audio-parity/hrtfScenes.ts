// The HRTF parity scenes (H4; ADR 0157, api-and-models §8 "Web Audio parity"): one voice, white noise, panned by the
// core's HRTF panner and by a `PannerNode` with `panningModel: "HRTF"`, at fixed directions. The data only: the
// comparison is `hrtfAnalysis.ts`'s, the specs are `audio-parity-hrtf.spec.ts` and `hrtfParity.test.ts`.
//
// Conventions (beyond `scenes.ts`'s):
// - The source is the same 0.6 s of white noise at -12 dBFS RMS for every direction: broadband, so every frequency of
//   the HRIR shows, and its cross-correlation between the ears has a sharp peak for the ITD.
// - The core's voice starts equal-power and crossfades into HRTF over 45 ms (H3), so the comparison skips the first
//   `analyzeFrom` = 0.1 s.
// - Chromium's HRTF panner delays its output by 256 frames (the convolver's fft/2 latency; the core's panner has none), so a
//   scene has `referenceLatency: 256`: the reference renders 256 extra frames and drops the first 256.
import type { ParityRate, Scene } from "./scenes";

/** Frames Chromium's HRTF panner lags the core by (issue #90; `hrtfAnalysis.ts` re-checks it per scene). */
export const HRTF_LATENCY_FRAMES = 256;

/** A direction as azimuth and elevation in degrees: azimuth 0 ahead (-Z), +90 right (+X); elevation +90 straight up. */
export type Direction = readonly [azimuth: number, elevation: number];

/** The listener-space unit vector of a direction (Web Audio's default listener). */
export function directionVector([azimuth, elevation]: Direction): [number, number, number] {
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/**
 * Directions on the IRCAM Composite set's measured grid (azimuth multiples of 15 degrees, elevations -45..90 in steps
 * of 15), each 0.3 degrees inside its cell where the angle is not 0, +-90 or 180. The panner picks a kernel by
 * truncating `azimuth / 1.875` and `(elevation + 45) / 15`, so a source exactly on a grid line sits on the edge of two
 * kernels, and which one it gets depends on the last bit of the angle (Chromium computes it in f32, the core in f64):
 * the two can pick different kernels (a step of 1.875 degrees in azimuth, 15 in elevation) and then differ by several dB.
 * 0.3 degrees in, the choice is the same, and the kernel is still the measured one (see `HRTF_EDGE_DIRECTIONS`).
 */
export const MEASURED_DIRECTIONS: readonly Direction[] = [
  [0, 0], [30.3, 0], [-29.7, 0], [60.3, 0], [90, 0], [-90, 0], [135.3, 0], [180, 0],
  [0, 30.3], [45.3, 30.3], [-89.7, 30.3], [0, -29.7], [90, -29.7], [-44.7, -44.7], [30.3, 60.3],
];

/** The same grid points exactly on the lines: reported by the spec, not asserted (see `MEASURED_DIRECTIONS`). */
export const HRTF_EDGE_DIRECTIONS: readonly Direction[] = [[30, 0], [45, 30], [0, -30], [90, -30], [30, 60], [0, 30]];

/** Directions between measured ones (the kernel's interpolation in azimuth, in elevation, in both). */
export const BETWEEN_DIRECTIONS: readonly Direction[] = [
  [7, 0], [22, 0], [-50, 0], [112, 0], [160, 0], [20, 12], [-35, -22], [100, 40],
];

/** The directions that also run at 44.1 kHz (the rate the table is stored at: no resampling there). */
export const DIRECTIONS_44K: readonly Direction[] = [[0, 0], [30.3, 0], [-90, 0], [180, 0], [0, 30.3], [22, 0], [100, 40]];

export const hrtfSceneId = ([az, el]: Direction, rate: ParityRate): string => `hrtf-az${az}-el${el}@${rate / 1000}`;

export function hrtfScene(direction: Direction, rate: ParityRate): Scene {
  return {
    id: hrtfSceneId(direction, rate),
    group: "hrtf",
    profile: "hrtf",
    rate,
    seconds: 0.6,
    clips: [{ kind: "noise", seed: 0x6000, db: -12, seconds: 0.6 }],
    effects: [],
    voices: [{ clip: 0, bus: "Bus", spatial: { dir: directionVector(direction), panner: "hrtf" } }],
    analyzeFrom: 0.1,
    windows: false,
    referenceLatency: HRTF_LATENCY_FRAMES,
  };
}

export const HRTF_SCENES: readonly Scene[] = [
  ...[...MEASURED_DIRECTIONS, ...BETWEEN_DIRECTIONS].map((d) => hrtfScene(d, 48_000)),
  ...DIRECTIONS_44K.map((d) => hrtfScene(d, 44_100)),
];
