// Stream decode (K7, `streams.ts` half; B3; architecture §1, §2.3, §3.4): the decoder worker's streams. Main sends
// `streamOpen` (the encoded file, transferred), `streamSeek`, `streamClose` and, once, `connectWorklet` (the worker's
// end of a `MessageChannel` whose other end the host gave the worklet). The PCM goes over that port straight to the
// worklet as wire messages, never through main ("Main is never on a stream's PCM path"):
//
// - STREAM_OPEN (kind 5) when a stream opens (or restarts at a new epoch), then STREAM_CHUNKs (kind 6) of 4,096
//   interleaved f32 frames (fewer only in the last), tagged with the epoch; STREAM_CLOSE (kind 7) after `streamClose`.
// - The worker keeps `buffered + inFlight <= 32,768` frames per stream (`credit.ts`) and then idles, with no timers.
//   The worklet sends STREAM_CREDIT (kind 11) as its voice consumes, with the emptied chunk buffers in the message
//   (an array of ArrayBuffers, the credit in the first); they go back into a pool, so a stream allocates no buffer
//   per chunk once the first window has circulated.
// - A loop wraps to frame 0 inside a chunk (flagged `wrapped`), so the ring sees one continuous signal (B4 trims the
//   seam). More than 2 channels are downmixed to the first two.
// - Main hears `streamOpened` (the file's info) and `streamClosed`, and on a failure `{type:"error", streamId, asset,
//   message}` (architecture §7: main then stops the voice with a 50 ms fade and warns once). A failed stream sends no
//   more chunks; its voice starves until main stops it.
// - `streamSeek` (B3b) restarts the stream at a frame with a new, larger epoch: the decoder seeks (sample-accurately),
//   then a STREAM_OPEN of that epoch and chunks from there; the core restarts its ring on it (the SEEK record main sends
//   with the same epoch may restart it first) and drops the old epoch's chunks. A loop wraps the frame into the file;
//   a seek past the end of a one-shot sends one empty last chunk; credits of older epochs are ignored and the credit
//   window starts again.
//
// Streams decode on their own instance of the wasm (`DecoderWasm.fork`), so a clip decode that traps can't take them
// with it. Never throws: every failure becomes an `error` reply.
import {
  Kind,
  MAGIC,
  readStreamCredit,
  STREAM_CHUNK_FIXED_END,
  STREAM_CHUNK_FLAGS_LAST,
  STREAM_CHUNK_FLAGS_WRAPPED,
  STREAM_OPEN_FIXED_END,
  STREAM_OPEN_FLAGS_LOOP,
  STREAM_TOTAL_FRAMES_UNKNOWN,
  writeEnvelope,
  writeStreamChunk,
  writeStreamClose,
  writeStreamOpen,
} from "../wire.generated";
import { CreditWindow, STREAM_CHUNK_FRAMES } from "./credit";
import type { DecoderReply, StreamOpenMessage, StreamPortLike, StreamRequest, StreamSeekMessage } from "./protocol";
import { DecoderError, type DecoderWasm } from "./wasm";

export interface StreamHost {
  post(reply: DecoderReply, transfer?: Transferable[]): void;
  /** The loaded wasm (rejects when it failed to load), or null before `init`. Defaults to none (every open fails). */
  wasm?(): Promise<DecoderWasm> | null;
}

/** Bytes of a pooled chunk buffer: the envelope and header, then 4,096 stereo f32 frames. */
export const STREAM_CHUNK_BUFFER_BYTES = STREAM_CHUNK_FIXED_END + STREAM_CHUNK_FRAMES * 2 * 4;
/** Chunk buffers kept for reuse (two windows of one stream, or one each of two). */
const POOL_MAX = 16;
/** Channels a stream sends at most (the core's ring holds 2). */
const MAX_CHANNELS = 2;

