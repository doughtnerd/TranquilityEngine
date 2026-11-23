// The Samples screen's audition (the prototype's play modes): what a mode plays for the selection (a span, a loop
// cycling, through the loops), played through the Studio's audio host (`playClipSpan`, the public Audio API), and the
// playhead following the audio clock (`playheadModel.ts`). `planPlay` is pure; the rest drives the host.
//
// Degraded until the core can start a clip at an offset and render edits (TODO, core tasks in flight): only one loop
// cycles per audition (Through loops cycles the first; later loops play straight through), and deleted snippets and
// closed gaps aren't heard yet; baked effects and normalize are heard once the sample is flattened (the audition then
// plays the render, which keeps the source's timeline: `sampleActions.ts`).
import { signal } from "@preact/signals";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { playheadAt, type PlayRun } from "../../components/playheadModel";
import type { SpanPlayback, StudioAudioHost } from "../../runtime/studioAudioHost";
import { isHold, snippets } from "./sampleEditing";
import { trimOf } from "./sampleTime";
import { nextMarker, type SampleSelection } from "./sampleView";
import { seamWindow } from "./seam";
import type { PlayMode } from "./samplesState";

export interface PlayPlan {
  readonly from: number;
  readonly to: number;
  readonly loop: { readonly start: number; readonly end: number; readonly count: number; readonly crossfadeMs: number } | null;
  /** The loop is held (While held): Play becomes Release. */
  readonly held: boolean;
  /** What the player bar says ("Loop 1", "Whole sample"). */
  readonly scope: string;
}

/** What `mode` plays for `selection`, from `playhead` (source seconds). Null when there's nothing to play. */
export function planPlay(e: SampleEdits, length: number, selection: SampleSelection, mode: PlayMode, playhead: number): PlayPlan | null {
  const [ta, tb] = trimOf(e, length);
  const plain = (from: number, to: number, scope: string): PlayPlan | null => (to - from > 0.001 ? { from, to, loop: null, held: false, scope } : null);
  const cycle = (id: string | undefined): PlayPlan | null => {
    const l = (id ? e.loops.find((x) => x.id === id) : undefined) ?? e.loops[0];
    if (!l || isHold(l)) return null;
    return { from: l.start, to: l.end, loop: { start: l.start, end: l.end, count: 0, crossfadeMs: l.crossfadeMs }, held: false, scope: "Loop" };
  };
  switch (mode) {
    case "whole":
      return plain(ta, tb, "Whole sample");
    case "loop":
      return cycle(selection.kind === "loop" ? selection.id : undefined);
    case "through": {
      const l = e.loops.find((x) => !isHold(x));
      if (!l) return plain(ta, tb, "Through loops");
      return { from: ta, to: tb, loop: { start: l.start, end: l.end, count: l.active === "held" ? 0 : Math.max(0, l.count), crossfadeMs: l.crossfadeMs }, held: l.active === "held" || l.count === 0, scope: "Through loops" };
    }
    case "toNextMarker": {
      const next = nextMarker(e, playhead);
      return plain(playhead, next ? next.at : tb, next ? `To ${next.name}` : "To the end");
    }
    case "toEnd":
      return plain(playhead, tb, "To the end");
    default:
      break;
  }
  // Selection.
  switch (selection.kind) {
    case "loop":
      return cycle(selection.id);
    case "marker": {
      const m = e.markers.find((x) => x.id === selection.id);
      if (!m) return null;
      return plain(m.at, m.end ?? tb, m.name);
    }
    case "snippet": {
      const s = snippets(e, length).find((x) => x.index === selection.index);
      return s ? plain(s.start, s.end, s.name) : null;
    }
    case "pickup":
    case "tail":
    case "link": {
      const first = e.loops[0], last = e.loops[e.loops.length - 1];
      if (selection.kind === "pickup" && first) return plain(ta, first.start, "Pickup");
      if (selection.kind === "tail" && last) return plain(last.end, tb, "Tail");
      if (selection.kind === "link") {
        const i = e.loops.findIndex((l) => l.id === selection.after);
        if (i >= 0 && e.loops[i + 1]) return plain(e.loops[i].end, e.loops[i + 1].start, "Link");
      }
      return null;
    }
    default:
      // The trim, or the sample: from the playhead when it's inside the trim, else the trim.
      return plain(playhead > ta && playhead < tb - 0.01 ? playhead : ta, tb, playhead > ta && playhead < tb - 0.01 ? "From the playhead" : "Trim");
  }
}

/** What the player bar says while the seam plays. */
export const SEAM_SCOPE = "Loop seam";

/**
 * Play across the seam (the Loop seam panel): the last `W` of the loop, the seam with its crossfade, then the first
 * `W` of the loop, and no more (`W` is the seam strip's window, `seam.ts`). A two-pass loop run that stops `W` into
 * its second pass. Null for a hold loop (no seam) or a loop that's gone.
 */
export function planSeam(e: SampleEdits, loopId: string): PlayPlan | null {
  const l = e.loops.find((x) => x.id === loopId);
  if (!l || isHold(l) || !(l.end - l.start > 0.002)) return null;
  const w = Math.min(seamWindow(l.start, l.end), (l.end - l.start) / 2);
  return { from: l.end - w, to: l.start + w, loop: { start: l.start, end: l.end, count: 2, crossfadeMs: l.crossfadeMs }, held: false, scope: SEAM_SCOPE };
}

export interface Playing {
  readonly path: string;
  readonly plan: PlayPlan;
  readonly run: PlayRun;
  readonly playback: SpanPlayback;
  released: boolean;
}

/** The audition playing now. */
export const playing = signal<Playing | null>(null);

let frame: number | null = null;

/** Start auditioning `plan` of `source`; the playhead (`onTime`, source seconds) follows the clock. */
export function startPlay(host: StudioAudioHost, path: string, source: string, plan: PlayPlan, preRoll: number, onTime: (t: number) => void, onEnd: () => void): string | null {
  stopPlay(host);
  if (!host.playable.peek()) return host.state.peek().kind === "failed" ? "The audio core isn't running" : "The audio engine is still starting";
  const playback = host.playClipSpan(source, { from: plan.from, to: plan.to, loop: plan.loop, preRoll });
  if (!playback) return "The audio engine refused to play it";
  const run: PlayRun = { startedAt: playback.startedAt, from: plan.from, to: plan.to, loop: plan.loop };
  const p: Playing = { path, plan, run, playback, released: false };
  playing.value = p;
  const step = () => {
    if (playing.peek() !== p) return;
    const now = host.audio.time;
    const at = p.released ? Math.min(plan.to, releasedTime(p, now)) : playheadAt(run, now).t;
    onTime(at);
    if (!playback.playing) {
      playing.value = null;
      onEnd();
      return;
    }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return null;
}

/** After a release the run continues through the loop's end to `to`. */
let releaseAt: { clock: number; t: number } | null = null;
function releasedTime(p: Playing, now: number): number {
  if (!releaseAt) return p.plan.to;
  return releaseAt.t + (now - releaseAt.clock);
}

/** Leave a held loop (Play becomes Release while one holds). */
export function releasePlay(host: StudioAudioHost): void {
  const p = playing.peek();
  if (!p || p.released) return;
  const now = host.audio.time;
  const t = playheadAt(p.run, now).t;
  releaseAt = { clock: now, t };
  p.released = true;
  p.playback.release();
}

export function stopPlay(_host?: StudioAudioHost): void {
  const p = playing.peek();
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  releaseAt = null;
  if (p) {
    p.playback.stop(0.01);
    playing.value = null;
  }
}
