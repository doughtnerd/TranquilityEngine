// The main-thread side of the decoder worker (ADR 0157; architecture section 1). `createDecoderClient()` returns the
// page's one client; the worker is spawned lazily by the first request and the wasm is fetched there. B5 (worker-sourced
// clips) calls `decodeClip`; B3 adds streams. Replies are matched to requests by id. A worker that dies (a crash, not a
// refusal) is respawned and the pending decodes are posted again, at most `MAX_RESPAWNS` times per `RESPAWN_WINDOW_MS`
// (B6: there is no `decodeAudioData` to fall back to); past that, or when the wasm is refused (it did not load, or its
// hash does not match), the pending decodes fail with `DecoderUnavailableError` and the next request starts afresh.
//
// B3: `connectWorklet` gives the worker its end of the channel to the worklet; `openStream`, `seekStream`, `loopStream`
// (E4.4) and `closeStream` steer streams whose PCM then flows worker to worklet; `onStream` hears `streamOpened`, `streamClosed`
// and stream errors. Streams are not carried over to a respawned worker: a worker that dies (or is refused) fails its
// open streams, an error each (the stream manager stops each voice with a fade and one warning), and the next worker
// bumps `generation`, so the caller connects it to the worklet again (which closes the dead worker's rings there).
import type { AmbisonicConvention, ClipInfo, DecodeHint, DecoderReply, DecoderRequest, ErrorMessage, IrFailedMessage, IrPreparedMessage, IrRequest, StreamClosedMessage, StreamOpenedMessage, StreamPortLike } from "./protocol";
import type { StreamLoopAt } from "./streams";

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

/** @internal B4: the decoder built with AAC (`myco_audio_decode_aac.wasm`), served beside the default one and fetched only by a worker of the "aac" build (a project with `audio.codecs.aac` on). */
export function decoderAacWasmUrl(): URL {
  return new URL("../wasm/myco_audio_decode_aac.wasm", import.meta.url);
}

/** @internal B4: which decoder wasm a worker loads: the default (WAV, FLAC, MP3, Ogg Vorbis) or the larger one that adds AAC. */
export type DecoderBuild = "default" | "aac";

function spawnWorker(): WorkerLike {
  // Vite bundles the worker and what it imports (the worker pipeline, the same as the navigation bake worker).
  return new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

/** B4: the decoder refused a file; `code` is its negative `ERR_*` code when it gave one (-3 not a container it reads, -4 a codec it lacks). */
export class DecodeFailedError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "DecodeFailedError";
  }
}

/** The decoder could not run at all (no `Worker`, the wasm refused or did not match, the worker died), as opposed to a bad file. Callers may fall back to another decoder. */
export class DecoderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecoderUnavailableError";
  }
}

