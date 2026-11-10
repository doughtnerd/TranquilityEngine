// Contract K9 (coordinator, MS2 wave 2): the clip registry's interface (api-and-models §3, "Clip registry").
// A1.3a fills every body; A1.4's coreBackend codes against this interface in the same wave. Don't change these
// signatures without the coordinator. H2 later loads the HRIR through it under the reserved ids 0xFFFF0000..0xFFFF00FF
// (so A3.4a's rebuild re-sends it with every other clip).

import { ClipEvent, ClipFormat, CLIP_BEGIN_FIXED_END, CLIP_CHUNK_FIXED_END, CLIP_UNLOAD_FIXED_END, Kind, writeClipBegin, writeClipChunk, writeClipUnload, writeEnvelope } from "../wire.generated";
import { CLIP_BYTES_PER_QUANTUM, createChunkPacer, planChunks } from "./chunker";
import { createEncodedCache } from "./encodedCache";
import { createDecoderClient, type DecoderClient } from "../decoder/decoderClient";
import { hintFromName } from "../decoder/protocol";
import { i16ToF32 } from "./pcm";

/** A clip's lifecycle (`copying -> ready` on the core's `resident` clip event, wire §4.3). */
export type ClipState = "idle" | "fetching" | "decoding" | "copying" | "ready" | "failed" | "unloading";

/** Why a clip failed, for warnings and `Audio.debug()`. */
export type ClipFailure = "fetch" | "decode" | "refusedCeiling" | "refusedGrow";

/** What the registry knows about one clip. */
export interface ClipInfo {
  /** The slot id sent to the core: index in the low bits, an 8-bit generation in the high bits (rejects stale chunks). */
  readonly id: number;
  /** The asset path the clip is keyed by (no `asset:` prefix). */
  readonly path: string;
  readonly state: ClipState;
  /** Live voices + pending plays + holding Worlds. */
  readonly refs: number;
  /** From decode; 0 until then. */
  readonly frames: number;
  readonly channels: number;
  readonly sampleRate: number;
  /** Wire `ClipFormat`: 0 f32, 1 i16, 2 HRIR. */
  readonly format: number;
  /** Bytes in the core's arena, for the `clipMemoryMB` ceiling. */
  readonly bytes: number;
  /** Set when `state` is "failed". */
  readonly failure: ClipFailure | null;
}

/** Called once when a clip becomes resident (ready) or fails. */
export type ClipResidentListener = (info: ClipInfo) => void;

