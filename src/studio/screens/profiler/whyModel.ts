// "Why it played" (ADR 0348; the prototype's causal chain): the decision path from the game's request through every
// playlist level to the sample and the bus. Captures gain pick paths on `eventStart` in a later task (0348's first
// extension); until then a capture knows only a voice's clip and bus, so the chain is those two steps and a note saying
// what is missing. The step kinds and their screens are the prototype's, so the full chain drops in. Pure.
import type { ScreenId } from "../../shell/screens";
import { STATUS_SEVERITY, voiceSummary, type VoiceBlock } from "./voiceModel";

export type WhyKind = "game" | "playlist" | "sample" | "bus";

export interface WhyStep {
  readonly kind: WhyKind;
  /** The kind as the chain labels it ("SAMPLE", "BUS"). */
  readonly label: string;
  readonly name: string;
  /** Why this step chose what it did, or what happened at it. */
  readonly why: string;
  readonly severity: "ok" | "warning" | "error";
  /** Where the step's asset is edited. */
  readonly screen: ScreenId | null;
  /** The asset or item that screen opens on (a path or a bus name). */
  readonly target: string | null;
}

export interface WhyChain {
  readonly steps: readonly WhyStep[];
  /** What the capture can't say yet, or null when the chain is complete. */
  readonly note: string | null;
}

/** Shown until captures carry pick paths. */
export const NO_PICK_PATH = "This capture has no decision path: captures record which playlist entry was picked, and why, from a later build. Shown: the sound and the bus it played on.";

/** The chain for `block` from what the capture holds. */
export function whyChain(block: VoiceBlock): WhyChain {
  const severity = STATUS_SEVERITY[block.status];
  const sample: WhyStep = {
    kind: "sample",
    label: "SAMPLE",
    name: block.clipName,
    why: block.status === "played" ? (block.open ? "Still playing at the end of the capture" : "Played") : voiceSummary(block),
    severity: block.status === "missing" || block.status === "failed" ? "error" : "ok",
    screen: "samples",
    target: block.clipName,
  };
  const bus: WhyStep = {
    kind: "bus",
    label: "BUS",
    name: block.busName,
    why: block.status === "stolen" || block.status === "blocked" ? voiceSummary(block) : "Mixed here",
    severity: block.status === "stolen" || block.status === "blocked" ? severity : "ok",
    screen: "mixer",
    target: block.busName,
  };
  return { steps: [sample, bus], note: NO_PICK_PATH };
}
