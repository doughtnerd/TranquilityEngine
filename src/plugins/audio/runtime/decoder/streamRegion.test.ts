// ADR 0158 §4 (M2 E4.4): the worker loops a stream's region through its gapless-loop path, defaults to the file's own
// loop points, and changes or releases the loop at a stream frame, splicing the ring with a new epoch when it has
// already sent past that frame. The real handler and myco_audio_decode.wasm, on a fake port to the worklet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import hash from "../wasm/hash.json";
import { Kind, readStreamChunk, readStreamOpen, STREAM_CHUNK_FIXED_END, STREAM_CHUNK_FLAGS_LAST, STREAM_CHUNK_FLAGS_WRAPPED, STREAM_OPEN_FLAGS_LOOP, writeEnvelope, writeStreamCredit, type StreamOpen } from "../wire.generated";
import { STREAM_CHUNK_FRAMES, STREAM_WINDOW_FRAMES } from "./credit";
import { createDecoderHandler } from "./handler";
import type { DecoderReply, StreamPortLike } from "./protocol";
import { resolveRegion, type StreamLoopAt } from "./streams";
import { makeWav, signal } from "./testWav";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;
const RATE = 48_000;
const FRAMES = 100_000;
const want = (k: number) => signal(k, 0) / 32768;

/** A WAV of `FRAMES` frames of `signal`, with a trailing `smpl` chunk looping `start..end` (end exclusive) when given. */
function wav(loop?: { start: number; end: number }): ArrayBuffer {
  const base = new Uint8Array(makeWav(FRAMES, 2, RATE, signal));
  if (!loop) return base.buffer;
  const smpl = new Uint8Array(8 + 60);
  const dv = new DataView(smpl.buffer);
  smpl.set([0x73, 0x6d, 0x70, 0x6c]); // "smpl"
  dv.setUint32(4, 60, true);
  dv.setUint32(8 + 28, 1, true); // one loop
  dv.setUint32(8 + 36 + 8, loop.start, true);
  dv.setUint32(8 + 36 + 12, loop.end - 1, true); // inclusive
  const out = new Uint8Array(base.length + smpl.length);
  out.set(base);
  out.set(smpl, base.length);
  return out.buffer;
}

async function rig() {
  const replies: DecoderReply[] = [];
  const handler = createDecoderHandler({ post: (r) => void replies.push(r), expectedSourceHash: hash.sourceHash });
  await handler.handle({ type: "init", wasmBytes: wasmBytes() });
  await vi.waitFor(() => expect(replies.some((r) => r.type === "ready")).toBe(true));
  replies.length = 0;
  const toWorklet: ArrayBuffer[] = [];
  const port: StreamPortLike = { onmessage: null, postMessage: (m) => void toWorklet.push(m as ArrayBuffer) };
  await handler.handle({ type: "connectWorklet", port });
  const credit = (streamId: number, epoch: number, frames: number) => {
    const head = new ArrayBuffer(32);
    writeEnvelope(new DataView(head), 0, { kind: Kind.STREAM_CREDIT, seq: 0, bodyBytes: 16 });
    writeStreamCredit(new DataView(head), 0, { streamId, epoch, consumedFrames: frames, returnedBuffers: 0 });
    port.onmessage?.({ data: [head] });
  };
  /**
   * A worklet stand-in: takes what the worker posted into `ring` (stream frame → left sample), honouring STREAM_OPEN
   * restarts and splices as `stream.rs` does, and credits everything (as a voice that keeps up).
   */
  const ring = new Map<number, number>();
  const opens: StreamOpen[] = [];
  let epoch = 0;
  let next = 0;
  let last = false;
  const drain = () => {
    for (const b of toWorklet.splice(0)) {
      const view = new DataView(b);
      if (view.getUint16(6, true) === Kind.STREAM_OPEN) {
        const o = readStreamOpen(view, 0);
        opens.push(o);
        epoch = o.epoch;
        next = o.startFrame;
        last = false;
        for (const k of [...ring.keys()]) if (k >= next) ring.delete(k);
        continue;
      }
      if (view.getUint16(6, true) !== Kind.STREAM_CHUNK) continue;
      const c = readStreamChunk(view, 0);
      if (c.epoch !== epoch) continue;
      const pcm = new Float32Array(b, STREAM_CHUNK_FIXED_END, c.frames * 2);
      for (let f = 0; f < c.frames; f++) ring.set(next + f, pcm[2 * f]!);
      next += c.frames;
      if (c.flags & STREAM_CHUNK_FLAGS_LAST) last = true;
    }
  };
  /** Credits up to `frames` more, a chunk at a time, until the worker stops (or the stream ends). */
  const pull = (streamId: number, frames: number) => {
    drain();
    for (let n = 0; n < frames && !last; n += STREAM_CHUNK_FRAMES) {
      credit(streamId, epoch, STREAM_CHUNK_FRAMES);
      drain();
    }
  };
  return { handler, replies, toWorklet, ring, opens, pull, drain, credit, chunks: () => toWorklet, next: () => next, ended: () => last };
}

