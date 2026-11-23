/**
 * Contract (ADR 0344): the project's audio file, `audio.json` (`myco.audio@1`) at the project root, replacing the
 * `audio` section of `project.json`. The Studio owns it (ADR 0341).
 *
 * `settings` holds today's engine budgets and options unchanged; the mix (buses, returns, VCAs, automation, ducking,
 * snapshots) is the prototype's model. Gains are dB. Names are identities, unique across buses, returns and VCAs.
 *
 * The runtime's mixer runs this model (`mixer.ts`; the runtime settings carry it under `mix`); its views in the old
 * `AudioSettings` shape (the backends' bus tree, the runtime's settings) are `runtimeView.ts`'s.
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve } from "../../core/curve";
import type { Effect } from "../effects/types";
import type { ParameterDef } from "../parameters";
import type { AudioSettings, DuckingDetector, DuckingMode, LoudnessTarget } from "../settings";
import type { EncodingConfig } from "../encoding/types";
import type { PackageDef, PackagingOptions } from "../packaging/definitions";
import type { AudioLocalisation } from "../localisation/types";

export const AUDIO_PROJECT_FORMAT = "myco.audio@1";
export const AUDIO_PROJECT_FILE = "audio.json";

/** The engine's budgets and options: every `AudioSettings` key that isn't part of the mix. */
export type AudioEngineSettings = Omit<
  AudioSettings,
  "buses" | "snapshots" | "ducking" | "parameters" | "automation" | "loudnessTargets" | "loudnessResetOnPlay"
> & {
  /** ADR 0345: instance submix pool. */
  submixes: number;
  /** ADR 0347: sounds farther than this (m) go to their bus's bed; null = beds by priority only (today). */
  bedBeyond: number | null;
  /** ADR 0347: global Doppler multiplier 0..2, default 1. */
  dopplerAmount: number;
  /** ADR 0355 §4: dialogue lines speaking at once (0: no limit) and the fade of an interrupted line, ms. */
  dialogue: { maxVoices: number; interruptFadeMs: number };
};

export interface Send { to: string; levelDb: number }

export interface Bus {
  name: string;
  /** null only for Master (the first bus). */
  parent: string | null;
  volumeDb: number;
  mute: boolean;
  /** Caps this bus and every bus under it; null = shares the nearest ancestor's. */
  voiceLimit: number | null;
  /** null = shares the nearest bed above. */
  bed: { own: boolean; priority: number } | null;
  /** Loudness metering (Master always). */
  meter: boolean;
  effects: Effect[];
  sends: Send[];
}

export interface Return {
  name: string;
  output: string;
  volumeDb: number;
  mute: boolean;
  effects: Effect[];
}

export interface Vca {
  name: string;
  volumeDb: number;
  members: string[];
}

export interface MixAutomation {
  /** A bus or return name. */
  on: string;
  target: "volume" | `send:${string}` | `fx:${string}:${string}`;
  parameter: string;
  curve: Curve;
  bypass: boolean;
}

export interface DuckingRule {
  target: string;
  trigger: string;
  mode: DuckingMode;
  detector: DuckingDetector;
  thresholdDb: number;
  amountDb: number;
  attackMs: number;
  releaseMs: number;
  enabled: boolean;
}

export type ConditionOp = "lt" | "le" | "eq" | "ne" | "ge" | "gt" | "between" | "is" | "not";
export interface SnapshotCondition {
  parameter: string;
  op: ConditionOp;
  /** A number, or a label for labelled parameters. */
  value: number | string;
  /** `between` only. */
  value2?: number;
}
export type SnapshotStart =
  | { kind: "base" }
  | { kind: "code" }
  | { kind: "never" }
  | { kind: "conditions"; match: "all" | "any"; conditions: SnapshotCondition[] };

export interface Snapshot {
  name: string;
  /** Folder path in the Snapshots tree, "" = top level. */
  folder: string;
  start: SnapshotStart;
  fadeInMs: number;
  fadeOutMs: number;
  holdMs: number;
  priority: number;
  combine: "override" | "add";
  /** bus or return name → dB offset. */
  buses: Record<string, number>;
  /** bus or return name → effect id → param → value (owner decision 2026-11-22). */
  effects: Record<string, Record<string, Record<string, number>>>;
}

export interface AudioProject {
  format: typeof AUDIO_PROJECT_FORMAT;
  settings: AudioEngineSettings;
  parameters: ParameterDef[];
  buses: Bus[];
  returns: Return[];
  vcas: Vca[];
  automation: MixAutomation[];
  ducking: DuckingRule[];
  snapshots: Snapshot[];
  loudness: { targets: LoudnessTarget[]; resetOnPlay: boolean };
  /**
   * ADR 0351 §2: encoding profiles, folder rules and budgets (`encoding/format.ts`). Absent when the file has none (every
   * file takes the built-in defaults; read it as `defaultEncodingConfig()`).
   */
  encoding?: EncodingConfig;
  /** ADR 0351 §7: package definitions (`packaging/definitions.ts`). Absent when there are none (no packages). */
  packages?: PackageDef[];
  /** ADR 0351 §7: package rules. Absent at the default (`strict: true`). */
  packaging?: PackagingOptions;
  /**
   * ADR 0354 §2: localised roots, loudness for batch import, the duration check, missing lines, the captions table
   * (`localisation/format.ts`). Absent at the defaults (no localised roots: nothing is localised).
   */
  localisation?: AudioLocalisation;
}

export interface AudioProjectParse {
  project: AudioProject;
  problems: string[];
  warnings: string[];
}
