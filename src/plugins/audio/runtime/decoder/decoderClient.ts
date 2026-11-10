// The main-thread side of the decoder worker (ADR 0157; architecture section 1). `createDecoderClient()` returns the
// page's one client; the worker is spawned lazily by the first request and the wasm is fetched there. B5 (worker-sourced
// clips) calls `decodeClip`; B3 adds streams. Replies are matched to requests by id; a worker that fails to load or dies
// rejects everything pending and is respawned by the next request.
//
// B3: `connectWorklet` gives the worker its end of the channel to the worklet; `openStream`, `seekStream` and
// `closeStream` steer streams whose PCM then flows worker to worklet; `onStream` hears `streamOpened`, `streamClosed`
// and stream errors. A worker that dies fails its open streams (an error each) and bumps `generation`, so the caller
// knows to connect the next worker to the worklet again.
import type { ClipInfo, DecodeHint, DecoderReply, DecoderRequest, ErrorMessage, StreamClosedMessage, StreamOpenedMessage, StreamPortLike } from "./protocol";

/** What the client needs of a worker (a `Worker`, or an in-process stand-in in tests). */
export interface WorkerLike {
  onmessage: ((event: { data: DecoderReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: DecoderRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

/** @internal Where `myco_audio_decode.wasm` is served: beside the mixer's, in the dev server and the app builds (the engine library copies it beside its bundle). */
export function decoderWasmUrl(): URL {
  return new URL("../wasm/myco_audio_decode.wasm", import.meta.url);
}

function spawnWorker(): WorkerLike {
  // Vite bundles the worker and what it imports (the worker pipeline, the same as the navigation bake worker).
  return new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

/** A decoded clip: `pcm` is interleaved int16 (`frames * channels` samples). */
export interface DecodedClip {
  readonly pcm: Int16Array;
  readonly rate: number;
  readonly channels: number;
  /** Frames decoded; for an MP3 without a length header this is known only now. */
  readonly frames: number;
  readonly info: ClipInfo;
}

export interface DecodeClipOptions {
  /** Aborting rejects with `AbortError` and tells the worker to stop at its next chunk. */
  readonly signal?: AbortSignal;
  /** Moves the caller's buffer to the worker instead of copying it (the caller's `bytes` is detached afterwards). Default: copy, so an encoded cache can keep its bytes. */
  readonly transfer?: boolean;
  /** Named in decoder errors. */
  readonly asset?: string;
  /** Called with each chunk as it arrives, before the result resolves (a copy of nothing: the chunk is also part of the result). */
  readonly onChunk?: (pcm: Int16Array, index: number) => void;
}

/** B3: what `openStream` takes. `bytes` is transferred (the caller's buffer is detached afterwards). */
export interface StreamOpenOptions {
  readonly streamId: number;
  readonly asset: string;
  readonly bytes: ArrayBuffer;
  readonly hint: DecodeHint;
  readonly startFrame: number;
  readonly epoch: number;
  readonly loop: boolean;
}

/** B3: the replies about streams. */
export type StreamReply = StreamOpenedMessage | StreamClosedMessage | (ErrorMessage & { readonly streamId: number });

export interface DecoderClient {
  /** Decodes a whole clip on the worker. `hint` is the container (see `hintFromName`); 0 lets the decoder probe. Rejects with the decoder's message on failure. */
  decodeClip(bytes: ArrayBuffer | Uint8Array, hint?: DecodeHint, options?: DecodeClipOptions): Promise<DecodedClip>;
  /** B3: the worker's end of the channel to the worklet (transferred). Spawns the worker if needed. */
  connectWorklet(port: MessagePort | StreamPortLike): void;
  /** B3: opens a stream; its PCM goes to the connected worklet, its replies to `onStream`. */
  openStream(options: StreamOpenOptions): void;
  /** B3b: restarts a stream at `frame` with `epoch`. */
  seekStream(streamId: number, frame: number, epoch: number): void;
  /** B3: closes a stream (the worker sends STREAM_CLOSE to the worklet). Unknown ids are answered too. */
  closeStream(streamId: number): void;
  /** B3: every stream reply; returns the unsubscribe. */
  onStream(listener: (reply: StreamReply) => void): () => void;
  /** B3: bumped each time a worker is spawned; a worklet connected to an older one must be connected again. */
  readonly generation: number;
  /** Terminates the worker and rejects what is pending. The client may be used again (it respawns). */
  dispose(): void;
}

export interface DecoderClientOptions {
  /** Makes the worker (tests pass an in-process one). A client with its own factory is private; without, it is the shared one. */
  readonly workerFactory?: () => WorkerLike;
  /** The wasm's URL for `init`; default `decoderWasmUrl()`. */
  readonly wasmUrl?: string;
  /** For an in-process worker: the wasm bytes to send instead of a URL. */
  readonly wasmBytes?: ArrayBuffer;
}

interface Pending {
  readonly chunks: Int16Array[];
  readonly options: DecodeClipOptions | undefined;
  resolve(value: DecodedClip): void;
  reject(reason: unknown): void;
  abort?: () => void;
}

class Client implements DecoderClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** B3: open streams by id (their asset, for the error a dead worker gives them), and the stream listeners. */
  private readonly streams = new Map<number, string>();
  private readonly streamListeners = new Set<(reply: StreamReply) => void>();
  generation = 0;

  constructor(
    private readonly options: DecoderClientOptions,
    private readonly onDispose?: () => void,
  ) {}

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = (this.options.workerFactory ?? spawnWorker)();
    this.generation++;
    worker.onmessage = (e) => this.onReply(worker, e.data);
    worker.onerror = (e) => this.failAll(worker, new Error(`audio decoder: the worker failed${e.message ? ` (${e.message})` : ""}`));
    this.worker = worker;
    if (this.options.wasmBytes) {
      const bytes = this.options.wasmBytes.slice(0);
      worker.postMessage({ type: "init", wasmBytes: bytes }, [bytes]);
    } else {
      worker.postMessage({ type: "init", wasmUrl: this.options.wasmUrl ?? decoderWasmUrl().href });
    }
    return worker;
  }

  decodeClip(bytes: ArrayBuffer | Uint8Array, hint: DecodeHint = 0, options?: DecodeClipOptions): Promise<DecodedClip> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    let buffer: ArrayBuffer;
    if (bytes instanceof ArrayBuffer) buffer = options?.transfer ? bytes : bytes.slice(0);
    else buffer = options?.transfer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<DecodedClip>((resolve, reject) => {
      const entry: Pending = { chunks: [], options, resolve, reject };
      if (signal) {
        entry.abort = () => {
          if (!this.pending.delete(id)) return;
          worker.postMessage({ type: "cancel", id });
          reject(abortError());
        };
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      this.pending.set(id, entry);
      worker.postMessage({ type: "decodeClip", id, asset: options?.asset, bytes: buffer, hint }, [buffer]);
    });
  }

  connectWorklet(port: MessagePort | StreamPortLike): void {
    this.ensureWorker().postMessage({ type: "connectWorklet", port: port as StreamPortLike }, [port as unknown as Transferable]);
  }

  openStream(o: StreamOpenOptions): void {
    const worker = this.ensureWorker();
    this.streams.set(o.streamId, o.asset);
    worker.postMessage({ type: "streamOpen", streamId: o.streamId, asset: o.asset, bytes: o.bytes, hint: o.hint, startFrame: o.startFrame, epoch: o.epoch, loop: o.loop }, [o.bytes]);
  }

  seekStream(streamId: number, frame: number, epoch: number): void {
    if (this.worker && this.streams.has(streamId)) this.worker.postMessage({ type: "streamSeek", streamId, frame, epoch });
  }

  closeStream(streamId: number): void {
    if (!this.streams.delete(streamId) || !this.worker) return;
    this.worker.postMessage({ type: "streamClose", streamId });
  }

  onStream(listener: (reply: StreamReply) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  private emitStream(reply: StreamReply): void {
    for (const listener of this.streamListeners) listener(reply);
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined; // aborted meanwhile
    this.pending.delete(id);
    if (entry.abort) entry.options?.signal?.removeEventListener("abort", entry.abort);
    return entry;
  }

  private onReply(worker: WorkerLike, msg: DecoderReply): void {
    if (worker !== this.worker) return;
    switch (msg.type) {
      case "clipChunk": {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        const pcm = new Int16Array(msg.pcm);
        entry.chunks.push(pcm);
        entry.options?.onChunk?.(pcm, msg.index);
        return;
      }
      case "clipDone": {
        const entry = this.settle(msg.id);
        if (!entry) return;
        const channels = msg.info.channels;
        const pcm = entry.chunks.length === 1 ? entry.chunks[0] : concat(entry.chunks, msg.info.frames * channels);
        entry.resolve({ pcm, rate: msg.info.rate, channels, frames: msg.info.frames, info: msg.info });
        return;
      }
      case "cancelled":
        this.settle(msg.id);
        return;
      case "streamOpened":
        if (this.streams.has(msg.streamId)) this.emitStream(msg);
        return;
      case "streamClosed":
        this.emitStream(msg);
        return;
      case "error": {
        if (msg.streamId !== undefined) {
          if (this.streams.has(msg.streamId)) this.emitStream({ ...msg, streamId: msg.streamId });
          return;
        }
        if (msg.id === undefined) {
          // Not tied to a request: the wasm did not load or did not match. Terminate so the next request retries from scratch.
          if (msg.fatal) this.failAll(worker, new Error(msg.message));
          return;
        }
        this.settle(msg.id)?.reject(new Error(msg.message));
        return;
      }
      default:
        return; // ready
    }
  }

  private failAll(worker: WorkerLike, error: Error): void {
    if (worker !== this.worker) return;
    this.worker = null;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
    // B3: its streams are gone with it.
    const streams = [...this.streams];
    this.streams.clear();
    for (const [streamId, asset] of streams) this.emitStream({ type: "error", streamId, asset, message: error.message });
  }

  dispose(): void {
    if (this.worker) this.failAll(this.worker, new Error("audio decoder: disposed"));
    this.onDispose?.();
  }
}

function concat(chunks: readonly Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function abortError(): Error {
  const e = new Error("audio decoder: the decode was cancelled");
  e.name = "AbortError";
  return e;
}

let shared: Client | null = null;

/**
 * The page's decoder client: one worker shared by every caller, spawned by the first `decodeClip`. With `options` (a
 * worker factory, for tests) a private client is made instead. `dispose()` on the shared client ends its worker; the
 * next `createDecoderClient()` makes a new one.
 */
export function createDecoderClient(options?: DecoderClientOptions): DecoderClient {
  if (options) return new Client(options);
  return (shared ??= new Client({}, () => {
    shared = null;
  }));
}