/** B6: a crashed worker is respawned at most this many times within `RESPAWN_WINDOW_MS`, like the core's rebuilds. */
export const MAX_RESPAWNS = 3;
export const RESPAWN_WINDOW_MS = 60_000;

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
  /** ADR 0162 §2.4 (B1): the clip's ambisonic sidecar convention, sent with the request so the decoder can convert FuMa (B2 applies it). Absent for an ordinary clip. */
  readonly convention?: AmbisonicConvention;
  /** B5: called once before the first chunk with what the container declares (`info.frames` -1 when unknown). */
  readonly onInfo?: (info: ClipInfo) => void;
  /** B5: false does not keep the chunks, so the result's `pcm` is empty: the caller took them through `onChunk` (a long clip is then not held twice). Default true. */
  readonly collect?: boolean;
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
  /** ADR 0158 §4 (contract C2, sent by E4.4): the loop region in frames (end exclusive, 0 = the end). */
  readonly loopStartFrame?: number;
  readonly loopEndFrame?: number;
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
  /**
   * ADR 0158 §4 (E4.4): changes a stream's loop region (`looping`; frames, end exclusive, 0/0 the whole file, both
   * omitted the file's own points) or releases it (`looping: false`), at stream frame `atStreamFrame` (the end of the
   * voice's current pass; omitted: where the worker is decoding). The caller reserves the stream's next epoch for it
   * (the worker splices with it when that frame was sent already, `decoder/streams.ts`).
   */
  loopStream(streamId: number, looping: boolean, loopStartFrame?: number, loopEndFrame?: number, atStreamFrame?: number): void;
  /** B3: closes a stream (the worker sends STREAM_CLOSE to the worklet). Unknown ids are answered too. */
  closeStream(streamId: number): void;
  /**
   * ADR 0162 C2b: posts a zone IR request (`prepareIr`, `generateIr`, `releaseIr`) to the worker, which sends the kernel to
   * the connected worklet itself. A request the worker can't take is answered with `irFailed` through `onIr`.
   */
  postIr(request: IrRequest): void;
  /** ADR 0162 C2b: every `irPrepared` / `irFailed`; a worker that dies fails its pending requests. Returns the unsubscribe. */
  onIr(listener: (reply: IrPreparedMessage | IrFailedMessage) => void): () => void;
  /** B3: every stream reply; returns the unsubscribe. */
  onStream(listener: (reply: StreamReply) => void): () => void;
  /** B3: bumped each time a worker is spawned or retired (crashed, refused, disposed); a worklet connected at another generation must be connected again. */
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
  /** The clock the respawn limit reads, in ms (default `Date.now`). */
  readonly now?: () => number;
}

interface Pending {
  readonly chunks: Int16Array[];
  /** The request, kept (the encoded bytes copied) to post it again to a respawned worker. */
  readonly bytes: ArrayBuffer;
  readonly hint: DecodeHint;
  /** Whether `onInfo` has run, so a repeat after a respawn does not call it twice. */
  informed: boolean;
  /** Chunks delivered to `onChunk`; a decode posted again skips the same ones (decoding is deterministic). */
  delivered: number;
  readonly options: DecodeClipOptions | undefined;
  resolve(value: DecodedClip): void;
  reject(reason: unknown): void;
  abort?: () => void;
}

