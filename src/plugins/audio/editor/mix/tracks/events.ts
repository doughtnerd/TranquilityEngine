// ADR 0171 amended by 0172 (M5a, task Pf3d; api-and-models §5.6, §7): the profiler's event tracks, pure (no DOM; the canvas
// draws `TrackData`, Pf4 mounts the modules). Three tracks:
//
//   - `events.instances` (lanes): event instance spans from eventStart and eventStop (args `instance, asset`; `instance`),
//     one lane per concurrent instance (at most `MAX_INSTANCE_LANES`; a later one shares the last lane and is counted).
//     A lane is 1 while an instance runs and 0 between, sampled on the STATUS times plus each span's own start and end
//     (the canvas draws samples, so a span needs samples inside it).
//   - `events.parameters` (ticks): a parameter event (args `name, instance, f32 bits`; the instance is `NO_NAME` for a
//     global parameter).
//   - `events.states` (ticks): a stateChange (args `parameter, label`, both ids in the `parameters` table).
//
// **Where the events come from.** `ProfileSource` has no "events in [t0, t1]" request: `seek(t)` answers the EVENT records
// from the keyframe at or before `t` up to `t` (`reader.ts`), so `EventLog` sweeps the capture with seeks. A record written
// before a keyframe and stamped after the previous one is reachable only by a seek made before that keyframe, so the sweep
// finds each keyframe boundary by galloping and then bisecting over the STATUS times (the `keyframeSeq` of the answer
// changes there) and reads the last seek of every keyframe interval: about seven seeks per captured second, none per STATUS.
// A live capture resumes from the start of its last (open) interval. Instances alive at the capture's first keyframe
// (a truncated ring's start) are spans from 0.
//
// Every tooltip is built by an exported pure function here (`instanceTooltip`, `parameterTooltip`, `stateTooltip`); a
// module's `tooltipAt` returns exactly its result.
import { EventKind } from "../../../runtime/capture/format";
import type { CaptureSeekState } from "../../../runtime/capture/reader";
import type { LineSeries, TrackData } from "../drawTimeline";
import { statusColumns, type ProfileSource } from "../profilerSource";
import type { TrackContext, TrackFactory, TrackModule } from "./types";

/** The id an absent name or instance carries in an EVENT (`capture/events.ts`' `NO_NAME`). */
export const NO_NAME = 0xffffffff;
/** Lanes the instances track draws; a deeper overlap shares the last lane. */
export const MAX_INSTANCE_LANES = 6;
/** The hover reach (seconds each side) until the panel sets `tolerance` from its pixel scale. */
export const DEFAULT_HOVER_TOLERANCE_S = 0.02;
/** Lines a tooltip lists before it counts the rest. */
export const MAX_TOOLTIP_LINES = 4;

/** A track module whose hover reach the panel sets (a few pixels in seconds at the current zoom). */
export type HoverTrackModule = TrackModule & { tolerance: number };

// --- shared pure helpers -----------------------------------------------------------------------------------------------

/** A time as the tooltips show it. */
export function formatSeconds(t: number): string {
  return `${t.toFixed(3)} s`;
}

