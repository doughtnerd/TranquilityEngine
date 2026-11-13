// ADR 0171/0172 (Rc5; api-and-models §7 `profilerSource.ts`): `CaptureSource` over the capture Worker's handler run in
// process (messages delivered asynchronously, transfers detached as a Worker would). Open, summary, seek, range,
// progress, refusals as `CaptureError`, cancel through an `AbortSignal`, the live path, close and a dying Worker. The
// same client on a real `node:worker_threads` thread is `runtime/capture/worker.thread.test.ts`.
import { describe, expect, it } from "vitest";
import { CaptureError, assembleCapture, encodeRecords } from "../../runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META, longCapture, longCaptureRecords, sampleCapture } from "../../runtime/capture/testSupport";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { CaptureSource, captureErrorFrom, type CaptureWorkerLike } from "./profilerSource";

/** A Worker stand-in: each message runs the real handler on a later macrotask; transferred buffers are detached. */
function inProcessWorker(): CaptureWorkerLike & { requests: CaptureRequest[]; terminated: boolean } {
  const w: CaptureWorkerLike & { requests: CaptureRequest[]; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    requests: [],
    terminated: false,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      w.requests.push(copy);
      setTimeout(() => { if (!w.terminated) void handler.handle(copy); }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.terminated) w.onmessage?.({ data: copy }); }, 0);
    },
  });
  return w;
}

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

async function refusal(p: Promise<unknown>): Promise<CaptureError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CaptureError) return e;
    throw e;
  }
  throw new Error("expected a CaptureError");
}

describe("CaptureSource (files)", () => {
  it("opens a file, transferring its bytes, and exposes duration, markers and truncation", async () => {
    const worker = inProcessWorker();
    const bytes = buf(sampleCapture());
    const s = await CaptureSource.openFile(bytes, { worker });
    expect(bytes.byteLength).toBe(0); // transferred
    expect(s.summary.recordCount).toBe(16);
    expect(s.duration).toBeCloseTo(768 / 44_100 + 3.25, 12);
    expect(s.markers).toEqual([{ seq: 6, seconds: 1000 / 48_000, text: "owner joined ✓" }]);
    expect(s.truncated).toBe(false);
    expect(s.summary.names.clips).toEqual([[1, "jump.ogg"], [2, "land.ogg"]]);
    const snap = await s.seek(0.033);
    expect([snap.seq, snap.keyframeSeq, snap.status?.currentFrame]).toEqual([11, 2, 1536]);
    const raw = await s.range(0, 10, ["currentFrame"]);
    expect(Array.from(raw.currentFrame!)).toEqual([768, 1536, 768]);
    const b = await s.range(0, 10, ["currentFrame"], 2);
    expect(Array.from(b.count!)).toEqual([3, 0]);
    s.close();
    expect(worker.terminated).toBe(true);
    await expect(s.seek(0)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports progress while it opens a long capture", async () => {
    const phases = new Set<string>();
    let lastDone = 0;
    const s = await CaptureSource.openFile(buf(longCapture(120)), { worker: inProcessWorker(), onProgress: (phase, done) => { phases.add(phase); lastDone = done; } });
    expect([...phases]).toEqual(["records"]);
    expect(lastDone).toBeGreaterThan(0);
    expect(lastDone).toBeLessThanOrEqual(s.summary.recordCount);
    s.close();
  });

  it("rejects a refused file with the Worker's CaptureError (code, offset, message once)", async () => {
    const big = sampleCapture().slice();
    new DataView(big.buffer).setUint32(68, 0xffff_ffff, true);
    const worker = inProcessWorker();
    const e = await refusal(CaptureSource.openFile(buf(big), { worker }));
    expect([e.code, e.offset]).toEqual(["tooLarge", 68]);
    expect(e.message.startsWith("tooLarge at 68: ")).toBe(true);
    expect(e.message.indexOf("tooLarge at 68")).toBe(e.message.lastIndexOf("tooLarge at 68"));
    expect(worker.terminated).toBe(true);
  });

  it("captureErrorFrom keeps a message that has no prefix", () => {
    expect(captureErrorFrom({ code: "badValue", offset: -1, message: "plain" }).message).toBe("badValue at -1: plain");
  });

  it("an aborted signal cancels the open (before it starts, and mid-open)", async () => {
    const pre = new AbortController();
    pre.abort();
    expect((await refusal(CaptureSource.openFile(buf(sampleCapture()), { worker: inProcessWorker(), signal: pre.signal }))).code).toBe("cancelled");
    const ac = new AbortController();
    const worker = inProcessWorker();
    const p = CaptureSource.openFile(buf(longCapture(600)), { worker, signal: ac.signal, onProgress: () => ac.abort() });
    expect((await refusal(p)).code).toBe("cancelled");
    expect(worker.requests.map((r) => r.type)).toEqual(["open", "cancel"]);
    expect(worker.requests[1]).toEqual({ type: "cancel", id: worker.requests[0]!.id });
  });

  it("a Worker that dies rejects what is pending", async () => {
    const worker = inProcessWorker();
    const s = await CaptureSource.openFile(buf(sampleCapture()), { worker });
    const realPost = worker.postMessage;
    worker.postMessage = () => {}; // the request is lost with the Worker
    const p = s.seek(0);
    worker.onerror?.({ message: "boom" });
    await expect(p).rejects.toThrow("capture worker failed: boom");
    worker.postMessage = realPost;
    await expect(s.seek(0)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("CaptureSource (live, R17: Rc6 appends, Pf1 reads)", () => {
  it("opens a header plus META and grows by appended segments", async () => {
    const recs = longCaptureRecords(2);
    const s = await CaptureSource.openLive(buf(assembleCapture(SAMPLE_HEADER, SAMPLE_META, [])), { worker: inProcessWorker() });
    expect(s.duration).toBe(0);
    const half = Math.floor(recs.length / 2);
    const seg = buf(encodeRecords(recs.slice(0, half)));
    const a = await s.appendSegment(seg);
    expect(seg.byteLength).toBe(0); // transferred
    expect(a.recordCount).toBe(half);
    await s.appendSegment(buf(encodeRecords(recs.slice(half))));
    expect(s.summary.recordCount).toBe(recs.length);
    expect(s.duration).toBeGreaterThan(1.9);
    expect((await s.seek(1.5)).status?.currentFrame).toBe(768 * Math.floor((1.5 * 48_000) / 768));
    const bad = await refusal(s.appendSegment(buf(encodeRecords(recs.slice(0, 1)))));
    expect(bad.code).toBe("badSeq");
    s.close();
  });
});
