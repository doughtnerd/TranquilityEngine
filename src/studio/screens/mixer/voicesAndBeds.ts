// Voice limits and ambisonic beds down the routing tree (ADR 0330 "Voice limits", "Beds"; the prototype's Voices and
// Bed columns). A voice limit caps a bus and every bus below it; a bus without one shares the nearest ancestor's. A bus
// may own a bed with a priority; Master always has one; the `settings.bed.maxBeds − 1` highest priorities get the
// rest (equal priorities: the earlier bus in the list), and every other bus mixes into the nearest bed above it.
// Pure.
import type { AudioProject, Bus } from "../../../engine/audio/project/types";
import { BED_PRIORITY_LIMITS, DEFAULT_BED_PRIORITY } from "../../../engine/audio/settings";
import { ancestorsOf, busOf, masterOf, type EditResult } from "./busTree";

// --- voice limits ------------------------------------------------------------------------------------------------------

/** The limit a bus runs under: its own, an ancestor's, or none. */
export interface VoiceLimitView {
  /** null: no limit anywhere above (∞). */
  readonly limit: number | null;
  /** The bus whose limit it is (the bus itself when it has its own). */
  readonly from: string | null;
  readonly own: boolean;
  /** "48", "↑ 48" (shared from above) or "∞". */
  readonly text: string;
}

export function voiceLimitOf(p: Pick<AudioProject, "buses">, name: string): VoiceLimitView {
  const bus = busOf(p, name);
  if (bus && bus.voiceLimit !== null) return { limit: bus.voiceLimit, from: name, own: true, text: String(bus.voiceLimit) };
  for (const a of ancestorsOf(p, name)) {
    const l = busOf(p, a)?.voiceLimit ?? null;
    if (l !== null) return { limit: l, from: a, own: false, text: `↑ ${l}` };
  }
  return { limit: null, from: null, own: false, text: "∞" };
}

/** What a new limit starts at when the mode turns to Limit: the inherited one, else 32. */
export const DEFAULT_VOICE_LIMIT = 32;

/** The voice limit range: 1 to the project's logical voices. */
export const voiceLimitRange = (p: Pick<AudioProject, "settings">): [number, number] => [1, p.settings.voices.logical];

/**
 * A bus's voice limit set ("Voice limit"): `null` inherits; a number is rounded and held to 1..logical voices, and a
 * non-positive number inherits (as the prototype's field does).
 */
export function setVoiceLimit(p: AudioProject, name: string, limit: number | null): EditResult<AudioProject> {
  const bus = busOf(p, name);
  if (!bus) return { refused: `there's no bus "${name}"` };
  let next: number | null = null;
  if (limit !== null) {
    if (!Number.isFinite(limit)) return { refused: "the limit must be a number" };
    const [lo, hi] = voiceLimitRange(p);
    next = limit <= 0 ? null : Math.min(hi, Math.max(lo, Math.round(limit)));
  }
  if (next === bus.voiceLimit) return { next: p };
  return { next: { ...p, buses: p.buses.map((b) => (b === bus ? { ...b, voiceLimit: next } : b)) } };
}

/** The value Limit starts from for `name`: what it inherits, else `DEFAULT_VOICE_LIMIT`. */
export const seedVoiceLimit = (p: Pick<AudioProject, "buses">, name: string): number => voiceLimitOf(p, name).limit ?? DEFAULT_VOICE_LIMIT;

// --- beds ----------------------------------------------------------------------------------------------------------------

/** Where a bus's distant sounds are mixed. */
export type BedState =
  /** It hosts a bed (Master, or a winning owner). */
  | { readonly kind: "own"; readonly priority: number }
  /** It asked for a bed but is out of the budget: it shares `host`'s. */
  | { readonly kind: "lost"; readonly priority: number; readonly host: string | null }
  /** It shares the nearest bed above it. */
  | { readonly kind: "share"; readonly host: string | null }
  /** Its sounds never go to a bed (`bed.own` false). */
  | { readonly kind: "off" }
  /** The project has no beds (`maxBeds` 0). */
  | { readonly kind: "none" };

