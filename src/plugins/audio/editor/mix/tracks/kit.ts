// ADR 0261 (builds on 0171 and 0172; the `TrackModule` contract in `types.ts`): the profiler track kit. Track factories
// declare what they read and how they draw it; the kit does the reading, the caching and the "value in force at t".
//
// **One read per growth.** `TrackKit.of(source)` is one kit per open capture. A factory declares the STATUS columns it reads
// (`status(columns)`) and whether it reads the EVENTs (`events()`); every declaration shares one `StatusFeed` and one
// `EventLog`. `refresh()` reads what the source gained since the last refresh: one `range` for the union of the declared
// columns from the newest sample held (never the whole capture again), and one `events` page from the record cursor. Calls
// while a read runs join it; a call after the source grew (a live segment arrived) runs once more when it ends.
//
// **Modules.** `track(spec)` makes a `TrackModule` from a row (`track`), a `build` that turns what was read into `TrackData`
// and a tooltip, and, for a track that reads more than STATUS columns and EVENTs (the bus seeks, the Worker's loudness
// series), its own `read`. The kit rebuilds a module only when something it reads changed. `lastAtOrBefore` is the one
// "sample in force at t" (`StatusFeed.at`); a track's tooltip asks it, never a bisect of its own. The kit lives in the
// editor: the reader keeps answering columns and events, not per-track series (ADR 0227).
import { firstAtOrAfter, lastAtOrBefore } from "../../../../../engine/core/sortedSearch";
import { RANGE_SECONDS, type CaptureEvent, type CaptureEventType, type CaptureRangeColumns } from "../../../runtime/capture/reader";
import type { TrackData } from "../drawTimeline";
import { statusColumns, type ProfileSource } from "../profilerSource";
import type { Track } from "../timelineModel";
import type { TrackModule } from "./types";

/** The hover reach (seconds each side) until the panel sets `tolerance` from its pixel scale. */
export const DEFAULT_HOVER_TOLERANCE_S = 0.02;

/** A track module whose hover reach the panel sets (a few pixels in seconds at the current zoom). */
export type HoverTrackModule = TrackModule & { tolerance: number };

/**
 * `run` behind one flight: a call while it runs joins it, unless `key()` changed since the flight began (the source grew),
 * in which case `run` goes once more after it, shared by every such call.
 */
export function singleFlight(run: () => Promise<void>, key: () => unknown = () => undefined): () => Promise<void> {
  let running: Promise<void> | null = null;
  let startedWith: unknown;
  let again: Promise<void> | null = null;
  const call = (): Promise<void> => {
    if (!running) {
      startedWith = key();
      running = run().finally(() => {
        running = null;
      });
      return running;
    }
    if (key() === startedWith) return running;
    return (again ??= running.catch(() => undefined).then(() => {
      again = null;
      return call();
    }));
  };
  return call;
}

// --- STATUS columns ------------------------------------------------------------------------------------------------------

/** The STATUS samples read so far, every declared column, growing (viewport seconds; 0 = the capture's first record). */
export class StatusFeed {
  private n = 0;
  private secs = new Float64Array(0);
  private cols = new Map<string, Float64Array>();

  /** Samples held. */
  get length(): number {
    return this.n;
  }

  /** Each sample's viewport time (a view over the held part). */
  get times(): Float64Array {
    return this.secs.subarray(0, this.n);
  }

  /** One declared column (a view over the held part). */
  column(name: string): Float64Array {
    const c = this.cols.get(name);
    if (!c) throw new Error(`track kit: column "${name}" was not declared`);
    return c.subarray(0, this.n);
  }

  /** Every column and `seconds` as a range answer (views), for the models that read `CaptureRangeColumns`. */
  columns(): CaptureRangeColumns {
    const out: CaptureRangeColumns = { [RANGE_SECONDS]: this.times };
    for (const name of this.cols.keys()) out[name] = this.column(name);
    return out;
  }

  /** The sample in force at viewport time `t` (the last at or before it); -1 before the first. */
  at(t: number): number {
    return lastAtOrBefore(this.secs, t, this.n);
  }

  /** Starts over with `names` as the columns (a column declared after reading began). */
  reset(names: Iterable<string>): void {
    this.n = 0;
    this.secs = new Float64Array(0);
    this.cols = new Map([...names].map((name) => [name, new Float64Array(0)]));
  }

  /**
   * Appends a range answer read from the newest held time: samples at that time already held (the answer starts at or
   * before them) are skipped. Returns how many were added.
   */
  append(got: CaptureRangeColumns): number {
    const t = got[RANGE_SECONDS] as Float64Array;
    let from = 0;
    if (this.n > 0) {
      const last = this.secs[this.n - 1]!;
      const held = this.n - firstAtOrAfter(this.secs, last, this.n); // samples at the newest time
      let equal = 0;
      while (equal < t.length && t[equal]! <= last) equal++;
      from = Math.min(equal, held); // more samples at that time than held: the rest arrived since
    }
    const add = t.length - from;
    if (add <= 0) return 0;
    this.grow(this.n + add);
    this.secs.set(t.subarray(from), this.n);
    for (const [name, c] of this.cols) c.set((got[name] as Float64Array).subarray(from), this.n);
    this.n += add;
    return add;
  }

  private grow(need: number): void {
    if (need <= this.secs.length) return;
    const cap = Math.max(256, need, this.secs.length * 2);
    const more = (a: Float64Array): Float64Array<ArrayBuffer> => {
      const b = new Float64Array(cap);
      b.set(a.subarray(0, this.n));
      return b;
    };
    this.secs = more(this.secs);
    for (const [name, c] of this.cols) this.cols.set(name, more(c));
  }
}

