// Contract K9 (coordinator, MS2 wave 2): the clip registry's interface (api-and-models §3, "Clip registry").
// A1.3a fills every body; A1.4's coreBackend codes against this interface in the same wave. Don't change these
// signatures without the coordinator. H2 later loads the HRIR through it under the reserved ids 0xFFFF0000..0xFFFF00FF
// (so A3.4a's rebuild re-sends it with every other clip).

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
  /** Ids of every clip that is ready, for a rebuild's re-send (A3.4a). */
  residentIds(): readonly number[];
}

/** The decoded clip the loader hands the registry (`decodeAudioData`'s result, planar). */
export interface DecodedClip {
  readonly frames: number;
  readonly channels: number;
  readonly sampleRate: number;
  /** One Float32Array per channel, each `frames` long. */
  readonly channelData: readonly Float32Array[];
}

/**
 * What the registry needs from its host. Every field is optional so `createClipRegistry()` still compiles in A1.4's
 * code; the host (A1.4's coreBackend) passes the real ones. A1.3a's own tests pass fakes.
 */
export interface ClipRegistryDeps {
  /** Posts one CLIP_BEGIN / CLIP_CHUNK / CLIP_UNLOAD message (one ArrayBuffer, transferred) to the core. */
  send?: (message: ArrayBuffer) => void;
  /** Fetches the asset's encoded bytes (default: `fetch` of the project asset URL). Rejects on failure. */
  fetchBytes?: (path: string) => Promise<ArrayBuffer>;
  /** Decodes encoded bytes on main (default: `decodeClip` in `loader.ts` on the host's context). */
  decode?: (encoded: ArrayBuffer) => Promise<DecodedClip>;
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
  /** Encoded-bytes cache cap (default 32 MB, api-and-models section 3). */
  encodedCapBytes?: number;
}

/** Ids: index in the low 24 bits, an 8-bit generation in the high bits; 0xFFFF0000..0xFFFF00FF is never handed out. */
export const CLIP_INDEX_BITS = 24;

/** A1.3a fills this: the registry on a host's link to the core. Other code gets the registry from the host. */
export function createClipRegistry(_deps: ClipRegistryDeps = {}): ClipRegistry {
  throw new Error("not implemented: A1.3a (createClipRegistry)");
}