export interface BedAllocation {
  readonly maxBeds: number;
  /** Buses hosting a bed, Master first then by priority. */
  readonly hosts: readonly string[];
  /** Buses that asked for a bed and didn't get one. */
  readonly lost: readonly string[];
  readonly state: ReadonlyMap<string, BedState>;
  /** The budget chip: "Beds 2/2 · 1 sharing". */
  readonly chip: string;
}

export function allocateBeds(p: Pick<AudioProject, "buses" | "settings">): BedAllocation {
  const maxBeds = p.settings.bed.maxBeds;
  const master = masterOf(p);
  const state = new Map<string, BedState>();
  if (maxBeds <= 0) {
    for (const b of p.buses) state.set(b.name, { kind: "none" });
    return { maxBeds, hosts: [], lost: [], state, chip: "No beds" };
  }
  const asking = p.buses
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.name !== master && b.bed?.own === true)
    .sort((x, y) => y.b.bed!.priority - x.b.bed!.priority || x.i - y.i);
  const winners = asking.slice(0, maxBeds - 1).map(({ b }) => b.name);
  const hosts = [master, ...winners];
  const lost = asking.slice(maxBeds - 1).map(({ b }) => b.name);
  const hostOf = (name: string): string | null => [name, ...ancestorsOf(p, name)].find((n) => hosts.includes(n)) ?? null;
  for (const b of p.buses) {
    if (hosts.includes(b.name)) state.set(b.name, { kind: "own", priority: b.bed?.priority ?? DEFAULT_BED_PRIORITY });
    else if (b.bed?.own === true) state.set(b.name, { kind: "lost", priority: b.bed.priority, host: hostOf(b.parent ?? b.name) });
    else if (b.bed && b.bed.own === false) state.set(b.name, { kind: "off" });
    else state.set(b.name, { kind: "share", host: b.parent ? hostOf(b.parent) : null });
  }
  const chip = `Beds ${hosts.length}/${maxBeds}${lost.length > 0 ? ` · ${lost.length} sharing` : ""}`;
  return { maxBeds, hosts, lost, state, chip };
}

/** A bed state as the Bed column says it ("Own · 80", "Lost · shares Master", "Shares SFX", "Off"). */
export function bedText(s: BedState | undefined): string {
  if (!s) return "";
  switch (s.kind) {
    case "own": return `Own · ${s.priority}`;
    case "lost": return `Lost · shares ${s.host ?? "nothing"}`;
    case "share": return s.host ? `Shares ${s.host}` : "Shares";
    case "off": return "Off";
    case "none": return "No beds";
  }
}

/** How a bus asks for a bed: share the nearest above, own one, or none at all. */
export type BedMode = "share" | "own" | "off";

export const bedModeOf = (b: Pick<Bus, "bed">): BedMode => (b.bed === null ? "share" : b.bed.own ? "own" : "off");

/** A bus's bed request set ("Ambisonic bed"). Owning keeps its priority, else starts at the default. Master always owns. */
export function setBed(p: AudioProject, name: string, mode: BedMode, priority?: number): EditResult<AudioProject> {
  const bus = busOf(p, name);
  if (!bus) return { refused: `there's no bus "${name}"` };
  if (bus.parent === null && mode !== "own") return { refused: "Master always has a bed" };
  if (priority !== undefined && !Number.isFinite(priority)) return { refused: "the priority must be a number" };
  const [lo, hi] = BED_PRIORITY_LIMITS;
  const prio = Math.min(hi, Math.max(lo, Math.round(priority ?? bus.bed?.priority ?? DEFAULT_BED_PRIORITY)));
  const bed = mode === "share" ? null : { own: mode === "own", priority: prio };
  if (JSON.stringify(bed) === JSON.stringify(bus.bed)) return { next: p };
  return { next: { ...p, buses: p.buses.map((b) => (b === bus ? { ...b, bed } : b)) } };
}
