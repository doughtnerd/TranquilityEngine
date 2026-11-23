// The Sequence transport (proto §2.6 "Transport"): what Play plays (Selection: the selected clips, the loop, or from a
// hold point or marker to the end; From playhead; From start), a one-second pre-roll, return to start at the end,
// follow playhead; Space plays, stops, or releases while a held loop exists ("⇥ Release"). The playhead while playing
// is estimated from the audio clock since the start (the runtime's own position replaces it when it reports one).
// Pure.
import type { PlaybackRules, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { clipLoops } from "./clipGeometry";
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

/** What Play plays. */
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
  const start = opts.preRoll ? Math.max(0, from - PRE_ROLL_SECONDS) : from;
  return { start, from, to: Math.max(from, to), selection };
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

/** The playhead estimated from the audio clock: start + elapsed, clamped to the range end unless the sequence plays on. */
export function estimatePlayhead(range: PlayRange, elapsed: number, plays: PlaybackRules["plays"]): number {
  const t = range.start + Math.max(0, elapsed);
  return plays === "untilStopped" && !range.selection ? t : Math.min(range.to, t);
}

/** Where the playhead rests when playback ends. */
export const restingPlayhead = (range: PlayRange, opts: TransportOptions, reached: number): number => (opts.returnToStart ? range.from : reached);
