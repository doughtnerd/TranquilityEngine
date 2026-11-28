// The Sequence transport (proto §2.6 "Transport"): what Play plays (Selection: the selected clips, the loop, or from a
// hold point or marker to the end; From playhead; From start), a one-second pre-roll, return to start at the end,
// follow playhead; Space plays, stops, or releases while a held loop exists ("⇥ Release"). The playhead while playing
// is the playback's own position when it reports one (a sequence with a tempo, `playheadFromMusic`), else estimated
// from the time since the start.
// Pure.
import { compileTempoMap, positionToTicks, ticksToSeconds } from "../../../../engine/audio/musicGrid";
import { meterParts } from "../../../../engine/audio/meter";
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { PlaybackRules, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { clipLoops, clipPlan, loopBand } from "./clipGeometry";
import type { SeqSelection } from "./sequenceSelection";
import { allClips, clipLength, sequenceLength, type SourceOf } from "./sequenceModel";

export type PlayMode = "selection" | "playhead" | "start";

export interface TransportOptions {
  readonly mode: PlayMode;
  readonly preRoll: boolean;
  readonly returnToStart: boolean;
  readonly follow: boolean;
}

export const DEFAULT_TRANSPORT: TransportOptions = { mode: "selection", preRoll: false, returnToStart: false, follow: true };
export const PRE_ROLL_SECONDS = 1;

export const PLAY_MODES: readonly { readonly value: PlayMode; readonly label: string; readonly title: string }[] = [
  { value: "selection", label: "Selection", title: "The selected clips, the selected loop, or from the selected hold point or marker to the end" },
  { value: "playhead", label: "From playhead", title: "From the playhead to the end" },
  { value: "start", label: "From start", title: "The whole sequence" },
];

export interface PlayRange {
  /** Where the playhead starts (pre-roll included). */
  readonly start: number;
  /** Where the range proper begins (return-to-start goes here). */
  readonly from: number;
  readonly to: number;
  /** A selection is played: `untilStopped` doesn't keep it alive past `to`. */
  readonly selection: boolean;
}

/** What Play plays (from the playhead or a marker at the end: from the start). */
export function playRange(s: SequenceSettings, sel: SeqSelection, playhead: number, opts: TransportOptions, sourceOf: SourceOf): PlayRange {
  const length = sequenceLength(s, sourceOf);
  let from = 0, to = length, selection = false;
  if (opts.mode === "playhead") from = Math.min(playhead, length);
  else if (opts.mode === "selection") {
    const picked = allClips(s).filter((c) => sel.clips.includes(c.clip.id));
    const loop = sel.loop ? s.loops.find((l) => l.id === sel.loop) : undefined;
    const marker = sel.marker ? s.markers.find((m) => m.id === sel.marker) : undefined;
    if (sel.focus === "clips" && picked.length) {
      from = Math.min(...picked.map((p) => p.clip.at));
      to = Math.max(...picked.map((p) => p.clip.at + clipLength(p.clip, sourceOf(p.clip))));
      selection = true;
    } else if (sel.focus === "loop" && loop) {
      from = loop.start;
      to = loop.end > loop.start ? loop.end : length;
      selection = loop.end > loop.start;
    } else if (sel.focus === "marker" && marker) from = Math.min(marker.at, length);
    else from = Math.min(playhead, length);
  }
  // At (or past) the end there's nothing left to hear: Play wraps to the start (proto W53).
  if (!selection && length > 0 && from >= length) from = 0;
  const start = opts.preRoll ? Math.max(0, from - PRE_ROLL_SECONDS) : from;
  return { start, from, to: Math.max(from, to), selection };
}

/**
 * The Play button's words: what Play will play now (sequence W-2, proto W53): "Play clip" / "Play 3 clips", "Play loop",
 * "Play from the hold point", "Play from <marker>", "Play from the playhead", "Play from the start"; a pre-roll adds
 * "with pre-roll". Follows `playRange`'s rules (a marker or playhead at the end plays from the start).
 */
export function playLabel(s: SequenceSettings, sel: SeqSelection, playhead: number, opts: TransportOptions, sourceOf: SourceOf): string {
  const length = sequenceLength(s, sourceOf);
  const range = playRange(s, sel, playhead, opts, sourceOf);
  const pre = opts.preRoll && range.start < range.from ? " with pre-roll" : "";
  const fromStart = `Play from the start${pre}`;
  if (opts.mode === "start") return fromStart;
  if (opts.mode === "selection") {
    const picked = allClips(s).filter((c) => sel.clips.includes(c.clip.id)).length;
    const loop = sel.loop ? s.loops.find((l) => l.id === sel.loop) : undefined;
    const marker = sel.marker ? s.markers.find((m) => m.id === sel.marker) : undefined;
    if (sel.focus === "clips" && picked) return `Play ${picked === 1 ? "clip" : `${picked} clips`}${pre}`;
    if (sel.focus === "loop" && loop) return loop.end > loop.start ? `Play loop${pre}` : range.from === 0 && loop.start >= length ? fromStart : `Play from the hold point${pre}`;
    if (sel.focus === "marker" && marker) return range.from === 0 && marker.at > 0 ? fromStart : `Play from ${marker.name}${pre}`;
  }
  return range.from === 0 ? fromStart : `Play from the playhead${pre}`;
}

/** Does the sequence hold a loop that waits for release (a sequence loop or a clip's loop "while held")? */
export function hasHeldLoop(s: SequenceSettings, sourceOf: SourceOf): boolean {
  if (s.loops.some((l) => l.active === "held")) return true;
  return allClips(s).some((c) => c.track.enabled && c.clip.enabled && clipLoops(c.clip, sourceOf(c.clip)).some((l) => l.active === "held"));
}

/** What Space does: play when stopped; while playing, release a held loop not yet released, else stop. */
export function spaceAction(playing: boolean, heldLoop: boolean, released: boolean): "play" | "release" | "stop" {
  if (!playing) return "play";
  return heldLoop && !released ? "release" : "stop";
}

/** A span of sequence time that holds the playhead until release: a loop's region (it wraps there) or a hold point (start = end). */
export interface HeldRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * Where a "while held" loop holds the sequence playhead (J6.3, D24/D25; the runtime's loop program): the sequence's
 * own held loops and hold points, and each enabled Sync clip's held driving loop over its last pass (the runtime wraps
 * the playhead back one pass at the loop's last pass end; a zero-length loop parks it). Async clips' loops hold their
 * own voice, not the playhead. Sorted by start.
 */
export function heldRegions(s: SequenceSettings, sourceOf: SourceOf): HeldRegion[] {
  const out: HeldRegion[] = s.loops.filter((l) => l.active === "held").map((l) => ({ start: l.start, end: Math.max(l.start, l.end) }));
  for (const { track, clip } of allClips(s)) {
    if (!track.enabled || !clip.enabled || !clip.sync || clip.sample === undefined) continue;
    const plan = clipPlan(clip, sourceOf(clip));
    const band = loopBand(plan);
    if (!band || band.active !== "held" || !plan.loop) continue;
    const span = plan.loop.end - plan.loop.start;
    if (clip.reverse) {
      // ADR 0362: reversed, the map is mirrored: the runtime wraps back one pass at the mirrored first pass (the passes
      // after the tail; a clip with no pass besides its first follows), a zero-length loop parks it after the tail.
      const L = plan.length;
      if (!Number.isFinite(L)) continue;
      if (span > 0 && plan.avail >= span - 1e-9) out.push({ start: clip.at + L - plan.pre - span, end: clip.at + L - plan.pre });
      else if (span <= 0) out.push({ start: clip.at + L - band.end, end: clip.at + L - band.end });
      continue;
    }
    out.push(span > 0 ? { start: clip.at + Math.max(band.start, band.end - span), end: clip.at + band.end } : { start: clip.at + band.start, end: clip.at + band.start });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Where playback was released: the audio clock's elapsed seconds then, and the playhead there. */
export interface ReleasePoint {
  readonly elapsed: number;
  readonly at: number;
}

/**
 * The playhead estimated from the audio clock: start + elapsed, held by the first held region it reaches until
 * released (wrapping inside a loop's region, parked on a hold point), then on from where it was at the release;
 * clamped to the range end unless the sequence plays on.
 */
export function estimatePlayhead(range: PlayRange, elapsed: number, plays: PlaybackRules["plays"], held: readonly HeldRegion[] = [], released: ReleasePoint | null = null): number {
  let t: number;
  if (released) t = released.at + Math.max(0, elapsed - released.elapsed);
  else {
    t = range.start + Math.max(0, elapsed);
    const r = held.find((h) => h.start >= range.start - 1e-9 && t >= h.end);
    if (r) t = r.end > r.start ? r.start + ((t - r.start) % (r.end - r.start)) : r.start;
  }
  return plays === "untilStopped" && !range.selection ? t : Math.min(range.to, t);
}

/** A playback's musical position, as its handle's `music` reads it (1-based bar and beat). */
export interface HeardPosition {
  readonly bar: number;
  readonly beat: number;
  readonly beatFraction: number;
}

/**
 * ADR 0362 §1: the playhead on the playback's own clock: a sequence with a tempo reports its playhead as a musical
 * position (`handle.music`), heard as it plays, through loops, holds and pauses (it holds with a pause); this turns it
 * back into sequence seconds on the sequence's tempo. Null without a tempo or a position (then `estimatePlayhead`).
 */
export function playheadFromMusic(tempo: SequenceSettings["tempo"], at: HeardPosition | null | undefined): number | null {
  if (!tempo || !at || !(tempo.bpm > 0) || !Number.isFinite(at.bar) || !Number.isFinite(at.beat)) return null;
  const map = compileTempoMap([{ at: "1:1:0", bpm: tempo.bpm, ...meterParts(tempo.meter) }], 0);
  const s = ticksToSeconds(map, positionToTicks(map, at.bar, at.beat, 0) + Math.max(0, at.beatFraction) * MUSIC_TICKS_PER_BEAT);
  return Number.isFinite(s) ? Math.max(0, s) : null;
}

/** Where the playhead rests when playback ends. */
export const restingPlayhead = (range: PlayRange, opts: TransportOptions, reached: number): number => (opts.returnToStart ? range.from : reached);
