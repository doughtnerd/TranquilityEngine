// Why each voice played, from what a capture records (ADR 0348 "Why it played"; spec §4.6.5, §4.6.6): the game's
// request starts a playlist instance (`eventStart`: the instance, its asset and, ADR 0435, its cause), each playlist level then decides
// (`pick`: depth, playlist, type, the entry chosen, a Switch's label, a Blend's heaviest entries), and the core starts a
// voice. A capture doesn't tie a voice to its instance, but the sink records them in that order at the same instant, so a
// voice (or a refusal) belongs to the newest instance started at its instant before it in record order. A voice a
// sequence or a queue starts later in its life isn't tied (its instance shows as unknown). Pure.
import type { CaptureEventAt, CaptureNames } from "../../../plugins/audio/runtime/capture/reader";

/** One level's decision. */
export interface Pick {
  readonly depth: number;
  /** The playlist that decided (its path; an embedded one's owner path). */
  readonly playlist: string;
  readonly type: "clip" | "queue" | "switch" | "blend" | "layer" | "sequence" | null;
  /** The entry chosen (0-based), or null. */
  readonly choice: number | null;
  /** A Switch's label, or null. */
  readonly label: string | null;
  /** A Blend's heaviest entries with their weights. */
  readonly weights: readonly { readonly entry: number; readonly weight: number }[];
}

/** ADR 0435: what in the game asked for an instance (each null when the capture doesn't say). */
export interface InstanceCause {
  /** The request: "Audio.play", "AudioSource", "AudioZone", "Audio.line", `Audio.say("Greet")`. */
  readonly trigger: string | null;
  /** The GameObject's path from the World root ("/Player/Bike"). */
  readonly node: string | null;
  /** The behaviour hook that asked ("BikeAudio.onCollisionEnter"). */
  readonly behaviour: string | null;
  /** The defined system that was running. */
  readonly system: string | null;
}

/** A playlist instance the game started, and the decisions under it. */
export interface InstanceDecisions {
  readonly instance: number;
  /** The asset the game asked for (a playlist path). */
  readonly asset: string;
  /** Viewport seconds. */
  readonly start: number;
  readonly seq: number;
  readonly picks: readonly Pick[];
  /** What in the game asked for it (ADR 0435), or null for a capture from before it. */
  readonly cause: InstanceCause | null;
}

/** How close (seconds) a voice's start must be to its instance's: the same audio quantum. */
const SAME_INSTANT = 0.03;

/** The instances of `events` (eventStart and its picks), by record order. */
export function instanceDecisions(events: readonly CaptureEventAt[], names: CaptureNames, origin: number): InstanceDecisions[] {
  const out: { instance: number; asset: string; start: number; seq: number; picks: Pick[]; cause: InstanceCause | null }[] = [];
  const open = new Map<number, (typeof out)[number]>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const { seq, seconds, event: e } of sorted) {
    if (e.type === "eventStart") {
      const c = e.cause;
      const name = (id: number | null) => (id === null ? null : names.parameter(id, seconds));
      const cause = c ? { trigger: name(c.trigger), node: name(c.node), behaviour: name(c.behaviour), system: name(c.system) } : null;
      const d = { instance: e.instance, asset: names.event(e.asset, seconds), start: seconds - origin, seq, picks: [] as Pick[], cause };
      out.push(d);
      open.set(e.instance, d);
    } else if (e.type === "pick") {
      const d = open.get(e.instance);
      if (!d) continue;
      d.picks.push({
        depth: e.depth, playlist: names.event(e.playlist, seconds), type: e.playlistType, choice: e.choice,
        label: e.label === null ? null : names.parameter(e.label, seconds), weights: e.weights.map((w) => ({ entry: w.entry, weight: w.weight })),
      });
    } else if (e.type === "eventStop") open.delete(e.instance);
  }
  return out;
}

/** The instance a voice started at `seconds` (viewport) with record `seq` belongs to, or null. */
export function instanceOf(instances: readonly InstanceDecisions[], seq: number, seconds: number): InstanceDecisions | null {
  let best: InstanceDecisions | null = null;
  for (const d of instances) {
    if (d.seq >= seq) break;
    if (Math.abs(d.start - seconds) <= SAME_INSTANT) best = d;
  }
  return best;
}

const TYPE_CODE: Readonly<Record<NonNullable<Pick["type"]>, string>> = { clip: "CLP", queue: "RND", switch: "SW", blend: "1D", layer: "LYR", sequence: "SEQ" };

/** A pick's kind as the chain heads it ("PLAYLIST · SW"). */
export const pickKind = (p: Pick): string => (p.type ? `PLAYLIST · ${TYPE_CODE[p.type]}` : "PLAYLIST");

/** Why a level chose what it did, in words: "Surface → Stone", "picked #4", "a 62% · b 38%". */
export function pickReason(p: Pick): string {
  if (p.type === "switch") return p.label ? `${p.label} → entry ${(p.choice ?? 0) + 1}` : p.choice === null ? "nothing for this label" : `entry ${p.choice + 1}`;
  if (p.type === "blend" && p.weights.length) return p.weights.map((w) => `entry ${w.entry + 1} ${Math.round(w.weight * 100)}%`).join(" · ");
  if (p.type === "sequence") return p.choice === null ? "" : `clip ${p.choice + 1}`;
  if (p.type === "layer") return "every layer";
  return p.choice === null ? "" : `picked #${p.choice + 1}`;
}
