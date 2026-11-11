// B3: the worker's stream decoder through the real handler and myco_audio_decode.wasm, on a fake port to the worklet:
// STREAM_OPEN then chunks that match a straight decode, the 32,768-frame credit window, buffers circulating with the
// credits, loops wrapping, STREAM_CLOSE, and errors naming the stream and its asset.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import hash from "../wasm/hash.json";
import { Kind, readStreamChunk, readStreamOpen, STREAM_CHUNK_FIXED_END, STREAM_CHUNK_FLAGS_LAST, STREAM_CHUNK_FLAGS_WRAPPED, STREAM_RING_FRAMES_WIDE, STREAM_WIDE_CHUNK_FRAMES, StreamConvention, writeEnvelope, writeStreamCredit } from "../wire.generated";
import { STREAM_CHUNK_FRAMES, STREAM_WINDOW_FRAMES } from "./credit";
import { createDecoderHandler } from "./handler";
import type { DecoderReply, StreamPortLike } from "./protocol";
import { STREAM_WIDE_CHUNK_BUFFER_BYTES } from "./streams";
import { makeWav, signal } from "./testWav";
import { DecoderWasm } from "./wasm";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const FIXTURES = fileURLToPath(new URL("../../../../../native/audio/crates/audio-decode/tests/fixtures/", import.meta.url));
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(FIXTURES + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function rig() {
  const replies: DecoderReply[] = [];
  const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  await vi.waitFor(() => expect(replies.some((r) => r.type === "ready")).toBe(true));
  replies.length = 0;
  const toWorklet: ArrayBuffer[] = [];
  const port: StreamPortLike = { onmessage: null, postMessage: (m) => void toWorklet.push(m as ArrayBuffer) };
  await handler.handle({ type: "connectWorklet", port });
  /** Sends a STREAM_CREDIT back with `buffers` (the credit written into the first). */
  const credit = (streamId: number, epoch: number, frames: number, buffers: ArrayBuffer[]) => {
    const head = buffers[0] ?? new ArrayBuffer(32);
    const view = new DataView(head);
    writeEnvelope(view, 0, { kind: Kind.STREAM_CREDIT, seq: 0, bodyBytes: 16 });
    writeStreamCredit(view, 0, { streamId, epoch, consumedFrames: frames, returnedBuffers: Math.max(0, buffers.length - 1) });
    port.onmessage?.({ data: buffers.length > 0 ? buffers : [head] });
  };
  return { handler, replies, toWorklet, credit };
}

const kindOf = (b: ArrayBuffer) => new DataView(b).getUint16(6, true);

/** Every frame of `chunks` (STREAM_CHUNK buffers) of a `ch`-channel stream, interleaved. */
function framesOf(chunks: ArrayBuffer[], ch: number): Float32Array {
  const parts = chunks.map((b) => {
    const c = readStreamChunk(new DataView(b), 0);
    return new Float32Array(b, STREAM_CHUNK_FIXED_END, c.frames * ch).slice();
  });
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("stream decoder (B3)", () => {
  it("opens, sends a window of chunks, and continues on credits until the last chunk; the frames match a straight decode", async () => {
    const { handler, replies, toWorklet, credit } = await rig();
    const frames = 100_000;
    const file = makeWav(frames, 2, 48_000, signal);
    await handler.handle({ type: "streamOpen", streamId: 5, asset: "music/a.wav", bytes: file.slice(0), hint: 1, startFrame: 0, epoch: 1 });
    expect(replies[0]).toMatchObject({ type: "streamOpened", streamId: 5, epoch: 1, info: { rate: 48_000, channels: 2, frames } });
    expect(kindOf(toWorklet[0]!)).toBe(Kind.STREAM_OPEN);
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ streamId: 5, channels: 2, sampleRate: 48_000, totalFrames: frames, epoch: 1, startFrame: 0, flags: 0 });
    const chunks = toWorklet.slice(1);
    expect(chunks.length).toBe(STREAM_WINDOW_FRAMES / STREAM_CHUNK_FRAMES);
    toWorklet.length = 0;
    // The worklet consumes and credits a chunk at a time, returning each buffer with its credit.
    const all = [...chunks];
    const isLast = (b: ArrayBuffer) => (readStreamChunk(new DataView(b), 0).flags & STREAM_CHUNK_FLAGS_LAST) !== 0;
    for (let k = 0; !isLast(all.at(-1)!) && k < 100; k++) {
      credit(5, 1, STREAM_CHUNK_FRAMES, [all[k]!.slice(0)]);
      all.push(...toWorklet.splice(0));
    }
    const last = readStreamChunk(new DataView(all.at(-1)!), 0);
    expect(last.flags & STREAM_CHUNK_FLAGS_LAST).toBeTruthy();
    const got = framesOf(all, 2);
    expect(got.length).toBe(frames * 2);
    for (let k = 0; k < frames; k += 997) {
      expect(got[2 * k]).toBe(signal(k, 0) / 32768);
      expect(got[2 * k + 1]).toBe(signal(k, 1) / 32768);
    }
    const seqs = all.map((b) => readStreamChunk(new DataView(b), 0).chunkSeq);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    await handler.handle({ type: "streamClose", streamId: 5 });
    expect(kindOf(toWorklet.at(-1)!)).toBe(Kind.STREAM_CLOSE);
    expect(replies.at(-1)).toEqual({ type: "streamClosed", streamId: 5 });
  });

  it("matches the decoder's own f32 output for a compressed file (MP3)", async () => {
    const { handler, toWorklet, credit } = await rig();
    await handler.handle({ type: "streamOpen", streamId: 1, asset: "t.mp3", bytes: fixture("tone-48000-stereo.mp3"), hint: 3, startFrame: 0, epoch: 1 });
    const chunks: ArrayBuffer[] = [];
    for (let guard = 0; guard < 200; guard++) {
      const fresh = toWorklet.splice(0).filter((b) => kindOf(b) === Kind.STREAM_CHUNK);
      chunks.push(...fresh);
      if (chunks.length && readStreamChunk(new DataView(chunks.at(-1)!), 0).flags & STREAM_CHUNK_FLAGS_LAST) break;
      credit(1, 1, STREAM_CHUNK_FRAMES * fresh.length, []);
    }
    const got = framesOf(chunks, 2);
    // A straight decode on a fresh instance.
    const w = await DecoderWasm.load(wasmBytes());
    const h = w.open(new Uint8Array(fixture("tone-48000-stereo.mp3")), 3);
    const scratch = w.alloc(4096 * 8);
    const want: number[] = [];
    for (;;) {
      const n = w.readF32(h, scratch, 4096);
      if (n === 0) break;
      want.push(...w.f32(scratch, n * 2));
    }
    expect(got.length).toBe(want.length);
    expect(Array.from(got)).toEqual(want);
  });

  it("a loop wraps inside a chunk and never sends a last chunk", async () => {
    const { handler, toWorklet, credit } = await rig();
    const frames = 5_000;
    const file = makeWav(frames, 2, 44_100, (k, c) => (k % 1000) * 10 + c);
    await handler.handle({ type: "streamOpen", streamId: 2, asset: "loop.wav", bytes: file, hint: 1, startFrame: 0, epoch: 1, loop: true });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ channels: 2, flags: 1, sampleRate: 44_100, convention: StreamConvention.AmbiX });
    credit(2, 1, 3 * STREAM_CHUNK_FRAMES, []);
    const chunks = toWorklet.filter((b) => kindOf(b) === Kind.STREAM_CHUNK);
    expect(chunks.length).toBe(11);
    const heads = chunks.map((b) => readStreamChunk(new DataView(b), 0));
    expect(heads.every((h) => h.frames === STREAM_CHUNK_FRAMES && (h.flags & STREAM_CHUNK_FLAGS_LAST) === 0)).toBe(true);
    expect(heads[1]!.flags & STREAM_CHUNK_FLAGS_WRAPPED).toBeTruthy(); // 5,000 frames: the second chunk wraps
    const got = framesOf(chunks, 2);
    for (let k = 0; k < got.length / 2; k += 61) {
      const src = k % frames;
      expect(got[2 * k]).toBe(((src % 1000) * 10) / 32768);
      expect(got[2 * k + 1]).toBe(((src % 1000) * 10 + 1) / 32768);
    }
  });

  it("B4: an ambisonic stream sends all 16 channels in 2,048-frame chunks within a 16,384-frame window, and loops", async () => {
    const { handler, replies, toWorklet, credit } = await rig();
    const frames = 5_000;
    const file = makeWav(frames, 16, 48_000, (k, c) => (k % 1000) * 16 + c);
    await handler.handle({ type: "streamOpen", streamId: 2, asset: "amb.wav", bytes: file, hint: 1, startFrame: 0, epoch: 1, loop: true, convention: "ambix" });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ channels: 16, flags: 1, convention: StreamConvention.AmbiX });
    expect(replies.find((r) => r.type === "streamOpened")).toMatchObject({ info: { channels: 16 } });
    expect((replies.find((r) => r.type === "streamOpened") as { info: { importGain?: number } }).info.importGain).toBeUndefined();
    let chunks = toWorklet.filter((b) => kindOf(b) === Kind.STREAM_CHUNK);
    expect(chunks.length).toBe(STREAM_RING_FRAMES_WIDE / STREAM_WIDE_CHUNK_FRAMES); // the window: 8 chunks
    expect(chunks.every((b) => b.byteLength === STREAM_WIDE_CHUNK_BUFFER_BYTES)).toBe(true);
    const heads = chunks.map((b) => readStreamChunk(new DataView(b), 0));
    expect(heads.every((h) => h.frames === STREAM_WIDE_CHUNK_FRAMES)).toBe(true);
    expect(heads[2]!.flags & STREAM_CHUNK_FLAGS_WRAPPED).toBeTruthy(); // 5,000 frames: the third chunk wraps
    const got = framesOf(chunks, 16);
    for (let k = 0; k < got.length / 16; k += 37) for (let c = 0; c < 16; c += 5) expect(got[16 * k + c]).toBe((((k % frames) % 1000) * 16 + c) / 32768);
    // A credit of 4,096 frames, with the emptied buffers: two more chunks, in those buffers.
    const before = handler.streamStats.allocated;
    toWorklet.length = 0;
    credit(2, 1, 4_096, chunks.slice(0, 2));
    chunks = toWorklet.filter((b) => kindOf(b) === Kind.STREAM_CHUNK);
    expect(chunks.length).toBe(2);
    expect(handler.streamStats.allocated).toBe(before);
  });

  it("B4: more than two channels need the ambisonic convention, and 4, 9 or 16 of them", async () => {
    const { handler, replies, toWorklet } = await rig();
    await handler.handle({ type: "streamOpen", streamId: 3, asset: "quad.wav", bytes: makeWav(3_000, 4, 48_000, signal), hint: 1, startFrame: 0, epoch: 1 });
    expect(replies.at(-1)).toMatchObject({ type: "error", streamId: 3, asset: "quad.wav", message: expect.stringMatching(/4-channel audio needs an ambisonic import setting/) });
    await handler.handle({ type: "streamOpen", streamId: 4, asset: "six.wav", bytes: makeWav(3_000, 6, 48_000, signal), hint: 1, startFrame: 0, epoch: 1, convention: "ambix" });
    expect(replies.at(-1)).toMatchObject({ type: "error", streamId: 4, message: expect.stringMatching(/6-channel audio isn't (supported|ambisonic)/) }); // the decoder refuses it at open
    expect(toWorklet.length).toBe(0);
    // A stereo file with a sidecar convention streams as stereo (the setting is ignored).
    await handler.handle({ type: "streamOpen", streamId: 5, asset: "st.wav", bytes: makeWav(3_000, 2, 48_000, signal), hint: 1, startFrame: 0, epoch: 1, convention: "fuma" });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ channels: 2, convention: StreamConvention.AmbiX });
  });

  it("B4: a FuMa stream is converted to AmbiX in every chunk, as the decoder converts a clip, and reports its import gain", async () => {
    for (const ch of [4, 9, 16]) {
      const { handler, replies, toWorklet, credit } = await rig();
      const frames = 9_000; // not a whole number of chunks; the stream runs to its end
      const file = makeWav(frames, ch, 48_000, signal);
      await handler.handle({ type: "streamOpen", streamId: 6, asset: "fuma.wav", bytes: file.slice(0), hint: 1, startFrame: 0, epoch: 1, convention: "fuma" });
      expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ channels: ch, convention: StreamConvention.FuMa });
      const chunks: ArrayBuffer[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const fresh = toWorklet.splice(0).filter((b) => kindOf(b) === Kind.STREAM_CHUNK);
        chunks.push(...fresh);
        if (chunks.length && readStreamChunk(new DataView(chunks.at(-1)!), 0).flags & STREAM_CHUNK_FLAGS_LAST) break;
        credit(6, 1, STREAM_WIDE_CHUNK_FRAMES * fresh.length, []);
      }
      const got = framesOf(chunks, ch);
      // The wasm's own converted read of the whole file, on a fresh instance.
      const w = await DecoderWasm.load(wasmBytes());
      const h = w.open(new Uint8Array(file), 1);
      const gain = w.setConvention(h, "fuma");
      const scratch = w.alloc(frames * ch * 4);
      const n = w.readF32(h, scratch, frames);
      const want = Array.from(w.f32(scratch, n * ch));
      expect(n).toBe(frames);
      expect(Array.from(got)).toEqual(want);
      // Converted: AmbiX of FuMa reorders the channels (FuMa's X, Y, Z → ACN's Y, Z, X) and rescales W.
      expect(Array.from(got).some((v, i) => v !== signal(Math.floor(i / ch), i % ch) / 32768)).toBe(true);
      expect(gain).not.toBe(1);
      expect(replies.find((r) => r.type === "streamOpened")).toMatchObject({ info: { channels: ch, importGain: gain } });
    }
  });

  it("starts at startFrame, and a seek restarts at a new epoch (B3b's hook)", async () => {
    const { handler, toWorklet } = await rig();
    const file = makeWav(50_000, 1, 48_000, (k) => k % 30_000);
    await handler.handle({ type: "streamOpen", streamId: 3, asset: "s.wav", bytes: file, hint: 1, startFrame: 20_000, epoch: 4 });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ startFrame: 20_000, epoch: 4 });
    expect(new Float32Array(toWorklet[1]!, STREAM_CHUNK_FIXED_END, 1)[0]).toBe(20_000 / 32768);
    toWorklet.length = 0;
    await handler.handle({ type: "streamSeek", streamId: 3, frame: 1_000, epoch: 5 });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ startFrame: 1_000, epoch: 5 });
    const c = readStreamChunk(new DataView(toWorklet[1]!), 0);
    expect(c.epoch).toBe(5);
    expect(new Float32Array(toWorklet[1]!, STREAM_CHUNK_FIXED_END, 1)[0]).toBe(1_000 / 32768);
  });

  it("a seek (B3b) wraps a loop's frame, ignores a stale epoch, restarts the credit window and drops old credits", async () => {
    const { handler, toWorklet, credit } = await rig();
    const file = makeWav(10_000, 1, 48_000, (k) => k % 30_000);
    await handler.handle({ type: "streamOpen", streamId: 5, asset: "l.wav", bytes: file, hint: 1, startFrame: 0, epoch: 1, loop: true });
    expect(toWorklet.length).toBeGreaterThan(1); // the open and a window of chunks
    toWorklet.length = 0;
    // A looping stream of 10,000 frames seeks to 25,000: frame 5,000 of the file.
    await handler.handle({ type: "streamSeek", streamId: 5, frame: 25_000, epoch: 2 });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ startFrame: 5_000, epoch: 2 });
    const chunks = toWorklet.slice(1);
    expect(chunks.length).toBe(STREAM_WINDOW_FRAMES / STREAM_CHUNK_FRAMES); // a whole new window, from empty
    expect(chunks.every((b) => readStreamChunk(new DataView(b), 0).epoch === 2)).toBe(true);
    expect(new Float32Array(chunks[0]!, STREAM_CHUNK_FIXED_END, 1)[0]).toBe(5_000 / 32768);
    // A seek whose epoch is not newer is stale: nothing is sent.
    toWorklet.length = 0;
    await handler.handle({ type: "streamSeek", streamId: 5, frame: 100, epoch: 2 });
    await handler.handle({ type: "streamSeek", streamId: 5, frame: 100, epoch: 1 });
    expect(toWorklet.length).toBe(0);
    // A credit tagged with the old epoch frees nothing; one with the new epoch does.
    credit(5, 1, 4 * STREAM_CHUNK_FRAMES, []);
    expect(toWorklet.length).toBe(0);
    credit(5, 2, STREAM_CHUNK_FRAMES, []);
    expect(toWorklet.length).toBe(1);
  });

  it("a seek past the end of a one-shot sends one empty last chunk of the new epoch; a seek back after the end plays again", async () => {
    const { handler, toWorklet } = await rig();
    const file = makeWav(6_000, 1, 48_000, (k) => k % 30_000);
    await handler.handle({ type: "streamOpen", streamId: 6, asset: "s.wav", bytes: file, hint: 1, startFrame: 0, epoch: 1 });
    const lastOf = (bufs: ArrayBuffer[]) => readStreamChunk(new DataView(bufs[bufs.length - 1]!), 0);
    expect(lastOf(toWorklet).flags & STREAM_CHUNK_FLAGS_LAST).toBe(STREAM_CHUNK_FLAGS_LAST); // the whole file fits the window
    toWorklet.length = 0;
    await handler.handle({ type: "streamSeek", streamId: 6, frame: 50_000, epoch: 2 });
    expect(readStreamOpen(new DataView(toWorklet[0]!), 0)).toMatchObject({ startFrame: 50_000, epoch: 2 });
    const empty = lastOf(toWorklet);
    expect(toWorklet.length).toBe(2);
    expect(empty).toMatchObject({ frames: 0, epoch: 2 });
    expect(empty.flags & STREAM_CHUNK_FLAGS_LAST).toBe(STREAM_CHUNK_FLAGS_LAST);
    // After the end, a seek back (the decoder reopens from the kept bytes) plays from there.
    toWorklet.length = 0;
    await handler.handle({ type: "streamSeek", streamId: 6, frame: 1_000, epoch: 3 });
    expect(new Float32Array(toWorklet[1]!, STREAM_CHUNK_FIXED_END, 1)[0]).toBe(1_000 / 32768);
    expect(lastOf(toWorklet)).toMatchObject({ epoch: 3, frames: 5_000 - STREAM_CHUNK_FRAMES });
  });

  it("a bad file fails with the stream's id and asset; a credit for another epoch sends nothing", async () => {
    const { handler, replies, toWorklet, credit } = await rig();
    await handler.handle({ type: "streamOpen", streamId: 8, asset: "bad.ogg", bytes: new Uint8Array(64).fill(7).buffer, hint: 4, startFrame: 0, epoch: 1 });
    expect(replies).toMatchObject([{ type: "error", streamId: 8, asset: "bad.ogg" }]);
    expect(toWorklet.length).toBe(0);
    await handler.handle({ type: "streamOpen", streamId: 9, asset: "a.wav", bytes: makeWav(80_000, 1, 48_000, signal), hint: 1, startFrame: 0, epoch: 2 });
    toWorklet.length = 0;
    credit(9, 1, 8 * STREAM_CHUNK_FRAMES, []);
    expect(toWorklet.length).toBe(0);
    credit(9, 2, STREAM_CHUNK_FRAMES, []);
    expect(toWorklet.length).toBe(1);
  });
});
