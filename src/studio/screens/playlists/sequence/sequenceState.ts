// The Sequence view's screen state (ADR 0343, 0349): what the timeline and the Inspector share while a sequence is open
// (the selection, the playhead, the snap, time display, Write and razor modes, the clipboard, open lanes, which curve a
// clip shows), and the transport: Play through the Studio's audio host (`audioHost().audition`, the real `Audio.play`),
// the playhead estimated from the clock until the runtime reports positions, Stop, Release and Space. The rules are
// the pure models beside this file; this module holds signals and talks to the host.
import { signal } from "@preact/signals";
import type { Automation, PlaybackRules, SequenceSettings } from "../../../../engine/audio/playlist/types";
import type { AudioEventHandle } from "../../../../plugins/audio/runtime";
import type { TimeFormat, TimeSpan } from "../../../components/timeRulerModel";
import { audioHost } from "../../../shell/studioServices";
import type { SeqClipboard } from "./sequenceClipboard";
import { DEFAULT_SNAP, type SnapSetting } from "./sequenceGrid";
import type { SourceOf } from "./sequenceModel";
import { EMPTY_SELECTION, pruneSelection, type SeqSelection } from "./sequenceSelection";
import { DEFAULT_TRANSPORT, estimatePlayhead, hasHeldLoop, heldRegions, playheadFromMusic, playRange, restingPlayhead, spaceAction, type HeldRegion, type PlayRange, type ReleasePoint, type TransportOptions } from "./transportModel";

export const seqSelection = signal<SeqSelection>(EMPTY_SELECTION);
export const seqPlayhead = signal(0);
export const seqSnap = signal<SnapSetting>(DEFAULT_SNAP);
export const seqTimeFormat = signal<TimeFormat>("timecode");
/** Write automation is armed (W). */
export const seqWrite = signal(false);
/** The razor tool (C). */
export const seqRazor = signal(false);
/** What clips draw (proto "Audio view"): the waveform, the spectrogram, or both split; one always stays on. */
export const seqAudioView = signal<{ readonly wave: boolean; readonly spec: boolean }>({ wave: true, spec: false });
/** The Parameters panel's Held toggle: off starts the next play released (While-held loops don't hold). */
export const seqHeld = signal(true);
/** Copied curves (the Automate button's menu): the lanes, and whose they were ("Paste curves from Skid"). */
export const seqCurveClipboard = signal<{ readonly from: string; readonly lanes: readonly Automation[] } | null>(null);
export const seqTransport = signal<TransportOptions>(DEFAULT_TRANSPORT);
export const seqClipboard = signal<SeqClipboard | null>(null);
/** Tracks whose automation lanes show. */
export const seqOpenLanes = signal<ReadonlySet<string>>(new Set());
/** The curve each clip shows (clip id → automation id); default its first time curve. */
export const seqShownCurve = signal<Readonly<Record<string, string>>>({});
/** The visible span, per open sequence (null: fit). */
export const seqView = signal<TimeSpan | null>(null);

/** The open sequence (set by the view each time it draws), for the transport and the Inspector. */
export interface SequenceContext {
  /** The sequence's file, or null when it is embedded in another playlist (it plays with its parent). */
  readonly file: string | null;
  readonly title: string;
  readonly seq: SequenceSettings;
  readonly plays: PlaybackRules["plays"];
  readonly sourceOf: SourceOf;
}
export const sequenceContext = signal<SequenceContext | null>(null);

/** Which sequence the state belongs to: opening another resets the selection, view and playhead. */
let openKey: string | null = null;
export function bindSequence(key: string, ctx: SequenceContext): void {
  if (openKey !== key) {
    openKey = key;
    seqSelection.value = EMPTY_SELECTION;
    seqView.value = null;
    seqPlayhead.value = 0;
    seqShownCurve.value = {};
    if (playback.peek()) stopSequence();
  }
  const pruned = pruneSelection(ctx.seq, seqSelection.peek());
  if (pruned !== seqSelection.peek()) seqSelection.value = pruned;
  sequenceContext.value = ctx;
}

