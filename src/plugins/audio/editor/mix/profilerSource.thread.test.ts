// ADR 0171/0172 (Rc5; architecture §3.7, §7.3): the capture Worker on a real thread. `worker.ts` is bundled with
// esbuild-wasm (as `npm run export` bundles scripts) and run on a `node:worker_threads` Worker behind a small scope
// adapter; the editor's `CaptureSource` drives it as it drives the browser Worker. Real structured clone and real
// transfers between threads: the open's bytes and `range`'s arrays move, a deflate bomb is refused on the thread, and a
// cancel sent while the thread is opening lands between its slices. Times are logged, never asserted (design targets).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureSource, type CaptureWorkerLike } from "./profilerSource";
import { CAPTURE_FLAG_COMPRESSED, CAPTURE_HEADER_BYTES, CaptureError } from "../../runtime/capture/format";
import { longCapture, sampleCapture } from "../../runtime/capture/testSupport";
import type { CaptureResponse } from "../../runtime/capture/worker";

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
}

const ENTRY = `
import { parentPort } from "node:worker_threads";
import { bindCaptureWorker } from ${JSON.stringify(fileURLToPath(new URL("../../runtime/capture/worker.ts", import.meta.url)))};
let listener = null;
parentPort.on("message", (data) => listener?.({ data }));
bindCaptureWorker({
  set onmessage(f) { listener = f; },
  get onmessage() { return listener; },
  postMessage: (m, t) => parentPort.postMessage(m, t),
});
`;

let dir = "";
let script = "";

beforeAll(async () => {
  const mod = (await import("esbuild-wasm")) as unknown as EsbuildLike & { default?: EsbuildLike };
  const esbuild = mod.default ?? mod;
  const out = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("../../runtime/capture/", import.meta.url)), loader: "ts", sourcefile: "thread-entry.ts" },
    bundle: true, format: "esm", platform: "node", target: "node20", write: false,
  });
  dir = mkdtempSync(join(tmpdir(), "rc5-capture-worker-"));
  script = join(dir, "worker.mjs");
  writeFileSync(script, out.outputFiles[0]!.text);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A `node:worker_threads` Worker as `CaptureSource` sees a browser Worker. */
function threadWorker(): CaptureWorkerLike {
  const w = new Worker(script);
  const like: CaptureWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m, t) => w.postMessage(m, t as never),
    terminate: () => void w.terminate(),
  };
  w.on("message", (data: CaptureResponse) => like.onmessage?.({ data }));
  w.on("error", (e) => like.onerror?.(e));
  return like;
}

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

function compress(file: Uint8Array): Uint8Array {
  const z = deflateRawSync(file.subarray(CAPTURE_HEADER_BYTES));
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + z.byteLength);
  out.set(file.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(z, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(10, v.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  return "none";
}

// Every assertion here is on work done (records scanned, keyframes counted, bytes transferred, error codes); the times
// are only logged. The timeout is the harness's patience for a real thread decoding a 10-minute capture on a busy
// machine (about 2.4 s alone, over the 5 s default under load), not a performance bound.
describe("the capture Worker on a worker_threads thread", { timeout: 120_000 }, () => {
  it("opens the 10-minute capture, seeks and returns transferred ranges (times logged)", async () => {
    const file = compress(longCapture(600));
    const bytes = buf(file);
    let t = performance.now();
    const s = await CaptureSource.openFile(bytes, { worker: threadWorker() });
    const openMs = performance.now() - t;
    expect(bytes.byteLength).toBe(0);
    expect(s.summary.keyframeCount).toBe(601);
    const seeks: number[] = [];
    for (let i = 0; i < 50; i++) {
      const at = (i * 599.3) / 50 + 0.4;
      t = performance.now();
      const snap = await s.seek(at);
      seeks.push(performance.now() - t);
      expect(snap.recordsScanned).toBeLessThanOrEqual(2 * 96 + 2);
      expect(snap.status!.currentFrame / 48_000).toBeLessThanOrEqual(at);
      expect(snap.status!.currentFrame / 48_000).toBeGreaterThan(at - 768 / 48_000);
    }
    const r = await s.range(0, 600, ["loadPermille", "underruns"], 600);
    expect(r["loadPermille.max"]).toBeInstanceOf(Float64Array);
    expect(r["loadPermille.max"]!.length).toBe(600);
    expect(Array.from(r.count!).reduce((a, b) => a + b, 0)).toBe(s.summary.statusCount);
    seeks.sort((a, b) => a - b);
    console.log(`[Rc5] on a thread: open ${openMs.toFixed(0)} ms (compressed 10-minute capture, round trip); seek round trip p50 ${seeks[25]!.toFixed(2)} ms, max ${seeks[49]!.toFixed(2)} ms`);
    s.close();
  });

  it("refuses a deflate bomb on the thread", async () => {
    const plain = sampleCapture({ index: false });
    const bomb = deflateRawSync(new Uint8Array(32 * 1024 * 1024));
    const file = new Uint8Array(CAPTURE_HEADER_BYTES + bomb.byteLength);
    file.set(compress(plain).subarray(0, CAPTURE_HEADER_BYTES));
    file.set(bomb, CAPTURE_HEADER_BYTES);
    expect(await codeOf(CaptureSource.openFile(buf(file), { worker: threadWorker() }))).toBe("inflateOverrun");
  });

  it("a cancel sent while the thread opens lands between its slices", async () => {
    const ac = new AbortController();
    const p = CaptureSource.openFile(buf(longCapture(600)), { worker: threadWorker(), signal: ac.signal, onProgress: (phase) => { if (phase === "records") ac.abort(); } });
    expect(await codeOf(p)).toBe("cancelled");
  });
});
