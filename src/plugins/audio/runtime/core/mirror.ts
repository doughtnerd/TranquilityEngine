// The status mirror (ADR 0157; api-and-models §3 "Status mirror", §4.3; architecture §1, §3.2, §3.8, §4.1, §4.2):
// every STATUS block the core posts is applied here in the host's `onmessage` (`CoreLink.onStatus`), never waiting
// for a frame, so `playing`, `reason`, playheads, peaks and counters stay fresh with frames stopped. Voice sections
// go into the voice table (ended, demoted, starved, playheads); clip and stream events queue for their owners (the
// clip registry, A1.3a; streams, M1b); peaks and counters take the newest; `minSlackFrames` the minimum since the
// last frame; `framePair` feeds the clock map (A1.4). All storage is preallocated: applying a block allocates nothing.
//
// (`readStatus`, which `CoreLink` runs before calling listeners, still builds a `StatusBlock` per block; that object
// is the link's, not the mirror's.)
import { MAX_BUSES } from "../../../../engine/audio/settings";
import type { StatusBlock } from "../wire.generated";
import type { CoreLink } from "./context";
import type { VoiceTable } from "./voiceTable";

/** @internal Clip and stream events held between frames before the oldest are dropped (and counted). */
export const MIRROR_EVENT_CAPACITY = 1024;

/** @internal Where `drainClipEvents` / `drainStreamEvents` send queued events (one long-lived object per owner). */
export interface MirrorEventSink {
  event(id: number, code: number): void;
}

/** @internal The main-thread mirror of the core's STATUS (api §3). */
export class StatusMirror {
  /** STATUS blocks applied. */
  blocks = 0;
  /**
   * True while the page is hidden (A3.4b sets it): `apply` then frees ended slots itself (`table.freeEnded()`),
   * since no frame will (architecture §3.8).
   */
  freeEndedInMessage = false;

  // --- Newest header values (§4.3) ---
  currentFrame = 0;
  dateMs = 0;
  pingSeq = 0;
  pingFrameLo = 0;
  underruns = 0;
  lateCommands = 0;
  workUnits = 0;
  workUnitsMax = 0;
  mixedVoices = 0;
  liveVoices = 0;
  flags = 0;
  mixedCap = 0;
  loadPermille = 0;
  traps = 0;
  underrunFrames = 0;
  arenaUsedKB = 0;
  arenaLargestFreeKB = 0;
  maxLatenessFrames = 0;
  hrtfVoices = 0;
  hrtfLoadFailure = 0;
  /** The first non-zero `abiVersion` seen (only the first block carries it). */
  abiVersion = 0;
  /** The newest block's `minSlackFrames`. */
  minSlackFrames = 0;
  /** The minimum `minSlackFrames` since the last `beginFrame` (`Infinity` if no block arrived since). */
  minSlackSinceFrame = Number.POSITIVE_INFINITY;
  /** §3 `framePair`: the newest block's `currentFrame` and `dateMs`, for the clock map. */
  frameAudio = 0;
  frameDateMs = 0;

  // --- Peaks (§4.3 `peaks`, newest block; index = bus) ---
  readonly peakL = new Float32Array(MAX_BUSES);
  readonly peakR = new Float32Array(MAX_BUSES);
  /** How many buses the newest block reported peaks for. */
  peakCount = 0;

  // --- Event queues (ring buffers, preallocated) ---
  /** Clip and stream events dropped because their queue was full. */
  droppedEvents = 0;
  private readonly clipIds = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private readonly clipCodes = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private clipHead = 0;
  private clipCount = 0;
  private readonly streamIds = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private readonly streamCodes = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private streamHead = 0;
  private streamCount = 0;

  private readonly listener = (status: StatusBlock): void => this.apply(status);

  constructor(readonly table: VoiceTable) {}

  /** Applies every STATUS the link receives, in its `onmessage`. Returns the unsubscribe. */
  attach(link: Pick<CoreLink, "onStatus">): () => void {
    return link.onStatus(this.listener);
  }

  /**
   * Api §3 / §4.3: one STATUS block into the mirror. Voice sections, in order: `ended` (`table.markEnded`), `demoted`
   * (`markDemoted`), `starved` (`markStarved`), `playheads` (`setPlayhead`); stale ids are ignored by the table.
   * `clipEvents` and `streamEvents` queue; `peaks` replace `peakL/peakR` for `peaks.length` buses (the rest keep
   * their values, `peakCount` says how many are current); header values take the newest; `minSlackSinceFrame` takes
   * the minimum; `framePair` the newest. Then, if `freeEndedInMessage`, `table.freeEnded()`. Allocates nothing.
   */
  apply(status: StatusBlock): void {
    throw new Error("not implemented: A1.1");
  }

  /**
   * The per-frame system's start: returns `minSlackSinceFrame` and resets it to `Infinity`, so each frame sees the
   * minimum since the previous one (§3).
   */
  beginFrame(): number {
    throw new Error("not implemented: A1.1");
  }

  /** Sends every queued clip event, oldest first, to `sink` and empties the queue (A1.3a's registry, per frame). */
  drainClipEvents(sink: MirrorEventSink): number {
    throw new Error("not implemented: A1.1");
  }

  /** Sends every queued stream event, oldest first, to `sink` and empties the queue (M1b). */
  drainStreamEvents(sink: MirrorEventSink): number {
    throw new Error("not implemented: A1.1");
  }

  /** Queued clip events. */
  get pendingClipEvents(): number {
    return this.clipCount;
  }

  /** Queued stream events. */
  get pendingStreamEvents(): number {
    return this.streamCount;
  }
}

/**
 * @internal Tests: a STATUS block with every header field 0, every section empty, then `fields` laid over it. Builds
 * the object the link would hand to `StatusMirror.apply`.
 */
export function makeStatusBlock(fields: Partial<StatusBlock> = {}): StatusBlock {
  return {
    currentFrame: 0,
    dateMs: 0,
    pingSeq: 0,
    pingFrameLo: 0,
    underruns: 0,
    lateCommands: 0,
    workUnits: 0,
    workUnitsMax: 0,
    mixedVoices: 0,
    liveVoices: 0,
    flags: 0,
    mixedCap: 0,
    loadPermille: 0,
    traps: 0,
    minSlackFrames: 0,
    underrunFrames: 0,
    arenaUsedKB: 0,
    arenaLargestFreeKB: 0,
    abiVersion: 0,
    maxLatenessFrames: 0,
    hrtfVoices: 0,
    hrtfLoadFailure: 0,
    ended: [],
    demoted: [],
    starved: [],
    playheads: [],
    clipEvents: [],
    streamEvents: [],
    peaks: [],
    ...fields,
  };
}