/** First index whose value is >= t. */
export function lowerBound(a: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > t. */
export function upperBound(a: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The indices of the sorted `times` within `tolerance` of `t`, as [from, to). */
export function indicesNear(times: ArrayLike<number>, t: number, tolerance: number): [number, number] {
  return [lowerBound(times, t - tolerance), upperBound(times, t + tolerance)];
}

/** Joins tooltip lines, naming how many more matched than the `MAX_TOOLTIP_LINES` shown. */
export function listText(lines: readonly string[], total = lines.length): string | null {
  if (total === 0 || lines.length === 0) return null;
  const shown = lines.slice(0, MAX_TOOLTIP_LINES);
  const more = total - shown.length;
  return more > 0 ? `${shown.join("\n")}\n+${more} more` : shown.join("\n");
}

/** A float32 value as text: six significant digits, so a stored 0.3f reads 0.3. */
export function formatValue(v: number): string {
  return String(Number(v.toPrecision(6)));
}

/** The sorted, de-duplicated union of two ascending-or-not time lists. */
export function mergeTimes(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const all = new Float64Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) all[i] = a[i]!;
  for (let i = 0; i < b.length; i++) all[a.length + i] = b[i]!;
  all.sort();
  let n = 0;
  for (let i = 0; i < all.length; i++) if (i === 0 || all[i] !== all[i - 1]) all[n++] = all[i]!;
  return all.subarray(0, n);
}

// --- the event log -----------------------------------------------------------------------------------------------------

/** The EVENT kinds the tracks read. */
const WANTED = new Set<number>([EventKind.eventStart, EventKind.eventStop, EventKind.parameter, EventKind.stateChange, EventKind.musicTransition]);

/** One EVENT record on the viewport axis. */
export interface LoggedEvent {
  readonly seq: number;
  /** Seconds on the viewport axis (0 = the capture's first record). */
  readonly time: number;
  readonly kind: number;
  readonly args: readonly number[];
  readonly f32: number | undefined;
}

/** An instance the capture's first keyframe already counted. */
export interface InitialInstance {
  readonly id: number;
  readonly asset: number;
}

/** Index of the last element <= t, or -1. */
function lastAtOrBefore(a: ArrayLike<number>, t: number): number {
  return upperBound(a, t) - 1;
}

/** The events of a capture, swept with seeks (see the header). One per `ProfileSource` (`eventLogFor`). */
export class EventLog {
  private readonly bySeq = new Map<number, LoggedEvent>();
  private sorted: LoggedEvent[] = [];
  private dirty = false;
  private resume = 0;
  private running: Promise<void> | null = null;
  private times: Float64Array = new Float64Array(0);
  private first: InitialInstance[] | null = null;
  /** Seeks made so far (tests assert the work done). */
  seeks = 0;

  constructor(private readonly source: ProfileSource) {}

  /** STATUS times (viewport axis) as of the last refresh. */
  get statusTimes(): Float64Array {
    return this.times;
  }

  /** Instances alive at the capture's first keyframe (empty until the first refresh). */
  get initial(): readonly InitialInstance[] {
    return this.first ?? [];
  }

  /** Every logged event of `kind`, by time then seq. */
  ofKind(kind: number): LoggedEvent[] {
    if (this.dirty) {
      this.sorted = [...this.bySeq.values()].sort((a, b) => a.time - b.time || a.seq - b.seq);
      this.dirty = false;
    }
    return this.sorted.filter((e) => e.kind === kind);
  }

  /** Reads what the source gained since the last refresh. Calls made while one runs share it. */
  refresh(): Promise<void> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private collect(state: CaptureSeekState, index: number): void {
    const start = this.source.startSeconds;
    if (this.first === null && index === 0) this.first = (state.keyframe?.events ?? []).map((e) => ({ id: e.id, asset: e.asset }));
    for (const rec of state.records) {
      if (rec.kind !== "event" || !WANTED.has(rec.payload.kind) || this.bySeq.has(rec.seq)) continue;
      this.bySeq.set(rec.seq, { seq: rec.seq, time: rec.seconds - start, kind: rec.payload.kind, args: rec.payload.args, f32: rec.payload.f32 });
      this.dirty = true;
    }
  }

  private async sweep(): Promise<void> {
    const src = this.source;
    const times = (await statusColumns(src, [])).seconds as Float64Array;
    this.times = times;
    const n = times.length;
    const probe = async (i: number): Promise<number> => {
      const s = await src.seek(times[i]! + src.startSeconds);
      this.seeks++;
      this.collect(s, i);
      return s.keyframeSeq;
    };
    let i = Math.min(this.resume, Math.max(0, n - 1));
    while (n > 0 && i < n) {
      this.resume = i;
      const base = await probe(i);
      let good = i;
      let bad = -1;
      // Gallop by half seconds to the first probe in another keyframe interval (or the end).
      while (good < n - 1 && bad < 0) {
        const j = Math.min(n - 1, Math.max(good + 1, lastAtOrBefore(times, times[good]! + 0.5)));
        if ((await probe(j)) === base) good = j;
        else bad = j;
      }
      if (bad < 0) break;
      // Bisect for the last STATUS before the keyframe: its seek holds the whole interval.
      let lo = good;
      let hi = bad;
      while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        if ((await probe(mid)) === base) lo = mid;
        else hi = mid;
      }
      i = hi;
    }
  }
}

const logs = new WeakMap<ProfileSource, EventLog>();

/** The one log of a source, shared by the event, music and (through it) any other track reading EVENT records. */
export function eventLogFor(source: ProfileSource): EventLog {
  let l = logs.get(source);
  if (!l) logs.set(source, (l = new EventLog(source)));
  return l;
}

// --- names -------------------------------------------------------------------------------------------------------------

/** Name lookups over the source's current summary (it grows with a live capture, so build one per refresh). */
export interface EventNames {
  parameter(id: number): string;
  event(id: number): string;
}

export function eventNames(source: ProfileSource): EventNames {
  const parameters = new Map(source.summary.names.parameters);
  const events = new Map(source.summary.names.events);
  return { parameter: (id) => parameters.get(id) ?? `parameter ${id}`, event: (id) => events.get(id) ?? `event ${id}` };
}

