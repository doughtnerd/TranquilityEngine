// Stream decode (K7, `streams.ts` half; B3; architecture §1, §2.3, §3.4): the decoder worker's streams. Main sends
// `streamOpen` (the encoded file, transferred), `streamSeek`, `streamClose` and, once, `connectWorklet` (the worker's
// end of a `MessageChannel` whose other end the host gave the worklet). The PCM goes over that port straight to the
// worklet as wire messages, never through main ("Main is never on a stream's PCM path"):
//
// - STREAM_OPEN (kind 5) when a stream opens (or restarts at a new epoch), then STREAM_CHUNKs (kind 6) of 4,096
//   interleaved f32 frames (fewer only in the last), tagged with the epoch; STREAM_CLOSE (kind 7) after `streamClose`.
// - The worker keeps `buffered + inFlight <= 32,768` frames per stream (`credit.ts`) and then idles, with no timers.
// - **Wide streams** (ADR 0162 B4, §4.6, R16): an ambisonic file of 4, 9 or 16 channels streams all of them into a wide
//   ring of the core: chunks of `STREAM_WIDE_CHUNK_FRAMES` (2,048 frames, 128 KB at 16 channels) within a window of
//   `STREAM_RING_FRAMES_WIDE` (16,384). `streamOpen.convention` (the sidecar's) is required for more than 2 channels
//   (without it the stream fails: "multichannel mixes aren't supported"); "fuma" converts each read to AmbiX in the wasm
//   (B2's `set_convention`), scaled into headroom by the import gain `streamOpened`'s info reports (as a clip's does),
//   and STREAM_OPEN carries the file's convention.
//   The worklet sends STREAM_CREDIT (kind 11) as its voice consumes, with the emptied chunk buffers in the message
//   (an array of ArrayBuffers, the credit in the first); they go back into a pool, so a stream allocates no buffer
//   per chunk once the first window has circulated.
// - A loop wraps to frame 0 inside a chunk (flagged `wrapped`), so the ring sees one continuous signal (B4 trims the
//   seam).
// - Main hears `streamOpened` (the file's info) and `streamClosed`, and on a failure `{type:"error", streamId, asset,
//   message}` (architecture §7: main then stops the voice with a 50 ms fade and warns once). A failed stream sends no
//   more chunks; its voice starves until main stops it.
// - `streamSeek` (B3b) restarts the stream at a frame with a new, larger epoch: the decoder seeks (sample-accurately),
//   then a STREAM_OPEN of that epoch and chunks from there; the core restarts its ring on it (the SEEK record main sends
//   with the same epoch may restart it first) and drops the old epoch's chunks. A loop wraps the frame into the file;
//   a seek past the end of a one-shot sends one empty last chunk; credits of older epochs are ignored and the credit
//   window starts again.
//
// - **Region loops and their release** (ADR 0158 §4, M2 E4.4). A looping stream loops `loopStartFrame..loopEndFrame`
//   of `streamOpen` (end exclusive; 0 = the file's end; both absent: the file's own loop points from the wasm's info,
//   else the whole file): the worker reads up to `loopEnd`, seeks to `loopStart` and reads on, inside one chunk, so the
//   ring sees one continuous signal (the gapless path whole-file loops always took). `streamOpened` carries the file's
//   own points. `streamLoop` changes the region or releases the loop (`looping: false`: no more wraps, the stream
//   plays on to the file's end) **at a stream frame**: main names the frame where the voice's current pass ends
//   (`StreamLoopAt.atStreamFrame`, its prediction from the voice's playhead), and the worker acts there. The worker
//   runs up to a ring (32,768 frames) ahead of the voice, so that frame may be behind what it already sent: it then
//   **splices** (see `stream.rs`): a new epoch (the stream's next, which main reserved when it sent the message) whose
//   STREAM_OPEN has `startFrame` = that stream frame and `loopEnd` set, and the core keeps its ring up to that frame and
//   takes the new epoch from there, gapless. Without a frame the change applies where the worker is decoding (a release
//   then lands up to a ring late).
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
  STREAM_MAX_CHANNELS,
  STREAM_RING_FRAMES_WIDE,
  STREAM_WIDE_CHUNK_FRAMES,
  StreamConvention,
  STREAM_TOTAL_FRAMES_UNKNOWN,
  writeEnvelope,
  writeStreamChunk,
  writeStreamClose,
  writeStreamOpen,
} from "../wire.generated";
import { CreditWindow, STREAM_CHUNK_FRAMES, STREAM_WINDOW_FRAMES } from "./credit";
import type { AmbisonicConvention, ClipInfo, DecoderReply, StreamLoopMessage, StreamOpenMessage, StreamPortLike, StreamRequest, StreamSeekMessage } from "./protocol";
import { DecoderError, type DecoderWasm, type RawInfo } from "./wasm";

