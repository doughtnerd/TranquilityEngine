// ADR 0171 amended by 0172 (M5a, task Rc5; api-and-models §7 `profilerSource.ts`; architecture §3.7, C26): the
// profiler's data source. `ProfileSource` is what the timeline and the tables read: duration, `seek(t)`,
// `range(t0, t1, columns)`, markers, truncation. `CaptureSource` is the one implementation, over the capture Worker
// (`runtime/capture/worker.ts`), for files and for the live ring: a live view opens the ring's header plus META and the
// recorder appends each sealed segment every second (`appendSegment`, R17; Rc6 calls it, Pf1 owns this file from W5).
//
// Requests are matched to responses by id. Errors reject with a `CaptureError` (the Worker's `code`, `offset`,
// `message`); a cancelled open rejects with code `cancelled`. A Worker that dies rejects everything pending.
import { CaptureError, type CaptureErrorInfo } from "../../runtime/capture/format";
import { RANGE_SECONDS, type CaptureMarkerAt, type CaptureOpenSummary, type CaptureRangeColumns, type CaptureSeekState } from "../../runtime/capture/reader";
import type { CaptureRequest, CaptureResponse } from "../../runtime/capture/worker";

/** What the profiler reads, whatever the capture's origin. */
export interface ProfileSource {
  /** The open capture's summary (header, META, counts, markers, gaps, names, warnings). */
  readonly summary: CaptureOpenSummary;
  /** Seconds on the continuous axis from the first record to the last. */
  readonly duration: number;
  readonly markers: readonly CaptureMarkerAt[];
  /** The ring wrapped before the save: the capture starts at a keyframe, not at Play. */
  readonly truncated: boolean;
  /** Opened as a live view: it grows by `appendSegment` (`duration`, `markers` and `summary` follow), and a file never does. */
  readonly live: boolean;
  /** The Worker's axis seconds of the capture's first record: viewport time 0. `seek` and `range` take axis seconds (viewport time + this). */
  readonly startSeconds: number;
  /** The state at `t` seconds on the axis (clamped to the capture). */
  seek(t: number): Promise<CaptureSeekState>;
  /** STATUS columns over [t0, t1]; with `buckets`, min/max per bucket (`rangeCapture`). The arrays are transferred, so the caller owns them. */
  range(t0: number, t1: number, columns: readonly string[], buckets?: number): Promise<CaptureRangeColumns>;
  close(): void;
}

