// ADR 0171 amended by 0172 (M5a, task Pf7; api-and-models §7; architecture §2.1, §3.7): live follow. While the Profiler
// panel is open in Play it is an owner of the recorder ring: it joins, opens a live `CaptureSource` on the ring's head,
// forwards each sealed segment to the Worker in order, and tells the view at most once per 66 ms that the model moved.
// Closing the panel ends its hold only: with no take (no other owner) the host stops recording and frees the ring, with a
// take running the take keeps it. No Preact here (Pf4 mounts it); the recorder is reached through `LiveHost`, which Pf4
// builds over `Audio.capture` (the recorder stays a lazy chunk that only `capture/capture.ts` imports).
//
// The 66 ms is a UI cadence: the throttle is a window opened by the first change, closed by one update, driven by an
// injectable scheduler. Segments are never throttled; they go to the Worker the moment the recorder posts them.
import { CaptureError, type CaptureWorkerRequest } from "../../runtime/capture/format";
import { CaptureSource, type CaptureSourceOptions, type ProfileSource } from "./profilerSource";
import { followLiveViewport, type Viewport } from "./timelineModel";

/** The least time between two model updates, milliseconds (§7). */
export const LIVE_UPDATE_MS = 66;

/** What a joined owner holds: the recorder's live feed (`Recorder.startLive` / `stopLive` / `liveLost`) and its own hold. */
export interface LiveRecording {
  /** The ring's 96 B header plus raw META with no records (the saver's `head`, Rc4). */
  head(): Uint8Array;
  /** `Recorder.startLive`: posts `open`, the take's sealed segments, then each segment as it seals. */
  startLive(opts: { post(request: CaptureWorkerRequest, transfer: Transferable[]): void; head: Uint8Array; id: number }): void;
  stopLive(): void;
  /** A segment the ring evicted before it was posted ended the feed. */
  readonly liveLost: boolean;
  /** End this owner's hold (`Audio.capture.stop` semantics): the last owner's release stops the recording and frees the ring. */
  release(): void;
}

/** Joins the recorder as an owner (loads the chunk on the first owner, allocates or joins the ring). Rejects with a message if unavailable. */
export interface LiveHost {
  join(): Promise<LiveRecording>;
}

export interface LiveScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type LiveFollowState =
  /** Not following (never started, or stopped). */
  | "idle"
  /** Joining the recorder and opening the Worker's live view. */
  | "starting"
  | "following"
  /** The ring evicted a segment before it was posted: the view stopped growing (the recording itself goes on). */
  | "lost"
  /** The recorder could not be joined, or the Worker refused a segment; `error` says why. */
  | "error";

/** What the view renders from. A new object per update, so a view compares by identity. */
export interface LiveFollowModel {
  readonly state: LiveFollowState;
  /** The live source while one is open (state `starting` has none yet). */
  readonly source: ProfileSource | null;
  /** Seconds on the viewport axis covered so far. */
  readonly duration: number;
  /** Segments the Worker has taken. */
  readonly segments: number;
  readonly error: string | null;
}

export interface LiveFollowOptions {
  host: LiveHost;
  /** Called at most once per `LIVE_UPDATE_MS`, with the latest model. */
  onUpdate(model: LiveFollowModel): void;
  /** Default: the global timers. */
  scheduler?: LiveScheduler;
  /** Options for each live source, so a reopen gets a fresh Worker (tests; default: the capture Worker). */
  sourceOptions?(): CaptureSourceOptions;
  /** Updates a window waits for: default `LIVE_UPDATE_MS`. */
  intervalMs?: number;
}

const GLOBAL_SCHEDULER: LiveScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The live view's follower: `start()` when the panel opens in Play, `stop()` when it closes, `notify()` when the ring grew. */
export class LiveFollow {
  private readonly host: LiveHost;
  private readonly onUpdate: LiveFollowOptions["onUpdate"];
  private readonly scheduler: LiveScheduler;
  private readonly sourceOptions: () => CaptureSourceOptions;
  private readonly interval: number;

