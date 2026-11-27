// "Why it played" (ADR 0348; spec §4.6.5; the prototype's causal chain): the decision path from the game's request
// through every playlist level to the sample and the bus. The request step names the trigger and its source (the
// GameObject, behaviour hook and system that asked, ADR 0435) when the capture records them. The capture's `eventStart` and `pick` records give the request
// and each level's decision (`decisionModel.ts` ties a voice to its instance); without them (a voice not tied to an
// instance, an older capture) the chain is the sound and the bus, with a note saying why. Each step names the screen its
// asset is edited on. Pure.
import type { ScreenId } from "../../shell/screens";
import { pickKind, pickReason, type InstanceCause, type InstanceDecisions } from "./decisionModel";
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
  /** More than the node has room for, one fact a line (the game step's source, ADR 0435); its tooltip. */
  readonly detail?: string;
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

/** Shown when a capture names the request but no script was running (a component's own start, async code, a UI event). */
const NO_SCRIPT = "No script hook running";

/**
 * ADR 0435: the game step from the instance's cause: the trigger's name, and where it came from (GameObject, behaviour
 * hook, system) as one line and, in full, as the detail. A capture from before it keeps the older "Game event …" step.
 */
function gameStep(decision: InstanceDecisions): WhyStep {
  const c: InstanceCause | null = decision.cause;
  const event = pathTitle(decision.asset).split(" / ").pop();
  if (!c || c.trigger === null) return { kind: "game", label: "GAME", name: `Game event ${event}`, why: "Game trigger", severity: "ok", screen: null, target: null };
  const facts: [string, string | null][] = [["GameObject", c.node], ["Behaviour", c.behaviour], ["System", c.system]];
  const known = facts.filter((f): f is [string, string] => f[1] !== null);
  const why = known.length ? known.map(([k, v]) => (k === "System" ? `system ${v}` : v)).join(" · ") : NO_SCRIPT;
  const detail = [`Trigger: ${c.trigger}`, ...(known.length ? known.map(([k, v]) => `${k}: ${v}`) : [NO_SCRIPT]), `Asked for: ${decision.asset}`].join("\n");
  return { kind: "game", label: "GAME", name: c.trigger, why, severity: "ok", screen: null, target: null, detail };
}

/** The chain for `block` from what the capture holds; `decision` is its playlist instance, when tied. */
export function whyChain(block: VoiceBlock, decision?: InstanceDecisions | null): WhyChain {
  const severity = STATUS_SEVERITY[block.status];
  const refusedHere = block.status === "blocked" || block.status === "refused";
  const steps: WhyStep[] = [];
  if (decision) {
    steps.push(gameStep(decision));
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
