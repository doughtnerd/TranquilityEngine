/**
 * What the sample analysers find in a sample's audio (ADR 0342 "detection of what's missing"): its tempo
 * (`tempo.ts`) and its root note (`pitch.ts`), each only when asked for. The Studio runs this on a worker; it is the one
 * entry point the worker calls.
 *
 * Pure; no plugin, no DOM.
 */
import type { InterleavedPcm } from "./mono";
import { detectRoot, type RootDetection } from "./pitch";
import { detectTempo, type TempoDetection } from "./tempo";

export type DetectKind = "tempo" | "root";

export interface SampleDetection {
  /** Null when not asked for, or nothing could be told. */
  readonly tempo: TempoDetection | null;
  readonly root: RootDetection | null;
}

/** Run the analysers `what` names over `input`. */
export function detectSample(input: InterleavedPcm, what: readonly DetectKind[]): SampleDetection {
  return {
    tempo: what.includes("tempo") ? detectTempo(input) : null,
    root: what.includes("root") ? detectRoot(input) : null,
  };
}