// --- EVENTs ----------------------------------------------------------------------------------------------------------------

/** The EVENT types the event and music tracks read. */
const EVENT_TYPES: readonly CaptureEventType[] = ["eventStart", "eventStop", "parameter", "stateChange", "musicTransition"];

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

/**
 * The capture's EVENTs (ADR 0227's `ProfileSource.events`), every one read exactly once: the whole capture at the first
 * refresh, then a live view's appended records. One seek at the first STATUS gives the instances alive at the capture's
 * first keyframe (a truncated ring's start), which are spans from 0.
 */
export class EventLog {
  private logged: LoggedEvent[] = [];
  private dirty = false;
  /** The record cursor the next read continues from (`CaptureEventsPage.next`). */
  private next = 0;
  private first: InitialInstance[] | null = null;

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

  /** Reads the EVENTs after the cursor (and, once, the first keyframe's instances); true when any arrived. */
  async read(src: ProfileSource, firstStatus: number | undefined): Promise<boolean> {
    if (this.first === null && firstStatus !== undefined) {
      const s = await src.seek(firstStatus + src.startSeconds);
      this.first = (s.keyframe?.events ?? []).map((e) => ({ id: e.id, asset: e.asset }));
    }
    const page = await src.events(this.next, EVENT_TYPES);
    this.next = page.next;
    const start = src.startSeconds;
    for (const e of page.events) this.logged.push({ seq: e.seq, time: e.seconds - start, event: e.event });
    if (page.events.length) this.dirty = true;
    return page.events.length > 0;
  }
}

// --- the kit -----------------------------------------------------------------------------------------------------------------

/** What a module's build returns: its data and its hover text at `t` (within `tolerance` seconds, for ticks and spans). */
export interface Built {
  data: TrackData | undefined;
  tooltip?(t: number, tolerance: number): string | null;
}

/** A track as a factory declares it. */
export interface TrackSpec {
  /** Its row; a function when the label follows the data (the CPU window). */
  readonly track: Track | (() => Track);
  /** Turns what was read into the drawn data and the tooltip; called after a refresh that changed something it reads. */
  build(): Built;
  /** A read beyond the declared STATUS columns and EVENTs (single-flighted by its owner); the module rebuilds after each. */
  read?(): Promise<void>;
}

const kits = new WeakMap<ProfileSource, TrackKit>();

/** One open capture's reads, shared by every track (see the header). */
export class TrackKit {
  private readonly feed = new StatusFeed();
  private readonly declared = new Set<string>();
  private wantsStatus = false;
  private log: EventLog | null = null;
  /** The columns the feed holds; a declaration after reading began makes the next read start over. */
  private feedColumns = "";
  private seen: unknown = undefined;
  /** Bumped whenever a refresh found something new (samples, events, or a new summary: markers, names). */
  version = 0;
  /** Reads what the source gained since the last refresh (one `range` for the declared columns, one `events` page). */
  readonly refresh: () => Promise<void>;

  constructor(private readonly source: ProfileSource) {
    this.refresh = singleFlight(() => this.read(), () => this.source.summary);
  }

  /** The kit of `source`, made on first use. */
  static of(source: ProfileSource): TrackKit {
    let k = kits.get(source);
    if (!k) kits.set(source, (k = new TrackKit(source)));
    return k;
  }

  /** Declares the STATUS columns a track reads (none: only the sample times); returns the shared feed. */
  status(columns: readonly string[] = []): StatusFeed {
    this.wantsStatus = true;
    for (const c of columns) this.declared.add(c);
    return this.feed;
  }

  /** Declares that a track reads the EVENTs (and the STATUS times its spans sample on); returns the shared log. */
  events(): EventLog {
    this.status();
    return (this.log ??= new EventLog());
  }

  /**
   * A module over `spec` (see the header). A module that reads only the shared feed and log builds when it is asked for its
   * data or tooltip after the kit read something new (a sibling's refresh counts); one with its own `read` builds after it.
   */
  track(spec: TrackSpec): HoverTrackModule {
    let built: Built | null = null;
    let builtAt = -1;
    const kit = this;
    const current = (): Built | null => {
      if (!spec.read && builtAt !== kit.version) {
        built = spec.build();
        builtAt = kit.version;
      }
      return built;
    };
    const m: HoverTrackModule = {
      get track() {
        return typeof spec.track === "function" ? spec.track() : spec.track;
      },
      tolerance: DEFAULT_HOVER_TOLERANCE_S,
      data: () => current()?.data,
      async refresh() {
        await Promise.all([kit.refresh(), spec.read?.()]);
        if (spec.read) built = spec.build();
        else current();
      },
      tooltipAt: (t) => current()?.tooltip?.(t, m.tolerance) ?? null,
    };
    return m;
  }

  private async read(): Promise<void> {
    const src = this.source;
    let grew = false;
    if (src.summary !== this.seen) {
      this.seen = src.summary;
      grew = true;
    }
    if (this.wantsStatus) {
      const names = [...this.declared].sort();
      const key = names.join(",");
      if (key !== this.feedColumns) {
        this.feed.reset(names);
        this.feedColumns = key;
      }
      const n = this.feed.length;
      const from = n ? this.feed.times[n - 1]! : 0;
      if (this.feed.append(await statusColumns(src, names, from)) > 0) grew = true;
    }
    if (this.log && (await this.log.read(src, this.feed.length ? this.feed.times[0] : undefined))) grew = true;
    if (grew) this.version++;
  }
}
