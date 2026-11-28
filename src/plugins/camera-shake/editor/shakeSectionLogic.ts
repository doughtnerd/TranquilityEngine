// What the Camera Shake Inspector sections show (ADR 0436 "Editor"): an impulse preset's envelope as plot points and
// its duration, and a one-line summary of a continuous noise profile. Pure: the views in `ShakeSections.tsx` draw it.
import { evalCurve } from "../../../engine/core/curve";
import { IMPULSE_SHAPES, NOISE_PROFILES, SHAKE_IMPULSE_PRESETS, CAMERA_NOISE_PRESETS, type CameraNoisePreset, type ShakeImpulsePreset } from "../runtime/presets";

/** `value` as an impulse preset, or null when it names none. */
export const impulsePresetOf = (value: unknown): ShakeImpulsePreset | null =>
  (SHAKE_IMPULSE_PRESETS as readonly unknown[]).includes(value) ? (value as ShakeImpulsePreset) : null;

/** `value` as a noise preset, or null when it names none. */
export const noisePresetOf = (value: unknown): CameraNoisePreset | null =>
  (CAMERA_NOISE_PRESETS as readonly unknown[]).includes(value) ? (value as CameraNoisePreset) : null;

/** Seconds an impulse lasts: the source's `duration` when above 0, else the preset's. */
export function impulseDuration(preset: ShakeImpulsePreset, duration: unknown): number {
  const d = Number(duration);
  return Number.isFinite(d) && d > 0 ? d : IMPULSE_SHAPES[preset].duration;
}

/**
 * The preset's envelope sampled at `samples` points across a `width` × `height` box (y down, strength 1 at the top,
 * 0 at the bottom), as an SVG `points` list.
 */
export function envelopePoints(preset: ShakeImpulsePreset, width: number, height: number, samples = 48): string {
  const curve = IMPULSE_SHAPES[preset].envelope;
  const out: string[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const v = Math.min(1, Math.max(0, evalCurve(curve, t)));
    out.push(`${(t * width).toFixed(1)},${((1 - v) * height).toFixed(1)}`);
  }
  return out.join(" ");
}

/** Seconds, short: "0.3 s", "2 s". */
export const formatSeconds = (s: number): string => `${Number(s.toFixed(2))} s`;

/** A noise profile in one line ("2 octaves, 0.3–1.1 Hz, turns up to 0.8°"), or null for "none" or an unknown preset. */
export function noiseSummary(noise: unknown): string | null {
  const preset = noisePresetOf(noise);
  const octaves = preset ? NOISE_PROFILES[preset] : [];
  if (octaves.length === 0) return null;
  const hz = octaves.map((o) => o.frequency);
  const lo = Math.min(...hz), hi = Math.max(...hz);
  const turn = Math.max(...octaves.flatMap((o) => o.rotation));
  const band = lo === hi ? `${lo} Hz` : `${lo}–${hi} Hz`;
  return `${octaves.length} octave${octaves.length === 1 ? "" : "s"}, ${band}, turns up to ${Number(turn.toFixed(2))}°`;
}