  private state: LiveFollowState = "idle";
  private error: string | null = null;
  private rec: LiveRecording | null = null;
  private src: CaptureSource | null = null;
  private segments = 0;
  /** Bumped by every start and stop: an await that finds a different value belongs to a run that ended. */
  private run = 0;
  private timer: unknown = null;
  private dirty = false;
  private abort: AbortController | null = null;

  constructor(opts: LiveFollowOptions) {
    this.host = opts.host;
    this.onUpdate = opts.onUpdate;
    this.scheduler = opts.scheduler ?? GLOBAL_SCHEDULER;
    this.sourceOptions = opts.sourceOptions ?? (() => ({}));
    this.interval = opts.intervalMs ?? LIVE_UPDATE_MS;
  }

  get current(): LiveFollowModel {
    return {
      state: this.state,
      source: this.src,
      duration: this.src && this.state !== "starting" ? this.src.duration : 0,
      segments: this.segments,
      error: this.error,
    };
  }

  /** The panel opened in Play: join the ring, open the live view, forward segments. A second call while running does nothing. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "error") return;
    this.releaseAll();
    const run = ++this.run;
    this.state = "starting";
    this.error = null;
    this.segments = 0;
    this.touch();
    let rec: LiveRecording | null = null;
    try {
      rec = await this.host.join();
      if (run !== this.run) {
        rec.release(); // the panel closed while the recorder loaded: it never owned the ring
        return;
      }
      this.rec = rec;
      const abort = (this.abort = new AbortController());
      const src = await CaptureSource.openLive(rec.head().slice().buffer as ArrayBuffer, { ...this.sourceOptions(), signal: abort.signal });
      if (run !== this.run) {
        src.close();
        return;
      }
      this.src = src;
      this.state = "following";
      // The recorder's `open` is answered by the source's own open above; its segments go through the source, in order.
      rec.startLive({ head: rec.head(), id: 0, post: (req, transfer) => this.forward(run, src, req, transfer) });
      this.touch();
    } catch (e) {
      if (run !== this.run) {
        // stop() already released what it knew of; a join that resolved late is released here.
        if (rec && rec !== this.rec) rec.release();
        return;
      }
      this.fail(e);
    }
  }

  /** The panel closed: end this owner's hold. With no take the recording stops and the ring is released; a running take keeps it. */
  stop(): void {
    const had = this.state !== "idle";
    this.run++;
    this.releaseAll();
    this.state = "idle";
    this.error = null;
    if (had) this.emit();
  }

  /** The ring grew (a STATUS block, a segment): the view is told at most once per window, however many calls come. */
  notify(): void {
    if (this.state === "idle") return;
    this.touch();
  }

  private forward(run: number, src: CaptureSource, req: CaptureWorkerRequest, transfer: Transferable[]): void {
    if (req.type !== "appendSegment") return; // `open` was done by `openLive`
    void transfer;
    src.appendSegment(req.bytes).then(
      () => {
        if (run !== this.run) return;
        this.segments++;
        this.syncLost();
        this.touch();
      },
      (e) => {
        if (run !== this.run) return;
        if (e instanceof CaptureError && e.code === "cancelled") return;
        this.fail(e);
      },
    );
  }

  private syncLost(): void {
    if (this.state === "following" && this.rec?.liveLost) this.state = "lost";
  }

  private fail(e: unknown): void {
    this.error = messageOf(e);
    this.state = "error";
    const rec = this.rec;
    this.rec = null;
    try {
      rec?.stopLive();
    } finally {
      rec?.release(); // an error ends the panel's hold too; start() may join again
      this.src?.close();
      this.src = null;
    }
    this.touch();
  }

  private releaseAll(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    const rec = this.rec;
    this.rec = null;
    try {
      rec?.stopLive();
    } finally {
      rec?.release();
      this.src?.close();
      this.src = null;
    }
  }

  /** Mark the model changed and open the update window if none is open. */
  private touch(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.syncLost();
      this.emit();
    }, this.interval);
  }

  private emit(): void {
    this.dirty = false;
    this.onUpdate(this.current);
  }
}

/** The viewport after an update: a following viewport stays on the live edge; any other is left where the user put it. */
export function viewportAfterUpdate(v: Viewport, model: LiveFollowModel): Viewport {
  return v.followLive ? followLiveViewport(v, model.duration) : v;
}
