/**
 * Internal (ADR 0337 §4–§5, amended by 0345 §1–§3): the audio encoder as the export and the Studio see it. One request
 * encodes one sound's PCM to a shipped codec; an `AudioEncoder` runs requests on a pool of threads, each holding one
 * instance of `myco_audio_encode.wasm` (`audioEncoderWasm.ts`):
 *
 * - `audioEncoderNode.ts`: `worker_threads`, cores − 1 by default (the export CLI);
 * - `audioEncoderBrowser.ts`: Web Workers, at most [`STUDIO_ENCODE_CONCURRENCY`] (2) at once (0345 §3: an 82 s clip
 *   holds 73–132 MB of a module's memory).
 *
 * This module holds the shared pieces: the request and result types, the thread protocol and the pool. It imports no
 * Node or DOM API. The encoder's version (for cache keys) is [`ENCODER_VERSION`], its source hash.
 */
import type { ShippedCodec } from "../engine/audio/encoding/types";
import encodeInfo from "./wasm/encode.json" with { type: "json" };

/** The encoder's version for cache keys (ADR 0337 §5): the hash of its sources, which the wasm embeds. */
export const ENCODER_VERSION: string = encodeInfo.sourceHash;
/** The Studio's cap on concurrent encodes (ADR 0345 §3). */
export const STUDIO_ENCODE_CONCURRENCY = 2;

/** One encode. */
export interface EncodeRequest {
  /** Interleaved samples, −1..1. */
  pcm: Float32Array;
  channels: number;
  sampleRate: number;
  codec: ShippedCodec;
  /** 0..1 (Vorbis, Opus). */
  quality: number;
  /** The highest output rate in Hz, or null for the source's; never upsamples; Opus is always 48 kHz. */
  rateCeiling: number | null;
  /** Downmix to mono ((L+R)/2) first. */
  mono: boolean;
}

/** What an encode gives. */
export interface EncodedAudio {
  /** PCM: a 16-bit WAV; ADPCM: raw blocks (`audio-encode`'s `adpcm.rs` layout); Vorbis and Opus: Ogg. */
  bytes: Uint8Array;
  codec: ShippedCodec;
  sampleRate: number;
  channels: number;
  /** Frames per channel it decodes to (Opus: pre-skip excluded). */
  frames: number;
  /** Opus's pre-skip at 48 kHz; 0 for the others. */
  preSkip: number;
}

/** Why an encode failed: `arg` (bad input), `refused` (the codec can't take it, e.g. Opus with 4 channels), `encode`. */
export type EncodeErrorKind = "arg" | "refused" | "encode";
export class AudioEncodeError extends Error {
  constructor(readonly kind: EncodeErrorKind, message: string) {
    super(message);
    this.name = "AudioEncodeError";
  }
}

/** Options of one `encode` call. */
export interface EncodeOptions {
  /** Hand `request.pcm`'s buffer to the thread instead of copying it (the caller's array is detached). */
  transfer?: boolean;
  /** Cancels a queued request (a running one finishes; its result is dropped). */
  signal?: AbortSignal;
}

/** Encodes on a pool of threads. */
export interface AudioEncoder {
  encode(request: EncodeRequest, options?: EncodeOptions): Promise<EncodedAudio>;
  /** Ends the threads; pending requests reject. */
  close(): void;
}

// --- the thread protocol --------------------------------------------------------------------------------------------

/** A message to a thread. */
export interface ThreadRequest {
  id: number;
  request: EncodeRequest;
}
/** A thread's reply. */
export type ThreadReply = { id: number; result: EncodedAudio } | { id: number; error: { kind: EncodeErrorKind; message: string } };

/** One thread as the pool sees it (a Worker, a `worker_threads` Worker, or a port). */
export interface EncoderThread {
  post(message: ThreadRequest, transfer: ArrayBuffer[]): void;
  /** Sets the reply handler and the handler for a thread that died (it is then replaced). */
  listen(onReply: (reply: ThreadReply) => void, onFail: (error: Error) => void): void;
  terminate(): void;
}

interface Job {
  request: EncodeRequest;
  transfer: boolean;
  resolve(v: EncodedAudio): void;
  reject(e: unknown): void;
  signal?: AbortSignal;
}

/**
 * A pool of at most `size` threads made by `spawn` on demand. Each thread runs one request at a time; others wait in
 * order. A thread that fails is dropped (its request rejects) and a new one is made for the next request.
 */
export function createEncoderPool(options: { size: number; spawn: () => EncoderThread }): AudioEncoder {
  const size = Math.max(1, Math.floor(options.size));
  const idle: EncoderThread[] = [];
  const busy = new Map<EncoderThread, { id: number; job: Job }>();
  const queue: Job[] = [];
  let next = 1;
  let closed = false;

  const spawn = (): EncoderThread => {
    const t = options.spawn();
    t.listen(
      (reply) => {
        const run = busy.get(t);
        if (!run || run.id !== reply.id) return;
        busy.delete(t);
        idle.push(t);
        if ("result" in reply) run.job.resolve(reply.result);
        else run.job.reject(new AudioEncodeError(reply.error.kind, reply.error.message));
        pump();
      },
      (error) => {
        const run = busy.get(t);
        busy.delete(t);
        const i = idle.indexOf(t);
        if (i >= 0) idle.splice(i, 1);
        t.terminate();
        run?.job.reject(new AudioEncodeError("encode", `the encoder thread failed: ${error.message}`));
        pump();
      },
    );
    return t;
  };

  const pump = () => {
    while (!closed && queue.length > 0) {
      const job = queue[0];
      if (job.signal?.aborted) {
        queue.shift();
        job.reject(job.signal.reason ?? new Error("aborted"));
        continue;
      }
      const thread = idle.pop() ?? (busy.size < size ? spawn() : null);
      if (!thread) return;
      queue.shift();
      const id = next++;
      busy.set(thread, { id, job });
      const pcm = job.transfer ? job.request.pcm : job.request.pcm.slice();
      thread.post({ id, request: { ...job.request, pcm } }, [pcm.buffer as ArrayBuffer]);
    }
  };

  return {
    encode(request, opts = {}) {
      if (closed) return Promise.reject(new Error("the audio encoder is closed"));
      return new Promise<EncodedAudio>((resolve, reject) => {
        const job: Job = { request, transfer: opts.transfer === true, resolve, reject, signal: opts.signal };
        opts.signal?.addEventListener("abort", () => {
          const i = queue.indexOf(job);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(opts.signal!.reason ?? new Error("aborted"));
          }
        }, { once: true });
        queue.push(job);
        pump();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error("the audio encoder was closed"));
      for (const [t, run] of busy) {
        run.job.reject(new Error("the audio encoder was closed"));
        t.terminate();
      }
      busy.clear();
      for (const t of idle.splice(0)) t.terminate();
    },
  };
}
