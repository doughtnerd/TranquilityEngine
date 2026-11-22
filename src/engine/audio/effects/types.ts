/**
 * Contract (ADR 0331): one effect model for every level. The catalogue (`catalogue.ts`) declares each type's
 * parameters, levels and defaults; this file is only the shapes every format and runtime share.
 *
 * Pure; no plugin, no DOM.
 */

/** Where an effect may run (ADR 0331 §"The four levels"). */
export type EffectLevel = "sample" | "voice" | "instance" | "bus";

export const EFFECT_TYPES = [
  "eq", "lowpass", "highpass", "bandpass", "compressor", "sidechainCompressor", "limiter", "gain", "saturation",
  "distortion", "bitcrush", "formantShift", "pitchShift", "chorus", "delay", "reverb", "envelope", "fades",
  "noiseReduction", "reverse",
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** One parameter of an effect type, as the catalogue declares it. */
export interface EffectParamSpec {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  default: number;
  /** `log` params (frequencies) interpolate and display in log scale (ADR 0332 "Units in, units out"). */
  scale: "linear" | "log";
  /** A 0/1 switch. */
  bool?: boolean;
}

/** One effect type in the catalogue. */
export interface EffectSpec {
  type: EffectType;
  label: string;
  version: string;
  params: readonly EffectParamSpec[];
  levels: readonly EffectLevel[];
  /** Profiler cost class (ADR 0331 §"The catalogue"). */
  cost: "light" | "medium" | "heavy";
  /** Extra non-numeric settings this type carries (sidechain: `key` bus name). */
  key?: "bus";
}

/** An effect in any file: `{ "id": "fx1", "type": "lowpass", "on": true, "params": { "cutoff": 800 } }`. */
export interface Effect {
  id: string;
  type: EffectType;
  on: boolean;
  /** Missing params take the catalogue default. */
  params: Record<string, number>;
  /** `sidechainCompressor`: the key bus. */
  key?: string;
}
