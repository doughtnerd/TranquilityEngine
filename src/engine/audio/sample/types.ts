/**
 * Contract (ADR 0328): a sample's non-destructive edits, the `sample` block of an audio file's sidecar
 * (`<file>.meta.json`, `myco.import@1`), and derived samples (`*.sample.json`, `myco.sample@1`).
 *
 * Times are seconds in the source file. Every loop and marker has a stable `id`.
 *
 * Pure; no plugin, no DOM.
 */
import type { Curve } from "../../core/curve";
import type { Effect } from "../effects/types";
import type { LoopBehaviour } from "../playlist/types";

export const SAMPLE_FORMAT = "myco.sample@1";
export const SAMPLE_SUFFIX = ".sample.json";

export type SampleKind = "oneshot" | "loop" | "sustain" | "music";
export type ValueSource = "file" | "detected" | "set";

/** What the WAV said about a loop when it was imported or last written (the diff and merge compare against it). */
export interface LoopFileSnapshot { chunk: "smpl"; index: number; start: number; end: number; direction: LoopDirection; count: number }
export type LoopDirection = "forward" | "pingPong" | "backward";

export interface SampleLoop extends LoopBehaviour {
  id: string;
  /** start == end: a hold point. */
  start: number;
  end: number;
  direction: LoopDirection;
  /** 0..500. */
  crossfadeMs: number;
  /** 0 = endless, else 1..999. */
  count: number;
  note?: string;
  file: LoopFileSnapshot | null;
}

export type MarkerType = "note" | "exit" | "hit" | "cue";
export interface MarkerFileSnapshot { chunk: "cue" | "ltxt"; id: number; at: number; end?: number; name: string }
export interface SampleMarker {
  id: string;
  type: MarkerType;
  name: string;
  at: number;
  /** Notes only: the end of a range. */
  end?: number;
  /** Notes only: a theme series index or `#rrggbb`. */
  color?: number | string;
  note?: string;
  file: MarkerFileSnapshot | null;
}

export interface TempoMarker { at: number; bpm: number; meter: string }
export interface SampleTempo { bpm: number; meter: string; map: TempoMarker[]; source: ValueSource }
export interface SampleRoot { note: string; cents: number; source: ValueSource }
export interface SampleNormalize { mode: "off" | "loudness" | "peak"; target: number; gainDb: number }

/** One automation lane of a sample's baked chain: `fx:<effect id>:<parameter>` over sample time. */
export interface SampleAutomation {
  id: string;
  target: `fx:${string}:${string}`;
  /** Sample time (seconds in the source file); the only input a sample has. */
  input: "clipTime";
  curve: Curve;
  bypass: boolean;
}

/** The `sample` block. Every field optional in the file; the parse fills defaults. */
export interface SampleEdits {
  kind: SampleKind;
  /** null = whole file. */
  trim: [number, number] | null;
  loops: SampleLoop[];
  markers: SampleMarker[];
  tempo: SampleTempo | null;
  root: SampleRoot | null;
  normalize: SampleNormalize;
  /** Baked chain (ADR 0331 level "sample"). */
  effects: Effect[];
  /**
   * Automation of the baked chain's effect parameters over the sample (decision log D23), keyed on `clipTime`: seconds in
   * the source file, like every other time here. The offline render (`sampleRender.ts`, ADR 0328 "Flatten") is its
   * runtime: it bakes `effects` with these lanes applied, so a playing sample never evaluates them live.
   */
  automation: SampleAutomation[];
  frozen: boolean;
  /** Razor cut positions. */
  cuts: number[];
  /** Start times of deleted snippets (silence in place). */
  deleted: number[];
  /** `[sourceStart, length]` gaps removed. */
  closedGaps: [number, number][];
  stinger: boolean;
  snapToZero: boolean;
  /**
   * Set when the sample plays a flattened render (`brake_skid.flat1.wav`: a project path, or a bare name in the source
   * file's folder) instead of the original. The render (`renderSample`) keeps the source's timeline (same start and
   * length, an effect tail appended) and bakes only the chain, its automation and normalisation: the runtime still
   * applies trim and loops, skips the normalize gain, and loops and markers keep their source seconds.
   */
  source?: string;
}

export interface SampleLineage {
  kind: "snippet" | "fork" | "duplicate";
  parent: string;
  mode: "follow" | "pin";
  /** Fork, follow: the parent's resolved block at fork time. */
  baseline?: SampleEdits;
  /** Fork, pin: hash of the parent's resolved block at pin time. */
  pinnedHash?: string;
}

/** The derived-sample asset file. */
export interface DerivedSampleAsset {
  format: typeof SAMPLE_FORMAT;
  /** The audio file it plays. */
  source: string;
  /** A snippet's range in the source. */
  range: [number, number] | null;
  lineage: SampleLineage;
  sample: SampleEdits;
}
