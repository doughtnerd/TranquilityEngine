// The pure half of Audition (ADR 0158 §7, E6.4): the Play / Stop / Release state machine, which `Audio.debug()` rows
// belong to the auditioned instance, which parameter values changed, when a playing instance is out of date against
// the asset, and the notice the panel shows when nothing is heard. No Preact, no `Audio`: `Audition.tsx` wires them.
import type { AudioReason, AudioStatus } from "../../runtime/backend";

/** Where the audition is: nothing started, playing, key-off sent (sustain tails playing), or ended by itself or by Stop. */
export type AuditionPhase = "idle" | "playing" | "released" | "ended";

export type AuditionAction = "play" | "stop" | "release" | "finished" | "refused";

/** The next phase. `play` always (re)starts; `release` only counts while playing; `finished` is the instance ending by itself. */
export function nextPhase(phase: AuditionPhase, action: AuditionAction): AuditionPhase {
  switch (action) {
    case "play": return "playing";
    case "stop": return phase === "idle" ? "idle" : "ended";
    case "release": return phase === "playing" ? "released" : phase;
    case "finished": return phase === "playing" || phase === "released" ? "ended" : phase;
    case "refused": return "ended";
  }
}

/** Which buttons are enabled. */
export function buttonStates(phase: AuditionPhase, canPlay = true): { play: boolean; stop: boolean; release: boolean } {
  const live = phase === "playing" || phase === "released";
  return { play: canPlay, stop: live, release: phase === "playing" };
}

/** The slice of a debug event row and voice row this module reads. */
export interface DebugEventRow { id: number; asset: string }
export interface DebugVoiceRow { id: number; clip: string; state: string; gain: number; bus?: string; event?: number | null }

const normal = (path: string): string => path.replace(/^asset:/, "");

/**
 * The instance a play just made: the row for `path` whose id wasn't there before the call (the handle doesn't expose
 * its id). Null when there is none (an inert play, or one that already ended).
 */
export function newInstanceId(before: readonly number[], rows: readonly DebugEventRow[], path: string): number | null {
  const known = new Set(before);
  const p = normal(path);
  let found: number | null = null;
  for (const r of rows) if (!known.has(r.id) && normal(r.asset) === p) found = r.id;
  return found;
}

/** The voices of one instance, in the debug order. */
export function instanceVoices<V extends DebugVoiceRow>(voices: readonly V[], id: number | null): V[] {
  return id === null ? [] : voices.filter((v) => v.event === id);
}

/** Whether instance `id` is still listed. */
export const instanceAlive = (rows: readonly DebugEventRow[], id: number | null): boolean => id !== null && rows.some((r) => r.id === id);

/** The voice rows the list shows at most (a big event can start dozens); the count of the rest. */
export const MAX_AUDITION_ROWS = 12;
export function limitRows<T>(rows: readonly T[], max = MAX_AUDITION_ROWS): { shown: T[]; hidden: number } {
  return rows.length <= max ? { shown: rows.slice(), hidden: 0 } : { shown: rows.slice(0, max), hidden: rows.length - max };
}

/** The parameters whose value differs from the last applied set (new names count), as entries to `setParameter`. */
export function parameterChanges(prev: Readonly<Record<string, number | string>>, next: Readonly<Record<string, number | string>>): [string, number | string][] {
  return Object.entries(next).filter(([k, v]) => prev[k] !== v);
}

/**
 * The runtime caches a parsed event per raw asset object, and the project hands out a new object whenever the file
 * is written. So a playing instance is out of date when the asset object now is not the one it started from; to
 * audition the screen, flush the document's pending write first, then play. (An unknown object either side: not stale.)
 */
export function isStale(startedWith: object | undefined, current: object | undefined): boolean {
  return startedWith !== undefined && current !== undefined && startedWith !== current;
}

/**
 * What to tell the person, or null. `played` is whether the last Play made an instance; `reason` its handle's reason.
 * Locked audio needs a click (the Play click normally does it); a failed backend has no sound at all.
 */
export function auditionNotice(status: AudioStatus, phase: AuditionPhase, reason: AudioReason | null, played: boolean): string | null {
  if (status === "failed") return "The audio backend failed to start, so nothing can be heard. See the Audio Debug panel and the console.";
  if (phase === "idle") return null;
  if (status === "locked") return "Audio is locked by the browser until you click in the page. Press Play again after clicking.";
  if (!played) {
    if (reason === "locked") return "Audio is locked by the browser until you click in the page.";
    return "Nothing played: the event may be empty, in its cooldown, at its instance limit, or its clips are missing.";
  }
  return null;
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