interface Stream {
  readonly id: number;
  readonly asset: string;
  readonly handle: number;
  /** The file's channels, and what is sent (at most 2). */
  readonly fileChannels: number;
  readonly channels: number;
  readonly rate: number;
  /** -1 when unknown. */
  readonly frames: number;
  readonly loop: boolean;
  epoch: number;
  chunkSeq: number;
  readonly credit: CreditWindow;
  readonly scratch: number;
  readonly scratchBytes: number;
  /** The last chunk was sent. */
  done: boolean;
  failed: boolean;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The worker's streams (one per worker; `handler.ts` routes every `stream*` message and `connectWorklet` here). */
export class StreamDecoder {
  private port: StreamPortLike | null = null;
  private readonly streams = new Map<number, Stream>();
  /** Streams whose `streamOpen` is waiting for the wasm, and those of them closed meanwhile. */
  private readonly opening = new Set<number>();
  private readonly cancelled = new Set<number>();
  private readonly pool: ArrayBuffer[] = [];
  private decoder: DecoderWasm | null = null;
  /** The one fork every stream shares (opens that wait together must land on the same instance). */
  private forking: Promise<DecoderWasm> | null = null;
  private seq = 0;
  /** Chunks posted, buffers allocated (not from the pool), credits received: for tests. */
  readonly stats = { chunks: 0, allocated: 0, credits: 0 };

  constructor(private readonly host: StreamHost) {}

  /** Handles one request; resolves when it has been dealt with. */
  async handle(request: StreamRequest): Promise<void> {
    switch (request.type) {
      case "connectWorklet":
        this.connect(request.port);
        return;
      case "streamOpen":
        return this.open(request);
      case "streamCredit": {
        const s = this.streams.get(request.streamId);
        if (s) this.credit(s, s.epoch, request.frames);
        return;
      }
      case "streamSeek":
        this.seek(request);
        return;
      case "streamClose":
        this.close(request.streamId);
        return;
    }
  }

  /** Open streams (for tests). */
  get openCount(): number {
    return this.streams.size;
  }

  /** The port to the worklet; a new one replaces the old (whose streams main closes). */
  private connect(port: StreamPortLike): void {
    if (this.port) this.port.onmessage = null;
    this.port = port;
    port.onmessage = (event) => this.onPortMessage(event.data);
  }

  private async open(m: StreamOpenMessage): Promise<void> {
    const loading = this.host.wasm?.() ?? null;
    if (!loading) return this.fail(m.streamId, m.asset, new DecoderError("audio decoder: not initialised"));
    this.opening.add(m.streamId);
    let w: DecoderWasm;
    try {
      w = await (this.forking ??= loading.then((loaded) => loaded.fork()));
    } catch (e) {
      this.opening.delete(m.streamId);
      this.cancelled.delete(m.streamId);
      this.forking = null;
      return this.fail(m.streamId, m.asset, e instanceof DecoderError ? e : new DecoderError("audio decoder: failed to load"));
    }
    this.decoder = w;
    this.opening.delete(m.streamId);
    if (this.cancelled.delete(m.streamId)) {
      this.host.post({ type: "streamClosed", streamId: m.streamId });
      return;
    }
    if (this.streams.has(m.streamId)) this.drop(this.streams.get(m.streamId)!);
    if (!this.port) return this.fail(m.streamId, m.asset, new DecoderError("audio decoder: no worklet port for streams"));
    let handle = -1;
    let scratch = 0;
    let scratchBytes = 0;
    let stream: Stream;
    try {
      handle = w.open(new Uint8Array(m.bytes), m.hint);
      const raw = w.info(handle);
      if (raw.channels < 1 || raw.rate < 1) throw new DecoderError("audio decoder: the file reports no channels or rate");
      scratchBytes = STREAM_CHUNK_FRAMES * raw.channels * 4;
      scratch = w.alloc(scratchBytes);
      if (m.startFrame > 0) w.seek(handle, m.startFrame);
      stream = {
        id: m.streamId,
        asset: m.asset,
        handle,
        fileChannels: raw.channels,
        channels: Math.min(raw.channels, MAX_CHANNELS),
        rate: raw.rate,
        frames: raw.frames,
        loop: m.loop === true,
        epoch: m.epoch,
        chunkSeq: 0,
        credit: new CreditWindow(),
        scratch,
        scratchBytes,
        done: false,
        failed: false,
      };
      this.streams.set(m.streamId, stream);
      this.host.post({
        type: "streamOpened",
        streamId: m.streamId,
        epoch: m.epoch,
        info: { rate: raw.rate, channels: raw.channels, frames: raw.frames, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact },
      });
    } catch (e) {
      if (scratch !== 0) w.free(scratch, scratchBytes);
      if (handle >= 0) w.close(handle);
      return this.failed(m.streamId, m.asset, e);
    }
    this.postOpen(stream, m.startFrame);
    this.pump(stream);
  }