// --- transport -------------------------------------------------------------------------------------------------------

export interface Playback {
  readonly range: PlayRange;
  readonly startedAt: number;
  readonly released: boolean;
  /** Where held loops hold the playhead until release (J6.3). */
  readonly held: readonly HeldRegion[];
  /** A loop waits for release (a held region, or an Async clip's held loop): playback doesn't end before it. */
  readonly holds: boolean;
  /** Where Release was pressed (null: not yet). */
  readonly releasePoint: ReleasePoint | null;
  /** ADR 0362 §1: when Pause was pressed (the clock `now` reads; null: playing). The playhead holds there. */
  readonly pausedAt: number | null;
}
export const playback = signal<Playback | null>(null);
/** Why nothing plays (the runtime refused, the core isn't running), shown in the player bar. */
export const transportMessage = signal<string | null>(null);

/** Shown while the sequence runtime isn't in this build (the playlist runtime refuses sequences until it lands). */
export const NO_RUNTIME_TEXT = "Sequences play once the runtime lands";

let handle: AudioEventHandle | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Play what the transport options say. */
export function playSequence(): void {
  const ctx = sequenceContext.peek();
  if (!ctx) return;
  if (!ctx.file) {
    transportMessage.value = "An embedded sequence plays with its parent: Trigger the parent, or Make shared to play it here.";
    return;
  }
  const range = playRange(ctx.seq, seqSelection.peek(), seqPlayhead.peek(), seqTransport.peek(), ctx.sourceOf);
  let h: AudioEventHandle | null = null;
  try {
    // The play's start offset starts the sequence's playhead at the range's start.
    h = audioHost().audition(ctx.file, range.start > 0 ? { offset: range.start } : undefined);
  } catch {
    h = null;
  }
  if (!h || !h.playing) {
    transportMessage.value = h ? NO_RUNTIME_TEXT : "The audio core isn't running, so nothing plays.";
    return;
  }
  transportMessage.value = null;
  handle = h;
  // The Parameters panel's Held toggle off: the key is already up, so While-held loops leave at once.
  const released = !seqHeld.peek();
  if (released) h.release();
  playback.value = { range, startedAt: now(), released, held: heldRegions(ctx.seq, ctx.sourceOf), holds: hasHeldLoop(ctx.seq, ctx.sourceOf), releasePoint: released ? { elapsed: 0, at: range.start } : null, pausedAt: null };
  seqPlayhead.value = range.start;
  timer ??= setInterval(tick, 30);
}

/** Seconds the play has played: since it started, less the time it was paused (it holds while paused). */
function elapsedOf(p: Playback): number {
  return ((p.pausedAt ?? now()) - p.startedAt) / 1000;
}

/** Where the playback's own clock is (a sequence with a tempo reports its playhead as a musical position), or null. */
function heardPlayhead(p: Playback, ctx: SequenceContext): number | null {
  const m = handle?.music;
  const s = m && m.segment !== null ? playheadFromMusic(ctx.seq.tempo, m) : null;
  if (s === null) return null;
  return ctx.plays === "untilStopped" && !p.range.selection ? s : Math.min(p.range.to, s);
}

function tick(): void {
  const p = playback.peek();
  const ctx = sequenceContext.peek();
  if (!p || !ctx) return stopSequence();
  // ADR 0362 §1: the playback's own clock when it has one (it holds where the audio holds, also while paused), else an
  // estimate from the time since Play (frozen while paused).
  const heard = heardPlayhead(p, ctx);
  if (p.pausedAt !== null) {
    if (heard !== null) seqPlayhead.value = heard;
    return; // paused: the play holds
  }
  const t = heard ?? estimatePlayhead(p.range, elapsedOf(p), ctx.plays, p.held, p.releasePoint);
  seqPlayhead.value = t;
  // A loop waiting for release keeps the play going (J6.3): only the runtime ending it (after Release) or Stop ends it.
  const waiting = p.holds && !p.released;
  const ended = !handle?.playing || (!waiting && t >= p.range.to && (p.range.selection || (ctx.plays === "oneShot" && !p.holds)));
  if (ended) finish(t);
}