/** The main-thread clip registry (one per host). */
export interface ClipRegistry {
  /**
   * Takes a reference to the clip at `path`, starting its load if it isn't loaded, and returns its id. The same
   * path always gives the same id while any reference is held. `holder` is the World key holding it (0 for none).
   * Never throws: a bad path gives an id whose state becomes "failed".
   */
  acquire(path: string, holder?: number): number;
  /** Drops one reference. At 0 refs with no holding World, the clip unloads one frame later. Unknown ids are ignored. */
  release(id: number): void;
  /** The clip's state; "idle" for an unknown id. */
  state(id: number): ClipState;
  /** Everything known about the clip, or null for an unknown id. */
  info(id: number): ClipInfo | null;
  /** Calls `listener` once when the clip is ready or failed (at once if it already is). Returns an unsubscribe. */
  onResident(id: number, listener: ClipResidentListener): () => void;
  /** Drops `key` from every clip's holders (A0.8's `onWorldReleased`). */
  releaseWorld(key: number): void;
  /** Called from the STATUS mirror for each clip event (wire `ClipEvent`: 1 resident, 2 refusedCeiling, 3 refusedGrow, 4 hrtfReady). */
  applyClipEvent(id: number, code: number): void;
  /** Ids of every clip that is ready, for a rebuild's re-send (A3.4a). Includes ready reserved (HRIR) clips. */
  residentIds(): readonly number[];
  /**
   * A3.4a, the hard rebuild: the core was replaced, so nothing is in its arena. Every clip whose CLIP_BEGIN went to
   * the old core (`copying` or `ready`) is sent again from the start: reserved (HRIR) clips first, from their kept
   * blob; then the clips in `order` (ids, the caller's priority order), then the rest. Each goes back to `fetching`
   * (re-decoded from the kept encoded bytes, else fetched again), and becomes `ready` again on the new core's
   * resident event, so `onResident` listeners added now hear about it. Decodes run in parallel, the copies begin in
   * that order. Clips still fetching or decoding are untouched: their CLIP_BEGIN will go to the new core anyway.
   * Optional so other registries (fakes) still satisfy K9.
   */
  resend?(order: readonly number[]): void;
  /**
   * H2: loads an HRIR table (wire format 2) under a reserved id in 0xFFFF0000..0xFFFF00FF (anything else throws).
   * No fetch or decode: `bytes` is the finished blob (api-and-models 4.1), sent as CLIP_BEGIN (`channels` 1, `frames`
   * = bytes / 2 int16 samples, `format` 2) and paced CLIP_CHUNKs like any clip. It completes on the core's clip event
   * 4 (hrtfReady) or 1, is never counted in the ceiling (`clipMemoryMB`), is listed by `residentIds()` once ready so a
   * rebuild re-sends it, and stays loaded until `release(id)`. A second call for an id already held is ignored.
   */
  acquireReserved(id: number, data: ReservedClipData): void;
  /**
   * A3.4c, a rebuild into a context at another rate: replaces the kept blob of a reserved clip already held (`data` is
   * the same table resampled for the new rate) without sending anything; the rebuild's `resend` then sends the new
   * blob. Chunks of the old blob still queued are dropped. Ignored for an id not held. Optional so fakes satisfy K9.
   */
  updateReserved?(id: number, data: ReservedClipData): void;
}

/** What `acquireReserved` takes. */
export interface ReservedClipData {
  /** The finished format = 2 blob; its length must be even. */
  readonly bytes: ArrayBuffer;
  /** The rate the blob's responses are at (the context rate). */
  readonly sampleRate: number;
  readonly format: 2;
}

/** The reserved HRIR clip id range (api-and-models 4.1). */
export const RESERVED_CLIP_FIRST = 0xffff0000;
export const RESERVED_CLIP_LAST = 0xffff00ff;

/**
 * What the registry needs from its host. Every field is optional so `createClipRegistry()` still compiles in A1.4's
 * code; the host (A1.4's coreBackend) passes the real ones. A1.3a's own tests pass fakes.
 */
export interface ClipRegistryDeps {
  /** Posts one CLIP_BEGIN / CLIP_CHUNK / CLIP_UNLOAD message (one ArrayBuffer, transferred) to the core. */
  send?: (message: ArrayBuffer) => void;
  /** Fetches the asset's encoded bytes (default: `fetch` of the project asset URL). Rejects on failure. */
  fetchBytes?: (path: string) => Promise<ArrayBuffer>;
  /**
   * The decoder worker's client (default `createDecoderClient()`, the page's shared worker; tests pass one on an
   * in-process worker or a fake). Clips decode there only (B6: no `decodeAudioData` on the core path): the file's own
   * rate, int16, and a clip whose container states its length starts uploading while the rest decodes. A worker that
   * cannot run (no Worker, the wasm refused or not matching, kept crashing) fails the clip loads, each with one warning.
   */
  decodeWorker?: Pick<DecoderClient, "decodeClip">;
  /** Wire `ClipFormat` for ordinary clips: 0 f32 or 1 i16 (default 1, architecture section 5: i16 halves arena use). */
  clipFormat?: number;
  /** The `clipMemoryMB` ceiling in bytes, for the registry's own accounting (default `DEFAULT_CLIP_CEILING_MB`). */
  ceilingBytes?: number;
  /** The single warning on a failed clip (default `console.warn`). */
  warn?: (message: string) => void;
  /** Runs `callback` one frame later (unload deferral; default `requestAnimationFrame`, else a 16 ms timeout). */
  nextFrame?: (callback: () => void) => void;
  /** Runs `callback` about one core quantum later (chunk pacing; default `setTimeout(callback, 0)`). */
  nextQuantum?: (callback: () => void) => void;
  /** The envelope `seq` of the next message (the host's one counter, so the core sees one sequence); default: the registry's own. */
  nextSeq?: () => number;
  /** Encoded-bytes cache cap (default 32 MB, api-and-models section 3). */
  encodedCapBytes?: number;
}