// --- instance spans ----------------------------------------------------------------------------------------------------

/** One event instance from its start to its stop. */
export interface EventSpan {
  readonly instance: number;
  readonly asset: number;
  readonly name: string;
  readonly start: number;
  /** Null while it runs (to the end of the capture). */
  readonly end: number | null;
  /** The span began before the capture (alive at its first keyframe), so `start` is 0. */
  readonly fromKeyframe: boolean;
}

/**
 * Spans from the sorted eventStart and eventStop events (args `instance, asset`; `instance`). A start of an instance that is
 * still open ends the earlier span there; a stop of an unknown instance is ignored. `initial` seeds the instances the first
 * keyframe counted as running from 0.
 */
export function eventSpans(starts: readonly LoggedEvent[], stops: readonly LoggedEvent[], initial: readonly InitialInstance[], names: EventNames): EventSpan[] {
  const spans: { instance: number; asset: number; start: number; end: number | null; fromKeyframe: boolean }[] = [];
  const open = new Map<number, (typeof spans)[number]>();
  const open1 = (instance: number, asset: number, start: number, fromKeyframe: boolean): void => {
    const s = { instance, asset, start, end: null as number | null, fromKeyframe };
    spans.push(s);
    open.set(instance, s);
  };
  for (const e of initial) open1(e.id, e.asset, 0, true);
  const all = [...starts, ...stops].sort((a, b) => a.time - b.time || a.seq - b.seq);
  for (const e of all) {
    const id = e.args[0]!;
    if (e.kind === EventKind.eventStart) {
      const prev = open.get(id);
      if (prev) prev.end = e.time;
      open1(id, e.args[1]!, e.time, false);
    } else {
      const s = open.get(id);
      if (s) {
        s.end = e.time;
        open.delete(id);
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.instance - b.instance).map((s) => ({ ...s, name: names.event(s.asset) }));
}

/** Greedy lane per span (spans sorted by start): the first lane free at its start, a new one up to `max`, else the last. */
export function assignLanes(spans: readonly EventSpan[], max = MAX_INSTANCE_LANES): { lane: number[]; lanes: number; overflow: number } {
  const free: number[] = [];
  const lane: number[] = [];
  let overflow = 0;
  for (const s of spans) {
    let k = free.findIndex((end) => end <= s.start);
    if (k < 0) {
      if (free.length < max) {
        k = free.length;
        free.push(0);
      } else {
        k = free.length - 1;
        overflow++;
      }
    }
    free[k] = Math.max(free[k]!, s.end ?? Infinity);
    lane.push(k);
  }
  return { lane, lanes: free.length, overflow };
}

/** The lane lines: 1 over each span, 0 between, on the STATUS times plus every span boundary (an open span ends at `duration`). */
export function instanceLines(spans: readonly EventSpan[], statusTimes: ArrayLike<number>, duration: number): { lines: LineSeries[]; overflow: number } {
  const { lane, lanes, overflow } = assignLanes(spans);
  const bounds: number[] = [];
  for (const s of spans) bounds.push(s.start, s.end ?? duration);
  const grid = mergeTimes(statusTimes, bounds);
  const times = Float64Array.from(grid);
  const values = Array.from({ length: lanes }, () => new Float64Array(times.length));
  spans.forEach((s, k) => {
    const to = upperBound(times, s.end ?? Math.max(duration, times.length ? times[times.length - 1]! : 0));
    for (let i = lowerBound(times, s.start); i < to; i++) values[lane[k]!]![i] = 1;
  });
  return { lines: values.map((v, i) => ({ times, values: v, color: i % 2 ? "accent2" : "accent", yMax: 1 })), overflow };
}

// --- tooltips (the strings) --------------------------------------------------------------------------------------------

/** One span as a line: `"Explosion" #12  0.512 s to 1.730 s (1.218 s)`. */
export function spanText(s: EventSpan, duration: number): string {
  const head = `${s.name} #${s.instance}`;
  const from = s.fromKeyframe ? "before the capture" : formatSeconds(s.start);
  if (s.end === null) return `${head}  ${from}, still running (${formatSeconds(Math.max(0, duration - s.start))} so far)`;
  return `${head}  ${from} to ${formatSeconds(s.end)} (${formatSeconds(s.end - s.start)})`;
}

/** The spans running at `t` (within `tolerance` of their ends), most recently started first. */
export function instanceTooltip(spans: readonly EventSpan[], t: number, tolerance: number, duration: number): string | null {
  const hit = spans.filter((s) => s.start - tolerance <= t && t <= (s.end ?? Infinity) + tolerance).reverse();
  return listText(hit.slice(0, MAX_TOOLTIP_LINES).map((s) => spanText(s, duration)), hit.length);
}

/** A parameter event on the axis. */
export interface ParameterChange {
  readonly time: number;
  readonly name: string;
  /** Null for a global parameter. */
  readonly instance: number | null;
  readonly value: number;
}

/** The parameter events (args `name, instance, f32 bits`) as changes. */
export function parameterChanges(events: readonly LoggedEvent[], names: EventNames): ParameterChange[] {
  const f = new Float32Array(1);
  const bits = new Uint32Array(f.buffer);
  return events.map((e) => {
    bits[0] = e.args[2]!;
    return { time: e.time, name: names.parameter(e.args[0]!), instance: e.args[1]! === NO_NAME ? null : e.args[1]!, value: f[0]! };
  });
}

export function parameterText(c: ParameterChange): string {
  return `${formatSeconds(c.time)}  ${c.name} = ${formatValue(c.value)}${c.instance === null ? "" : ` (instance ${c.instance})`}`;
}

/** A state change on the axis. */
export interface StateChange {
  readonly time: number;
  readonly parameter: string;
  readonly label: string;
}

/** The stateChange events (args `parameter, label`) as changes. */
export function stateChanges(events: readonly LoggedEvent[], names: EventNames): StateChange[] {
  return events.map((e) => ({ time: e.time, parameter: names.parameter(e.args[0]!), label: names.parameter(e.args[1]!) }));
}

export function stateText(c: StateChange): string {
  return `${formatSeconds(c.time)}  ${c.parameter} → ${c.label}`;
}

function tickTooltip<T extends { time: number }>(items: readonly T[], t: number, tolerance: number, text: (c: T) => string): string | null {
  const times = items.map((c) => c.time);
  const [from, to] = indicesNear(times, t, tolerance);
  return listText(items.slice(from, Math.min(to, from + MAX_TOOLTIP_LINES)).map(text), to - from);
}

export function parameterTooltip(changes: readonly ParameterChange[], t: number, tolerance: number): string | null {
  return tickTooltip(changes, t, tolerance, parameterText);
}

export function stateTooltip(changes: readonly StateChange[], t: number, tolerance: number): string | null {
  return tickTooltip(changes, t, tolerance, stateText);
}

// --- the modules -------------------------------------------------------------------------------------------------------

/** What a module's refresh builds. */
export interface Built {
  data: TrackData | undefined;
  tooltip(t: number, tolerance: number): string | null;
}

/** A hover track over a `build` run after each refresh (the source's log is refreshed first). */
export function hoverModule(track: TrackModule["track"], log: { refresh(): Promise<void> } | null, build: () => Built): HoverTrackModule {
  let built: Built | null = null;
  const m: HoverTrackModule = {
    track,
    tolerance: DEFAULT_HOVER_TOLERANCE_S,
    data: () => built?.data,
    async refresh() {
      await log?.refresh();
      built = build();
    },
    tooltipAt: (t) => built?.tooltip(t, m.tolerance) ?? null,
  };
  return m;
}

/** The event instance, parameter and state-change tracks of an opened capture. */
export const eventTracks: TrackFactory = (ctx: TrackContext) => {
  const source = ctx.source;
  const log = eventLogFor(source);
  const instances = hoverModule({ id: "events.instances", label: "Event instances", kind: "lanes", height: 48, visible: true }, log, () => {
    const spans = eventSpans(log.ofKind(EventKind.eventStart), log.ofKind(EventKind.eventStop), log.initial, eventNames(source));
    const duration = source.duration;
    return {
      data: spans.length ? { lines: instanceLines(spans, log.statusTimes, duration).lines } : undefined,
      tooltip: (t, tol) => instanceTooltip(spans, t, tol, duration),
    };
  });
  const parameters = hoverModule({ id: "events.parameters", label: "Parameters", kind: "ticks", height: 22, visible: true }, log, () => {
    const changes = parameterChanges(log.ofKind(EventKind.parameter), eventNames(source));
    return {
      data: changes.length ? { ticks: Float64Array.from(changes, (c) => c.time), tickColor: "accent2" } : undefined,
      tooltip: (t, tol) => parameterTooltip(changes, t, tol),
    };
  });
  const states = hoverModule({ id: "events.states", label: "State changes", kind: "ticks", height: 22, visible: true }, log, () => {
    const changes = stateChanges(log.ofKind(EventKind.stateChange), eventNames(source));
    return {
      data: changes.length ? { ticks: Float64Array.from(changes, (c) => c.time), tickColor: "accent" } : undefined,
      tooltip: (t, tol) => stateTooltip(changes, t, tol),
    };
  });
  return [instances, parameters, states];
};