/** What `CaptureSource` needs of a Worker (a `Worker`, or a test's in-process or thread adapter). */
export interface CaptureWorkerLike {
  onmessage: ((e: { data: CaptureResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  postMessage(message: CaptureRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface CaptureSourceOptions {
  /** The Worker to use (default: a new module Worker on `capture/worker.ts`). */
  worker?: CaptureWorkerLike;
  /** Open progress: inflated bytes, then records scanned. */
  onProgress?(phase: "inflate" | "records", done: number, total: number): void;
  /** Aborting cancels the open (it rejects with code `cancelled`). */
  signal?: AbortSignal;
}

function spawnCaptureWorker(): CaptureWorkerLike {
  // Vite bundles the worker and what it imports (the worker pipeline, as for the decoder and navigation bake workers).
  return new Worker(new URL("../../runtime/capture/worker.ts", import.meta.url), { type: "module" }) as unknown as CaptureWorkerLike;
}

/** The Worker's refusal as a `CaptureError` on main (its message without the code prefix the constructor adds again). */
export function captureErrorFrom(info: CaptureErrorInfo): CaptureError {
  const prefix = `${info.code} at ${info.offset}: `;
  return new CaptureError(info.code, info.offset, info.message.startsWith(prefix) ? info.message.slice(prefix.length) : info.message);
}

interface Pending {
  resolve(r: CaptureResponse): void;
  reject(e: unknown): void;
  progress?: CaptureSourceOptions["onProgress"];
}

/** The capture Worker's client: one capture per source, one Worker per source. */
export class CaptureSource implements ProfileSource {
  private readonly worker: CaptureWorkerLike;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private current: CaptureOpenSummary | null = null;
  private closed = false;
  private isLive = false;

  private constructor(worker: CaptureWorkerLike) {
    this.worker = worker;
    worker.onmessage = (e) => this.receive(e.data);
    worker.onerror = (e) => this.die(e);
  }

  /** Opens a capture file. `bytes` is transferred to the Worker (detached here). */
  static async openFile(bytes: ArrayBuffer, opts: CaptureSourceOptions = {}): Promise<CaptureSource> {
    return CaptureSource.open("file", bytes, opts);
  }

  /** Opens a live view: `head` is the ring's 96 B header (stored, no records) plus raw META; then `appendSegment` per sealed segment. */
  static async openLive(head: ArrayBuffer, opts: CaptureSourceOptions = {}): Promise<CaptureSource> {
    return CaptureSource.open("live", head, opts);
  }

  private static async open(source: "file" | "live", bytes: ArrayBuffer, opts: CaptureSourceOptions): Promise<CaptureSource> {
    const s = new CaptureSource(opts.worker ?? spawnCaptureWorker());
    const id = s.nextId++;
    const onAbort = () => s.worker.postMessage({ type: "cancel", id }, []);
    if (opts.signal?.aborted) {
      s.close();
      throw new CaptureError("cancelled", -1, "the open was cancelled");
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await s.request({ type: "open", id, source, bytes }, [bytes], opts.onProgress);
      if (r.type !== "opened") throw new Error(`capture worker: unexpected ${r.type}`);
      s.current = r.summary;
      s.isLive = source === "live";
      return s;
    } catch (e) {
      s.close();
      throw e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  get summary(): CaptureOpenSummary {
    return this.current!;
  }

  get duration(): number {
    return this.current!.endSeconds - this.current!.startSeconds;
  }

  get markers(): readonly CaptureMarkerAt[] {
    return this.current!.markers;
  }

  get truncated(): boolean {
    return this.current!.truncated;
  }

  get live(): boolean {
    return this.isLive;
  }

  get startSeconds(): number {
    return this.current!.startSeconds;
  }

  async seek(t: number): Promise<CaptureSeekState> {
    const r = await this.request({ type: "seek", id: this.nextId++, seconds: t }, []);
    if (r.type !== "snapshot") throw new Error(`capture worker: unexpected ${r.type}`);
    return r.snapshot;
  }

  async range(t0: number, t1: number, columns: readonly string[], buckets?: number): Promise<CaptureRangeColumns> {
    const r = await this.request({ type: "range", id: this.nextId++, t0, t1, columns: [...columns], ...(buckets === undefined ? {} : { buckets }) }, []);
    if (r.type !== "range") throw new Error(`capture worker: unexpected ${r.type}`);
    return r.columns;
  }

  /** Live (R17; Rc6): one sealed segment of raw records, transferred. Resolves with the extended summary. A refused segment ends the live view (the Worker drops it). */
  async appendSegment(bytes: ArrayBuffer): Promise<CaptureOpenSummary> {
    const r = await this.request({ type: "appendSegment", id: this.nextId++, bytes }, [bytes]);
    if (r.type !== "appended") throw new Error(`capture worker: unexpected ${r.type}`);
    this.current = r.summary;
    return r.summary;
  }

  /** Ends the source: the Worker is terminated and anything pending rejects. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.rejectAll(new CaptureError("cancelled", -1, "the capture source was closed"));
  }

  private request(req: CaptureRequest, transfer: Transferable[], progress?: Pending["progress"]): Promise<CaptureResponse> {
    if (this.closed) return Promise.reject(new CaptureError("cancelled", -1, "the capture source is closed"));
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, progress });
      this.worker.postMessage(req, transfer);
    });
  }

  private receive(r: CaptureResponse): void {
    const p = this.pending.get(r.id);
    if (!p) return;
    if (r.type === "progress") {
      p.progress?.(r.phase, r.done, r.total);
      return;
    }
    this.pending.delete(r.id);
    if (r.type === "error") p.reject(captureErrorFrom(r.error));
    else if (r.type === "cancelled") p.reject(new CaptureError("cancelled", -1, "the open was cancelled"));
    else p.resolve(r);
  }

  private die(e: unknown): void {
    const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    this.closed = true;
    this.rejectAll(new Error(`capture worker failed: ${message}`));
  }

  private rejectAll(e: unknown): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }
}

/**
 * STATUS columns over viewport time [from, to] (seconds from the capture's first record; the whole capture by default),
 * raw (one sample per STATUS), with `seconds` rebased to the viewport axis. The models in `cpuTrack.ts` read this.
 */
export async function statusColumns(source: ProfileSource, columns: readonly string[], from = 0, to = source.duration): Promise<CaptureRangeColumns> {
  const o = source.startSeconds;
  const cols = await source.range(o + from, o + to, columns);
  if (o !== 0) {
    const s = cols[RANGE_SECONDS] as Float64Array;
    for (let i = 0; i < s.length; i++) s[i] = s[i]! - o;
  }
  return cols;
}
