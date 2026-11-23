// The project's loudness targets (UI pass MX-63; ADR 0171 decision 4 as amended by ADR 0362 item 8): `audio.json`'s
// `loudness.targets`, 1..8 entries (the first is the default), each a name, an integrated level in LUFS, a tolerance in
// LU and a true-peak ceiling in dBTP, edited in Project settings · Loudness targets. And the integrated loudness of a
// whole take: the Loudness panel measures a take's replay from its start to its end (`takeLoudnessStep`). Pure.
import type { AudioProject } from "../../../engine/audio/project/types";
import { DEFAULT_LOUDNESS_TARGETS, LOUDNESS_TARGET_LIMITS, MAX_LOUDNESS_TARGETS, MAX_TARGET_NAME, type LoudnessTarget } from "../../../engine/audio/settings";
import { uniqueName } from "../../../engine/core/uniqueName";
import type { EditResult } from "../../../plugins/audio/editor/editResult";

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const withTargets = (p: AudioProject, targets: LoudnessTarget[]): AudioProject => ({ ...p, loudness: { ...p.loudness, targets } });

/** A new target after the others ("Target", numbered), starting from the default one's levels. */
export function addTarget(p: AudioProject): EditResult<AudioProject> {
  const list = p.loudness.targets;
  if (list.length >= MAX_LOUDNESS_TARGETS) return { refused: `a project holds at most ${MAX_LOUDNESS_TARGETS} loudness targets` };
  const from = list[0] ?? DEFAULT_LOUDNESS_TARGETS[0]!;
  return { next: withTargets(p, [...list, { name: uniqueName("Target", list.map((t) => t.name)), integrated: from.integrated, tolerance: from.tolerance, truePeak: from.truePeak }]) };
}

/** Target `index` changed: numbers clamped to their limits; a name must be non-empty, short and not another's. */
export function editTarget(p: AudioProject, index: number, patch: Partial<LoudnessTarget>): EditResult<AudioProject> {
  const list = p.loudness.targets;
  const t = list[index];
  if (!t) return { refused: "that target isn't there any more" };
  const next: LoudnessTarget = { ...t };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === "") return { refused: "a target needs a name" };
    if (name.length > MAX_TARGET_NAME) return { refused: `a target's name has at most ${MAX_TARGET_NAME} characters` };
    if (list.some((x, i) => i !== index && x.name === name)) return { refused: `another target is named "${name}"` };
    next.name = name;
  }
  for (const key of ["integrated", "tolerance", "truePeak"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) return { refused: `${key === "truePeak" ? "the true-peak ceiling" : key === "tolerance" ? "the tolerance" : "the level"} is a number` };
    next[key] = Math.round(clamp(v, LOUDNESS_TARGET_LIMITS[key]) * 10) / 10;
  }
  return { next: withTargets(p, list.map((x, i) => (i === index ? next : x))) };
}

/** Target `index` removed; the last one stays (a project always has a target). */
export function removeTarget(p: AudioProject, index: number): EditResult<AudioProject> {
  const list = p.loudness.targets;
  if (!list[index]) return { refused: "that target isn't there any more" };
  if (list.length <= 1) return { refused: "a project keeps at least one loudness target" };
  return { next: withTargets(p, list.filter((_, i) => i !== index)) };
}

/** Target `index` first (the default the meters check against). */
export function makeDefaultTarget(p: AudioProject, index: number): EditResult<AudioProject> {
  const list = p.loudness.targets;
  const t = list[index];
  if (!t) return { refused: "that target isn't there any more" };
  if (index === 0) return { next: p };
  return { next: withTargets(p, [t, ...list.filter((_, i) => i !== index)]) };
}

/** The defaults back (console −24, PC/web −18, mobile −16 LUFS, ±2 LU, −1 dBTP). */
export const resetTargets = (p: AudioProject): EditResult<AudioProject> => ({ next: withTargets(p, DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t }))) });

// --- a whole take's integrated loudness ---------------------------------------------------------------------------------

