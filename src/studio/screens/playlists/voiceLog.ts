// What an audition plays, read from the runtime's public `Audio.debug()` (ADR 0329, 0327 "the Studio plays through
// the real engine"; the prototype's Plays now and Voices panels, PL:1239–1325): the voices of the open playlist's
// instances now, and a log of every voice seen while auditioning (start, end, status, gain, instance) with the triggers
// the playback rules refused. The panels poll a snapshot; this folds each snapshot into the log. Pure.
import type { PlaylistBody } from "../../../engine/audio/playlist/types";

/** The part of `Audio.debug()` the log reads. */
export interface DebugSnapshot {
  /** The audio clock, seconds. */
  readonly time: number;
  readonly events?: readonly { readonly id: number; readonly asset: string; readonly voices: number }[];
  readonly voices: readonly { readonly id: number; readonly clip: string; readonly bus: string; readonly state: string; readonly gain: number; readonly playheadSeconds: number | null; readonly event?: number | null }[];
  readonly playlistTotals?: { readonly recentRefusals: readonly { readonly playlist: string; readonly reason: string; readonly time: number }[] };
}

export type VoiceStatus = "playing" | "virtual" | "stolen" | "waiting" | "muted" | "finished" | "refused";

export interface LogRow {
  /** Unique in the log ("v12", "r3.5"). */
  readonly key: string;
  readonly kind: "voice" | "refused";
  /** The instance number (the runtime's instance id), 0 for a refused trigger. */
  readonly instance: number;
  /** The sample path (a refused trigger: the reason). */
  readonly clip: string;
  readonly bus: string;
  /** Audio-clock seconds. */
  readonly start: number;
  readonly end: number | null;
  readonly status: VoiceStatus;
  /** The latest gain, dB (−∞ as −120). */
  readonly gainDb: number;
}

/** At most this many rows (the prototype's 240); the oldest go first. */
export const LOG_LIMIT = 240;

export const toDb = (gain: number): number => (gain > 0 ? Math.max(-120, 20 * Math.log10(gain)) : -120);

const statusOf = (state: string): VoiceStatus =>
  state === "playing" ? "playing" : state === "virtual" ? "virtual" : state === "stolen" ? "stolen" : state === "busMuted" ? "muted" : state === "waitingForData" || state === "locked" ? "waiting" : "playing";

/** The instance ids of `asset` in a snapshot. */
export const instancesOf = (s: DebugSnapshot, asset: string): Set<number> => new Set((s.events ?? []).filter((e) => e.asset === asset).map((e) => e.id));

/** The voices of `asset`'s instances in a snapshot (what plays now). */
export function voicesNow(s: DebugSnapshot, asset: string): { id: number; instance: number; clip: string; bus: string; status: VoiceStatus; gain: number; gainDb: number; playhead: number | null }[] {
  const ids = instancesOf(s, asset);
  return s.voices
    .filter((v) => v.event != null && ids.has(v.event))
    .map((v) => ({ id: v.id, instance: v.event!, clip: v.clip, bus: v.bus, status: statusOf(v.state), gain: v.gain, gainDb: toDb(v.gain), playhead: v.playheadSeconds }));
}

/** `log` with snapshot `s` of `asset` folded in: new voices start, seen ones update, gone ones finish; new refusals are added. */
export function updateLog(log: readonly LogRow[], s: DebugSnapshot, asset: string): LogRow[] {
  const now = voicesNow(s, asset);
  const seen = new Map(now.map((v) => [`v${v.id}:${v.instance}`, v]));
  const out: LogRow[] = log.map((row) => {
    if (row.kind !== "voice" || row.end !== null) return row;
    const v = seen.get(row.key);
    if (!v) return { ...row, end: s.time, status: row.status === "stolen" ? "stolen" : "finished" };
    seen.delete(row.key);
    return v.status === row.status && v.gainDb === row.gainDb ? row : { ...row, status: v.status, gainDb: v.gainDb };
  });
  for (const [key, v] of seen) out.push({ key, kind: "voice", instance: v.instance, clip: v.clip, bus: v.bus, start: Math.max(0, s.time - Math.max(0, v.playhead ?? 0)), end: null, status: v.status, gainDb: v.gainDb });
  for (const r of s.playlistTotals?.recentRefusals ?? []) {
    if (r.playlist !== asset) continue;
    const key = `r${r.time}`;
    if (out.some((x) => x.key === key)) continue;
    out.push({ key, kind: "refused", instance: 0, clip: r.reason, bus: "", start: r.time, end: r.time, status: "refused", gainDb: -120 });
  }
  out.sort((a, b) => a.start - b.start);
  return out.length > LOG_LIMIT ? out.slice(out.length - LOG_LIMIT) : out;
}

/** Every start and end time in the log, once each, in order (what previous / next step through). */
export function eventTimes(log: readonly LogRow[]): number[] {
  const t = new Set<number>();
  for (const r of log) {
    t.add(r.start);
    if (r.end !== null) t.add(r.end);
  }
  return [...t].sort((a, b) => a - b);
}

/** The event time before or after `cursor` (null cursor: the first or last), or null at the end. */
export function stepEvent(times: readonly number[], cursor: number | null, dir: -1 | 1): number | null {
  if (times.length === 0) return null;
  if (cursor === null) return dir > 0 ? times[0]! : times[times.length - 1]!;
  const eps = 1e-6;
  if (dir > 0) return times.find((t) => t > cursor + eps) ?? null;
  for (let i = times.length - 1; i >= 0; i--) if (times[i]! < cursor - eps) return times[i]!;
  return null;
}

/** The rows sounding at time `t` (started, not ended). */
export const aliveAt = (log: readonly LogRow[], t: number): LogRow[] => log.filter((r) => r.kind === "voice" && r.start <= t && (r.end === null || r.end > t));

/** The log's span (first start to last end, or `now` while a voice still plays). */
export function logSpan(log: readonly LogRow[], now: number): [number, number] | null {
  if (log.length === 0) return null;
  const start = Math.min(...log.map((r) => r.start));
  const end = Math.max(...log.map((r) => r.end ?? now));
  return [start, Math.max(start, end)];
}

/**
 * Whether Release means something for a playlist (the player bar shows it then): it plays until stopped, a Queue plays
 * continuously, a Blend has a voice envelope, or a Clip loops its region, here or in any playlist it plays.
 */
export function canRelease(body: PlaylistBody, load: (path: string) => PlaylistBody | null, seen: ReadonlySet<string> = new Set()): boolean {
  if (body.playback.plays === "untilStopped" || body.queue?.continuous || (body.type === "blend" && body.blend && body.blend.envelope.mode !== "off")) return true;
  return body.entries.some((e) => {
    if (e.kind === "sample") return body.type === "clip" && e.loop === "on";
    if (e.kind === "line") return false; // ADR 0340 §5: a line plays its file once
    if (e.kind === "embedded") return canRelease(e.embedded, load, seen);
    if (seen.has(e.playlist)) return false;
    const linked = load(e.playlist);
    return linked ? canRelease(linked, load, new Set([...seen, e.playlist])) : false;
  });
}

/** A status in the prototype's words. */
export const STATUS_TEXT: Record<VoiceStatus, string> = {
  playing: "Playing", virtual: "Virtual (inaudible)", stolen: "Stolen", waiting: "Loading", muted: "Bus muted", finished: "Finished", refused: "Not played",
};

/** A refusal reason in words. */
export const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  cooldown: "cooldown since the last trigger", chance: "the chance roll", maxInstances: "max instances (when full: don't play)", missing: "the playlist is missing", unsupported: "this type doesn't play yet",
};
