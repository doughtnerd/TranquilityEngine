// ADR 0171 amended by 0172 (M5a, task Rc5; api-and-models §5, §7; architecture §3.7, §7.3): the capture Worker. It
// opens a capture with the bounds-checked reader (progress, cancel), builds the time index, and answers `seek` and
// `range` (typed arrays transferred to main). One capture per Worker: a new `open` replaces the last (and cancels one
// still opening). The live view (R17, Rc6) opens a header plus META and takes sealed segments through `appendSegment`.
//
// The editor spawns it with `new Worker(new URL(".../capture/worker.ts", import.meta.url), { type: "module" })`
// (`editor/mix/profilerSource.ts`); Vite's worker pipeline bundles it as it does the decoder worker. All logic is in
// `createCaptureWorkerHandler`, so tests run it in process and on a `node:worker_threads` thread (`worker.test.ts`).
//
// Cancel: the open is async and awaits `pause` after each inflate chunk and every 4,096 records; `pause` yields a
// macrotask once `PAUSE_SLICE_MS` have passed since the last yield, so a `cancel` message runs between slices and the
// open ends with `cancelled`. `seek` and `range` are synchronous and short (one keyframe interval, or the span asked).
import {
  CaptureError, type CaptureErrorInfo, type CaptureWorkerRequest, type CaptureWorkerResponse,
} from "./format";
import {
  CaptureTimeIndex, openCapture, openLiveCapture, rangeCapture, seekCapture, summarizeCapture,
  type CaptureContents, type CaptureDecoder, type CaptureOpenSummary, type CaptureRangeColumns, type CaptureSeekState,
} from "./reader";

/** `range` with Rc5's bucket count (H3's request has none yet; omitted, the answer is one sample per STATUS). */
export type CaptureRangeRequest = Extract<CaptureWorkerRequest, { type: "range" }> & { buckets?: number };
/** Every request the Worker takes (H3's, with `range`'s buckets). */
export type CaptureRequest = Exclude<CaptureWorkerRequest, { type: "range" }> | CaptureRangeRequest;

/** H3's responses with Rc5's fuller payloads (each a subtype of H3's, so H3's `CaptureWorkerResponse` still describes them). */
export type CaptureResponse =
  | Exclude<CaptureWorkerResponse, { type: "opened" | "appended" | "snapshot" | "range" }>
  | { type: "opened"; id: number; summary: CaptureOpenSummary }
  | { type: "appended"; id: number; summary: CaptureOpenSummary }
  | { type: "snapshot"; id: number; snapshot: CaptureSeekState }
  | { type: "range"; id: number; t0: number; t1: number; columns: CaptureRangeColumns };

/** The longest the open runs between yields to the Worker's event loop. */
export const PAUSE_SLICE_MS = 8;

export interface CaptureWorkerHandlerOptions {
  /** Posts a response; `transfer` lists the buffers to move. */
  post(response: CaptureResponse, transfer: Transferable[]): void;
  /** Yields to the event loop (default: a `MessageChannel` round trip, never clamped like nested `setTimeout`). */
  yieldNow?(): Promise<void>;
  /** The clock for `PAUSE_SLICE_MS` (default `performance.now`). */
  now?(): number;
}

export interface CaptureWorkerHandler {
  handle(request: CaptureRequest): Promise<void>;
}

interface Session {
  contents: CaptureContents;
  index: CaptureTimeIndex;
  /** The live view's decoder (null for a file). */
  live: CaptureDecoder | null;
}

/** The structured-clone form of a refusal (any other throw is an internal error, posted as `badRecord` at -1). */
export function errorInfo(e: unknown): CaptureErrorInfo {
  if (e instanceof CaptureError) return { code: e.code, offset: e.offset, message: e.message };
  return { code: "badRecord", offset: -1, message: `internal error: ${e instanceof Error ? e.message : String(e)}` };
}

