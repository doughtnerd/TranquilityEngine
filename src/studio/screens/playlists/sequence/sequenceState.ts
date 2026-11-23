// The Sequence view's screen state (ADR 0343, 0349): what the timeline and the Inspector share while a sequence is open
// (the selection, the playhead, the snap, time display, Write and razor modes, the clipboard, open lanes, which curve a
// clip shows), and the transport: Play through the Studio's audio host (`audioHost().audition`, the real `Audio.play`),
// the playhead estimated from the clock until the runtime reports positions, Stop, Release and Space. The rules are
// the pure models beside this file; this module holds signals and talks to the host.
import { signal } from "@preact/signals";
import type { PlaybackRules, SequenceSettings } from "../../../../engine/audio/playlist/types";
import type { AudioEventHandle } from "../../../../plugins/audio/runtime";
import type { TimeFormat, TimeSpan } from "../../../components/timeRulerModel";
import { audioHost } from "../../../shell/studioServices";
import type { SeqClipboard } from "./sequenceClipboard";
import { DEFAULT_SNAP, type SnapSetting } from "./sequenceGrid";
import type { SourceOf } from "./sequenceModel";
import { EMPTY_SELECTION, pruneSelection, type SeqSelection } from "./sequenceSelection";
import { DEFAULT_TRANSPORT, estimatePlayhead, hasHeldLoop, heldRegions, playRange, restingPlayhead, spaceAction, type HeldRegion, type PlayRange, type ReleasePoint, type TransportOptions } from "./transportModel";

export const seqSelection = signal<SeqSelection>(EMPTY_SELECTION);
export const seqPlayhead = signal(0);
export const seqSnap = signal<SnapSetting>(DEFAULT_SNAP);
export const seqTimeFormat = signal<TimeFormat>("bars");
/** Write automation is armed (W). */
export const seqWrite = signal(false);
/** The razor tool (C). */
export const seqRazor = signal(false);
/** Waveforms drawn in clips. */
export const seqShowWave = signal(true);
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
  // TODO(W3-E sequence runtime): read the runtime's playhead instead of the estimate.
  transportMessage.value = null;
  handle = h;
  playback.value = { range, startedAt: now(), released: false, held: heldRegions(ctx.seq, ctx.sourceOf), holds: hasHeldLoop(ctx.seq, ctx.sourceOf), releasePoint: null };
  seqPlayhead.value = range.start;
  timer ??= setInterval(tick, 30);
}

function tick(): void {
  const p = playback.peek();
  const ctx = sequenceContext.peek();
  if (!p || !ctx) return stopSequence();
  const t = estimatePlayhead(p.range, (now() - p.startedAt) / 1000, ctx.plays, p.held, p.releasePoint);
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
  const elapsed = (now() - p.startedAt) / 1000;
  playback.value = { ...p, released: true, releasePoint: { elapsed, at: ctx ? estimatePlayhead(p.range, elapsed, ctx.plays, p.held, null) : seqPlayhead.peek() } };
}

/** A held loop exists in the open sequence (Space releases it while playing). */
export function sequenceHasHeldLoop(): boolean {
  const ctx = sequenceContext.peek();
  return !!ctx && hasHeldLoop(ctx.seq, ctx.sourceOf);
}

/** Space: play, release a held loop, or stop. */
export function sequenceSpace(): void {
  const p = playback.peek();
  switch (spaceAction(!!p, sequenceHasHeldLoop(), !!p?.released)) {
    case "play": return playSequence();
    case "release": return releaseSequence();
    case "stop": return stopSequence();
  }
}

/** ⏮: the playhead to the start. */
export function returnToStart(): void {
  if (!playback.peek()) seqPlayhead.value = 0;
}
