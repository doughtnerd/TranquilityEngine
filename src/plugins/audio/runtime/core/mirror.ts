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

  /** Forgets the peaks (a bus remap: the indices they were reported for no longer mean the same buses). */
  resetPeaks(): void {
    this.peakL.fill(0);
    this.peakR.fill(0);
    this.peakCount = 0;
  }

  /**
   * Api §3 / §4.3: one STATUS block into the mirror. Voice sections, in order: `ended` (`table.markEnded`), `demoted`
   * (`markDemoted`), `starved` (`markStarved`), `playheads` (`setPlayhead`); stale ids are ignored by the table.
   * `clipEvents` and `streamEvents` queue; `peaks` replace `peakL/peakR` for `peaks.length` buses (the rest keep
   * their values, `peakCount` says how many are current); header values take the newest; `minSlackSinceFrame` takes
   * the minimum; `framePair` the newest. Then, if `freeEndedInMessage`, `table.freeEnded()`. Allocates nothing.
   */
  apply(status: StatusBlock): void {
    const table = this.table;
    this.blocks++;
    // Voice sections, in §4.3's order. Indexed loops: no iterator objects.
    const ended = status.ended;
    for (let k = 0; k < ended.length; k++) table.markEnded(ended[k]!);
    const demoted = status.demoted;
    for (let k = 0; k < demoted.length; k++) table.markDemoted(demoted[k]!);
    const starved = status.starved;
    for (let k = 0; k < starved.length; k++) table.markStarved(starved[k]!);
    const playheads = status.playheads;
    for (let k = 0; k < playheads.length; k++) table.setPlayhead(playheads[k]!.id, playheads[k]!.clipFrame);
    const clipEvents = status.clipEvents;
    for (let k = 0; k < clipEvents.length; k++) this.pushClip(clipEvents[k]!.clipId, clipEvents[k]!.code);
    const streamEvents = status.streamEvents;
    for (let k = 0; k < streamEvents.length; k++) this.pushStream(streamEvents[k]!.id, streamEvents[k]!.code);
    const peaks = status.peaks;
    const n = peaks.length < MAX_BUSES ? peaks.length : MAX_BUSES;
    for (let b = 0; b < n; b++) {
      this.peakL[b] = peaks[b]!.l;
      this.peakR[b] = peaks[b]!.r;
    }
    this.peakCount = n;
    // Header: the newest block wins.
    this.currentFrame = status.currentFrame;
    this.dateMs = status.dateMs;
    this.pingSeq = status.pingSeq;
    this.pingFrameLo = status.pingFrameLo;
    this.underruns = status.underruns;
    this.lateCommands = status.lateCommands;
    this.workUnits = status.workUnits;
    this.workUnitsMax = status.workUnitsMax;
    this.mixedVoices = status.mixedVoices;
    this.liveVoices = status.liveVoices;
    this.flags = status.flags;
    this.mixedCap = status.mixedCap;
    this.loadPermille = status.loadPermille;
    this.traps = status.traps;
    this.underrunFrames = status.underrunFrames;
    this.arenaUsedKB = status.arenaUsedKB;
    this.arenaLargestFreeKB = status.arenaLargestFreeKB;
    this.maxLatenessFrames = status.maxLatenessFrames;
    this.hrtfVoices = status.hrtfVoices;
    this.hrtfLoadFailure = status.hrtfLoadFailure;
    if (this.abiVersion === 0 && status.abiVersion !== 0) this.abiVersion = status.abiVersion;
    this.minSlackFrames = status.minSlackFrames;
    if (status.minSlackFrames < this.minSlackSinceFrame) this.minSlackSinceFrame = status.minSlackFrames;
    this.frameAudio = status.currentFrame;
    this.frameDateMs = status.dateMs;
    if (this.freeEndedInMessage) table.freeEnded();
  }

  /**
   * The per-frame system's start: returns `minSlackSinceFrame` and resets it to `Infinity`, so each frame sees the
   * minimum since the previous one (§3).
   */
  beginFrame(): number {
    const min = this.minSlackSinceFrame;
    this.minSlackSinceFrame = Number.POSITIVE_INFINITY;
    return min;
  }

  /** Sends every queued clip event, oldest first, to `sink` and empties the queue (A1.3a's registry, per frame). */
  drainClipEvents(sink: MirrorEventSink): number {
    const n = this.clipCount;
    let head = this.clipHead;
    // Emptied first (past the drained range), so an event pushed from inside the sink waits for the next drain.
    this.clipCount = 0;
    this.clipHead = (head + n) % MIRROR_EVENT_CAPACITY;
    for (let k = 0; k < n; k++) {
      sink.event(this.clipIds[head]!, this.clipCodes[head]!);
      head = (head + 1) % MIRROR_EVENT_CAPACITY;
    }
    return n;
  }

  /** Sends every queued stream event, oldest first, to `sink` and empties the queue (M1b). */
  drainStreamEvents(sink: MirrorEventSink): number {
    const n = this.streamCount;
    let head = this.streamHead;
    this.streamCount = 0;
    this.streamHead = (head + n) % MIRROR_EVENT_CAPACITY;
    for (let k = 0; k < n; k++) {
      sink.event(this.streamIds[head]!, this.streamCodes[head]!);
      head = (head + 1) % MIRROR_EVENT_CAPACITY;
    }
    return n;
  }

  /** Queues a clip event; a full queue drops its oldest (counted in `droppedEvents`). */
  private pushClip(id: number, code: number): void {
    if (this.clipCount === MIRROR_EVENT_CAPACITY) {
      this.clipHead = (this.clipHead + 1) % MIRROR_EVENT_CAPACITY;
      this.clipCount--;
      this.droppedEvents++;
    }
    const at = (this.clipHead + this.clipCount) % MIRROR_EVENT_CAPACITY;
    this.clipIds[at] = id;
    this.clipCodes[at] = code;
    this.clipCount++;
  }

  /** Queues a stream event; a full queue drops its oldest (counted in `droppedEvents`). */
  private pushStream(id: number, code: number): void {
    if (this.streamCount === MIRROR_EVENT_CAPACITY) {
      this.streamHead = (this.streamHead + 1) % MIRROR_EVENT_CAPACITY;
      this.streamCount--;
      this.droppedEvents++;
    }
    const at = (this.streamHead + this.streamCount) % MIRROR_EVENT_CAPACITY;
    this.streamIds[at] = id;
    this.streamCodes[at] = code;
    this.streamCount++;
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