  /** STREAM_OPEN for `s`'s current epoch, starting at stream frame `startFrame`. */
  private postOpen(s: Stream, startFrame: number): void {
    const buffer = new ArrayBuffer(STREAM_OPEN_FIXED_END);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.STREAM_OPEN, seq: this.nextSeq(), bodyBytes: STREAM_OPEN_FIXED_END - 16 });
    writeStreamOpen(view, 0, {
      streamId: s.id,
      channels: s.channels,
      sampleRate: s.rate,
      totalFrames: s.frames >= 0 && s.frames < STREAM_TOTAL_FRAMES_UNKNOWN ? s.frames : STREAM_TOTAL_FRAMES_UNKNOWN,
      loopStart: 0,
      loopEnd: 0,
      flags: s.loop ? STREAM_OPEN_FLAGS_LOOP : 0,
      epoch: s.epoch,
      startFrame,
    });
    this.port?.postMessage(buffer, [buffer]);
  }

  /**
   * B3b: restart at `m.frame` with the new epoch `m.epoch` (the core restarts its ring on the STREAM_OPEN). A seek whose
   * epoch is not newer than the stream's is stale and ignored; for a looping stream of known length the frame wraps.
   */
  private seek(m: StreamSeekMessage): void {
    const s = this.streams.get(m.streamId);
    if (!s || !this.decoder || ((m.epoch - s.epoch) | 0) <= 0) return;
    const frame = s.loop && s.frames > 0 ? m.frame % s.frames : m.frame;
    try {
      this.decoder.seek(s.handle, frame);
    } catch (e) {
      return this.failStream(s, e);
    }
    s.epoch = m.epoch;
    s.chunkSeq = 0;
    s.done = false;
    s.failed = false;
    s.credit.reset();
    this.postOpen(s, frame);
    this.pump(s);
  }

  private close(id: number): void {
    const s = this.streams.get(id);
    if (s) this.drop(s);
    else if (this.opening.has(id)) {
      this.cancelled.add(id);
      return; // `open` answers once the wasm is in
    }
    const buffer = new ArrayBuffer(16 + 4);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.STREAM_CLOSE, seq: this.nextSeq(), bodyBytes: 4 });
    writeStreamClose(view, 0, { streamId: id });
    this.port?.postMessage(buffer, [buffer]);
    this.host.post({ type: "streamClosed", streamId: id });
  }

  /** Frees `s`'s decoder and scratch and forgets it. */
  private drop(s: Stream): void {
    this.streams.delete(s.id);
    const w = this.decoder;
    if (!w) return;
    w.free(s.scratch, s.scratchBytes);
    w.close(s.handle);
  }

  /** A message from the worklet: a STREAM_CREDIT, as an array of buffers (the credit first) or one buffer. */
  private onPortMessage(data: unknown): void {
    const buffers = Array.isArray(data) ? (data as unknown[]) : [data];
    let credit: { streamId: number; epoch: number; consumedFrames: number } | null = null;
    for (let k = 0; k < buffers.length; k++) {
      const b = buffers[k];
      if (!(b instanceof ArrayBuffer)) continue;
      if (k === 0 && b.byteLength >= 32) {
        const view = new DataView(b);
        if (view.getUint32(0, true) === MAGIC && view.getUint16(6, true) === Kind.STREAM_CREDIT) credit = readStreamCredit(view, 0);
      }
      if (b.byteLength >= STREAM_CHUNK_BUFFER_BYTES && this.pool.length < POOL_MAX) this.pool.push(b);
    }
    if (!credit) return;
    this.stats.credits++;
    const s = this.streams.get(credit.streamId);
    if (s) this.credit(s, credit.epoch, credit.consumedFrames);
  }

  private credit(s: Stream, epoch: number, frames: number): void {
    if (epoch !== s.epoch) return; // frames of an older epoch's ring
    s.credit.credit(frames);
    this.pump(s);
  }

  /** Sends chunks while the credit window has room for a whole one (see the header). */
  private pump(s: Stream): void {
    const w = this.decoder;
    const port = this.port;
    if (!w || !port || s.done || s.failed) return;
    const fc = s.fileChannels;
    try {
      while (s.credit.canSend(STREAM_CHUNK_FRAMES)) {
        let n = w.readF32(s.handle, s.scratch, STREAM_CHUNK_FRAMES);
        let flags = 0;
        if (n < STREAM_CHUNK_FRAMES && s.loop) {
          // Wrap to the start (more than once for a file shorter than a chunk); a file that gives nothing is broken.
          let empty = 0;
          while (n < STREAM_CHUNK_FRAMES) {
            w.seek(s.handle, 0);
            flags |= STREAM_CHUNK_FLAGS_WRAPPED;
            const m = w.readF32(s.handle, s.scratch + n * fc * 4, STREAM_CHUNK_FRAMES - n);
            if (m === 0 && ++empty > 1) throw new DecoderError("audio decoder: the looping stream holds no audio");
            n += m;
          }
        } else if (n < STREAM_CHUNK_FRAMES) {
          flags |= STREAM_CHUNK_FLAGS_LAST;
        }
        const buffer = this.take();
        const view = new DataView(buffer);
        const ch = s.channels;
        writeEnvelope(view, 0, { kind: Kind.STREAM_CHUNK, seq: this.nextSeq(), bodyBytes: STREAM_CHUNK_FIXED_END - 16 + n * ch * 4 });
        writeStreamChunk(view, 0, { streamId: s.id, chunkSeq: s.chunkSeq++ >>> 0, frames: n, flags, epoch: s.epoch });
        if (n > 0) {
          const src = w.f32(s.scratch, n * fc);
          const dst = new Float32Array(buffer, STREAM_CHUNK_FIXED_END, n * ch);
          if (fc === ch) dst.set(src);
          else for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++) dst[f * ch + c] = src[f * fc + c]!;
        }
        port.postMessage(buffer, [buffer]);
        this.stats.chunks++;
        s.credit.sent(n);
        if (flags & STREAM_CHUNK_FLAGS_LAST) {
          s.done = true;
          return;
        }
      }
    } catch (e) {
      this.failStream(s, e);
    }
  }

  /** A pooled chunk buffer, or a new one. */
  private take(): ArrayBuffer {
    const b = this.pool.pop();
    if (b) return b;
    this.stats.allocated++;
    return new ArrayBuffer(STREAM_CHUNK_BUFFER_BYTES);
  }

  private nextSeq(): number {
    const s = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return s;
  }

  /** A decode failure in an open stream: it sends nothing more. A trap resets the instance, failing every stream on it. */
  private failStream(s: Stream, e: unknown): void {
    if (!(e instanceof DecoderError) && this.decoder) {
      this.decoder.reset();
      const all = [...this.streams.values()];
      this.streams.clear();
      for (const other of all) {
        other.failed = true;
        if (other !== s) this.fail(other.id, other.asset, new DecoderError("audio decoder: the stream decoder was reset"));
      }
      return this.failed(s.id, s.asset, e);
    }
    s.failed = true;
    this.failed(s.id, s.asset, e);
  }

  private failed(id: number, asset: string, e: unknown): void {
    this.fail(id, asset, e instanceof DecoderError ? e : new DecoderError(describe(e)));
  }

  private fail(streamId: number, asset: string, e: DecoderError): void {
    this.host.post({ type: "error", streamId, asset, message: e.message, code: e.code !== 0 ? e.code : undefined });
  }
}
