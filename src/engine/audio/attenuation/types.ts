/**
 * Contract (ADR 0347): distance attenuation as curves. Used inline in a playlist's `spatial.attenuation` or as a shared
 * preset asset `*.attenuation.json` (`myco.attenuation@1`).
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve } from "../../core/curve";

export const ATTENUATION_FORMAT = "myco.attenuation@1";
export const ATTENUATION_SUFFIX = ".attenuation.json";

/** The four distance curves, keyed on metres, in the target's units. A missing curve is flat (no effect). */
export interface AttenuationCurves {
  /** dB (0 = unchanged). */
  volume?: Curve;
  /** Hz (cutoff). */
  lowpass?: Curve;
  /** dB added to the voice's reverb send. */
  reverbSend?: Curve;
  /** Degrees, 0..360. */
  spread?: Curve;
}

export interface Attenuation {
  minDistance: number;
  maxDistance: number;
  curves: AttenuationCurves;
}

/** The asset file. */
export interface AttenuationAsset extends Attenuation {
  format: typeof ATTENUATION_FORMAT;
}

/** Presets that write curve keys (ADR 0347: the old rolloff laws become presets). */
export type AttenuationPreset = "linear" | "inverse" | "exponential" | "inverseSquare";