/** Ids: index in the low 24 bits, an 8-bit generation in the high bits. */
export const CLIP_INDEX_BITS = 24;
/**
 * Indices stay below this, so no id can fall in the reserved HRIR range 0xFFFF0000..0xFFFF00FF (generation 0xFF with
 * index 0xFF0000..0xFF00FF). 16.7 million live clips is not a limit anyone reaches.
 */
export const CLIP_INDEX_LIMIT = 0xff0000;

/** @internal `id` from a slot index and generation. */
export const makeClipId = (index: number, generation: number): number => (((generation & 0xff) << CLIP_INDEX_BITS) | index) >>> 0;
/** @internal The slot index of `id`. */
export const clipIndex = (id: number): number => id & 0xffffff;
/** @internal The generation of `id`. */
export const clipGeneration = (id: number): number => id >>> CLIP_INDEX_BITS;

const DEFAULT_CEILING_BYTES = 128 << 20;

interface Slot {
  readonly index: number;
  readonly generation: number;
  readonly path: string;
  state: ClipState;
  /** Acquires not yet released (voices and pending plays). */
  refs: number;
  readonly holders: Set<number>;
  frames: number;
  channels: number;
  sampleRate: number;
  format: number;
  bytes: number;
  failure: ClipFailure | null;
  /** True once CLIP_BEGIN went out, so unload must send CLIP_UNLOAD. */
  begun: boolean;
  /** Zero refs and holders: unload runs at the next frame unless something acquires first. */
  unloadScheduled: boolean;
  /** Bumped by each load (the first, and each `resend`): a load whose token is no longer current stops. */
  loads: number;
  /** Freed: async work for this slot stops. */
  dead: boolean;
  /** Interleaved int16 awaiting its paced chunks, by the frame offset of each chunk. */
  parts: Map<number, Int16Array> | null;
  /** The worker decode in flight; aborted when the load goes stale (unload, a resend) or the clip fails. */
  abort: AbortController | null;
  readonly listeners: Set<ClipResidentListener>;
}

/** A reserved (HRIR) clip: its blob stays here for paced sending and for a rebuild's re-send. */
interface ReservedSlot {
  readonly id: number;
  state: ClipState;
  data: ReservedClipData;
  samples: number;
  /** True while CLIP_BEGIN has gone out and no CLIP_UNLOAD has. */
  begun: boolean;
  readonly listeners: Set<ClipResidentListener>;
}

