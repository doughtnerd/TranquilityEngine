// ADR 0331: the spatial assets' preparation in the decoder worker: `prepareSpatial` on the handler (real
// myco_audio_decode.wasm) and `DecoderClient.prepareSpatial` over an in-process worker. The blobs' bytes are pinned in
// audio-decode's tests/spatial.rs; here the route, the replies and the failures.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDecoderClient, type WorkerLike } from "./decoderClient";
import { createDecoderHandler } from "./handler";
import type { DecoderReply, DecoderRequest } from "./protocol";
import { DecoderWasm } from "./wasm";
import hash from "../wasm/hash.json";

const read = (url: URL): ArrayBuffer => {
  const b = readFileSync(url);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const WASM = read(new URL("../wasm/myco_audio_decode.wasm", import.meta.url));
const HRIR = read(new URL("../wasm/myco_hrir.bin", import.meta.url));
const MAGLS = read(new URL("../../../../engine/audio/magls-o3.bin", import.meta.url));
const sha = (b: ArrayBuffer) => createHash("sha256").update(new Uint8Array(b)).digest("hex");

/** The pinned 48 kHz digests (tests/spatial.rs, recorded from the TypeScript preparation ADR 0331 retired). */
const HRIR_48K = "e3614308b75e174f53fdbcadb86ebbf76e46d9df8e247e42234035223522ff7c";
const MAGLS_48K = "72e6aac61d568b6a739e5d6534c7b44ed44d2defa077ca6ae6d4e5a0f9edfa8b";

describe("DecoderWasm.prepareHrir / prepareMagls", () => {
  it("give the pinned blobs and refuse a bad rate (ERR_ARG) and a bad layout (ERR_FORMAT)", async () => {
    const w = await DecoderWasm.load(WASM.slice(0));
    expect(sha(w.prepareHrir(new Uint8Array(HRIR), 48000).slice().buffer)).toBe(HRIR_48K);
    expect(sha(w.prepareMagls(new Uint8Array(MAGLS), 48000).slice().buffer)).toBe(MAGLS_48K);
    expect(() => w.prepareHrir(new Uint8Array(HRIR), 0)).toThrow(expect.objectContaining({ code: -2 }));
    expect(() => w.prepareMagls(new Uint8Array(HRIR), 48000)).toThrow(expect.objectContaining({ code: -3 }));
    expect(() => w.prepareHrir(new Uint8Array(0), 48000)).toThrow(expect.objectContaining({ code: -2 }));
  });
});

describe("the handler's prepareSpatial", () => {
  it("answers spatialPrepared with the blob, or spatialFailed with the decoder's code", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash });
    await handler.handle({ type: "init", wasmBytes: WASM.slice(0) });
    await handler.handle({ type: "prepareSpatial", id: 7, kind: "magls", bytes: MAGLS.slice(0), rate: 48000 });
    await handler.handle({ type: "prepareSpatial", id: 8, kind: "hrir", bytes: HRIR.slice(0), rate: Number.NaN });
    const ok = replies.find((r) => r.type === "spatialPrepared");
    expect(ok).toMatchObject({ id: 7 });
    expect(sha((ok as { bytes: ArrayBuffer }).bytes)).toBe(MAGLS_48K);
    expect(replies.find((r) => r.type === "spatialFailed")).toMatchObject({ id: 8, code: -2 });
  });

  it("fails a request before init", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r) });
    await handler.handle({ type: "prepareSpatial", id: 1, kind: "hrir", bytes: HRIR.slice(0), rate: 48000 });
    expect(replies).toEqual([expect.objectContaining({ type: "spatialFailed", id: 1, message: "audio decoder: not initialised" })]);
  });
});

function inProcessWorker(posted: DecoderRequest[]): () => WorkerLike {
  return () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message, transfer) {
        posted.push(message);
        void handler.handle(structuredClone(message, { transfer: transfer ?? [] }));
      },
      terminate() {},
    };
    const handler = createDecoderHandler({
      post: (reply, transfer) => {
        const cloned = structuredClone(reply, { transfer: transfer ?? [] });
        queueMicrotask(() => worker.onmessage?.({ data: cloned }));
      },
      expectedSourceHash: hash.sourceHash,
    });
    return worker;
  };
}

describe("DecoderClient.prepareSpatial", () => {
  it("resolves with the blob and leaves the caller's asset in place", async () => {
    const posted: DecoderRequest[] = [];
    const client = createDecoderClient({ workerFactory: inProcessWorker(posted), wasmBytes: WASM.slice(0) });
    const asset = HRIR.slice(0);
    expect(sha(await client.prepareSpatial("hrir", asset, 48000))).toBe(HRIR_48K);
    expect(asset.byteLength).toBe(HRIR.byteLength);
    expect(posted.find((m) => m.type === "prepareSpatial")).toMatchObject({ kind: "hrir", rate: 48000 });
    client.dispose();
  });

  it("rejects with DecodeFailedError and the decoder's code for a refused rate", async () => {
    const client = createDecoderClient({ workerFactory: inProcessWorker([]), wasmBytes: WASM.slice(0) });
    await expect(client.prepareSpatial("magls", MAGLS, -1)).rejects.toMatchObject({ name: "DecodeFailedError", code: -2 });
    client.dispose();
  });

  it("a worker crash fails the request with DecoderUnavailableError (not posted again)", async () => {
    const posted: DecoderRequest[] = [];
    const factory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(message) {
          posted.push(message);
          if (message.type === "prepareSpatial") queueMicrotask(() => worker.onerror?.({ message: "boom" }));
        },
        terminate() {},
      };
      return worker;
    };
    const client = createDecoderClient({ workerFactory: factory, wasmBytes: WASM.slice(0) });
    await expect(client.prepareSpatial("hrir", HRIR, 48000)).rejects.toMatchObject({ name: "DecoderUnavailableError" });
    expect(posted.filter((m) => m.type === "prepareSpatial")).toHaveLength(1);
    client.dispose();
  });
});
