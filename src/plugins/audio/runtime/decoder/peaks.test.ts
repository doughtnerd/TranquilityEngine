// Ed1: `computePeaks` on the handler (real myco_audio_decode.wasm) and `DecoderClient.computePeaks` over an in-process worker.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDecoderClient, type WorkerLike } from "./decoderClient";
import { createDecoderHandler } from "./handler";
import { CLIP_CHUNK_FRAMES, type DecoderReply, type DecoderRequest, type PeaksMessage } from "./protocol";
import hash from "../wasm/hash.json";
import { makeWav, signal } from "./testWav";

const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;

async function harness(options: { yieldToEvents?: () => Promise<void> } = {}) {
  const replies: DecoderReply[] = [];
  const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash, ...options });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  return { handler, replies };
}

/** Brute-force base level of a signal: channel-major [min, max] per `binFrames` frames. */
function reference(frames: number, channels: number, binFrames: number, f: (k: number, c: number) => number): Int16Array {
  const bins = Math.ceil(frames / binFrames);
  const out = new Int16Array(channels * bins * 2);
  for (let c = 0; c < channels; c++) {
    for (let b = 0; b < bins; b++) {
      let lo = 32767;
      let hi = -32768;
      for (let k = b * binFrames; k < Math.min(frames, (b + 1) * binFrames); k++) {
        const v = f(k, c);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      out[(c * bins + b) * 2] = lo;
      out[(c * bins + b) * 2 + 1] = hi;
    }
  }
  return out;
}

async function peaksOf(frames: number, channels: number, binFrames: number): Promise<PeaksMessage> {
  const { handler, replies } = await harness();
  await handler.handle({ type: "computePeaks", id: 7, asset: "a.wav", bytes: makeWav(frames, channels, 44100, signal), hint: 1, binFrames });
  expect(replies.filter((r) => r.type !== "ready")).toHaveLength(1);
  const last = replies[replies.length - 1];
  if (last.type !== "peaks") throw new Error(`expected peaks, got ${JSON.stringify(last)}`);
  return last;
}

describe("computePeaks on the handler", () => {
  it("stereo, across chunk boundaries, with a partial last bin: equals the brute-force reduction", async () => {
    const frames = CLIP_CHUNK_FRAMES * 2 + 12345;
    const binFrames = 1000; // does not divide a chunk, so bins straddle chunks
    const msg = await peaksOf(frames, 2, binFrames);
    expect(msg).toMatchObject({ id: 7, rate: 44100, channels: 2, frames, binFrames, bins: Math.ceil(frames / binFrames) });
    const got = new Int16Array(msg.peaks);
    const want = reference(frames, 2, binFrames, signal);
    expect(got.length).toBe(want.length);
    expect(got).toEqual(want);
  });

  it("binFrames 256 on a mono clip shorter than a chunk", async () => {
    const msg = await peaksOf(1000, 1, 256);
    expect(msg.bins).toBe(4);
    expect(new Int16Array(msg.peaks)).toEqual(reference(1000, 1, 256, signal));
  });

  it("binFrames 1 gives each sample as its own min and max", async () => {
    const msg = await peaksOf(50, 1, 1);
    const got = new Int16Array(msg.peaks);
    expect(msg.bins).toBe(50);
    for (let k = 0; k < 50; k++) expect([got[k * 2], got[k * 2 + 1]]).toEqual([signal(k, 0), signal(k, 0)]);
  });

  it("an MP3 without a length header: bins follow the decoded frames", async () => {
    const { handler, replies } = await harness();
    const bytes = readFileSync(FIXTURES + "tone-48000-stereo-vbr-noxing.mp3");
    await handler.handle({ type: "computePeaks", id: 1, bytes: new Uint8Array(bytes).slice().buffer, hint: 3, binFrames: 256 });
    const last = replies[replies.length - 1];
    if (last.type !== "peaks") throw new Error("expected peaks");
    expect(last.channels).toBe(2);
    expect(last.bins).toBe(Math.ceil(last.frames / 256));
    expect(last.peaks.byteLength).toBe(2 * last.bins * 2 * 2);
  });

  it("a file that is not audio is answered by an error with the id and asset", async () => {
    const { handler, replies } = await harness();
    await handler.handle({ type: "computePeaks", id: 3, asset: "x.wav", bytes: new Uint8Array(64).buffer, hint: 1, binFrames: 256 });
    expect(replies[replies.length - 1]).toMatchObject({ type: "error", id: 3, asset: "x.wav" });
  });

  it("a cancel between chunks stops it: `cancelled`, no peaks", async () => {
    let hand: Awaited<ReturnType<typeof harness>>["handler"] | null = null;
    let first = true;
    const { handler, replies } = await harness({
      yieldToEvents: async () => {
        if (first) {
          first = false;
          await hand!.handle({ type: "cancel", id: 9 });
        }
      },
    });
    hand = handler;
    await handler.handle({ type: "computePeaks", id: 9, bytes: makeWav(CLIP_CHUNK_FRAMES * 3, 1, 44100, signal), hint: 1, binFrames: 256 });
    expect(replies[replies.length - 1]).toEqual({ type: "cancelled", id: 9 });
    expect(replies.some((r) => r.type === "peaks")).toBe(false);
  });

  it("before init it answers an error", async () => {
    const replies: DecoderReply[] = [];
    const handler = createDecoderHandler({ post: (r) => void replies.push(r) });
    await handler.handle({ type: "computePeaks", id: 2, bytes: new ArrayBuffer(8), hint: 0, binFrames: 256 });
    expect(replies[0]).toMatchObject({ type: "error", id: 2 });
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

describe("DecoderClient.computePeaks", () => {
  const make = () => {
    const posted: DecoderRequest[] = [];
    return { posted, client: createDecoderClient({ workerFactory: inProcessWorker(posted), wasmBytes: wasmBytes() }) };
  };

  it("resolves the base level as an Int16Array", async () => {
    const { client, posted } = make();
    const wavBytes = makeWav(5000, 2, 48000, signal);
    const p = await client.computePeaks(wavBytes, 1, 256, { asset: "s.wav" });
    expect(p).toMatchObject({ rate: 48000, channels: 2, frames: 5000, binFrames: 256, bins: 20 });
    expect(p.peaks).toBeInstanceOf(Int16Array);
    expect(p.peaks).toEqual(reference(5000, 2, 256, signal));
    expect(wavBytes.byteLength).toBeGreaterThan(0); // copied, not transferred, by default
    expect(posted.find((m) => m.type === "computePeaks")).toMatchObject({ asset: "s.wav", binFrames: 256, hint: 1 });
    client.dispose();
  });

  it("transfer: true detaches the caller's buffer", async () => {
    const { client } = make();
    const wavBytes = makeWav(1000, 1, 44100, signal);
    await client.computePeaks(wavBytes, 1, 256, { transfer: true });
    expect(wavBytes.byteLength).toBe(0);
    client.dispose();
  });

  it("rejects with the decoder's message for a bad file", async () => {
    const { client } = make();
    await expect(client.computePeaks(new Uint8Array(64), 1, 256)).rejects.toMatchObject({ name: "DecodeFailedError" });
    client.dispose();
  });

  it("an abort rejects with AbortError and posts a cancel", async () => {
    const { client, posted } = make();
    const ac = new AbortController();
    const pending = client.computePeaks(makeWav(CLIP_CHUNK_FRAMES * 2, 1, 44100, signal), 1, 256, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(posted.some((m) => m.type === "cancel")).toBe(true);
    client.dispose();
  });
});