const defaultNextFrame = (cb: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

/**
 * A1.3a: the registry on a host's link to the core (api-and-models section 3 "Clip registry"). One slot per path
 * while it is referenced; the lifecycle is idle, fetching, decoding, copying (CLIP_BEGIN then paced CLIP_CHUNKs, at
 * most 256 KB per tick), then ready on the core's `resident` event. `info().refs` is acquires not yet released plus
 * holding Worlds; the clip unloads (CLIP_UNLOAD, one frame later) when both are 0.
 */
export function createClipRegistry(deps: ClipRegistryDeps = {}): ClipRegistry {
  const format = deps.clipFormat ?? ClipFormat.I16;
  const bytesPerSample = format === ClipFormat.F32 ? 4 : 2;
  const ceiling = deps.ceilingBytes ?? DEFAULT_CEILING_BYTES;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const nextFrame = deps.nextFrame ?? defaultNextFrame;
  const nextQuantum = deps.nextQuantum ?? ((cb: () => void) => void setTimeout(cb, 0));
  const send = deps.send ?? (() => {});
  let ownSeq = 0;
  const nextSeq = deps.nextSeq ?? (() => ownSeq++);
  const fetchBytes =
    deps.fetchBytes ??
    (async (path: string) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  let ownWorker: Pick<DecoderClient, "decodeClip"> | undefined;
  const worker = (): Pick<DecoderClient, "decodeClip"> => deps.decodeWorker ?? (ownWorker ??= createDecoderClient());
  const cache = createEncodedCache(deps.encodedCapBytes);
  const pacer = createChunkPacer();

  const byPath = new Map<string, Slot>();
  const byId = new Map<number, Slot>();
  const reserved = new Map<number, ReservedSlot>();
  const freeIndices: number[] = [];
  const generations: number[] = [];
  let nextIndex = 0;
  let pumping = false;

  const idOf = (slot: Slot): number => makeClipId(slot.index, slot.generation);
  const infoOf = (slot: Slot): ClipInfo => ({
    id: idOf(slot),
    path: slot.path,
    state: slot.unloadScheduled ? "unloading" : slot.state,
    refs: slot.refs + slot.holders.size,
    frames: slot.frames,
    channels: slot.channels,
    sampleRate: slot.sampleRate,
    format: slot.format,
    bytes: slot.bytes,
    failure: slot.failure,
  });

  const post = (bytes: number, write: (view: DataView) => void): void => {
    const buffer = new ArrayBuffer(bytes);
    write(new DataView(buffer));
    send(buffer);
  };
  const envelope = (view: DataView, kind: number, total: number): void => {
    writeEnvelope(view, 0, { kind, seq: nextSeq() >>> 0, bodyBytes: total - 16 });
  };

  const notify = (slot: Slot): void => {
    const info = infoOf(slot);
    const listeners = [...slot.listeners];
    slot.listeners.clear();
    for (const l of listeners) {
      try {
        l(info);
      } catch (err) {
        console.error("[myco] clip listener failed:", err);
      }
    }
  };

  const fail = (slot: Slot, failure: ClipFailure, detail: string): void => {
    if (slot.dead || slot.state === "failed") return;
    slot.state = "failed";
    slot.failure = failure;
    slot.parts = null;
    slot.abort?.abort();
    pacer.cancel(idOf(slot));
    warn(`audio: clip "${slot.path}" failed to load (${detail})`);
    notify(slot);
  };

  const beginReserved = (res: ReservedSlot): void => {
    res.begun = true;
    post(CLIP_BEGIN_FIXED_END, (view) => {
      envelope(view, Kind.CLIP_BEGIN, CLIP_BEGIN_FIXED_END);
      writeClipBegin(view, 0, { clipId: res.id, frames: res.samples, channels: 1, sampleRate: res.data.sampleRate, format: ClipFormat.HRIR });
    });
    pacer.enqueue(res.id, planChunks(res.samples, 1, 2), 1, 2);
    schedulePump();
  };

  const reservedInfo = (res: ReservedSlot): ClipInfo => ({
    id: res.id,
    path: "",
    state: res.state,
    refs: 1,
    frames: res.samples,
    channels: 1,
    sampleRate: res.data.sampleRate,
    format: ClipFormat.HRIR,
    bytes: 0,
    failure: null,
  });

  const loadedBytes = (): number => {
    let total = 0;
    for (const slot of byPath.values()) if (slot.state === "copying" || slot.state === "ready") total += slot.bytes;
    return total;
  };

  const pump = (): void => {
    pumping = false;
    const chunks = pacer.take(CLIP_BYTES_PER_QUANTUM);
    for (const chunk of chunks) {
      const res = reserved.get(chunk.clipId);
      if (res) {
        // Raw int16 words of the blob (channels 1), word aligned: the blob's length is even, padded to 4 on the wire.
        const total = CLIP_CHUNK_FIXED_END + ((chunk.bytes + 3) & ~3);
        post(total, (view) => {
          envelope(view, Kind.CLIP_CHUNK, total);
          writeClipChunk(view, 0, { clipId: chunk.clipId, frameOffset: chunk.frameOffset, frames: chunk.frames, reserved: 0 });
          new Uint8Array(view.buffer, CLIP_CHUNK_FIXED_END, chunk.bytes).set(new Uint8Array(res.data.bytes, chunk.frameOffset * 2, chunk.bytes));
        });
        continue;
      }
      const slot = byId.get(chunk.clipId);
      if (!slot || slot.dead) continue;
      const samples = chunk.frames * slot.channels;
      // Word aligned (api-and-models 4.1): an odd int16 sample count is padded with two zero bytes.
      const total = CLIP_CHUNK_FIXED_END + ((chunk.bytes + 3) & ~3);
      // The worker's interleaved int16, already cut at the chunk boundaries `enqueuePiece` planned.
      const data = slot.parts?.get(chunk.frameOffset);
      if (!data) continue;
      slot.parts!.delete(chunk.frameOffset);
      post(total, (view) => {
        envelope(view, Kind.CLIP_CHUNK, total);
        writeClipChunk(view, 0, { clipId: chunk.clipId, frameOffset: chunk.frameOffset, frames: chunk.frames, reserved: 0 });
        if (format === ClipFormat.F32) i16ToF32(data, new Float32Array(view.buffer, CLIP_CHUNK_FIXED_END, samples));
        else new Int16Array(view.buffer, CLIP_CHUNK_FIXED_END, samples).set(data);
      });
    }
    if (pacer.pending > 0) schedulePump();
  };
  const schedulePump = (): void => {
    if (pumping) return;
    pumping = true;
    nextQuantum(pump);
  };

  /** What a load hands `beginCopy`: the worker's interleaved int16 pieces in order. */
  interface Loaded {
    readonly frames: number;
    readonly channels: number;
    readonly sampleRate: number;
    readonly pieces: readonly Int16Array[];
  }

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** CLIP_BEGIN for a clip about to upload (or a failure past the ceiling); false when it failed. */
  const startClip = (slot: Slot, frames: number, channels: number, sampleRate: number): boolean => {
    slot.frames = frames;
    slot.channels = channels;
    slot.sampleRate = sampleRate;
    slot.format = format;
    slot.bytes = frames * channels * bytesPerSample;
    if (frames === 0 || channels === 0) {
      fail(slot, "decode", "empty clip");
      return false;
    }
    if (loadedBytes() + slot.bytes > ceiling) {
      fail(slot, "refusedCeiling", "over the clip memory ceiling");
      return false;
    }
    slot.state = "copying";
    slot.begun = true;
    post(CLIP_BEGIN_FIXED_END, (view) => {
      envelope(view, Kind.CLIP_BEGIN, CLIP_BEGIN_FIXED_END);
      writeClipBegin(view, 0, { clipId: idOf(slot), frames, channels, sampleRate, format });
    });
    return true;
  };

  /** Takes back a CLIP_BEGIN whose decode failed or must start over: the core drops the partial clip. */
  const retract = (slot: Slot): void => {
    if (!slot.begun) return;
    const id = idOf(slot);
    pacer.cancel(id);
    slot.parts = null;
    slot.begun = false;
    post(CLIP_UNLOAD_FIXED_END, (view) => {
      envelope(view, Kind.CLIP_UNLOAD, CLIP_UNLOAD_FIXED_END);
      writeClipUnload(view, 0, { clipId: id });
    });
  };

  /** Queues one decoded piece (interleaved int16 starting at frame `offset`) as paced chunks of the clip. */
  const enqueuePiece = (slot: Slot, pcm: Int16Array, offset: number): void => {
    const channels = slot.channels;
    const parts = (slot.parts ??= new Map());
    const plan = planChunks(pcm.length / channels, channels, bytesPerSample).map((c) => ({ frameOffset: offset + c.frameOffset, frames: c.frames }));
    for (const c of plan) parts.set(c.frameOffset, pcm.subarray((c.frameOffset - offset) * channels, (c.frameOffset - offset + c.frames) * channels));
    pacer.enqueue(idOf(slot), plan, channels, bytesPerSample);
    schedulePump();
  };

  /**
   * The worker path. `early`: when the container states the clip's length, CLIP_BEGIN goes out at once and each chunk
   * is queued as the worker produces it ("streamed"); otherwise (an MP3 without a length header, or `early` false)
   * the clip is decoded to its end and its pieces handed back, so CLIP_BEGIN carries the real frame count.
   */
  const decodeOnWorker = async (slot: Slot, token: number, encoded: ArrayBuffer, early: boolean): Promise<Loaded | "streamed" | null> => {
    const stale = (): boolean => slot.dead || slot.loads !== token;
    const controller = new AbortController();
    slot.abort = controller;
    const pieces: Int16Array[] = [];
    let channels = 0;
    let streamedFrames = 0; // the length CLIP_BEGIN promised; 0 when not streaming
    let received = 0;
    try {
      const result = await worker().decodeClip(encoded, hintFromName(slot.path), {
        signal: controller.signal,
        asset: slot.path,
        collect: false,
        onInfo: (info) => {
          channels = info.channels;
          if (!early || stale() || !info.lengthKnown || info.frames <= 0) return;
          if (startClip(slot, info.frames, info.channels, info.rate)) streamedFrames = info.frames;
          else controller.abort(); // failed past the ceiling
        },
        onChunk: (pcm) => {
          if (stale() || slot.state === "failed") return;
          const frames = pcm.length / channels;
          if (streamedFrames === 0) pieces.push(pcm);
          else if (received < streamedFrames) enqueuePiece(slot, frames > streamedFrames - received ? pcm.subarray(0, (streamedFrames - received) * channels) : pcm, received);
          received += frames;
        },
      });
      if (stale() || slot.state === "failed") return null;
      if (streamedFrames > 0) return "streamed";
      return { frames: result.frames, channels: result.channels, sampleRate: result.rate, pieces };
    } catch (err) {
      if (stale() || slot.state === "failed") return null;
      retract(slot);
      // A worker that cannot run (DecoderUnavailableError) fails the clip like a bad file: one warning for this asset.
      fail(slot, "decode", message(err));
      return null;
    } finally {
      if (slot.abort === controller) slot.abort = null;
    }
  };

  /**
   * Fetches (or takes the kept bytes) and decodes; null when it failed (already reported) or went stale, "streamed"
   * when the worker already began the upload (`early`). `then` runs with a decoded clip in the same tick (a first load
   * begins its copy without waiting another microtask). The worker always gives the file's own rate, a rebuild's
   * re-decode included.
   */
  const fetchDecode = async (slot: Slot, token: number, options: { early?: boolean } = {}, then?: (loaded: Loaded) => void): Promise<Loaded | "streamed" | null> => {
    const stale = (): boolean => slot.dead || slot.loads !== token;
    let encoded: ArrayBuffer;
    try {
      slot.state = "fetching";
      const cached = cache.get(slot.path);
      if (cached) encoded = cached;
      else {
        encoded = await fetchBytes(slot.path);
        if (stale()) return null;
        cache.set(slot.path, encoded);
      }
    } catch (err) {
      if (!stale()) fail(slot, "fetch", message(err));
      return null;
    }
    slot.state = "decoding";
    const result = await decodeOnWorker(slot, token, encoded, options.early === true);
    if (result && result !== "streamed") then?.(result);
    return result;
  };

  const load = (slot: Slot): Promise<unknown> => fetchDecode(slot, ++slot.loads, { early: true }, (loaded) => beginCopy(slot, loaded));

  /** CLIP_BEGIN and the paced chunks of a decoded clip (or a failure past the ceiling). */
  const beginCopy = (slot: Slot, loaded: Loaded): void => {
    if (!startClip(slot, loaded.frames, loaded.channels, loaded.sampleRate)) return;
    let offset = 0;
    for (const piece of loaded.pieces) {
      enqueuePiece(slot, piece, offset);
      offset += piece.length / loaded.channels;
    }
  };

  const allocate = (path: string): Slot => {
    const index = freeIndices.length > 0 ? freeIndices.shift()! : nextIndex++;
    if (index >= CLIP_INDEX_LIMIT) throw new Error("audio: clip slots exhausted");
    const slot: Slot = {
      index,
      generation: generations[index] ?? 0,
      path,
      state: "idle",
      refs: 0,
      holders: new Set(),
      frames: 0,
      channels: 0,
      sampleRate: 0,
      format,
      bytes: 0,
      failure: null,
      begun: false,
      unloadScheduled: false,
      loads: 0,
      dead: false,
      parts: null,
      abort: null,
      listeners: new Set(),
    };
    byPath.set(path, slot);
    byId.set(idOf(slot), slot);
    return slot;
  };

  const unload = (slot: Slot): void => {
    if (slot.dead) return;
    if (!slot.unloadScheduled || slot.refs > 0 || slot.holders.size > 0) {
      slot.unloadScheduled = false;
      return;
    }
    const id = idOf(slot);
    slot.dead = true;
    slot.parts = null;
    slot.abort?.abort(); // a worker decode in flight stops at its next chunk
    pacer.cancel(id);
    if (slot.begun) {
      post(CLIP_UNLOAD_FIXED_END, (view) => {
        envelope(view, Kind.CLIP_UNLOAD, CLIP_UNLOAD_FIXED_END);
        writeClipUnload(view, 0, { clipId: id });
      });
    }
    cache.delete(slot.path);
    byPath.delete(slot.path);
    byId.delete(id);
    generations[slot.index] = (slot.generation + 1) & 0xff;
    freeIndices.push(slot.index);
  };

  const maybeUnload = (slot: Slot): void => {
    if (slot.dead || slot.unloadScheduled || slot.refs > 0 || slot.holders.size > 0) return;
    slot.unloadScheduled = true;
    nextFrame(() => unload(slot));
  };

  return {
    acquire(path, holder = 0) {
      let slot = byPath.get(path);
      if (!slot) {
        slot = allocate(path);
        void load(slot);
      }
      slot.unloadScheduled = false;
      slot.refs++;
      if (holder > 0) slot.holders.add(holder);
      return idOf(slot);
    },
    release(id) {
      const res = reserved.get(id);
      if (res) {
        reserved.delete(id);
        pacer.cancel(id);
        if (res.begun) {
          post(CLIP_UNLOAD_FIXED_END, (view) => {
            envelope(view, Kind.CLIP_UNLOAD, CLIP_UNLOAD_FIXED_END);
            writeClipUnload(view, 0, { clipId: id });
          });
        }
        return;
      }
      const slot = byId.get(id);
      if (!slot || slot.refs === 0) return;
      slot.refs--;
      maybeUnload(slot);
    },
    state(id) {
      const res = reserved.get(id);
      if (res) return res.state;
      const slot = byId.get(id);
      return slot ? infoOf(slot).state : "idle";
    },
    info(id) {
      const res = reserved.get(id);
      if (res) return reservedInfo(res);
      const slot = byId.get(id);
      return slot ? infoOf(slot) : null;
    },
    onResident(id, listener) {
      const res = reserved.get(id);
      if (res) {
        if (res.state === "ready") {
          listener(reservedInfo(res));
          return () => {};
        }
        res.listeners.add(listener);
        return () => void res.listeners.delete(listener);
      }
      const slot = byId.get(id);
      if (!slot) return () => {};
      if (slot.state === "ready" || slot.state === "failed") {
        listener(infoOf(slot));
        return () => {};
      }
      slot.listeners.add(listener);
      return () => void slot.listeners.delete(listener);
    },
    releaseWorld(key) {
      for (const slot of [...byPath.values()]) {
        if (slot.holders.delete(key)) maybeUnload(slot);
      }
    },
    applyClipEvent(id, code) {
      const res = reserved.get(id);
      if (res) {
        if ((code === ClipEvent.HrtfReady || code === ClipEvent.Resident) && res.state === "copying") {
          res.state = "ready";
          const info = reservedInfo(res);
          const listeners = [...res.listeners];
          res.listeners.clear();
          for (const l of listeners) {
            try {
              l(info);
            } catch (err) {
              console.error("[myco] clip listener failed:", err);
            }
          }
        } else if (code === ClipEvent.RefusedCeiling || code === ClipEvent.RefusedGrow) {
          res.state = "failed";
          warn("audio: the HRIR table was refused by the core");
        }
        return;
      }
      const slot = byId.get(id);
      if (!slot || slot.dead) return;
      if (code === ClipEvent.Resident) {
        if (slot.state !== "copying") return;
        slot.state = "ready";
        notify(slot);
      } else if (code === ClipEvent.RefusedCeiling) fail(slot, "refusedCeiling", "the core refused it: over the clip memory ceiling");
      else if (code === ClipEvent.RefusedGrow) fail(slot, "refusedGrow", "the core could not grow its clip memory");
    },
    acquireReserved(id, data) {
      if (!(Number.isInteger(id) && id >= RESERVED_CLIP_FIRST && id <= RESERVED_CLIP_LAST)) throw new Error(`audio: ${id} is not a reserved clip id`);
      if (data.format !== ClipFormat.HRIR || data.bytes.byteLength === 0 || data.bytes.byteLength % 2 !== 0) throw new Error("audio: a reserved clip needs an even-length format 2 blob");
      if (reserved.has(id)) return;
      const res: ReservedSlot = { id, state: "copying", data, samples: data.bytes.byteLength / 2, begun: false, listeners: new Set() };
      reserved.set(id, res);
      beginReserved(res);
    },
    updateReserved(id, data) {
      const res = reserved.get(id);
      if (!res) return;
      if (data.format !== ClipFormat.HRIR || data.bytes.byteLength === 0 || data.bytes.byteLength % 2 !== 0) throw new Error("audio: a reserved clip needs an even-length format 2 blob");
      pacer.cancel(id);
      res.data = data;
      res.samples = data.bytes.byteLength / 2;
    },
    resend(order) {
      for (const res of reserved.values()) {
        if (!res.begun || res.state === "failed") continue;
        pacer.cancel(res.id);
        res.state = "copying";
        beginReserved(res);
      }
      const slots: Slot[] = [];
      const seen = new Set<Slot>();
      const add = (slot: Slot | undefined): void => {
        if (!slot || slot.dead || seen.has(slot) || !slot.begun || (slot.state !== "copying" && slot.state !== "ready")) return;
        seen.add(slot);
        slots.push(slot);
      };
      for (const id of order) add(byId.get(id));
      for (const slot of byPath.values()) add(slot);
      const jobs = slots.map((slot) => {
        pacer.cancel(idOf(slot));
        slot.parts = null;
        slot.abort?.abort(); // an upload still decoding on the worker starts over
        slot.begun = false;
        const token = ++slot.loads;
        // Not `early`: decode fully, then begin in the caller's priority order.
        return { slot, token, decoded: fetchDecode(slot, token) };
      });
      void (async () => {
        for (const job of jobs) {
          const decoded = await job.decoded;
          if (decoded && decoded !== "streamed" && !job.slot.dead && job.slot.loads === job.token) beginCopy(job.slot, decoded);
        }
      })();
    },
    residentIds() {
      const ids: number[] = [];
      for (const res of reserved.values()) if (res.state === "ready") ids.push(res.id);
      for (const slot of byPath.values()) if (slot.state === "ready") ids.push(idOf(slot));
      return ids;
    },
  };
}
