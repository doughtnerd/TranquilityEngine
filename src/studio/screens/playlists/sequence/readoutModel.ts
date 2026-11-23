// The readout under the Sequence timeline (proto A8 `.readout`, spec §2.7): at the playhead, what the sequence is doing
// (a run chip: holding at a hold point, looping a loop, past its end with voices still playing or until stopped) and
// what each track is doing there (its clip's pickup, loop pass and parameter condition, the tail, silence past the
// sample, a disabled clip or track, holding or leaving after a release). Read from the timeline's model and the
// transport's estimate. Pure.
import type { PlaybackRules, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { clipPlan, clipToSource, loopBand } from "./clipGeometry";
import { clipLength, type SourceOf } from "./sequenceModel";
import { loopName } from "./timelineOverlays";

export interface ReadoutState {
  /** Playing (else only the tracks under the playhead are read). */
  readonly playing: boolean;
  /** Release was pressed (held loops leave by their exit). */
  readonly released: boolean;
  /** Write is armed while playing. */
  readonly writing: boolean;
  /** Game parameter values (test values), by name. */
  readonly values: Readonly<Record<string, number>>;
}

export type ReadoutTone = "text" | "warning" | "muted";

export interface ReadoutTrack {
  readonly name: string;
  readonly state: string;
  readonly tone: ReadoutTone;
}

export interface Readout {
  /** "● Writing automation" while Write records. */
  readonly writing: boolean;
  /** The sequence's state ("Holding at Hold 1"), or null. */
  readonly run: string | null;
  readonly tracks: readonly ReadoutTrack[];
}

const holds = (op: ">" | "<", v: number, threshold: number) => (op === ">" ? v > threshold : v < threshold);

export function sequenceReadout(s: SequenceSettings, sourceOf: SourceOf, t: number, length: number, plays: PlaybackRules["plays"], st: ReadoutState): Readout {
  let run: string | null = null;
  if (st.playing) {
    const here = s.loops.find((l) => (l.start === l.end ? Math.abs(t - l.start) < 1e-3 : t >= l.start && t < l.end));
    const active = here && (here.active === "always" || (here.active === "held" && !st.released) || (here.active === "parameter" && !!here.binding && holds(here.binding.op, st.values[here.binding.parameter] ?? 0, here.binding.value)));
    if (here && active) run = here.start === here.end ? `Holding at ${loopName(s, here.id)}` : `Looping ${loopName(s, here.id)}`;
    else if (t >= length - 1e-9) run = plays === "untilStopped" ? "Sequence end · until stopped" : "Sequence end · voices still playing";
  }
  const tracks: ReadoutTrack[] = [];
  for (const track of s.tracks) {
    const under = track.clips.find((c) => t >= c.at - 1e-9 && t < c.at + clipLength(c, sourceOf(c)));
    if (!under) {
      const before = track.clips.some((c) => c.at + clipLength(c, sourceOf(c)) <= t);
      if (st.playing && before) tracks.push({ name: track.name, state: "ended", tone: "muted" });
      continue;
    }
    if (!track.enabled) {
      tracks.push({ name: track.name, state: "track disabled", tone: "muted" });
      continue;
    }
    if (!under.enabled) {
      tracks.push({ name: track.name, state: "clip disabled", tone: "muted" });
      continue;
    }
    if (under.sample === undefined) {
      tracks.push({ name: track.name, state: "playing its playlist", tone: "text" });
      continue;
    }
    const src = sourceOf(under);
    const plan = clipPlan(under, src);
    const u = t - under.at;
    if (clipToSource(plan, u) === null) {
      tracks.push({ name: track.name, state: "silent (past the sample)", tone: "muted" });
      continue;
    }
    const band = loopBand(plan);
    if (!plan.loop || !band) {
      tracks.push({ name: track.name, state: "playing", tone: "text" });
      continue;
    }
    if (u < band.start) {
      tracks.push({ name: track.name, state: "pickup", tone: "text" });
      continue;
    }
    if (u >= band.end) {
      tracks.push({ name: track.name, state: "tail", tone: "text" });
      continue;
    }
    if (band.hold) {
      tracks.push({ name: track.name, state: st.released && plan.loop.active === "held" ? "released → leaves" : "holding", tone: st.released ? "warning" : "text" });
      continue;
    }
    const span = plan.loop.end - plan.loop.start;
    const pass = 1 + band.dividers.filter((d) => d <= u + 1e-9).length;
    let state = `loop pass ${Math.max(1, Math.min(pass, Math.ceil((band.end - band.start) / Math.max(1e-9, span))))}`;
    let tone: ReadoutTone = "text";
    const b = plan.loop.binding;
    if (plan.loop.active === "parameter" && b) {
      const ok = holds(b.op, st.values[b.parameter] ?? 0, b.value);
      state += ` · ${b.parameter} ${b.op} ${b.value.toFixed(2)} ${ok ? "✓" : "✗ → leaves"}`;
      if (!ok) tone = "warning";
    } else if (plan.loop.active === "held" && st.released) {
      state += " · released → leaves";
      tone = "warning";
    }
    tracks.push({ name: track.name, state, tone });
  }
  return { writing: st.writing, run, tracks };
}
