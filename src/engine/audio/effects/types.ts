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
/** A built-in type: one the catalogue itself declares. */
export type BuiltinEffectType = (typeof EFFECT_TYPES)[number];
/**
 * ADR 0338 §4: a plugin effect's type, namespaced by its plugin ("example.tremolo"). Built-in names have no dot, so
 * the two never meet. A plugin type whose plugin is off or missing is kept in files and passes audio through.
 */
export type PluginEffectType = `${string}.${string}`;
export type EffectType = BuiltinEffectType | PluginEffectType;

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
  /**
   * ADR 0338 §3: a choice among labelled options; the value is the option's index (`min` 0, `max` the last index,
   * `step` 1) and the card shows a menu.
   */
  choices?: readonly string[];
  /**
   * ADR 0338 §3: false for a parameter that steps at a block's start instead of gliding (switches and choices).
   * Absent: true for a number, false for `bool` and `choices`.
   */
  smooth?: boolean;
}

/** ADR 0338 §4: where a plugin effect type comes from, and whether its plugin runs. */
export interface EffectPluginInfo {
  /** The plugin's name; null when no installed plugin declares the type. */
  readonly name: string | null;
  /** The plugin's title (its name when it has none; the type when the plugin is missing). */
  readonly title: string;
  /** The plugin's version ("" when missing). */
  readonly version: string;
  /** `on`: registered and enabled; `off`: turned off in Project Settings > Plugins; `missing`: not installed. */
  readonly state: "on" | "off" | "missing";
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
  /** ADR 0338: a plugin's effect (absent for built-ins). */
  plugin?: EffectPluginInfo;
}

/** ADR 0338 §3: one module of a plugin's `audio` section (`modules.<id>`). */
export interface PluginEffectModule {
  readonly id: string;
  /** The wasm file, relative to the plugin folder (or package). */
  readonly wasm: string;
  /** The module's memory budget in MB (default 4, at most 64). */
  readonly memoryMB: number;
}

/** ADR 0338 §3: one effect a plugin declares: its catalogue spec plus what the host needs to run it. */
export interface PluginEffectDecl {
  readonly spec: EffectSpec & { readonly type: PluginEffectType; readonly plugin: EffectPluginInfo };
  /** The `modules` id that holds it, and its index (`kind`) in that module. */
  readonly module: string;
  readonly kind: number;
  /** Instructions per frame the effect may use per call (0344 §3: default 1,000, at most 5,000). */
  readonly instructionsPerFrame: number;
  /** Instances pre-created at registration (default 16). */
  readonly maxInstances: number;
}

/** ADR 0338 §3: a plugin's parsed `audio` section. */
export interface PluginAudio {
  readonly abi: number;
  readonly modules: readonly PluginEffectModule[];
  readonly effects: readonly PluginEffectDecl[];
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