function defaultYield(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

export function createCaptureWorkerHandler(opts: CaptureWorkerHandlerOptions): CaptureWorkerHandler {
  const yieldNow = opts.yieldNow ?? defaultYield;
  const now = opts.now ?? (() => performance.now());
  let session: Session | null = null;
  /** The open in flight: its id and its abort flag. */
  let opening: { id: number; signal: { aborted: boolean } } | null = null;

  const post = (r: CaptureResponse, transfer: Transferable[] = []) => opts.post(r, transfer);
  const fail = (id: number, e: unknown) => post({ type: "error", id, error: errorInfo(e) });
  const need = (id: number): Session => {
    if (!session) throw new CaptureError("badValue", -1, opening ? "the capture is still opening" : "no capture is open");
    return session;
  };

  async function open(id: number, source: "file" | "live", bytes: ArrayBuffer): Promise<void> {
    if (opening) opening.signal.aborted = true;
    session = null;
    const mine = { id, signal: { aborted: false } };
    opening = mine;
    let last = now();
    const pause = async (): Promise<void> => {
      if (now() - last < PAUSE_SLICE_MS) return;
      await yieldNow();
      last = now();
    };
    try {
      const index = new CaptureTimeIndex();
      let contents: CaptureContents;
      let live: CaptureDecoder | null = null;
      if (source === "file") {
        contents = await openCapture(new Uint8Array(bytes), {
          signal: mine.signal, pause,
          onProgress: (phase, done, total) => post({ type: "progress", id, phase, done, total }),
        });
      } else {
        live = openLiveCapture(new Uint8Array(bytes));
        contents = live.contents;
      }
      if (mine.signal.aborted) throw new CaptureError("cancelled", -1, "the open was cancelled");
      index.extend(contents);
      if (opening !== mine) return;
      session = { contents, index, live };
      post({ type: "opened", id, summary: summarizeCapture(contents, index) });
    } catch (e) {
      if (e instanceof CaptureError && e.code === "cancelled") post({ type: "cancelled", id });
      else fail(id, e);
    } finally {
      if (opening === mine) opening = null;
    }
  }

  return {
    async handle(req) {
      switch (req.type) {
        case "open":
          return open(req.id, req.source, req.bytes);
        case "appendSegment": {
          try {
            const s = need(req.id);
            if (!s.live) throw new CaptureError("badValue", -1, "appendSegment on a file capture");
            try {
              s.live.appendRecords(new Uint8Array(req.bytes));
            } catch (e) {
              session = null; // the decoder is unusable after a refusal (reader.ts): the live view ends
              throw e;
            }
            s.index.extend(s.contents);
            post({ type: "appended", id: req.id, summary: summarizeCapture(s.contents, s.index) });
          } catch (e) {
            fail(req.id, e);
          }
          return;
        }
        case "seek":
          try {
            const s = need(req.id);
            post({ type: "snapshot", id: req.id, snapshot: seekCapture(s.contents, s.index, req.seconds) });
          } catch (e) {
            fail(req.id, e);
          }
          return;
        case "range":
          try {
            const s = need(req.id);
            const columns = rangeCapture(s.contents, s.index, req.t0, req.t1, req.columns, req.buckets);
            post({ type: "range", id: req.id, t0: req.t0, t1: req.t1, columns }, Object.values(columns).map((a) => a.buffer as ArrayBuffer));
          } catch (e) {
            fail(req.id, e);
          }
          return;
        case "cancel":
          if (opening && opening.id === req.id) opening.signal.aborted = true;
          return;
        case "close":
          if (opening) opening.signal.aborted = true;
          session = null;
          post({ type: "closed", id: req.id });
          return;
      }
    },
  };
}

/** What `bindCaptureWorker` needs of a Worker scope (a `DedicatedWorkerGlobalScope`, or a test's thread adapter). */
export interface CaptureWorkerScope {
  onmessage: ((e: { data: CaptureRequest }) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** Wires a handler to `scope`'s messages. */
export function bindCaptureWorker(scope: CaptureWorkerScope): CaptureWorkerHandler {
  const handler = createCaptureWorkerHandler({ post: (r, transfer) => scope.postMessage(r, transfer) });
  scope.onmessage = (e) => void handler.handle(e.data);
  return handler;
}

// The Worker entry: bind when this module runs as a Worker (never in the page or in a test importing it).
declare const WorkerGlobalScope: (abstract new () => unknown) | undefined;
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  bindCaptureWorker(globalThis as unknown as CaptureWorkerScope);
}
