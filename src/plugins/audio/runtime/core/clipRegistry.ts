// Contract K9 (coordinator, MS2 wave 2): the clip registry's interface (api-and-models §3, "Clip registry").
// A1.3a fills every body; A1.4's coreBackend codes against this interface in the same wave. Don't change these
// signatures without the coordinator. H2 later loads the HRIR through it under the reserved ids 0xFFFF0000..0xFFFF00FF
// (so A3.4a's rebuild re-sends it with every other clip).

import { ClipEvent, ClipFormat, CLIP_BEGIN_FIXED_END, CLIP_CHUNK_FIXED_END, CLIP_UNLOAD_FIXED_END, Kind, MAGLS_CLIP_ID, writeClipBegin, writeClipChunk, writeClipUnload, writeEnvelope } from "../wire.generated";
import { CLIP_BYTES_PER_QUANTUM, createChunkPacer, planChunks } from "./chunker";
import { createEncodedCache } from "./encodedCache";
import { createDecoderClient, DecodeFailedError, type DecoderClient } from "../decoder/decoderClient";
import { hintFromName } from "../decoder/protocol";
import { Assets } from "../../../../engine/scene/Assets";
import type { AmbisonicImport } from "../../../../engine/scene/importSettings";
import { setFileLoopFrames, setFileLoopPoints } from "../loopPoints";
import { aacRefusal, createWarnOnce, unsupportedFormat, type WarnOnce } from "./codecs";
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
  /** Wire `ClipFormat`: 0 f32, 1 i16, 2 HRIR, 4 MagLS filters (ADR 0162). */
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
  /**
   * M2 F1: the clip's sample rate (`info(id).sampleRate`) without building an info object, or null for an unknown id;
   * the play path asks it per voice. Optional so fakes still satisfy K9 (callers fall back to `info`).
   */
  sampleRate?(id: number): number | null;
  /**
   * ADR 0158 (E3.1): the length in seconds (at pitch 1) of the clip loaded for `path`, or null while it isn't known
   * (not acquired, still loading, failed). Optional so fakes still satisfy K9.
   */
  duration?(path: string): number | null;
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
   * H2: loads an HRIR table (wire format 2) under a reserved id in 0xFFFF0000..0xFFFF00FF, or (ADR 0162 A3, C6) the
   * MagLS filters (format 4) under `MAGLS_CLIP_ID` 0xFFFF0100; any other id or pairing throws. No fetch or decode:
   * `bytes` is the finished blob (api-and-models 4.1, 0162 §4.5), sent as CLIP_BEGIN (`channels` 1, `frames` = bytes / 2
   * int16 words for format 2, bytes / 4 f32 words for format 4, header included) and paced CLIP_CHUNKs like any clip. It completes on the core's clip event
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
  /** The finished blob: format 2, an even length; format 4, a multiple of 4. */
  readonly bytes: ArrayBuffer;
  /** The rate the blob's responses are at (the context rate). */
  readonly sampleRate: number;
  /** 2 (HRIR, reserved ids 0xFFFF0000..0xFFFF00FF) or 4 (MagLS filters, `MAGLS_CLIP_ID`). */
  readonly format: 2 | 4;
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
  /**
   * B4: `audio.codecs.aac`. Off (the default), an AAC asset (`.m4a`, `.mp4`, `.aac`) fails without being fetched, with
   * one warning naming the setting; on, the host passes the AAC build's decoder client.
   */
  aac?: boolean;
  /**
   * B4: warns once per asset for files the core can't decode (AAC while it is off, a format the decoder doesn't read),
   * however often the clip is reloaded. The host shares one with its streams; default: the registry's own over `warn`.
   */
  warnOnce?: WarnOnce;
}

/**
 * ADR 0162 §2.4: whether a decoded clip of `channels` channels is playable given its sidecar's `ambisonic` block. A clip
 * over 2 channels must be ambisonic (4, 9 or 16 channels: order 1, 2 or 3); a given `order` must agree with the
 * channel count; orders 2 and 3 are WAV only (FLAC stops at 8 channels and there is no Opus decoder). `error` is the
 * load failure's detail. 1-2 channel clips aren't checked here (a sidecar on one is ignored by the caller).
 * @internal
 */
