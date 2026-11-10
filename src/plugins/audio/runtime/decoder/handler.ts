// The decoder worker's message handler, factored out of the worker so Node tests drive it in-process (K7): it routes
// `decodeClip` and `cancel` to `clips.ts` and `stream*` (E4.4: `streamLoop` too) and `connectWorklet` to `streams.ts` (B3), loads the
// wasm on `init` (requests that arrive first wait for it), and turns every failure into an `error` reply. Never throws,
// never waits on anything but the wasm.
import { decodeClip } from "./clips";
import type { DecodeClipMessage, DecoderReply, DecoderRequest, InitMessage } from "./protocol";
import { StreamDecoder } from "./streams";
import { DecoderError, DecoderWasm } from "./wasm";

export interface HandlerOptions {
  /** Sends a reply; `transfer` lists the buffers it moves. */
  post(reply: DecoderReply, transfer?: Transferable[]): void;
  /** Source hash the wasm must embed (32 hex digits); omitted: not checked. */
  expectedSourceHash?: string;
  /** Fetches the wasm bytes for `init.wasmUrl` (the worker passes `fetch`). */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** Awaited between chunks of a clip decode (default: a macrotask, so queued messages run). */
  yieldToEvents?: () => Promise<void>;
}

export interface DecoderHandler {
  /** Handles one request; resolves when the request has been dealt with (tests await it). */
  handle(request: DecoderRequest): Promise<void>;
  /** B3: the stream decoder's counts (chunks posted, chunk buffers allocated, credits received). */
  readonly streamStats: { readonly chunks: number; readonly allocated: number; readonly credits: number };
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createDecoderHandler(options: HandlerOptions): DecoderHandler {
  const { post } = options;
  const yieldToEvents = options.yieldToEvents ?? macrotask;
  let wasm: Promise<DecoderWasm> | null = null;
  let failure: string | null = null;
  const cancelled = new Set<number>();
  const active = new Set<number>();
  // B3: the streams, on their own instance of the wasm once it loaded.
  const streams = new StreamDecoder({ post, wasm: () => wasm });

  const load = async (msg: InitMessage): Promise<DecoderWasm> => {
    try {
      let source: ArrayBuffer;
      if (msg.wasmBytes) source = msg.wasmBytes;
      else if (msg.wasmUrl && options.fetchBytes) source = await options.fetchBytes(msg.wasmUrl);
      else throw new DecoderError("audio decoder: init has no wasm to load");
      const loaded = await DecoderWasm.load(source, options.expectedSourceHash);
      post({ type: "ready", abiVersion: loaded.abiVersion });
      return loaded;
    } catch (e) {
      failure = describe(e);
      post({ type: "error", message: failure, fatal: true });
      throw e;
    }
  };

  const clip = async (msg: DecodeClipMessage): Promise<void> => {
    const fail = (e: unknown) =>
      post({ type: "error", id: msg.id, asset: msg.asset, message: describe(e), code: e instanceof DecoderError && e.code !== 0 ? e.code : undefined });
    if (!wasm) return fail(new DecoderError("audio decoder: not initialised"));
    let decoder: DecoderWasm;
    try {
      decoder = await wasm;
    } catch {
      return fail(new DecoderError(failure ?? "audio decoder: failed to load"));
    }
    active.add(msg.id);
    try {
      const info = await decodeClip(decoder, new Uint8Array(msg.bytes), msg.hint, {
        onInfo: (info) => post({ type: "clipInfo", id: msg.id, info }),
        onChunk: (index, pcm) => post({ type: "clipChunk", id: msg.id, index, pcm: pcm.buffer as ArrayBuffer }, [pcm.buffer as ArrayBuffer]),
        cancelled: () => cancelled.has(msg.id),
        yieldToEvents,
      });
      post(info ? { type: "clipDone", id: msg.id, info } : { type: "cancelled", id: msg.id });
    } catch (e) {
      // A trap (not a DecoderError) leaves the instance's memory in an unknown state: start a fresh one.
      if (!(e instanceof DecoderError)) decoder.reset();
      fail(e);
    } finally {
      active.delete(msg.id);
      cancelled.delete(msg.id);
    }
  };

  return {
    streamStats: streams.stats,
    async handle(request) {
      switch (request.type) {
        case "init":
          if (!wasm) {
            wasm = load(request);
            wasm.catch(() => undefined); // reported as an error reply; later requests see `failure`
          }
          return;
        case "decodeClip":
          return clip(request);
        case "cancel":
          if (active.has(request.id)) cancelled.add(request.id);
          return;
        case "streamOpen":
        case "streamCredit":
        case "streamSeek":
        case "streamClose":
        case "streamLoop":
        case "connectWorklet":
          return streams.handle(request);
      }
    },
  };
}