class Client implements DecoderClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** When the worker last crashed (ms), oldest first, within the window. */
  private crashes: number[] = [];
  /** B3: open streams by id (their asset, for the error a dead worker gives them), and the stream listeners. */
  private readonly streams = new Map<number, string>();
  private readonly streamListeners = new Set<(reply: StreamReply) => void>();
  /** ADR 0162 C2b: zone IR requests awaiting a reply (token to kernel id), and the listeners. */
  private readonly irPending = new Map<number, number>();
  private readonly irListeners = new Set<(reply: IrPreparedMessage | IrFailedMessage) => void>();
  generation = 0;

  constructor(
    private readonly options: DecoderClientOptions,
    private readonly onDispose?: () => void,
  ) {}

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const now = (this.options.now ?? Date.now)();
    this.crashes = this.crashes.filter((t) => now - t < RESPAWN_WINDOW_MS);
    if (this.crashes.length > MAX_RESPAWNS) throw new DecoderUnavailableError(`audio decoder: the worker crashed ${this.crashes.length} times within ${RESPAWN_WINDOW_MS / 1000} s`);
    const worker = (this.options.workerFactory ?? spawnWorker)();
    this.generation++;
    worker.onmessage = (e) => this.onReply(worker, e.data);
    worker.onerror = (e) => this.crashed(worker, `audio decoder: the worker failed${e.message ? ` (${e.message})` : ""}`);
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
    // Kept for a repeat after a crash (the post below transfers `buffer`).
    const kept = buffer.slice(0);
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      return Promise.reject(new DecoderUnavailableError(`audio decoder: no worker (${e instanceof Error ? e.message : String(e)})`));
    }
    const id = this.nextId++;
    return new Promise<DecodedClip>((resolve, reject) => {
      const entry: Pending = { chunks: [], bytes: kept, hint, informed: false, delivered: 0, options, resolve, reject };
      if (signal) {
        entry.abort = () => {
          if (!this.pending.delete(id)) return;
          this.worker?.postMessage({ type: "cancel", id });
          reject(abortError());
        };
        signal.addEventListener("abort", entry.abort, { once: true });
      }
      this.pending.set(id, entry);
      worker.postMessage({ type: "decodeClip", id, asset: options?.asset, bytes: buffer, hint, convention: options?.convention }, [buffer]);
    });
  }

  connectWorklet(port: MessagePort | StreamPortLike): void {
    this.ensureWorker().postMessage({ type: "connectWorklet", port: port as StreamPortLike }, [port as unknown as Transferable]);
  }

  openStream(o: StreamOpenOptions): void {
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      // B6's respawn budget is spent (or there is no `Worker`): the stream fails like one on a dead worker.
      this.emitStream({ type: "error", streamId: o.streamId, asset: o.asset, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.streams.set(o.streamId, o.asset);
    const region = o.loopStartFrame !== undefined || o.loopEndFrame !== undefined ? { loopStartFrame: o.loopStartFrame ?? 0, loopEndFrame: o.loopEndFrame ?? 0 } : {};
    worker.postMessage({ type: "streamOpen", streamId: o.streamId, asset: o.asset, bytes: o.bytes, hint: o.hint, startFrame: o.startFrame, epoch: o.epoch, loop: o.loop, ...region }, [o.bytes]);
  }

  loopStream(streamId: number, looping: boolean, loopStartFrame?: number, loopEndFrame?: number, atStreamFrame?: number): void {
    if (!this.worker || !this.streams.has(streamId)) return;
    const message: StreamLoopAt = {
      type: "streamLoop",
      streamId,
      looping,
      ...(loopStartFrame !== undefined || loopEndFrame !== undefined ? { loopStartFrame: loopStartFrame ?? 0, loopEndFrame: loopEndFrame ?? 0 } : {}),
      ...(atStreamFrame !== undefined ? { atStreamFrame } : {}),
    };
    this.worker.postMessage(message);
  }

  seekStream(streamId: number, frame: number, epoch: number): void {
    if (this.worker && this.streams.has(streamId)) this.worker.postMessage({ type: "streamSeek", streamId, frame, epoch });
  }

  closeStream(streamId: number): void {
    if (!this.streams.delete(streamId) || !this.worker) return;
    this.worker.postMessage({ type: "streamClose", streamId });
  }

  postIr(request: IrRequest): void {
    if (request.type === "releaseIr") {
      this.worker?.postMessage(request);
      return;
    }
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      this.emitIr({ type: "irFailed", token: request.token, kernelId: request.kernelId, code: 0, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.irPending.set(request.token, request.kernelId);
    worker.postMessage(request);
  }

  onIr(listener: (reply: IrPreparedMessage | IrFailedMessage) => void): () => void {
    this.irListeners.add(listener);
    return () => this.irListeners.delete(listener);
  }

  private emitIr(reply: IrPreparedMessage | IrFailedMessage): void {
    for (const listener of [...this.irListeners]) listener(reply);
  }

  /** The worker is gone with its kept IR bytes and its worklet port: what was pending fails. */
  private failIr(message: string): void {
    const pending = [...this.irPending];
    this.irPending.clear();
    for (const [token, kernelId] of pending) this.emitIr({ type: "irFailed", token, kernelId, code: 0, message });
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
      case "clipInfo": {
        const entry = this.pending.get(msg.id);
        if (!entry || entry.informed) return;
        entry.informed = true;
        entry.options?.onInfo?.(msg.info);
        return;
      }
      case "clipChunk": {
        const entry = this.pending.get(msg.id);
        if (!entry || msg.index < entry.delivered) return; // a repeat after a respawn
        entry.delivered = msg.index + 1;
        const pcm = new Int16Array(msg.pcm);
        if (entry.options?.collect !== false) entry.chunks.push(pcm);
        entry.options?.onChunk?.(pcm, msg.index);
        return;
      }
      case "clipDone": {
        const entry = this.settle(msg.id);
        if (!entry) return;
        const channels = msg.info.channels;
        const pcm = entry.chunks.length === 0 ? new Int16Array(0) : entry.chunks.length === 1 ? entry.chunks[0] : concat(entry.chunks, msg.info.frames * channels);
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
      case "irPrepared":
      case "irFailed":
        if (this.irPending.delete(msg.token)) this.emitIr(msg);
        return;
      case "error": {
        if (msg.streamId !== undefined) {
          if (this.streams.has(msg.streamId)) this.emitStream({ ...msg, streamId: msg.streamId });
          return;
        }
        if (msg.id === undefined) {
          // Not tied to a request: the wasm did not load or did not match (a refusal, not a crash: no retry). Terminate so the next request starts afresh.
          if (msg.fatal) this.failAll(worker, new DecoderUnavailableError(msg.message));
          return;
        }
        this.settle(msg.id)?.reject(new DecodeFailedError(msg.message, msg.code));
        return;
      }
      default:
        return; // ready
    }
  }

  /** The worker died: respawn it and post the pending decodes again, unless it keeps dying. Its streams fail. */
  private crashed(worker: WorkerLike, message: string): void {
    if (worker !== this.worker) return;
    this.crashes.push((this.options.now ?? Date.now)());
    const entries = [...this.pending.entries()];
    this.retire(worker);
    this.failStreams(`${message}; the stream stopped`);
    this.failIr(message);
    if (entries.length === 0) return;
    let next: WorkerLike;
    try {
      next = this.ensureWorker();
    } catch (e) {
      const error = e instanceof DecoderUnavailableError ? e : new DecoderUnavailableError(`${message}; ${e instanceof Error ? e.message : String(e)}`);
      for (const [id] of entries) this.settle(id)?.reject(error);
      return;
    }
    for (const [id, entry] of entries) {
      if (this.pending.get(id) !== entry) continue;
      const bytes = entry.bytes.slice(0);
      next.postMessage({ type: "decodeClip", id, bytes, hint: entry.hint, asset: entry.options?.asset, convention: entry.options?.convention }, [bytes]);
    }
  }

  private retire(worker: WorkerLike): void {
    this.worker = null;
    // B3: a worker connected to the worklet is gone, so a caller holding the old generation connects again (the
    // next spawn bumps it once more).
    this.generation++;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  private failAll(worker: WorkerLike, error: Error): void {
    if (worker !== this.worker) return;
    this.retire(worker);
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
    this.failStreams(error.message);
    this.failIr(error.message);
  }

  /** B3: the worker's streams are gone with it (its decoder state and its end of the worklet channel). */
  private failStreams(message: string): void {
    const streams = [...this.streams];
    this.streams.clear();
    for (const [streamId, asset] of streams) this.emitStream({ type: "error", streamId, asset, message });
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

const shared = new Map<DecoderBuild, Client>();

/**
 * The page's decoder client: one worker shared by every caller, spawned by the first `decodeClip`. With `options` (a
 * worker factory, for tests) a private client is made instead. `dispose()` on the shared client ends its worker; the
 * next `createDecoderClient()` makes a new one. Same as `sharedDecoderClient("default")` without options.
 */
export function createDecoderClient(options?: DecoderClientOptions): DecoderClient {
  if (options) return new Client(options);
  return sharedDecoderClient("default");
}

/**
 * @internal B4: the page's shared client for `build`. The core asks for the "aac" one when the project sets
 * `audio.codecs.aac` (its worker loads `myco_audio_decode_aac.wasm`), else the default one, so a page only ever spawns
 * the worker (and fetches the wasm) it uses.
 */
export function sharedDecoderClient(build: DecoderBuild): DecoderClient {
  let client = shared.get(build);
  if (!client) {
    const options: DecoderClientOptions = build === "aac" ? { wasmUrl: decoderAacWasmUrl().href } : {};
    client = new Client(options, () => {
      if (shared.get(build) === client) shared.delete(build);
    });
    shared.set(build, client);
  }
  return client;
}
