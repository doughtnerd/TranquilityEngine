// The decoder worker's message handler, factored out of the worker so Node tests drive it in-process (K7). ADR 0351 A4:
// `packLoad` / `packRelease` hold `.mycopak` packages (`packs.ts`) whose entries `decodeClip` and `streamOpen` name with
// `pack` (an ADPCM entry comes back as clip format 6 blocks or decoded int16). It routes
// `decodeClip` and `cancel` to `clips.ts`, `stream*` (E4.4: `streamLoop` too) and `connectWorklet` to `streams.ts` (B3), and the
// zone IR messages (ADR 0162 K0: `prepareIr`, `generateIr`, `releaseIr`) to `irPrepare.ts` (C2b), the music messages
// (ADR 0166 §4.6, H3: `primeGroup`, `cancelGroup`, `protectMusic`, `releaseMusic`) to `musicGroups.ts` (D1a, D1b), loads the
// wasm on `init` (requests that arrive first wait for it), and turns every failure into an `error` reply. Never throws,
// never waits on anything but the wasm.
import { ADPCM_BLOCK_FRAMES, ADPCM_CHANNEL_BYTES } from "../wire.generated";
import { decodeClip } from "./clips";
import { IrPreparer } from "./irPrepare";
import { MusicCache } from "./musicCache";
import { MusicGroups } from "./musicGroups";
import { adpcmInfo, adpcmPieces, entryHint, PackStore, type HeldEntry } from "./packs";
import { CLIP_CHUNK_FRAMES, type ComputePeaksMessage, type DecodeClipMessage, type DecoderReply, type DecoderRequest, type InitMessage, type StreamOpenMessage } from "./protocol";
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
  // ADR 0166 (D1a, H3): music groups open their members on the same streams; a closed stream leaves its group.
  const streams = new StreamDecoder({ post, wasm: () => wasm, closed: (id) => groups.closed(id) });
  const groups = new MusicGroups({ post, streams, cache: new MusicCache({ warn: (instance, _message, bytes, budget) => post({ type: "musicWarn", cause: "encodedOverBudget", instance, bytes, budget }) }) });
  // ADR 0162 (K0): zone IR preparation, filled by C2b in irPrepare.ts. It sends kernels over the worklet port that
  // `connectWorklet` hands the stream decoder too, so it hears about each new port.
  const ir = new IrPreparer({ post, wasm: () => wasm, fetchBytes: options.fetchBytes });
  // ADR 0351 §7, A4: the packages main loaded (`packs.ts`).
  const packs = new PackStore();

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
      let bytes: Uint8Array = new Uint8Array(msg.bytes);
      let hint = msg.hint;
      if (msg.pack) {
        const held = packs.entry(msg.pack.pack, msg.pack.path);
        if (!held) throw new DecoderError(`audio decoder: package ${msg.pack.pack} holds no entry "${msg.pack.path}" (not loaded, or released)`);
        if (held.entry.codec === "adpcm") {
          const done = await adpcmClip(decoder, msg, held);
          post(done ? { type: "clipDone", id: msg.id, info: done } : { type: "cancelled", id: msg.id });
          return;
        }
        bytes = held.data;
        hint = entryHint(held.entry);
      }
      const info = await decodeClip(decoder, bytes, hint, {
        onInfo: (info) => post({ type: "clipInfo", id: msg.id, info }),
        onChunk: (index, pcm) => post({ type: "clipChunk", id: msg.id, index, pcm: pcm.buffer as ArrayBuffer }, [pcm.buffer as ArrayBuffer]),
        cancelled: () => cancelled.has(msg.id),
        yieldToEvents,
        convention: msg.convention,
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

  /**
   * ADR 0351 A4: a held ADPCM entry as a clip: with load `compressed`, its blocks unchanged (info `clipFormat` 6, the core
   * decodes them per voice); otherwise decoded to int16 here (`myco_decode_adpcm`). Chunks of `CLIP_CHUNK_FRAMES` frames
   * (64 blocks) as any clip's. Returns the info, or null when cancelled.
   */
  const adpcmClip = async (decoder: DecoderWasm, msg: DecodeClipMessage, held: HeldEntry): Promise<ReturnType<typeof adpcmInfo> | null> => {
    const { entry, data } = held;
    const compressed = entry.load === "compressed";
    const info = adpcmInfo(entry, compressed);
    const pieces = adpcmPieces(entry, data, ADPCM_BLOCK_FRAMES, ADPCM_CHANNEL_BYTES, CLIP_CHUNK_FRAMES);
    post({ type: "clipInfo", id: msg.id, info });
    const pcm = compressed ? null : decoder.decodeAdpcm(data, entry.channels, entry.frames);
    for (let index = 0; index < pieces.length; index++) {
      let chunk: ArrayBuffer;
      if (pcm) {
        const from = index * CLIP_CHUNK_FRAMES * entry.channels;
        chunk = pcm.slice(from, Math.min(pcm.length, from + CLIP_CHUNK_FRAMES * entry.channels)).buffer as ArrayBuffer;
      } else {
        chunk = pieces[index]!.slice().buffer as ArrayBuffer;
      }
      post({ type: "clipChunk", id: msg.id, index, pcm: chunk }, [chunk]);
      if (cancelled.has(msg.id)) return null;
      await yieldToEvents();
      if (cancelled.has(msg.id)) return null;
    }
    return info;
  };

  /** ADR 0351 A4: a stream over a held entry: the entry's bytes (a copy: the stream decoder owns what it opens) and hint. */
  const packStream = (msg: StreamOpenMessage): StreamOpenMessage | null => {
    if (!msg.pack) return msg;
    const held = packs.entry(msg.pack.pack, msg.pack.path);
    if (!held || held.entry.codec === "adpcm") {
      post({ type: "error", streamId: msg.streamId, asset: msg.asset, message: held ? `audio decoder: "${msg.pack.path}" is ADPCM, which plays from the core's arena, not a stream` : `audio decoder: package ${msg.pack.pack} holds no entry "${msg.pack.path}" (not loaded, or released)` });
      return null;
    }
    return { ...msg, bytes: held.data.slice().buffer as ArrayBuffer, hint: entryHint(held.entry) };
  };

  // Ed1: a clip decoded in the same chunks as `clip`, each reduced at once to one [min, max] pair per `binFrames` frames
  // per channel, so no more than one chunk of PCM exists at a time and the reply is `channels * bins * 2` int16.
  const peaks = async (msg: ComputePeaksMessage): Promise<void> => {
    const fail = (e: unknown) =>
      post({ type: "error", id: msg.id, asset: msg.asset, message: describe(e), code: e instanceof DecoderError && e.code !== 0 ? e.code : undefined });
    if (!wasm) return fail(new DecoderError("audio decoder: not initialised"));
    let decoder: DecoderWasm;
    try {
      decoder = await wasm;
    } catch {
      return fail(new DecoderError(failure ?? "audio decoder: failed to load"));
    }
    const binFrames = Math.max(1, Math.floor(msg.binFrames));
    active.add(msg.id);
    try {
      let channels = 0;
      let bins = 0; // finished bins per channel
      let filled = 0; // frames in the open bin
      let capacity = 0; // bins per channel the buffers hold
      let out = new Int16Array(0); // channel-major: [channel][bin][min, max]
      let curMin: Int16Array = new Int16Array(0);
      let curMax: Int16Array = new Int16Array(0);
      const grow = (need: number) => {
        if (need <= capacity) return;
        const next = Math.max(need, capacity * 2, 64);
        const bigger = new Int16Array(channels * next * 2);
        for (let c = 0; c < channels; c++) bigger.set(out.subarray(c * capacity * 2, (c * capacity + bins) * 2), c * next * 2);
        out = bigger;
        capacity = next;
      };
      const closeBin = () => {
        grow(bins + 1);
        for (let c = 0; c < channels; c++) {
          const at = (c * capacity + bins) * 2;
          out[at] = curMin[c];
          out[at + 1] = curMax[c];
          curMin[c] = 32767;
          curMax[c] = -32768;
        }
        bins++;
        filled = 0;
      };
      const info = await decodeClip(decoder, new Uint8Array(msg.bytes), msg.hint, {
        onInfo: (i) => {
          channels = i.channels;
          curMin = new Int16Array(channels).fill(32767);
          curMax = new Int16Array(channels).fill(-32768);
          if (i.frames > 0) grow(Math.ceil(i.frames / binFrames));
        },
        onChunk: (_index, pcm) => {
          const frames = pcm.length / channels;
          for (let f = 0; f < frames; f++) {
            const base = f * channels;
            for (let c = 0; c < channels; c++) {
              const v = pcm[base + c];
              if (v < curMin[c]) curMin[c] = v;
              if (v > curMax[c]) curMax[c] = v;
            }
            if (++filled === binFrames) closeBin();
          }
        },
        cancelled: () => cancelled.has(msg.id),
        yieldToEvents,
      });
      if (!info) {
        post({ type: "cancelled", id: msg.id });
        return;
      }
      if (filled > 0) closeBin();
      // Repack to exactly `bins` per channel (the buffers may hold spare capacity).
      const packed = new Int16Array(channels * bins * 2);
      for (let c = 0; c < channels; c++) packed.set(out.subarray(c * capacity * 2, (c * capacity + bins) * 2), c * bins * 2);
      post({ type: "peaks", id: msg.id, rate: info.rate, channels, frames: info.frames, binFrames, bins, peaks: packed.buffer as ArrayBuffer }, [packed.buffer as ArrayBuffer]);
    } catch (e) {
      if (!(e instanceof DecoderError)) decoder.reset();
      fail(e);
    } finally {
      active.delete(msg.id);
      cancelled.delete(msg.id);
    }
  };

  return {
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
        case "computePeaks":
          return peaks(request);
        case "cancel":
          if (active.has(request.id)) cancelled.add(request.id);
          return;
        case "streamOpen": {
          const open = packStream(request);
          if (open) return streams.handle(open);
          return;
        }
        case "packLoad": {
          const loaded = packs.load(request.pack, request.bytes);
          post("error" in loaded ? { type: "error", pack: request.pack, message: loaded.error } : { type: "packLoaded", pack: request.pack, entries: loaded.entries, bytes: loaded.bytes });
          return;
        }
        case "packRelease":
          packs.release(request.pack);
          return;
        case "streamCredit":

        case "streamSeek":
        case "streamClose":
        case "streamLoop":
          return streams.handle(request);
        case "connectWorklet":
          ir.connectWorklet(request.port);
          return streams.handle(request);
        case "prepareIr":
        case "generateIr":
        case "releaseIr":
          return ir.handle(request);
        case "primeGroup":
        case "cancelGroup":
        case "protectMusic":
        case "releaseMusic":
        case "invalidateMusic":
          return groups.handle(request);
      }
    },
  };
}
