// The pure half of Audition (ADR 0158 §7, E6.4): the Play / Stop / Release state machine, which `Audio.debug()` rows
// belong to the auditioned instance, which parameter values changed, when a playing instance is out of date against
// the asset, and the notice the panel shows when nothing is heard. No Preact, no `Audio`: `Audition.tsx` wires them.
import { signal } from "@preact/signals";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import type { AudioEventHandle, AudioReason, AudioStatus } from "../../runtime/backend";

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

// --- the shared audition (Ed5) -------------------------------------------------------------------------------------------

/**
 * The one audition that is playing, whoever started it (the Event editor's Audition panel or the segment view's transport):
 * the event asset and its handle. Starting another stops this one; the stinger Trigger buttons and the transport read it.
 */
export interface ActiveAudition {
  readonly path: string;
  readonly handle: Pick<AudioEventHandle, "playing" | "trigger" | "stop">;
}

export const activeAudition = signal<ActiveAudition | null>(null);

/** Make `handle` the active audition of `path`, stopping a different one that was playing. */
export function setActiveAudition(path: string, handle: ActiveAudition["handle"]): void {
  const prev = activeAudition.peek();
  if (prev && prev.handle !== handle) { try { prev.handle.stop(0.02); } catch { /* already gone */ } }
  activeAudition.value = { path, handle };
}

/** Forget `handle` when it is the active one (a stop, or the end of the instance); another audition stays. */
export function clearActiveAudition(handle: ActiveAudition["handle"]): void {
  if (activeAudition.peek()?.handle === handle) activeAudition.value = null;
}

/**
 * What the stinger Trigger buttons get for the event at `path`: the live audition's `trigger`, or null when `path` isn't
 * playing (the buttons stay disabled and say to press Play).
 */
export function stingerAuditionFor(path: string, active: ActiveAudition | null): { trigger(name: string): boolean } | null {
  if (!active || active.path !== path || !active.handle.playing) return null;
  const { handle } = active;
  return { trigger: (name) => handle.trigger(name) };
}

/**
 * The parameter values the Event editor's sliders hold for auditioning, per event path (only the ones moved; the rest are
 * the event's defaults, `auditionValues`). Shared so the segment view's transport plays with the same values (F-15).
 */
export const auditionOverrides = signal<Readonly<Record<string, Readonly<Record<string, number | string>>>>>({});
export const NO_OVERRIDES: Readonly<Record<string, number | string>> = Object.freeze({});

/** A slider moved: remember `value` of `name` for `event`'s audition. */
export function setAuditionValue(event: string, name: string, value: number | string): void {
  const cur = auditionOverrides.value;
  auditionOverrides.value = { ...cur, [event]: { ...cur[event], [name]: value } };
}

/** The trigger names of every stinger under `root`, in tree order, without repeats. */
export function stingerNames(root: MusicNode | undefined): string[] {
  const out: string[] = [];
  const walk = (n: MusicNode): void => {
    if (n.type === "segment") return;
    for (const s of n.stingers) if (!out.includes(s.trigger)) out.push(s.trigger);
    for (const c of n.children) walk(c);
  };
  if (root) walk(root);
  return out;
}
