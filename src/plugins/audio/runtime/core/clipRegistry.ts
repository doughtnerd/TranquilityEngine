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

/** A1.3a fills this: the registry on a host's link to the core. A1.3a may add parameters (the link, the preset);
 * other code gets the registry from the host, never by calling this. */
export function createClipRegistry(): ClipRegistry {
  throw new Error("not implemented: A1.3a (createClipRegistry)");
}
