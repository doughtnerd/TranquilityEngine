// "Why it played" (ADR 0348; spec §4.6.5; the prototype's causal chain): the decision path from the game's request
// through every playlist level to the sample and the bus. The capture's `eventStart` and `pick` records give the request
// and each level's decision (`decisionModel.ts` ties a voice to its instance); without them (a voice not tied to an
// instance, an older capture) the chain is the sound and the bus, with a note saying why. Each step names the screen its
// asset is edited on. Pure.
import type { ScreenId } from "../../shell/screens";
import { pickKind, pickReason, type InstanceDecisions } from "./decisionModel";
import { STATUS_SEVERITY, voiceSummary, type VoiceBlock } from "./voiceModel";

export type WhyKind = "game" | "playlist" | "sample" | "bus";

export interface WhyStep {
  readonly kind: WhyKind;
  /** The kind as the chain labels it ("GAME", "PLAYLIST · SW", "SAMPLE", "BUS"). */
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
  /** What the capture can't say, or null when the chain is complete. */
  readonly note: string | null;
}

/** Shown when the capture doesn't tie the voice to a game request. */
export const NO_PICK_PATH =
  "This capture doesn't tie this voice to a game request (it started later in its playlist's life, before the capture, or the capture is from an older build), so the chain starts at the sound.";

/** "audio/vehicles/boost.playlist.json" → "vehicles / boost". */
function pathTitle(path: string): string {
  const parts = path.split("/");
  const file = parts.pop() ?? path;
  const dot = file.indexOf(".");
  const name = dot > 0 ? file.slice(0, dot) : file;
  const folder = parts.pop();
  return folder ? `${folder} / ${name}` : name;
}

/** The chain for `block` from what the capture holds; `decision` is its playlist instance, when tied. */
export function whyChain(block: VoiceBlock, decision?: InstanceDecisions | null): WhyChain {
  const severity = STATUS_SEVERITY[block.status];
  const refusedHere = block.status === "blocked" || block.status === "refused";
  const steps: WhyStep[] = [];
  if (decision) {
    steps.push({ kind: "game", label: "GAME", name: `Game event ${pathTitle(decision.asset).split(" / ").pop()}`, why: "Game trigger", severity: "ok", screen: null, target: null });
    const picks = [...decision.picks].sort((a, b) => a.depth - b.depth);
    if (picks.length === 0 || picks[0]!.playlist !== decision.asset)
      steps.push({ kind: "playlist", label: "PLAYLIST", name: pathTitle(decision.asset), why: refusedHere ? voiceSummary(block) : "Started", severity: refusedHere ? severity : "ok", screen: "playlists", target: decision.asset });
    picks.forEach((p, i) => {
      const last = i === picks.length - 1;
      steps.push({
        kind: "playlist", label: pickKind(p), name: pathTitle(p.playlist), why: last && refusedHere ? voiceSummary(block) : pickReason(p) || "Played",
        severity: last && refusedHere ? severity : "ok", screen: "playlists", target: p.playlist.split("#")[0]!,
      });
    });
  }
  steps.push({
    kind: "sample",
    label: "SAMPLE",
    name: block.clipName,
    why: block.status === "played" ? (block.open ? "Still playing at the end of the capture" : "Played") : block.status === "missing" ? "Not in the build" : voiceSummary(block),
    severity: block.status === "missing" || block.status === "failed" ? "error" : "ok",
    screen: "samples",
    target: block.clipName,
  });
  steps.push({
    kind: "bus",
    label: "BUS",
    name: block.busName,
    why: block.status === "stolen" || block.status === "blocked" ? voiceSummary(block) : "Mixed here",
    severity: block.status === "stolen" || block.status === "blocked" ? severity : "ok",
    screen: "mixer",
    target: block.busName,
  });
  return { steps, note: decision ? null : NO_PICK_PATH };
}
