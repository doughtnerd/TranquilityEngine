// ADR 0171 amended by 0172 (M5a, task Rc5; api-and-models §5, §7; architecture §3.7, §7.3): the capture Worker. It
// opens a capture with the bounds-checked reader (progress, cancel), builds the time index, and answers `seek` and
// `range` (typed arrays transferred to main), and (Pf6) the loudness series: `loudnessInfo`, `loudnessSeries`, `loudnessAt`,
// `loudnessMarks`, answered from a `LoudnessTrackModel` built on the first loudness request by walking the records once (a
// live view extends it from the last record read). One capture per Worker: a new `open` replaces the last (and cancels one
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
  CaptureError, EpochReason, EventKind, RecordType, decodeKeyframe,
  type CaptureErrorInfo, type CaptureLoudnessColumns, type CaptureWorkerRequest, type CaptureWorkerResponse,
} from "./format";
import {
  CaptureTimeIndex, decodeRecordAt, openCapture, openLiveCapture, rangeCapture, recordSeconds, seekCapture, summarizeCapture,
  type CaptureContents, type CaptureDecoder, type CaptureOpenSummary, type CaptureRangeColumns, type CaptureSeekState,
} from "./reader";
import { LoudnessTrackModel, type LoudnessControl } from "../mix/loudnessTrackModel";
import { LOUD_OUTPUT_TAP, readStatus } from "../wire.generated";

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
  /** The loudness series, built on the first loudness request and extended from `next` as a live view grows. */
  loud: LoudnessBuild | null;
}

/** Pf6: the loudness model and how far through the records it has read. */
interface LoudnessBuild {
  model: LoudnessTrackModel;
  next: number;
  /** The newest STATUS or KEYFRAME time, as `CaptureTimeIndex`'s clamped key, so the model's times rise as the index's do. */
  lastKey: number;
}

/** The `NO_NAME` of `events.ts` (a loudnessControl EVENT without a bus: every meter). */
const NO_NAME = 0xffffffff;
const LOUDNESS_RESET = 1;
const LOUDNESS_PAUSE = 2;
const LOUDNESS_RESUME = 3;

/**
 * Pf6: feeds `s.loud.model` the records after the last one read, in order: STATUS (its `loudBuses` and `loudEnergies`
 * through the shared `LoudnessStats`), KEYFRAME (the metered readings), EPOCH (not the first), and loudnessControl EVENTs.
 * A capture the ring truncated starts mid-run, so its model is in "seek" mode (I and LRA held at the keyframes' readings);
 * a whole capture replays from its first record and reads the live meter's values bit for bit.
 */
function loudnessOf(s: Session): LoudnessTrackModel {
  const c = s.contents;
  const L = (s.loud ??= { model: new LoudnessTrackModel(c.truncated ? "seek" : "replay"), next: 0, lastKey: -Infinity });
  const t = c.records;
  let slotOfName: Map<string, number> | null = null;
  for (let i = L.next; i < t.count; i++) {
    switch (t.type[i]) {
      case RecordType.STATUS: {
        const time = (L.lastKey = Math.max(L.lastKey, recordSeconds(c, i)));
        const d = decodeRecordAt(c, i);
        if (d.kind !== "status") break;
        const st = readStatus(d.payload);
        L.model.feed({ time, loudShed: st.loudShed, loudBuses: st.loudBuses, loudEnergies: st.loudEnergies });
        break;
      }
      case RecordType.KEYFRAME: {
        const time = (L.lastKey = Math.max(L.lastKey, recordSeconds(c, i)));
        const d = decodeRecordAt(c, i);
        if (d.kind !== "keyframe") break;
        const p = d.payload;
        const kf = decodeKeyframe(new DataView(p.buffer, p.byteOffset, p.byteLength), 0, p.byteLength);
        if (kf.metered.length > 0) L.model.addKeyframe(time, kf.metered);
        break;
      }
      case RecordType.EPOCH: {
        const d = decodeRecordAt(c, i);
        if (d.kind === "epoch" && d.payload.reason !== EpochReason.start) L.model.epoch(recordSeconds(c, i));
        break;
      }
      case RecordType.EVENT: {
        const d = decodeRecordAt(c, i);
        if (d.kind !== "event" || d.payload.kind !== EventKind.loudnessControl) break;
        const reason = d.payload.reason;
        const what: LoudnessControl | null =
          reason === LOUDNESS_RESET ? { kind: "reset" } : reason === LOUDNESS_PAUSE ? { kind: "pause" } : reason === LOUDNESS_RESUME ? { kind: "resume" } : null;
        if (!what) break; // reason 4 (the target changed) alters no meter
        const id = d.payload.args[0] ?? NO_NAME;
        let slot: number | undefined;
        if (id !== NO_NAME) {
          // The bus arrives as a name in the parameters table; the buses table maps slot to name. A name no slot carries is the root (the final-output tap).
          const name = c.names.parameters.get(id);
          if (slotOfName === null) slotOfName = new Map([...c.names.buses].map(([k, v]) => [v, k]));
          slot = name === undefined ? undefined : (slotOfName.get(name) ?? LOUD_OUTPUT_TAP);
          if (slot !== undefined && slot !== LOUD_OUTPUT_TAP && !L.model.bus(slot)) slot = LOUD_OUTPUT_TAP;
        }
        L.model.control(Math.max(L.lastKey, recordSeconds(c, i)), what, slot);
        break;
      }
    }
  }
  L.next = t.count;
  return L.model;
}