/** The file frame the ring's stream frame `k` should hold for a stream opened at 0 looping `start..end`. */
const looped = (k: number, start: number, end: number) => (k < end ? k : start + ((k - start) % (end - start)));

describe("stream region loops in the worker (E4.4)", () => {
  it("resolves a region: as sent, the file's points when none is sent, whole for empty or inverted", () => {
    expect(resolveRegion(100, 900, null, 1000)).toEqual({ start: 100, end: 900 });
    expect(resolveRegion(100, 0, null, 1000)).toEqual({ start: 100, end: 1000 });
    expect(resolveRegion(undefined, undefined, { start: 5, end: 50 }, 1000)).toEqual({ start: 5, end: 50 });
    expect(resolveRegion(undefined, undefined, null, 1000)).toEqual({ start: 0, end: 0 });
    expect(resolveRegion(800, 200, null, 1000)).toEqual({ start: 0, end: 1000 });
    expect(resolveRegion(100, 5000, null, 1000)).toEqual({ start: 100, end: 1000 });
  });

  it("wraps a region gaplessly: every frame continues the file or jumps from loopEnd - 1 to loopStart, inside chunks", async () => {
    const r = await rig();
    const [start, end] = [10_000, 23_000];
    await r.handler.handle({ type: "streamOpen", streamId: 3, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: start, loopEndFrame: end });
    r.pull(3, 120_000);
    expect(r.next()).toBeGreaterThan(5 * (end - start));
    for (let k = 0; k < r.next(); k++) if (r.ring.get(k) !== want(looped(k, start, end))) expect.fail(`stream frame ${k}: ${r.ring.get(k)} vs file frame ${looped(k, start, end)}`);
    // The seams fall inside chunks (13,000 frames don't divide 4,096) and are flagged; nothing is a last chunk.
    const opened = r.replies.find((m) => m.type === "streamOpened");
    expect(opened && "loopStartFrame" in opened.info).toBe(false);
    expect(r.ended()).toBe(false);
  });

  it("flags each chunk holding a seam as wrapped, and starts a looping stream inside its region", async () => {
    const r = await rig();
    await r.handler.handle({ type: "streamOpen", streamId: 4, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 50_000, epoch: 1, loop: true, loopStartFrame: 1_000, loopEndFrame: 9_000 });
    const chunks: ArrayBuffer[] = [];
    const flags: number[] = [];
    for (const b of r.chunks()) if (new DataView(b).getUint16(6, true) === Kind.STREAM_CHUNK) chunks.push(b);
    for (const b of chunks) flags.push(readStreamChunk(new DataView(b), 0).flags);
    r.drain();
    // Frame 50,000 is past the region: it wraps in (1,000 + 49,000 % 8,000 = 2,000).
    expect(r.ring.get(50_000)).toBe(want(2_000));
    expect(r.ring.get(50_000 + 7_000)).toBe(want(1_000)); // 9,000 reached after 7,000 frames
    expect(flags[0]! & STREAM_CHUNK_FLAGS_WRAPPED).toBe(0);
    expect(flags[1]! & STREAM_CHUNK_FLAGS_WRAPPED).toBeTruthy();
  });

  it("defaults to the file's own loop points (smpl), and reports them in streamOpened", async () => {
    const r = await rig();
    const [start, end] = [4_000, 15_000];
    await r.handler.handle({ type: "streamOpen", streamId: 5, asset: "a.wav", bytes: wav({ start, end }), hint: 1, startFrame: 0, epoch: 1, loop: true });
    expect(r.replies[0]).toMatchObject({ type: "streamOpened", info: { loopStartFrame: start, loopEndFrame: end, frames: FRAMES } });
    r.pull(5, 60_000);
    for (let k = 0; k < r.next(); k++) if (r.ring.get(k) !== want(looped(k, start, end))) expect.fail(`stream frame ${k}`);
    // 0/0 sent explicitly is the whole file, file points or not.
    const w = await rig();
    await w.handler.handle({ type: "streamOpen", streamId: 6, asset: "a.wav", bytes: wav({ start, end }), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: 0, loopEndFrame: 0 });
    w.pull(6, 120_000);
    for (let k = 0; k < w.next(); k += 7) if (w.ring.get(k) !== want(k % FRAMES)) expect.fail(`whole-file stream frame ${k}`);
  });

  it("a release at a seam already sent splices: a new epoch continues the ring there with the tail, to the end", async () => {
    const r = await rig();
    const [start, end] = [10_000, 20_000];
    await r.handler.handle({ type: "streamOpen", streamId: 7, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: start, loopEndFrame: end });
    r.drain();
    // 32,768 frames sent: seams at stream frames 20,000 and 30,000. The voice's pass ends at the first.
    expect(r.next()).toBe(STREAM_WINDOW_FRAMES);
    const release: StreamLoopAt = { type: "streamLoop", streamId: 7, looping: false, atStreamFrame: 20_000 };
    await r.handler.handle(release);
    r.drain();
    const splice = r.opens.at(-1)!;
    expect(splice).toMatchObject({ epoch: 2, startFrame: 20_000, loopStart: start, loopEnd: end, flags: 0 });
    r.pull(7, 200_000);
    expect(r.ended()).toBe(true);
    // Before the seam: the first pass; from it: the file from loopEnd on, to its end.
    for (let k = 0; k < r.next(); k++) {
      const file = k < 20_000 ? k : end + (k - 20_000);
      if (r.ring.get(k) !== want(file)) expect.fail(`stream frame ${k}: want file frame ${file}`);
    }
    expect(r.next()).toBe(20_000 + FRAMES - end);
  });

  it("a release at a seam not sent yet stops the wrap there, in the same epoch", async () => {
    const r = await rig();
    const [start, end] = [10_000, 60_000];
    await r.handler.handle({ type: "streamOpen", streamId: 8, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: start, loopEndFrame: end });
    r.drain();
    await r.handler.handle({ type: "streamLoop", streamId: 8, looping: false, atStreamFrame: 60_000 } as StreamLoopAt);
    r.pull(8, 200_000);
    expect(r.opens.length).toBe(1);
    expect(r.ended()).toBe(true);
    for (let k = 0; k < r.next(); k += 3) if (r.ring.get(k) !== want(k)) expect.fail(`stream frame ${k}`);
    expect(r.next()).toBe(FRAMES);
  });

  it("a release one pass later than the worker's next seam keeps wrapping until it", async () => {
    const r = await rig();
    const [start, end] = [10_000, 20_000];
    await r.handler.handle({ type: "streamOpen", streamId: 9, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: start, loopEndFrame: end });
    r.drain();
    await r.handler.handle({ type: "streamLoop", streamId: 9, looping: false, atStreamFrame: 50_000 } as StreamLoopAt);
    r.pull(9, 200_000);
    expect(r.ended()).toBe(true);
    for (let k = 0; k < r.next(); k++) {
      const file = k < 50_000 ? looped(k, start, end) : end + (k - 50_000);
      if (r.ring.get(k) !== want(file)) expect.fail(`stream frame ${k}: want file frame ${file}`);
    }
  });

  it("a region change at a frame already sent splices a looping epoch that jumps to the new start there", async () => {
    const r = await rig();
    await r.handler.handle({ type: "streamOpen", streamId: 10, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: 0, loopEndFrame: 0 });
    r.drain();
    // New region 2,000..12,000 from the start of the stream: its first seam is stream frame 12,000.
    await r.handler.handle({ type: "streamLoop", streamId: 10, looping: true, loopStartFrame: 2_000, loopEndFrame: 12_000, atStreamFrame: 12_000 } as StreamLoopAt);
    r.drain();
    expect(r.opens.at(-1)).toMatchObject({ epoch: 2, startFrame: 12_000, loopStart: 2_000, loopEnd: 12_000, flags: STREAM_OPEN_FLAGS_LOOP });
    r.pull(10, 80_000);
    for (let k = 0; k < r.next(); k++) if (r.ring.get(k) !== want(looped(k, 2_000, 12_000))) expect.fail(`stream frame ${k}`);
  });

  it("credits of the epoch before a splice still count; a seek afterwards drops the map and restarts", async () => {
    const r = await rig();
    await r.handler.handle({ type: "streamOpen", streamId: 11, asset: "a.wav", bytes: wav(), hint: 1, startFrame: 0, epoch: 1, loop: true, loopStartFrame: 1_000, loopEndFrame: 5_000 });
    r.drain();
    await r.handler.handle({ type: "streamLoop", streamId: 11, looping: false, atStreamFrame: 9_000 } as StreamLoopAt);
    r.drain();
    expect(r.opens.at(-1)!.epoch).toBe(2);
    const before = r.next();
    // An old-epoch credit (in flight across the splice) frees room as the new epoch's does.
    const sent = r.next();
    r.credit(11, 1, STREAM_CHUNK_FRAMES);
    r.drain();
    expect(r.next()).toBe(sent + STREAM_CHUNK_FRAMES);
    await r.handler.handle({ type: "streamSeek", streamId: 11, frame: 70_000, epoch: 4 });
    r.drain();
    expect(r.opens.at(-1)).toMatchObject({ epoch: 4, startFrame: 70_000, loopEnd: 0 });
    expect(r.ring.get(70_000)).toBe(want(70_000));
    expect(before).toBeGreaterThan(9_000);
  });
});
