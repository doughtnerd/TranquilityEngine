// ADR 0171 amended by 0172 (M5a, task Pf3d; api-and-models §5.6 kind 13, §7): the profiler's music tracks, pure.
//
//   - `music.state` (lanes): one lane per music instance (at most `MAX_MUSIC_LANES`, by first appearance), a step line
//     whose level is the playing segment (its number among the capture's segments), sampled on the STATUS times plus each
//     change; the hover names the segment and how it was entered.
//   - `music.transitions` (ticks): one per `musicTransition` event (args `instance, from, to`; segments are ids in the
//     `events` table, `from` is `NO_NAME` for the first segment, `capture/events.ts`).
//
// **The rule.** A `musicTransition` records the change as `from` to `to` and carries no rule id (`transition.ts`' `commit` and
// `noteFirstSegment` write the segments only), so the rule is named by what a rule matches on, the segment pair: "rule A -> B",
// and "first segment, from nothing" for the start. The tooltips are `transitionText` and `musicStateTooltip`.
import { EventKind } from "../../../runtime/capture/format";
import type { LineSeries } from "../drawTimeline";
import {
  NO_NAME, eventLogFor, eventNames, formatSeconds, hoverModule, indicesNear, listText, lowerBound, mergeTimes, MAX_TOOLTIP_LINES,
  type EventNames, type LoggedEvent,
} from "./events";
import type { TrackContext, TrackFactory } from "./types";

/** Lanes the music state track draws; later instances are not drawn (their transitions still tick). */
export const MAX_MUSIC_LANES = 4;

/** One recorded change of a music instance's segment. */
export interface MusicTransition {
  readonly time: number;
  readonly instance: number;
  /** Null for the first segment. */
  readonly from: string | null;
  readonly to: string;
}

/** The musicTransition events as transitions. */
export function musicTransitions(events: readonly LoggedEvent[], names: EventNames): MusicTransition[] {
  return events.map((e) => ({
    time: e.time,
    instance: e.args[0]!,
    from: e.args[1]! === NO_NAME ? null : names.event(e.args[1]!),
    to: names.event(e.args[2]!),
  }));
}

/** The rule a transition is named by (the segment pair the rule matched; see the header). */
export function transitionRule(t: Pick<MusicTransition, "from" | "to">): string {
  return t.from === null ? "first segment, from nothing" : `${t.from} → ${t.to}`;
}

/** A transition's tooltip line: `1.200 s  music 7: A -> B  (rule A -> B)`. */
export function transitionText(t: MusicTransition): string {
  const what = t.from === null ? `starts ${t.to}` : `${t.from} → ${t.to}`;
  return `${formatSeconds(t.time)}  music ${t.instance}: ${what}  (rule: ${transitionRule(t)})`;
}

/** The transitions within `tolerance` of `t`. */
export function transitionTooltip(transitions: readonly MusicTransition[], t: number, tolerance: number): string | null {
  const [from, to] = indicesNear(transitions.map((x) => x.time), t, tolerance);
  return listText(transitions.slice(from, Math.min(to, from + MAX_TOOLTIP_LINES)).map(transitionText), to - from);
}

/** One segment playing on an instance. */
export interface MusicSegment {
  readonly instance: number;
  readonly segment: string;
  readonly start: number;
  /** Null for the one still playing. */
  readonly end: number | null;
  /** The rule that entered it. */
  readonly rule: string;
}

/** The segments each instance played: a transition ends its instance's current segment and starts `to`. */
export function musicSegments(transitions: readonly MusicTransition[]): MusicSegment[] {
  const out: { instance: number; segment: string; start: number; end: number | null; rule: string }[] = [];
  const current = new Map<number, (typeof out)[number]>();
  for (const t of transitions) {
    const prev = current.get(t.instance);
    if (prev) prev.end = t.time;
    const s = { instance: t.instance, segment: t.to, start: t.time, end: null as number | null, rule: transitionRule(t) };
    out.push(s);
    current.set(t.instance, s);
  }
  return out;
}

/** The segment lines: level = the segment's number (1-based, by first appearance) over a scale topped by the segment count. */
export function musicStateLines(segments: readonly MusicSegment[], statusTimes: ArrayLike<number>, duration: number): LineSeries[] {
  const number = new Map<string, number>();
  for (const s of segments) if (!number.has(s.segment)) number.set(s.segment, number.size + 1);
  const instances: number[] = [];
  for (const s of segments) if (!instances.includes(s.instance)) instances.push(s.instance);
  const bounds: number[] = [];
  for (const s of segments) bounds.push(s.start, s.end ?? duration);
  const times = Float64Array.from(mergeTimes(statusTimes, bounds));
  return instances.slice(0, MAX_MUSIC_LANES).map((instance, lane) => {
    const values = new Float64Array(times.length);
    for (const s of segments) {
      if (s.instance !== instance) continue;
      const to = s.end === null ? times.length : lowerBound(times, s.end);
      for (let i = lowerBound(times, s.start); i < to; i++) values[i] = number.get(s.segment)!;
    }
    return { times, values, color: lane % 2 ? "accent2" : "accent", yMax: Math.max(1, number.size) } satisfies LineSeries;
  });
}

/** What is playing at `t`: one line per instance with a segment at `t`. */
export function musicStateTooltip(segments: readonly MusicSegment[], t: number): string | null {
  const hit = segments.filter((s) => s.start <= t && (s.end === null || t < s.end));
  return listText(hit.map((s) => `music ${s.instance}: playing ${s.segment} since ${formatSeconds(s.start)}  (rule: ${s.rule})`));
}

/** The music state and transition tracks of an opened capture. */
export const musicTracks: TrackFactory = (ctx: TrackContext) => {
  const source = ctx.source;
  const log = eventLogFor(source);
  const state = hoverModule({ id: "music.state", label: "Music state", kind: "lanes", height: 40, visible: true }, log, () => {
    const segments = musicSegments(musicTransitions(log.ofKind(EventKind.musicTransition), eventNames(source)));
    return {
      data: segments.length ? { lines: musicStateLines(segments, log.statusTimes, source.duration) } : undefined,
      tooltip: (t) => musicStateTooltip(segments, t),
    };
  });
  const transitions = hoverModule({ id: "music.transitions", label: "Music transitions", kind: "ticks", height: 22, visible: true }, log, () => {
    const list = musicTransitions(log.ofKind(EventKind.musicTransition), eventNames(source));
    return {
      data: list.length ? { ticks: Float64Array.from(list, (x) => x.time), tickColor: "accent" } : undefined,
      tooltip: (t, tol) => transitionTooltip(list, t, tol),
    };
  });
  return [state, transitions];
};

