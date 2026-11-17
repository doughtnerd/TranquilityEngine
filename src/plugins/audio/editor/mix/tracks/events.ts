// ADR 0171 amended by 0172 (M5a, task Pf3d; api-and-models §5.6, §7): the profiler's event tracks, pure (no DOM; the canvas
// draws `TrackData`, Pf4 mounts the modules). Three tracks:
//
//   - `events.instances` (lanes): event instance spans from eventStart and eventStop, one lane per concurrent instance (at
//     most `MAX_INSTANCE_LANES`; a later one shares the last lane and is counted). A lane is 1 while an instance runs and 0
//     between, sampled on the STATUS times plus each span's own start and end (the canvas draws samples, so a span needs
//     samples inside it).
//   - `events.parameters` (ticks): a parameter event (a null instance is a global parameter).
//   - `events.states` (ticks): a stateChange (parameter and label, both ids in the `parameters` table).
//
// **Where the events come from** (ADR 0227). `EventLog` asks `ProfileSource.events` for the typed EVENTs (`CaptureEvent`)
// after its record cursor: the whole capture once, then a live view's appended records on each refresh, every EVENT exactly
// once. One seek at the first STATUS gives the instances alive at the capture's first keyframe (a truncated ring's start),
// which are spans from 0.
//
// Every tooltip is built by an exported pure function here (`instanceTooltip`, `parameterTooltip`, `stateTooltip`); a
// module's `tooltipAt` returns exactly its result.
import type { CaptureEvent, CaptureEventType } from "../../../runtime/capture/reader";
import type { LineSeries, TrackData } from "../drawTimeline";
import { statusColumns, type ProfileSource } from "../profilerSource";
import { assignLanes } from "./lanes";
import type { TrackContext, TrackFactory, TrackModule } from "./types";

/** Lanes the instances track draws; a deeper overlap shares the last lane. */
const MAX_INSTANCE_LANES = 6;
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

/** The EVENT types the tracks read. */
const WANTED: readonly CaptureEventType[] = ["eventStart", "eventStop", "parameter", "stateChange", "musicTransition"];

/** The typed event of one type. */
export type EventOf<T extends CaptureEventType> = Extract<CaptureEvent, { type: T }>;

/** One EVENT record on the viewport axis. */
export interface LoggedEvent<T extends CaptureEventType = CaptureEventType> {
  readonly seq: number;
  /** Seconds on the viewport axis (0 = the capture's first record). */
  readonly time: number;
  readonly event: EventOf<T>;
}

/** An instance the capture's first keyframe already counted. */
export interface InitialInstance {
  readonly id: number;
  readonly asset: number;
}

/** The events of a capture, read through `ProfileSource.events` (see the header). One per `ProfileSource` (`eventLogFor`). */
export class EventLog {
  private logged: LoggedEvent[] = [];
  private dirty = false;
  /** The record cursor the next read continues from (`CaptureEventsPage.next`). */
  private next = 0;
  private running: Promise<void> | null = null;
  private times: Float64Array = new Float64Array(0);
  private first: InitialInstance[] | null = null;

  constructor(private readonly source: ProfileSource) {}

  /** STATUS times (viewport axis) as of the last refresh. */
  get statusTimes(): Float64Array {
    return this.times;
  }

  /** Instances alive at the capture's first keyframe (empty until the first refresh). */
  get initial(): readonly InitialInstance[] {
    return this.first ?? [];
  }

  /** Every logged event of `type`, by time then seq. */
  ofKind<T extends CaptureEventType>(type: T): LoggedEvent<T>[] {
    if (this.dirty) {
      this.logged.sort((a, b) => a.time - b.time || a.seq - b.seq);
      this.dirty = false;
    }
    return this.logged.filter((e) => e.event.type === type) as unknown as LoggedEvent<T>[];
  }