function finish(reached: number): void {
  const p = playback.peek();
  handle?.stop(0.12);
  handle = null;
  if (timer) clearInterval(timer);
  timer = null;
  playback.value = null;
  if (p) seqPlayhead.value = restingPlayhead(p.range, seqTransport.peek(), reached);
}

/** Stop (a 120 ms fade, ADR 0343). */
export function stopSequence(): void {
  finish(seqPlayhead.peek());
}

/** Release: held loops leave by their exit settings. */
export function releaseSequence(): void {
  const p = playback.peek();
  if (!p) return;
  handle?.release();
  const ctx = sequenceContext.peek();
  const elapsed = elapsedOf(p);
  playback.value = { ...p, released: true, releasePoint: { elapsed, at: ctx ? estimatePlayhead(p.range, elapsed, ctx.plays, p.held, null) : seqPlayhead.peek() } };
}

/**
 * ADR 0362 §1: Pause holds the play where it is (`AudioPlaylistHandle.pause`: its voices, the sequence clock and what it
 * planned) and freezes the playhead; Resume continues both from there.
 */
export function pauseSequence(): void {
  const p = playback.peek();
  if (!p || p.pausedAt !== null) return;
  handle?.pause();
  playback.value = { ...p, pausedAt: now() };
}

export function resumeSequence(): void {
  const p = playback.peek();
  if (!p || p.pausedAt === null) return;
  handle?.resume();
  // The time it was paused doesn't count: the playhead continues from where it froze.
  playback.value = { ...p, startedAt: p.startedAt + (now() - p.pausedAt), pausedAt: null };
}

/** A held loop exists in the open sequence (Space releases it while playing). */
export function sequenceHasHeldLoop(): boolean {
  const ctx = sequenceContext.peek();
  return !!ctx && hasHeldLoop(ctx.seq, ctx.sourceOf);
}

/** Space: play, release a held loop, or stop; on a paused play, resume. */
export function sequenceSpace(): void {
  const p = playback.peek();
  if (p?.pausedAt != null) return resumeSequence(); // Space continues a paused play
  switch (spaceAction(!!p, sequenceHasHeldLoop(), !!p?.released)) {
    case "play": return playSequence();
    case "release": return releaseSequence();
    case "stop": return stopSequence();
  }
}

/** Held now: before playing, the toggle's state; while playing, until Release. */
export function sequenceHeldNow(): boolean {
  const p = playback.value;
  return p ? !p.released : seqHeld.value;
}

/** The Parameters panel's Held / Released toggle: while playing it releases (as Space does); stopped, it sets how the next play starts. */
export function toggleHeld(): void {
  const p = playback.peek();
  if (p) {
    if (!p.released) releaseSequence();
    return;
  }
  seqHeld.value = !seqHeld.peek();
}

/** ⏮: the playhead to the start. */
export function returnToStart(): void {
  if (!playback.peek()) seqPlayhead.value = 0;
}

// --- Write automation (touch): a control held while Write is armed and the sequence plays records its value -----------

let touch: { key: string; samples: [number, number][] } | null = null;
/** A control is being written (the readout's "● Writing automation"). */
export const seqWriting = signal(false);

/**
 * A control moved (`drag` true while held, false on release). With Write armed during playback it records
 * [playhead, value] and returns null until release, then the samples to write; otherwise it returns "plain" (set the
 * value as usual). `key` names the control (owner and target), so two controls never mix.
 */
export function touchWrite(key: string, value: number, drag: boolean): readonly (readonly [number, number])[] | "plain" | null {
  const armed = seqWrite.peek() && !!playback.peek();
  if (!touch && !armed) return "plain";
  if (!touch || touch.key !== key) touch = { key, samples: [] };
  touch.samples.push([seqPlayhead.peek(), value]);
  seqWriting.value = true;
  if (drag) return null;
  const out = touch.samples;
  touch = null;
  seqWriting.value = false;
  return out;
}