/** E4.4: kept as an alias; `atStreamFrame` is now part of `StreamLoopMessage` (contract C2). */
export type StreamLoopAt = StreamLoopMessage;

/** A loop region in file frames, `end` exclusive (0: the file's end). */
export interface StreamRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * The region a looping stream loops (E4.4): `start`/`end` as sent (end 0 = the file's end; both absent: the file's own
 * points, `fileLoop`, else the whole file), clamped to a file of `frames` frames (-1 unknown). An empty or inverted
 * region loops the whole file, as the core does for clips.
 */
export function resolveRegion(start: number | undefined, end: number | undefined, fileLoop: StreamRegion | null, frames: number): StreamRegion {
  if (start === undefined && end === undefined) return fileLoop ?? { start: 0, end: 0 };
  let a = Math.max(0, Math.floor(start ?? 0));
  let b = Math.max(0, Math.floor(end ?? 0));
  if (frames > 0 && (b === 0 || b > frames)) b = frames;
  if (b !== 0 && !(a < b)) {
    a = 0;
    b = frames > 0 ? frames : 0;
  }
  return { start: a, end: b };
}

/** The file's own loop region from the wasm's info, or null. */
function fileLoopOf(raw: RawInfo): StreamRegion | null {
  return raw.loopStartFrame !== undefined && raw.loopEndFrame !== undefined && raw.loopEndFrame > raw.loopStartFrame ? { start: raw.loopStartFrame, end: raw.loopEndFrame } : null;
}

/** Where a looping stream is after `frame` frames (file frames, never wrapped) in `region` of a `frames`-frame file. */
function wrapInto(frame: number, region: StreamRegion, frames: number): number {
  const end = region.end > 0 ? region.end : frames;
  if (!(end > 0) || frame < end) return frame;
  return region.start + ((frame - region.start) % (end - region.start));
}

export interface StreamHost {
  post(reply: DecoderReply, transfer?: Transferable[]): void;
  /** The loaded wasm (rejects when it failed to load), or null before `init`. Defaults to none (every open fails). */
  wasm?(): Promise<DecoderWasm> | null;
}

/** Bytes of a pooled chunk buffer: the envelope and header, then 4,096 stereo f32 frames. */
export const STREAM_CHUNK_BUFFER_BYTES = STREAM_CHUNK_FIXED_END + STREAM_CHUNK_FRAMES * 2 * 4;
/** B4: bytes of a pooled wide chunk buffer: the envelope and header, then 2,048 frames of 16 channels. */
export const STREAM_WIDE_CHUNK_BUFFER_BYTES = STREAM_CHUNK_FIXED_END + STREAM_WIDE_CHUNK_FRAMES * STREAM_MAX_CHANNELS * 4;
/** Chunk buffers kept for reuse per size (two windows of one stream, or one each of two). */
const POOL_MAX = 16;

/** B4: a stream's ring class: 1-2 channels narrow, 4, 9 or 16 wide (the core's `stream.rs` classes). */
interface StreamClass {
  readonly chunkFrames: number;
  readonly window: number;
  readonly bufferBytes: number;
}
const NARROW: StreamClass = { chunkFrames: STREAM_CHUNK_FRAMES, window: STREAM_WINDOW_FRAMES, bufferBytes: STREAM_CHUNK_BUFFER_BYTES };
const WIDE: StreamClass = { chunkFrames: STREAM_WIDE_CHUNK_FRAMES, window: STREAM_RING_FRAMES_WIDE, bufferBytes: STREAM_WIDE_CHUNK_BUFFER_BYTES };

/**
 * B4 (ADR 0162 §2.4, §4.6): the ring class for a file of `channels` channels, or why it can't stream. More than 2
 * channels need the sidecar's ambisonic convention and 4, 9 or 16 channels (order 1, 2 or 3).
 */
export function streamClassFor(channels: number, convention: AmbisonicConvention | undefined): StreamClass | string {
  if (channels <= 2) return NARROW;
  if (!convention) return `audio decoder: ${channels}-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported`;
  if (channels !== 4 && channels !== 9 && channels !== 16) return `audio decoder: ${channels}-channel audio isn't ambisonic: first, second and third order need 4, 9 or 16 channels`;
  return WIDE;
}