/** ADR 0162 §2.4 (B2): the import gain a FuMa clip's decode reported, by clip path (absent: 1). */
const importGains = new Map<string, number>();
const gainKey = (path: string): string => path.replace(/^asset:/, "").replace(/^\.?\//, "");

/**
 * ADR 0162 §2.4 (B2): the factor the decoder scaled a FuMa clip down by to keep it int16 (√2 for orders 1-3), which
 * multiplies the clip's import volume; 1 for every other clip and before its decode reports.
 * @internal
 */
export function ambisonicImportGain(path: string): number {
  return importGains.get(gainKey(path)) ?? 1;
}

export function checkAmbisonic(path: string, channels: number, ambisonic: AmbisonicImport | null): { readonly order: 1 | 2 | 3 } | { readonly error: string } {
  if (!ambisonic) return { error: `${channels}-channel audio needs an ambisonic import setting (ADR 0162); multichannel mixes aren't supported` };
  const inferred = channels === 4 ? 1 : channels === 9 ? 2 : channels === 16 ? 3 : null;
  if (ambisonic.order !== null) {
    const needs = (ambisonic.order + 1) ** 2;
    if (channels !== needs) return { error: `ambisonic order ${ambisonic.order} needs ${needs} channels, but the file has ${channels}` };
  } else if (inferred === null) {
    return { error: `${channels}-channel audio isn't ambisonic: first, second and third order need 4, 9 or 16 channels` };
  }
  const order = (ambisonic.order ?? inferred) as 1 | 2 | 3;
  const hint = hintFromName(path);
  if (order >= 2 && hint !== 1 && hint !== 0) return { error: `ambisonic order ${order} (${channels} channels) needs a WAV file; other formats stop at 8 channels` };
  return { order };
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

/** Bytes per wire word of a reserved blob: int16 for format 2 (HRIR), f32 for format 4 (MagLS). */
const reservedWordBytes = (format: number): number => (format === ClipFormat.MagLS ? 4 : 2);

/** Throws unless `data` is a valid reserved blob for `id` (format 2 in the HRIR range, format 4 at `MAGLS_CLIP_ID`). */
function checkReserved(id: number, data: ReservedClipData): void {
  const hrir = Number.isInteger(id) && id >= RESERVED_CLIP_FIRST && id <= RESERVED_CLIP_LAST;
  if (!hrir && id !== MAGLS_CLIP_ID) throw new Error(`audio: ${id} is not a reserved clip id`);
  const format = hrir ? ClipFormat.HRIR : ClipFormat.MagLS;
  if (data.format !== format || data.bytes.byteLength === 0 || data.bytes.byteLength % reservedWordBytes(format) !== 0) {
    throw new Error(hrir ? "audio: a reserved clip needs an even-length format 2 blob" : "audio: the MagLS clip needs a format 4 blob whose length is a multiple of 4");
  }
}

/** A reserved (HRIR or MagLS) clip: its blob stays here for paced sending and for a rebuild's re-send. */
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
  const warnOnce = deps.warnOnce ?? createWarnOnce(warn);
  const aac = deps.aac === true;
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

  /** `codecWarning`: B4, the file can't be decoded by this core at all: that warning instead, once per asset. */
  const fail = (slot: Slot, failure: ClipFailure, detail: string, codecWarning?: string): void => {
    if (slot.dead || slot.state === "failed") return;
    slot.state = "failed";
    slot.failure = failure;
    if (failure === "decode" || failure === "fetch") setFileLoopPoints(slot.path, null); // nothing will ever report: resolve waiters
    slot.parts = null;
    slot.abort?.abort();
    pacer.cancel(idOf(slot));
    if (codecWarning) warnOnce(slot.path, codecWarning);
    else warn(`audio: clip "${slot.path}" failed to load (${detail})`);
    notify(slot);
  };

  const beginReserved = (res: ReservedSlot): void => {
    res.begun = true;
    post(CLIP_BEGIN_FIXED_END, (view) => {
      envelope(view, Kind.CLIP_BEGIN, CLIP_BEGIN_FIXED_END);
      writeClipBegin(view, 0, { clipId: res.id, frames: res.samples, channels: 1, sampleRate: res.data.sampleRate, format: res.data.format });
    });
    const word = reservedWordBytes(res.data.format);
    pacer.enqueue(res.id, planChunks(res.samples, 1, word), 1, word);
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
    format: res.data.format,
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
        // Raw words of the blob (channels 1; int16 for format 2, f32 for format 4), padded to 4 bytes on the wire.
        const total = CLIP_CHUNK_FIXED_END + ((chunk.bytes + 3) & ~3);
        post(total, (view) => {
          envelope(view, Kind.CLIP_CHUNK, total);
          writeClipChunk(view, 0, { clipId: chunk.clipId, frameOffset: chunk.frameOffset, frames: chunk.frames, reserved: 0 });
          new Uint8Array(view.buffer, CLIP_CHUNK_FIXED_END, chunk.bytes).set(new Uint8Array(res.data.bytes, chunk.frameOffset * reservedWordBytes(res.data.format), chunk.bytes));
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
    const ambisonic = Assets.importSettings(slot.path).ambisonic;
    try {
      const result = await worker().decodeClip(encoded, hintFromName(slot.path), {
        signal: controller.signal,
        asset: slot.path,
        collect: false,
        // ADR 0162 §2.4 (B1): the decoder (B2) converts FuMa while decoding; it ignores this for a clip of 1-2 channels.
        convention: ambisonic?.convention,
        onInfo: (info) => {
          channels = info.channels;
          if (info.channels > 2) {
            const checked = checkAmbisonic(slot.path, info.channels, ambisonic);
            if ("error" in checked) {
              fail(slot, "decode", checked.error); // nothing was begun yet; fail() also aborts this decode
              return;
            }
            // B2: fold the FuMa headroom scale back into the clip's volume (ambisonicImportGain).
            if (info.importGain !== undefined) importGains.set(gainKey(slot.path), info.importGain);
            else importGains.delete(gainKey(slot.path));
          } else if (ambisonic) warnOnce(`${slot.path}#ambisonic`, `audio: "${slot.path}" has an ambisonic import setting but ${info.channels} channel${info.channels === 1 ? "" : "s"}; ignored (ADR 0162)`);
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
      // ADR 0158 §4 (C2): the file's own loop region, in frames; clips without one report null so waiters resolve.
      const { loopStartFrame: ls, loopEndFrame: le } = result.info;
      setFileLoopFrames(slot.path, ls !== undefined && le !== undefined ? { start: ls, end: le } : null, result.rate);
      if (streamedFrames > 0) return "streamed";
      return { frames: result.frames, channels: result.channels, sampleRate: result.rate, pieces };
    } catch (err) {
      if (stale() || slot.state === "failed") return null;
      retract(slot);
      // A worker that cannot run (DecoderUnavailableError) fails the clip like a bad file: one warning for this asset.
      // B4: a file the decoder can't read at all names its format and what is supported, once per asset.
      const detail = message(err);
      fail(slot, "decode", detail, unsupportedFormat(slot.path, aac, err instanceof DecodeFailedError ? err.code : undefined, detail) ?? undefined);
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
    // B4: AAC while `audio.codecs.aac` is off isn't fetched at all.
    const refused = aacRefusal(slot.path, aac);
    if (refused) {
      fail(slot, "decode", "AAC is off", refused);
      return null;
    }
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
    duration(path) {
      const slot = byPath.get(path);
      return slot && slot.frames > 0 && slot.sampleRate > 0 ? slot.frames / slot.sampleRate : null;
    },
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
      // As `infoOf(slot).state`, without the object (the play path asks per voice, M2 F1).
      return slot ? (slot.unloadScheduled ? "unloading" : slot.state) : "idle";
    },
    sampleRate(id) {
      const res = reserved.get(id);
      if (res) return reservedInfo(res).sampleRate;
      const slot = byId.get(id);
      return slot ? slot.sampleRate : null;
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
      checkReserved(id, data);
      if (reserved.has(id)) return;
      const res: ReservedSlot = { id, state: "copying", data, samples: data.bytes.byteLength / reservedWordBytes(data.format), begun: false, listeners: new Set() };
      reserved.set(id, res);
      beginReserved(res);
    },
    updateReserved(id, data) {
      const res = reserved.get(id);
      if (!res) return;
      checkReserved(id, data);
      pacer.cancel(id);
      res.data = data;
      res.samples = data.bytes.byteLength / reservedWordBytes(data.format);
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
