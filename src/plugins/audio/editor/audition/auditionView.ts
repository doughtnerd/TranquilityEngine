// What the audition's views (the Event editor's Audition bar, the segment view's transport bar, the stinger rows) decide
// on their own (ADR 0268): which buttons are enabled, how many voice rows to show, how to name the backend, and the
// stinger names of an event. Pure; the audition itself is `audition.ts`.
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import { musicEntries } from "../../../../engine/audio/musicTree";
import { isLive, type AuditionPhase } from "./audition";

/** Which buttons are enabled. */
export function buttonStates(phase: AuditionPhase, canPlay = true): { play: boolean; stop: boolean; release: boolean } {
  return { play: canPlay, stop: isLive(phase), release: phase === "playing" };
}

/** The voice rows the list shows at most (a big event can start dozens); the count of the rest. */
export const MAX_AUDITION_ROWS = 12;
export function limitRows<T>(rows: readonly T[], max = MAX_AUDITION_ROWS): { shown: T[]; hidden: number } {
  return rows.length <= max ? { shown: rows.slice(), hidden: 0 } : { shown: rows.slice(0, max), hidden: rows.length - max };
}

/** What the audition says about the backend that plays it (ADR 0162 §8): its name, and whether event filters and aux sends are skipped. */
export interface AuditionBackendInfo {
  label: string;
  /** True on the Babylon fallback, which skips event filters and aux sends with a warning. */
  skipsFilterAndSends: boolean;
  /** A sentence for the editor when `skipsFilterAndSends`, else null. */
  note: string | null;
}

/** `name` is `Audio.debug().core.backend`: "core", "babylon", "pending" (the core is still loading) or anything else (a test fake). */
export function auditionBackend(name: unknown): AuditionBackendInfo {
  if (name === "babylon") {
    return {
      label: "Babylon fallback", skipsFilterAndSends: true,
      note: "This audition plays on the Babylon fallback, which skips the event's filters and aux sends. The audio core plays them.",
    };
  }
  if (name === "core") return { label: "Audio core", skipsFilterAndSends: false, note: null };
  if (name === "pending") return { label: "Audio core loading", skipsFilterAndSends: false, note: null };
  return { label: typeof name === "string" && name !== "" ? name : "Audio core", skipsFilterAndSends: false, note: null };
}

/** The trigger names of every stinger under `root` (its containers, not the library), in tree order, without repeats. */
export function stingerNames(root: MusicNode | undefined): string[] {
  const out: string[] = [];
  if (!root) return out;
  for (const { node } of musicEntries(root, { library: false })) {
    if (node.type === "segment") continue;
    for (const s of node.stingers) if (!out.includes(s.trigger)) out.push(s.trigger);
  }
  return out;
}