interface Stream {
  readonly id: number;
  readonly asset: string;
  readonly handle: number;
  /** The file's channels, all of them sent (B4: 1-2 narrow, 4, 9 or 16 wide). */
  readonly fileChannels: number;
  readonly channels: number;
  /** B4: its ring class (chunk frames, credit window, pooled buffer size). */
  readonly cls: StreamClass;
  /** B4: the file's convention as STREAM_OPEN states it (the PCM sent is AmbiX either way). */
  readonly convention: number;
  readonly rate: number;
  /** -1 when unknown. */
  readonly frames: number;
  /** The file's own loop points (wasm info), or null. */
  readonly fileLoop: StreamRegion | null;
  /** E4.4: looping, and the region (end 0: the file's end). */
  loop: boolean;
  region: StreamRegion;
  /** The stream frame of this epoch's first ring frame (the `startFrame` its ring started from), the ring frames sent since, and the file frame the next read gives. */
  base: number;
  sent: number;
  pos: number;
  /** Where the stream jumped (a wrap, a seek, a splice): stream frame to file frame, oldest first, kept a few windows back. */
  readonly marks: { stream: number; file: number }[];
  /** E4.4: a loop change waiting for its stream frame. */
  pending: { at: number; looping: boolean; region: StreamRegion } | null;
  /** The epoch before the last splice: its credits still count (the ring is the same). */
  prevEpoch: number;
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
  /** Chunk buffers for reuse, by size (narrow, wide). */
  private readonly pool = new Map<number, ArrayBuffer[]>([
    [STREAM_CHUNK_BUFFER_BYTES, []],
    [STREAM_WIDE_CHUNK_BUFFER_BYTES, []],
  ]);
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
      case "streamLoop":
        this.changeLoop(request);
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
    let info: ClipInfo;
    try {
      handle = w.open(new Uint8Array(m.bytes), m.hint);
      const raw = w.info(handle);
      if (raw.channels < 1 || raw.rate < 1) throw new DecoderError("audio decoder: the file reports no channels or rate");
      const cls = streamClassFor(raw.channels, m.convention);
      if (typeof cls === "string") throw new DecoderError(cls);
      // ADR 0162 §2.4 (B2): FuMa is converted in each read (so per chunk), scaled down by the import gain main applies.
      const importGain = cls === WIDE && m.convention === "fuma" ? w.setConvention(handle, "fuma") : 1;
      scratchBytes = cls.chunkFrames * raw.channels * 4;
      scratch = w.alloc(scratchBytes);
      const fileLoop = fileLoopOf(raw);
      const loop = m.loop === true;
      const region = resolveRegion(m.loopStartFrame, m.loopEndFrame, fileLoop, raw.frames);
      const start = loop ? wrapInto(Math.max(0, m.startFrame), region, raw.frames) : Math.max(0, m.startFrame);
      if (start > 0) w.seek(handle, start);
      stream = {
        id: m.streamId,
        asset: m.asset,
        handle,
        fileChannels: raw.channels,
        channels: raw.channels,
        cls,
        convention: cls === WIDE && m.convention === "fuma" ? StreamConvention.FuMa : StreamConvention.AmbiX,
        rate: raw.rate,
        frames: raw.frames,
        fileLoop,
        loop,
        region,
        base: m.startFrame,
        sent: 0,
        pos: start,
        marks: [{ stream: m.startFrame, file: start }],
        pending: null,
        prevEpoch: m.epoch,
        epoch: m.epoch,
        chunkSeq: 0,
        credit: new CreditWindow(cls.window),
        scratch,
        scratchBytes,
        done: false,
        failed: false,
      };
      this.streams.set(m.streamId, stream);
      info = importGain !== 1 ? { ...infoOf(raw), importGain } : infoOf(raw);
    } catch (e) {
      if (scratch !== 0) w.free(scratch, scratchBytes);
      if (handle >= 0) w.close(handle);
      return this.failed(m.streamId, m.asset, e);
    }
    // STREAM_OPEN first: main may answer `streamOpened` with a `streamLoop` at once (E4.4), which may send chunks.
    this.postOpen(stream, m.startFrame);
    this.host.post({ type: "streamOpened", streamId: m.streamId, epoch: m.epoch, info });
    this.pump(stream);
  }

  /**
   * STREAM_OPEN for `s`'s current epoch, starting at stream frame `startFrame`. `splice` (E4.4, `stream.rs`): the epoch
   * continues the ring there, and `loopStart`/`loopEnd` (never 0) name the region it loops from there, or the one it left.
   */
  private postOpen(s: Stream, startFrame: number, splice: StreamRegion | null = null): void {
    const buffer = new ArrayBuffer(STREAM_OPEN_FIXED_END);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.STREAM_OPEN, seq: this.nextSeq(), bodyBytes: STREAM_OPEN_FIXED_END - 16 });
    writeStreamOpen(view, 0, {
      streamId: s.id,
      channels: s.channels,
      sampleRate: s.rate,
      totalFrames: s.frames >= 0 && s.frames < STREAM_TOTAL_FRAMES_UNKNOWN ? s.frames : STREAM_TOTAL_FRAMES_UNKNOWN,
      loopStart: splice ? splice.start : 0,
      loopEnd: splice ? splice.end || (s.frames > 0 ? s.frames : 0xfffffffe) : 0,
      flags: s.loop ? STREAM_OPEN_FLAGS_LOOP : 0,
      epoch: s.epoch,
      startFrame,
      convention: s.convention,
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
    // A loop change still waiting for its frame applies now (that frame was on the old timeline).
    if (s.pending) {
      s.loop = s.pending.looping;
      if (s.pending.looping) s.region = s.pending.region;
      s.pending = null;
    }
    const frame = s.loop ? wrapInto(Math.max(0, m.frame), s.region, s.frames) : Math.max(0, m.frame);
    try {
      this.decoder.seek(s.handle, frame);
    } catch (e) {
      return this.failStream(s, e);
    }
    s.base = frame;
    s.sent = 0;
    s.pos = frame;
    s.marks.length = 0;
    s.marks.push({ stream: frame, file: frame });
    s.epoch = m.epoch;
    s.prevEpoch = m.epoch;
    s.chunkSeq = 0;
    s.done = false;
    s.failed = false;
    s.credit.reset();
    this.postOpen(s, frame);
    this.pump(s);
  }

  /**
   * E4.4: a `streamLoop` (see the header): a new region (`looping`) or a release, at `atStreamFrame` (or where the
   * worker is decoding). A frame not sent yet waits for the pump to reach it; one already sent is spliced.
   */
  private changeLoop(m: StreamLoopAt): void {
    const s = this.streams.get(m.streamId);
    if (!s || s.failed || !this.decoder) return;
    const region = m.looping ? resolveRegion(m.loopStartFrame, m.loopEndFrame, s.fileLoop, s.frames) : s.region;
    const next = s.base + s.sent;
    let at = m.atStreamFrame !== undefined && Number.isFinite(m.atStreamFrame) ? Math.floor(m.atStreamFrame) : next;
    // Before this epoch's first frame the ring can't take it: where the worker is.
    if (at <= s.base && next > s.base) at = next;
    if (at >= next) {
      s.pending = { at, looping: m.looping, region };
      this.pump(s);
      return;
    }
    // Already sent: splice at `at`.
    const left = s.region;
    try {
      const lin = this.fileAt(s, at - 1) + 1;
      this.decoder.seek(s.handle, lin);
      s.pos = lin;
      while (s.marks.length > 1 && s.marks[s.marks.length - 1]!.stream >= at) s.marks.pop();
      s.marks.push({ stream: at, file: lin });
      s.credit.credit(next - at); // those frames are dropped from the ring
      s.sent = at - s.base;
      s.pending = null;
      this.apply(s, m.looping, region, at);
    } catch (e) {
      return this.failStream(s, e);
    }
    s.prevEpoch = s.epoch;
    s.epoch = (s.epoch + 1) >>> 0;
    s.chunkSeq = 0;
    s.done = false;
    this.postOpen(s, at, m.looping ? s.region : left);
    this.pump(s);
  }

  /** A loop change lands at stream frame `at` (the next frame read): a release stops wrapping; a region jumps to its start unless the stream is inside it. */
  private apply(s: Stream, looping: boolean, region: StreamRegion, at: number): void {
    s.loop = looping;
    if (!looping) return;
    s.region = region;
    const end = region.end > 0 ? region.end : s.frames;
    if (s.pos >= region.start && (!(end > 0) || s.pos < end)) return;
    this.decoder!.seek(s.handle, region.start);
    s.pos = region.start;
    this.mark(s, at, region.start);
  }

  /** The file frame stream frame `frame` (sent, of this epoch) held, from the marks. */
  private fileAt(s: Stream, frame: number): number {
    let k = s.marks.length - 1;
    while (k > 0 && s.marks[k]!.stream > frame) k--;
    const m = s.marks[k]!;
    return m.file + (frame - m.stream);
  }

  private mark(s: Stream, stream: number, file: number): void {
    s.marks.push({ stream, file });
    // Keep the marks a few windows back (the voice is at most a window behind what was sent).
    const keepFrom = s.base + s.sent - 4 * STREAM_WINDOW_FRAMES;
    let drop = 0;
    while (drop < s.marks.length - 1 && s.marks[drop + 1]!.stream <= keepFrom) drop++;
    if (drop > 0) s.marks.splice(0, drop);
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
      const pool = this.pool.get(b.byteLength);
      if (pool && pool.length < POOL_MAX) pool.push(b);
    }
    if (!credit) return;
    this.stats.credits++;
    const s = this.streams.get(credit.streamId);
    if (s) this.credit(s, credit.epoch, credit.consumedFrames);
  }

  private credit(s: Stream, epoch: number, frames: number): void {
    if (epoch !== s.epoch && epoch !== s.prevEpoch) return; // frames of an older epoch's ring (a splice keeps the ring)
    s.credit.credit(frames);
    this.pump(s);
  }

  /**
   * Sends chunks while the credit window has room for a whole one (see the header). A chunk is filled in pieces: up to
   * the region's end (then a wrap to its start, flagged `wrapped`), up to a pending loop change's frame (then the
   * change), up to the file's end (then a wrap, or the last chunk).
   */
  private pump(s: Stream): void {
    const w = this.decoder;
    const port = this.port;
    if (!w || !port || s.done || s.failed) return;
    const fc = s.fileChannels;
    const chunkFrames = s.cls.chunkFrames;
    try {
      while (s.credit.canSend(chunkFrames)) {
        let n = 0;
        let flags = 0;
        let empty = 0;
        while (n < chunkFrames) {
          const at = s.base + s.sent + n;
          const p = s.pending;
          if (p && at >= p.at) {
            s.pending = null;
            this.apply(s, p.looping, p.region, at);
            continue;
          }
          let want = chunkFrames - n;
          if (p) want = Math.min(want, p.at - at);
          const end = s.loop && s.region.end > 0 ? s.region.end : 0;
          if (end > 0) want = Math.min(want, end - s.pos);
          if (want <= 0) {
            this.wrap(s, at);
            flags |= STREAM_CHUNK_FLAGS_WRAPPED;
            continue;
          }
          const got = w.readF32(s.handle, s.scratch + n * fc * 4, want);
          s.pos += got;
          n += got;
          if (got > 0) empty = 0;
          if (got < want) {
            // The file's end.
            if (!s.loop) {
              flags |= STREAM_CHUNK_FLAGS_LAST;
              break;
            }
            if (got === 0 && ++empty > 1) throw new DecoderError("audio decoder: the looping stream holds no audio");
            this.wrap(s, s.base + s.sent + n);
            flags |= STREAM_CHUNK_FLAGS_WRAPPED;
          }
        }
        const buffer = this.take(s.cls.bufferBytes);
        const view = new DataView(buffer);
        const ch = s.channels;
        writeEnvelope(view, 0, { kind: Kind.STREAM_CHUNK, seq: this.nextSeq(), bodyBytes: STREAM_CHUNK_FIXED_END - 16 + n * ch * 4 });
        writeStreamChunk(view, 0, { streamId: s.id, chunkSeq: s.chunkSeq++ >>> 0, frames: n, flags, epoch: s.epoch });
        if (n > 0) {
          new Float32Array(buffer, STREAM_CHUNK_FIXED_END, n * ch).set(w.f32(s.scratch, n * fc));
        }
        port.postMessage(buffer, [buffer]);
        this.stats.chunks++;
        s.credit.sent(n);
        s.sent += n;
        if (flags & STREAM_CHUNK_FLAGS_LAST) {
          s.done = true;
          return;
        }
      }
    } catch (e) {
      this.failStream(s, e);
    }
  }

  /** The loop's seam at stream frame `at`: back to the region's start. */
  private wrap(s: Stream, at: number): void {
    const start = s.region.start;
    this.decoder!.seek(s.handle, start);
    s.pos = start;
    this.mark(s, at, start);
  }

  /** A pooled chunk buffer of `bytes` (a class's size), or a new one. */
  private take(bytes: number): ArrayBuffer {
    const b = this.pool.get(bytes)?.pop();
    if (b) return b;
    this.stats.allocated++;
    return new ArrayBuffer(bytes);
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

/** What `streamOpened` reports: the file's info, with its own loop points when it states them (E4.4). */
function infoOf(raw: RawInfo): ClipInfo {
  const loop = fileLoopOf(raw);
  return { rate: raw.rate, channels: raw.channels, frames: raw.frames, framesEstimate: raw.framesEstimate, codec: raw.codec, lengthKnown: raw.exact, ...(loop ? { loopStartFrame: loop.start, loopEndFrame: loop.end } : {}) };
}
