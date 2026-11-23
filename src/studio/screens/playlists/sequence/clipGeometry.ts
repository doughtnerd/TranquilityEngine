// How a clip plays its sample over its length (ADR 0343 runtime semantics, proto §2.6 `geo`/`mapU`), for drawing: the
// clip's loops (the sample's, with this clip's overrides; "Override" vs "Inherited"), clip time → sample time as
// pickup, first pass, further passes of the first loop filling the clip, then the tail; the waveform pieces that
// mapping draws, the loop band with its pass dividers (a zero-length loop is a hold), the sample markers shown in the
// clip (hidden ones flagged) and the chips (loop activation, parameter binding, FX count, the playlist it picks, the
// "follows" warning). Pure.
import type { Clip, LoopBehaviour, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { clipLength, type SourceFacts, type SourceLoop, type SourceOf } from "./sequenceModel";

/** A loop as this clip plays it. */
export interface ClipLoop extends SourceLoop {
  /** This clip overrides some of the sample's settings for it. */
  readonly overridden: boolean;
}

/** The sample's loops with this clip's overrides applied, in source order. */
export function clipLoops(c: Clip, src: SourceFacts | null): ClipLoop[] {
  return (src?.loops ?? []).map((l) => {
    const o = c.loops[l.id];
    if (!o) return { ...l, overridden: false };
    const merged: SourceLoop = { ...l, ...stripUndefined(o) } as SourceLoop;
    return { ...merged, overridden: true };
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Where the clip starts in the sample's file time. */
const sourceStart = (c: Clip, src: SourceFacts | null): number => (src?.start ?? 0) + c.offset;

/** The loop the clip's passes repeat: the first loop that ends after the clip's start (proto: only the first drives). */
function drivingLoop(c: Clip, src: SourceFacts | null): ClipLoop | null {
  const s0 = sourceStart(c, src);
  return clipLoops(c, src).find((l) => l.end > s0 || (l.start === l.end && l.start >= s0)) ?? null;
}

/** The clip's plan: pickup + first pass (`pre`), the extra-pass time (`avail`), the loop, and the sample's end. */
export interface ClipPlan {
  readonly s0: number;
  readonly length: number;
  readonly loop: ClipLoop | null;
  /** Clip time when the first pass ends (the loop's end), or the clip length without a loop. */
  readonly pre: number;
  /** Clip time spent in further passes (or holding, for a zero-length loop). */
  readonly avail: number;
  /** The sample's end in file time (Infinity while unknown). */
  readonly end: number;
}

export function clipPlan(c: Clip, src: SourceFacts | null): ClipPlan {
  const length = clipLength(c, src);
  const s0 = sourceStart(c, src);
  const end = src?.length != null ? (src.start ?? 0) + src.length : Infinity;
  const loop = drivingLoop(c, src);
  if (!loop) return { s0, length, loop: null, pre: length, avail: 0, end };
  const pre = Math.max(0, loop.end - s0);
  const tail = Math.max(0, end - loop.end);
  const avail = Number.isFinite(tail) ? Math.max(0, length - pre - tail) : 0;
  return { s0, length, loop, pre, avail, end };
}

/** Sample (file) time at clip time `u`, or null past the sample's end ("silent, past the sample"). */
export function clipToSource(plan: ClipPlan, u: number): number | null {
  const { s0, loop, pre, avail, end } = plan;
  let t: number;
  if (!loop || u < pre) t = s0 + u;
  else if (u < pre + avail) {
    const span = loop.end - loop.start;
    t = span > 0 ? loop.start + ((u - pre) % span) : loop.start;
  } else t = loop.end + (u - pre - avail);
  return t >= end ? null : t;
}

/** One linear piece of the waveform: clip time `[at, at + length)` plays file time from `src` (a hold: stays at `src`). */
export interface WavePiece {
  readonly at: number;
  readonly length: number;
  readonly src: number;
  readonly hold: boolean;
}

/** The waveform pieces of the clip (pickup and first pass, each extra pass, the tail), cut at the clip and sample ends. */
export function wavePieces(plan: ClipPlan): WavePiece[] {
  const out: WavePiece[] = [];
  const push = (at: number, length: number, src: number, hold = false) => {
    const room = Math.min(length, plan.length - at, hold ? Infinity : plan.end - src);
    if (room > 1e-9 && at < plan.length) out.push({ at, length: room, src, hold });
  };
  const { s0, loop, pre, avail } = plan;
  if (!loop) {
    push(0, plan.length, s0);
    return out;
  }
  push(0, pre, s0);
  const span = loop.end - loop.start;
  if (avail > 0) {
    if (span <= 0) push(pre, avail, loop.start, true);
    else for (let u = 0; u < avail - 1e-9; u += span) push(pre + u, Math.min(span, avail - u), loop.start);
  }
  push(pre + avail, plan.length - pre - avail, loop.end);
  return out;
}

/** The driving loop's band in clip time, with a divider at each pass boundary; a hold draws as a line. */
export interface LoopBand {
  readonly loopId: string;
  readonly start: number;
  readonly end: number;
  readonly dividers: readonly number[];
  readonly hold: boolean;
  readonly active: LoopBehaviour["active"];
  readonly overridden: boolean;
}

export function loopBand(plan: ClipPlan): LoopBand | null {
  const { loop, s0, pre, avail } = plan;
  if (!loop) return null;
  const span = loop.end - loop.start;
  const start = Math.max(0, loop.start - s0);
  const end = Math.min(plan.length, pre + avail);
  if (start >= plan.length) return null;
  const dividers: number[] = [];
  if (span > 0) for (let u = pre; u < end - 1e-9; u += span) dividers.push(u);
  return { loopId: loop.id, start, end: Math.max(start, end), dividers, hold: span <= 0, active: loop.active, overridden: loop.overridden };
}

/**
 * ADR 0362: where clip time `u` of the forward plan is heard on a clip that plays in reverse (clip time `u` plays the
 * forward map at `length − u`, so the plan is drawn mirrored: the tail first, the passes backwards). An open-ended clip
 * isn't mirrored.
 */
export const reversedAt = (plan: ClipPlan, u: number): number => (Number.isFinite(plan.length) ? plan.length - u : u);

/** The loop band as drawn on a clip: `loopBand`, mirrored when the clip plays in reverse (`reverse`). */
export function drawnLoopBand(plan: ClipPlan, reverse: boolean): LoopBand | null {
  const band = loopBand(plan);
  if (!band || !reverse || !Number.isFinite(plan.length)) return band;
  const start = reversedAt(plan, band.end);
  const end = reversedAt(plan, band.start);
  return { ...band, start, end, dividers: band.dividers.map((d) => reversedAt(plan, d)).sort((a, b) => a - b) };
}

/**
 * A sample marker drawn in the clip: its clip time on the first pass (or the tail; mirrored on a reversed clip, where it
 * is heard), and whether this clip hides it.
 */
export interface ClipMarker {
  readonly id: string;
  readonly name: string;
  readonly at: number;
  readonly type: "note" | "exit" | "hit" | "cue";
  readonly hidden: boolean;
}

export function clipMarkers(c: Clip, src: SourceFacts | null, plan: ClipPlan): ClipMarker[] {
  const out: ClipMarker[] = [];
  for (const m of src?.markers ?? []) {
    let at: number;
    if (plan.loop && m.at >= plan.loop.end) at = plan.pre + plan.avail + (m.at - plan.loop.end);
    else at = m.at - plan.s0;
    if (at < 0 || at > plan.length) continue;
    out.push({ id: m.id, name: m.name, at: c.reverse ? reversedAt(plan, at) : at, type: m.type, hidden: c.hiddenMarkers.includes(m.id) });
  }
  return out;
}

/** A chip on the clip (proto: activation icon, `P brake > 0.10` / `⚠ unbound`, FX count, `→ pick`, `⚠ follows`). */
export interface ClipChip {
  readonly kind: "loop" | "binding" | "unbound" | "fx" | "pick" | "follows" | "disabled";
  readonly text: string;
  readonly title: string;
}

const ACTIVE_ICON: Record<LoopBehaviour["active"], string> = { always: "↻", held: "✋", parameter: "P" };
const ACTIVE_TEXT: Record<LoopBehaviour["active"], string> = { always: "Loops while the voice plays", held: "Loops while held; on release leaves by its exit", parameter: "Loops while its parameter condition holds" };

/**
 * The clip this one follows, or null (owner decision 4, UI pass 2026-11-23): music stems on parallel tracks that start
 * together are all Sync to the sequence clock, so a clip never "follows" one on another track. A Sync clip follows only
 * when it is chained after another Sync clip on its own track and overlaps it (a crossfaded chain): the earlier clip's
 * loop drives the playhead there and this one's is ignored (the runtime's one-driver rule, ADR 0343).
 */
export function clipFollows(s: Pick<SequenceSettings, "tracks">, clipId: string, sourceOf: SourceOf): Clip | null {
  for (const t of s.tracks) {
    const ci = t.clips.findIndex((x) => x.id === clipId);
    if (ci < 0) continue;
    const c = t.clips[ci]!;
    if (!t.enabled || !c.enabled || !c.sync || c.sample === undefined) return null;
    let best: Clip | null = null;
    t.clips.forEach((p, pi) => {
      if (pi === ci || !p.enabled || !p.sync || p.sample === undefined) return;
      if (p.at > c.at || (p.at === c.at && pi > ci)) return; // only a clip before it in the chain
      if (p.at + clipLength(p, sourceOf(p)) <= c.at + 1e-9) return; // back to back: nothing overlaps
      if (!best || p.at > best.at) best = p;
    });
    return best;
  }
  return null;
}

export function clipChips(c: Clip, src: SourceFacts | null, opts: { readonly follows: boolean; readonly playlistName?: string }): ClipChip[] {
  const out: ClipChip[] = [];
  if (!c.enabled) out.push({ kind: "disabled", text: "off", title: "Disabled: it doesn't play (E)" });
  const loop = drivingLoop(c, src);
  if (loop) {
    out.push({ kind: "loop", text: ACTIVE_ICON[loop.active], title: `${ACTIVE_TEXT[loop.active]}${loop.overridden ? " (this clip's override)" : " (from the sample)"}` });
    if (loop.active === "parameter") {
      if (loop.binding) out.push({ kind: "binding", text: `P ${loop.binding.parameter} ${loop.binding.op} ${loop.binding.value.toFixed(2)}`, title: "The loop is active while this holds" });
      else out.push({ kind: "unbound", text: "⚠ unbound", title: "Active while a parameter holds, but names none: it never turns active" });
    }
  }
  if (c.effects.length) out.push({ kind: "fx", text: `FX ${c.effects.length}`, title: c.effects.map((e) => e.type).join(", ") });
  if (c.playlist !== undefined) out.push({ kind: "pick", text: `→ ${opts.playlistName ?? "pick"}`, title: "Resolves once when the playhead enters the clip" });
  if (opts.follows) out.push({ kind: "follows", text: "⚠ follows", title: "Chained over the sync clip before it on this track, whose loop drives the playhead here; this clip's loop is ignored (Make Async to let it loop on its own)" });
  return out;
}