  /** Reads what the source gained since the last refresh. Calls made while one runs share it. */
  refresh(): Promise<void> {
    this.running ??= this.read().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async read(): Promise<void> {
    const src = this.source;
    const times = (await statusColumns(src, [])).seconds as Float64Array;
    this.times = times;
    if (this.first === null && times.length > 0) {
      const s = await src.seek(times[0]! + src.startSeconds);
      this.first = (s.keyframe?.events ?? []).map((e) => ({ id: e.id, asset: e.asset }));
    }
    const page = await src.events(this.next, WANTED);
    this.next = page.next;
    const start = src.startSeconds;
    for (const e of page.events) this.logged.push({ seq: e.seq, time: e.seconds - start, event: e.event });
    if (page.events.length) this.dirty = true;
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
 * Spans from the eventStart and eventStop events. A start of an instance that is still open ends the earlier span there; a
 * stop of an unknown instance is ignored. `initial` seeds the instances the first keyframe counted as running from 0.
 */
function eventSpans(starts: readonly LoggedEvent<"eventStart">[], stops: readonly LoggedEvent<"eventStop">[], initial: readonly InitialInstance[], names: EventNames): EventSpan[] {
  const spans: { instance: number; asset: number; start: number; end: number | null; fromKeyframe: boolean }[] = [];
  const open = new Map<number, (typeof spans)[number]>();
  const open1 = (instance: number, asset: number, start: number, fromKeyframe: boolean): void => {
    const s = { instance, asset, start, end: null as number | null, fromKeyframe };
    spans.push(s);
    open.set(instance, s);
  };
  for (const e of initial) open1(e.id, e.asset, 0, true);
  const all = [...starts, ...stops].sort((a, b) => a.time - b.time || a.seq - b.seq);
  for (const { event: e, time } of all) {
    const id = e.instance;
    if (e.type === "eventStart") {
      const prev = open.get(id);
      if (prev) prev.end = time;
      open1(id, e.asset, time, false);
    } else {
      const s = open.get(id);
      if (s) {
        s.end = time;
        open.delete(id);
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.instance - b.instance).map((s) => ({ ...s, name: names.event(s.asset) }));
}

/** The lane lines: 1 over each span, 0 between, on the STATUS times plus every span boundary (an open span ends at `duration`). */
function instanceLines(spans: readonly EventSpan[], statusTimes: ArrayLike<number>, duration: number): { lines: LineSeries[]; overflow: number } {
  const { lane, lanes, overflow } = assignLanes(spans, MAX_INSTANCE_LANES);
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
function spanText(s: EventSpan, duration: number): string {
  const head = `${s.name} #${s.instance}`;
  const from = s.fromKeyframe ? "before the capture" : formatSeconds(s.start);
  if (s.end === null) return `${head}  ${from}, still running (${formatSeconds(Math.max(0, duration - s.start))} so far)`;
  return `${head}  ${from} to ${formatSeconds(s.end)} (${formatSeconds(s.end - s.start)})`;
}

/** The spans running at `t` (within `tolerance` of their ends), most recently started first. */
function instanceTooltip(spans: readonly EventSpan[], t: number, tolerance: number, duration: number): string | null {
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

/** The parameter events as changes. */
export function parameterChanges(events: readonly LoggedEvent<"parameter">[], names: EventNames): ParameterChange[] {
  return events.map(({ time, event: e }) => ({ time, name: names.parameter(e.name), instance: e.instance, value: e.value }));
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

/** The stateChange events as changes. */
function stateChanges(events: readonly LoggedEvent<"stateChange">[], names: EventNames): StateChange[] {
  return events.map(({ time, event: e }) => ({ time, parameter: names.parameter(e.parameter), label: names.parameter(e.label) }));
}

export function stateText(c: StateChange): string {
  return `${formatSeconds(c.time)}  ${c.parameter} → ${c.label}`;
}

function tickTooltip<T extends { time: number }>(items: readonly T[], t: number, tolerance: number, text: (c: T) => string): string | null {
  const times = items.map((c) => c.time);
  const [from, to] = indicesNear(times, t, tolerance);
  return listText(items.slice(from, Math.min(to, from + MAX_TOOLTIP_LINES)).map(text), to - from);
}

function parameterTooltip(changes: readonly ParameterChange[], t: number, tolerance: number): string | null {
  return tickTooltip(changes, t, tolerance, parameterText);
}

function stateTooltip(changes: readonly StateChange[], t: number, tolerance: number): string | null {
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
    const spans = eventSpans(log.ofKind("eventStart"), log.ofKind("eventStop"), log.initial, eventNames(source));
    const duration = source.duration;
    return {
      data: spans.length ? { lines: instanceLines(spans, log.statusTimes, duration).lines } : undefined,
      tooltip: (t, tol) => instanceTooltip(spans, t, tol, duration),
    };
  });
  const parameters = hoverModule({ id: "events.parameters", label: "Parameters", kind: "ticks", height: 22, visible: true }, log, () => {
    const changes = parameterChanges(log.ofKind("parameter"), eventNames(source));
    return {
      data: changes.length ? { ticks: Float64Array.from(changes, (c) => c.time), tickColor: "accent2" } : undefined,
      tooltip: (t, tol) => parameterTooltip(changes, t, tol),
    };
  });
  const states = hoverModule({ id: "events.states", label: "State changes", kind: "ticks", height: 22, visible: true }, log, () => {
    const changes = stateChanges(log.ofKind("stateChange"), eventNames(source));
    return {
      data: changes.length ? { ticks: Float64Array.from(changes, (c) => c.time), tickColor: "accent" } : undefined,
      tooltip: (t, tol) => stateTooltip(changes, t, tol),
    };
  });
  return [instances, parameters, states];
};