/** What the Loudness panel knows of the open take's replay each tick. */
export interface TakeReplayReading {
  /** The take's path (another take starts over). */
  readonly take: string;
  readonly duration: number;
  /** The playhead, take seconds. */
  readonly time: number;
  readonly playing: boolean;
  /** The master's integrated loudness now (LUFS; −Infinity or NaN before any gated block). */
  readonly integrated: number;
}

/** How far a take's measurement got. */
export type TakeLoudness =
  | { readonly state: "idle"; readonly take: string | null }
  /** From the take's start, on and paused included; `at` is the playhead. */
  | { readonly state: "measuring"; readonly take: string; readonly duration: number; readonly at: number; readonly integrated: number }
  /** The replay reached the end: the whole take's integrated loudness. */
  | { readonly state: "done"; readonly take: string; readonly duration: number; readonly integrated: number }
  /** A seek or a jump broke the run: the reading isn't the whole take's. */
  | { readonly state: "broken"; readonly take: string };

export const NO_TAKE_LOUDNESS: TakeLoudness = { state: "idle", take: null };
/** A replay that starts within this of 0 s counts as from the start. */
export const TAKE_START_S = 0.25;
/** The playhead may move this far between ticks before it counts as a seek, s. */
const TAKE_JUMP_S = 2;
/** Within this of the end counts as reaching it. */
const TAKE_END_S = 0.1;

/**
 * One tick of the whole-take measurement: a replay that plays from its start begins one (`reset`: the meters are reset
 * so the reading covers only the take); playing to the end finishes it with the integrated reading; a seek back or a
 * jump forward breaks it. No take open: idle.
 */
export function takeLoudnessStep(prev: TakeLoudness, r: TakeReplayReading | null): { next: TakeLoudness; reset: boolean } {
  if (!r) return { next: NO_TAKE_LOUDNESS, reset: false };
  const sameTake = prev.take === r.take;
  const startsHere = r.playing && r.time <= TAKE_START_S;
  if (startsHere && (!sameTake || prev.state !== "measuring" || prev.at > TAKE_START_S + 1e-9)) {
    return { next: { state: "measuring", take: r.take, duration: r.duration, at: r.time, integrated: r.integrated }, reset: true };
  }
  if (!sameTake) return { next: { state: "idle", take: r.take }, reset: false };
  if (prev.state !== "measuring") return { next: prev, reset: false };
  if (r.time < prev.at - 0.05 || r.time - prev.at > TAKE_JUMP_S) return { next: { state: "broken", take: r.take }, reset: false };
  if (r.time >= r.duration - TAKE_END_S) return { next: { state: "done", take: r.take, duration: r.duration, integrated: r.integrated }, reset: false };
  return { next: { ...prev, at: r.time, integrated: r.integrated }, reset: false };
}

const lufs = (v: number) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}${Math.abs(Math.round(v * 10) / 10).toFixed(1)} LUFS` : "—");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The panel's line for it, with a verdict against `target` (null text: nothing to say, no take open). */
export function takeLoudnessText(t: TakeLoudness, target: LoudnessTarget | null): { text: string; verdict: "ok" | "warn" | null } | null {
  switch (t.state) {
    case "idle":
      return t.take === null ? null : { text: "Whole take: replay the take from its start to measure it", verdict: null };
    case "broken":
      return { text: "Whole take: the replay jumped, so this isn't the whole take; replay it from its start", verdict: null };
    case "measuring":
      return { text: `Whole take: measuring… ${clock(t.at)} of ${clock(t.duration)} · ${lufs(t.integrated)} so far`, verdict: null };
    case "done": {
      const over = target && Number.isFinite(t.integrated) ? t.integrated - target.integrated : null;
      const verdict = over === null ? null : Math.abs(over) > (target?.tolerance ?? 0) ? "warn" : "ok";
      const against = target && over !== null ? ` · ${verdict === "ok" ? "on target" : `${Math.abs(Math.round(over * 10) / 10)} LU ${over > 0 ? "over" : "under"}`} (${String(target.integrated).replace("-", "−")} ±${target.tolerance})` : "";
      return { text: `Whole take: ${lufs(t.integrated)} integrated over ${clock(t.duration)}${against}`, verdict };
    }
  }
}