/** A bus's samples in [t0, t1] as transferable columns. */
function seriesColumns(model: LoudnessTrackModel, slot: number, t0: number, t1: number): CaptureLoudnessColumns {
  const bus = model.bus(slot);
  const time = bus?.time ?? [];
  let lo = 0;
  let hi = time.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (time[m]! < t0) lo = m + 1; else hi = m; }
  const from = lo;
  hi = time.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (time[m]! <= t1) lo = m + 1; else hi = m; }
  const to = lo;
  const f = (a: readonly number[] | undefined) => Float64Array.from((a ?? []).slice(from, to));
  return {
    time: f(bus?.time), momentary: f(bus?.momentary), shortTerm: f(bus?.shortTerm), integrated: f(bus?.integrated), lra: f(bus?.lra),
    truePeak: f(bus?.truePeak), peak: f(bus?.peak), incomplete: Uint8Array.from((bus?.incomplete ?? []).slice(from, to)),
  };
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
      session = { contents, index, live, loud: null };
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
        case "loudnessInfo":
          try {
            const m = loudnessOf(need(req.id));
            post({ type: "loudnessInfo", id: req.id, mode: m.mode, buses: m.slots().map((slot) => ({ slot, samples: m.bus(slot)!.time.length })) });
          } catch (e) {
            fail(req.id, e);
          }
          return;
        case "loudnessSeries":
          try {
            const m = loudnessOf(need(req.id));
            const t0 = req.t0 ?? -Infinity;
            const t1 = req.t1 ?? Infinity;
            if (!(t1 >= t0) || !Number.isInteger(req.slot)) throw new CaptureError("badValue", -1, `loudnessSeries slot ${req.slot} over [${t0}, ${t1}]`);
            const columns = seriesColumns(m, req.slot, t0, t1);
            const gaps = (m.bus(req.slot)?.gaps ?? []).filter((g) => g.to >= t0 && g.from <= t1).map((g) => ({ ...g }));
            post({ type: "loudnessSeries", id: req.id, slot: req.slot, columns, gaps }, Object.values(columns).map((a) => a.buffer as ArrayBuffer));
          } catch (e) {
            fail(req.id, e);
          }
          return;
        case "loudnessAt":
          try {
            const m = loudnessOf(need(req.id));
            if (!Number.isFinite(req.t)) throw new CaptureError("badValue", -1, `loudnessAt ${req.t}`);
            const slots = req.slot === undefined ? m.slots() : [req.slot];
            post({ type: "loudnessAt", id: req.id, t: req.t, buses: slots.map((slot) => ({ slot, values: m.valuesAt(slot, req.t) })) });
          } catch (e) {
            fail(req.id, e);
          }
          return;
        case "loudnessMarks":
          try {
            const m = loudnessOf(need(req.id));
            const { target } = req;
            if (![target.integrated, target.tolerance, target.truePeak].every(Number.isFinite)) throw new CaptureError("badValue", -1, "loudnessMarks: a non-finite target");
            post({
              type: "loudnessMarks", id: req.id,
              marks: m.targetMarks(target, { ...(req.metrics ? { metrics: req.metrics } : {}), ...(req.truePeak === undefined ? {} : { truePeak: req.truePeak }) }),
            });
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
