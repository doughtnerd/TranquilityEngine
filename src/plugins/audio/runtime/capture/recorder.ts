// ADR 0171 amended by 0172 (M5a, task Rc2; architecture §2.1, §3.1, §3.5, §3.6, §4.1, §4.2, §7.3; api-and-models §1.2,
// §5.3-§5.5): the recorder. It owns the ring (`capture/ring.ts`) and writes the stream into it: the raw STATUS copy
// inside `CoreLink.recorderTap`, a KEYFRAME each second of **rendered** STATUS frames (ADR 0172 §2, R13) and at each
// epoch's start, EPOCH and GAP records (§5.4, §3.5), markers, and the record and segment bookkeeping the save (Rc4)
// and the live view (Rc6) read.
//
// **The lazy chunk (ground rules).** Nothing imports this file statically: `capture/capture.ts` loads it through
// `import()` on the first `start()` (Rc4 sets the loader), so a game that never captures loads no recorder.
//
// **Registering the tap.** `Recorder.attach(backend)` sets `backend.recorderTap` (the optional `AudioBackend` member;
// `CoreBackend` forwards it to `CoreLink.recorderTap`, K0) to the recorder's preallocated `tap`; `detach()` clears it.
// Rc4 calls them from `capture.ts`'s start and stop.
//
// **Zero allocation per block.** `tap` reads the envelope's `currentFrame` and copies the block in 32-bit words into
// the preallocated ring; the cadence check is arithmetic. With K0's two-argument tap the one remaining allocation is the
// `DataView` over the transferred buffer: `CoreLink.handleMessage` already holds one, and passing it as the tap's third
// argument removes it (a one-line change in `core/context.ts` and the `RecorderTap` type, the coordinator's). A keyframe
// (once a second) is built straight into the ring through Rc1b's `encodeKeyframe` from the `KeyframeSource`'s payload;
// the source must not allocate either.
import type { RecorderTap } from "../backend";
import {
  CAPTURE_KEYFRAME_INTERVAL_MS, CAPTURE_RECORD_MAX_BYTES, EPOCH_BYTES, GAP_BYTES, GapReason, RecordType, encodeEpoch, encodeGap,
  encodeKeyframe, encodeMarker, keyframeBytes, markerBytes, cutUtf8, CAPTURE_MARKER_MAX_BYTES,
  type CaptureWorkerRequest, type EpochPayload, type KeyframePayload,
} from "./format";
import { RecorderRing, ringBytesFor, type RingPreset, type RingSpan } from "./ring";
import { STATUS_BUFFER_BYTES } from "../wire.generated";

export { KEYFRAME_INDEX_SLOTS, RING_PRESET_BYTES, ringBytesFor, type RingPreset, type RingSpan } from "./ring";

/** What `capture.ts`'s `RecorderModule` sees (Rc4 widens its interface to this module's exports). */
export const recorderModule = true as const;

/**
 * The keyframe codec (contract H3). The default is `format.ts`'s `keyframeBytes` and `encodeKeyframe`, which Rc1b fills
 * in W5; until then they throw, so tests pass a placeholder (`capture/testSupport.ts` `keyframeCodecForTests`).
 */
export interface KeyframeCodec {
  bytes(p: KeyframePayload): number;
  encode(view: DataView, off: number, p: KeyframePayload): number;
}

export const FORMAT_KEYFRAME_CODEC: KeyframeCodec = { bytes: keyframeBytes, encode: encodeKeyframe };

/**
 * The main-side state at one instant (§5.5): voices, buses and lanes, metered buses, events, music, mix. Called once
 * per keyframe; it returns a payload it reuses (no allocation). Rc3/Rc4 wire the real one; the default is empty.
 */
export type KeyframeSource = () => KeyframePayload;

/** An empty keyframe (no voices, buses, meters, events or music). */
export const EMPTY_KEYFRAME: KeyframePayload = Object.freeze({
  voices: [], buses: [], metered: [], events: [], music: [],
  mix: Object.freeze({ slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 }),
});

/** A sealed segment's facts, passed with its copy (the object is reused: read it in the callback). */
export interface SealedSegmentInfo {
  segment: number;
  epoch: number;
  firstSeq: number;
  records: number;
  /** The keyframe's frame and the segment's largest frame. */
  frame: number;
  endFrame: number;
  sampleRate: number;
}

/**
 * The live view's hand-off (R17, Rc6; architecture §3.7). `post` is the Worker's `postMessage` (`profilerSource.ts`'s
 * `CaptureWorkerLike`): the recorder posts `open {source: "live", bytes: head}` once, then one `appendSegment` per sealed
 * segment, each with its buffer in the transfer list. The Worker answers `opened` and `appended` (or `error`) to the
 * client; the recorder reads no answer.
 */
export interface LiveFeedOptions {
  post(request: CaptureWorkerRequest, transfer: Transferable[]): void;
  /** The 96 B header plus raw META with no records (`assembleCapture(header, meta, [])`, the saver's, Rc4). */
  head: Uint8Array;
  /** The live capture's id: `open`'s. Each `appendSegment` takes `nextId()` (default: `id + 1`, `id + 2`, ...). */
  id: number;
  nextId?: () => number;
}

/** `Audio.debug().recorder`'s ring part (§1.3). */
export interface RecorderRingDebug {
  bytes: number;
  capacity: number;
  segments: number;
  evicted: number;
  dropped: number;
  truncated: boolean;
}

/** The context the first EPOCH names (§5.3): the rest of `EpochPayload` but `reason` and `perfMs`. */
export type EpochContext = Omit<EpochPayload, "reason" | "perfMs">;

export interface RecorderOptions {
  /** Ring size class (§4.2); default "default". */
  preset?: RingPreset;
  /** `navigator.deviceMemory` (absent on WebKit and Firefox); default read from `navigator` when it exists. */
  deviceMemory?: number;
  /** An exact ring size, overriding preset and device memory (tests). */
  ringBytes?: number;
  keyframeSource?: KeyframeSource;
  codec?: KeyframeCodec;
  /** `performance.now()`; injectable for tests. */
  now?: () => number;
}

/** Something whose `recorderTap` the recorder sets: an `AudioBackend` (optional member) or a `CoreLink`. */
export interface RecorderTapTarget {
  recorderTap?: RecorderTap | null;
}

/** `navigator.deviceMemory` when the browser reports one. */
function defaultDeviceMemory(): number | undefined {
  const nav = (globalThis as { navigator?: { deviceMemory?: unknown } }).navigator;
  return typeof nav?.deviceMemory === "number" ? nav.deviceMemory : undefined;
}

/**
 * The recorder (§2.1). `begin` writes the first EPOCH and KEYFRAME and starts the first take; `tap` takes each STATUS;
 * `epoch` opens a new core's epoch; `gap` writes a GAP; `marker` a MARKER; `newTake` (a start from Held) a GAP `held`
 * and a fresh segment the take starts at. `record` reserves any other record (Rc3's events).
 */
export class Recorder {
  readonly ring: RecorderRing;
  /** Called with a copy of each segment when the next one opens (R17: Rc6 posts it to the Worker). Copies only when set. */
  onSegmentSealed: ((segment: Uint8Array, info: SealedSegmentInfo) => void) | null = null;

  private readonly codec: KeyframeCodec;
  private keyframeSource: KeyframeSource;
  private readonly now: () => number;
  private readonly sealed: SealedSegmentInfo = { segment: 0, epoch: 0, firstSeq: 0, records: 0, frame: 0, endFrame: 0, sampleRate: 0 };
  private target: RecorderTapTarget | null = null;
  private live: { post: LiveFeedOptions["post"]; nextId: () => number; next: number } | null = null;
  /** Segments posted to the Worker's live view, and whether it ended (a segment the ring evicted before it was sent). */
  liveSegments = 0;
  liveLost = false;

  /** The current epoch (0 at `begin`, +1 per `epoch`), its sample rate, and the last keyframe's frame. */
  epochNumber = -1;
  sampleRate = 0;
  lastKeyframeFrame = 0;
  /** The newest STATUS frame (Rc3's `deferred` test, §4.1). */
  newestStatusFrame = 0;
  /** The segment the latest take starts at (R16); -1 before `begin`. */
  takeStart = -1;
  /** STATUS blocks refused for a length outside [24, `statusBytesMax`] (never expected; counted, not thrown). */
  badStatus = 0;
  /** STATUS blocks the tap took (tests, debug). */
  statusCount = 0;
  /** Set by `requestKeyframe`: the next STATUS opens a segment whatever its frame. */
  private keyframeDue = false;

  constructor(opts: RecorderOptions = {}) {
    const bytes = opts.ringBytes ?? ringBytesFor(opts.preset ?? "default", opts.deviceMemory ?? defaultDeviceMemory());
    this.ring = new RecorderRing(bytes);
    this.codec = opts.codec ?? FORMAT_KEYFRAME_CODEC;
    this.keyframeSource = opts.keyframeSource ?? (() => EMPTY_KEYFRAME);
    this.now = opts.now ?? (() => performance.now());
  }

  /**
   * The STATUS tap (architecture §3.1), preallocated: called by `CoreLink.handleMessage` after the decode and before the
   * RECYCLE with the raw block and the envelope's total bytes. `view`, when the link passes its own, saves the one
   * allocation left. Keyframes on rendered frames: the block's `currentFrame` (offset 16, §5.3) 1,000 ms of frames past
   * the last keyframe opens a segment (R13).
   */
  readonly tap = (data: ArrayBuffer, byteLength: number, view?: DataView): void => {
    if (this.epochNumber < 0) return;
    if (byteLength < 24 || byteLength > STATUS_BUFFER_BYTES || byteLength > data.byteLength) {
      this.badStatus++;
      return;
    }
    const src = view ?? new DataView(data);
    const frame = src.getFloat64(16, true);
    this.statusCount++;
    if (this.keyframeDue || frame - this.lastKeyframeFrame >= (this.sampleRate * CAPTURE_KEYFRAME_INTERVAL_MS) / 1000) {
      this.writeKeyframe(frame, true);
    }
    if (frame > this.newestStatusFrame) this.newestStatusFrame = frame;
    this.ring.copyStatus(src, byteLength, this.epochNumber, frame);
  };

  /**
   * Main-side-only frames (G7b): a backend with no STATUS (the Babylon fallback) reports its audio clock here instead of
   * through `tap`. Advances `newestStatusFrame` (the frame events are stamped at) and writes the cadence's KEYFRAME, the
   * `tap`'s own rule; writes no STATUS record (a main-side-only capture has none).
   */
  advanceFrame(frame: number): void {
    if (this.epochNumber < 0 || !(frame >= 0)) return;
    if (this.keyframeDue || frame - this.lastKeyframeFrame >= (this.sampleRate * CAPTURE_KEYFRAME_INTERVAL_MS) / 1000) this.writeKeyframe(frame, true);
    if (frame > this.newestStatusFrame) this.newestStatusFrame = frame;
  }

  /** Ring content seconds (`Audio.capture.seconds`). */
  get seconds(): number {
    return this.ring.seconds;
  }

  /** Ring bytes held (`Audio.capture.bytes`). */
  get bytes(): number {
    return this.ring.usedBytes;
  }

  /** True when an eviction passed the latest take's start (§4.2): the file then begins at a later keyframe. */
  get truncated(): boolean {
    return this.takeStart >= 0 && this.ring.firstSegment > this.takeStart;
  }

  /**
   * Starts the live view (R17): posts `open` with the head, then the take's already sealed segments (those the ring still
   * holds), and from then on each segment as it seals (every second of rendered STATUS frames, never a timer). If the ring
   * already evicted the take's start the view begins at the oldest kept segment, which the Worker's decoder takes as it
   * takes a truncated file. A second call replaces the first feed (the old Worker capture is the client's to close).
   */
  startLive(opts: LiveFeedOptions): void {
    let id = opts.id;
    this.live = { post: opts.post, nextId: opts.nextId ?? (() => ++id), next: -1 };
    this.liveLost = false;
    this.liveSegments = 0;
    const head = opts.head.slice().buffer as ArrayBuffer;
    opts.post({ type: "open", id: opts.id, source: "live", bytes: head }, [head]);
    const ring = this.ring;
    let from = Math.max(this.takeStart < 0 ? ring.firstSegment : this.takeStart, ring.firstSegment);
    for (; from < ring.openSegment; from++) this.postSegment(from, ring.copySegment(from));
    this.live.next = from;
  }

  /** Stops posting segments (the client closes the Worker's capture with `close`). */
  stopLive(): void {
    this.live = null;
  }

  /** Replace the keyframe source (Rc3/Rc4 wire the backend's state once the backend exists). */
  setKeyframeSource(source: KeyframeSource): void {
    this.keyframeSource = source;
  }

  /** Sets `target.recorderTap` to `tap` (Rc4: `capture.ts` start, with the running backend). */
  attach(target: RecorderTapTarget): void {
    if (this.target && this.target !== target) this.detach();
    this.target = target;
    target.recorderTap = this.tap;
  }

  /** Clears the tap it set (Rc4: the last owner's stop, Held; Released). */
  detach(): void {
    if (this.target && this.target.recorderTap === this.tap) this.target.recorderTap = null;
    this.target = null;
  }

  /**
   * The recording's first records (§2.1 "header + audio section + keyframe"; the header and META are the saver's): an
   * EPOCH `start` at `frame` (the core's current frame) opening epoch 0's first segment, then a KEYFRAME. Starts the take.
   */
  begin(frame: number, context: EpochContext): void {
    this.epochNumber = -1;
    this.openEpoch(0, frame, context);
    this.takeStart = this.ring.openSegment;
  }

  /**
   * A new core's epoch (§4.1; `reason` one of `EpochReason` but `start`): an EPOCH at `frame` (the new context's, usually
   * 0) opening a segment, then a KEYFRAME. The previous segment is sealed.
   */
  epoch(reason: number, frame: number, context: EpochContext): void {
    this.openEpoch(reason, frame, context);
  }

  /** A GAP (§3.5, §5.3) at `frame`: known events only (paused, rebuild, held, dropped, recordTooLarge). */
  gap(reason: number, frame: number, perfFrom: number, perfTo: number, firstSeq = 0, lastSeq = 0): void {
    const off = this.ring.record(RecordType.GAP, 0, this.epochNumber, frame, GAP_BYTES);
    if (off >= 0) encodeGap(this.ring.view, off, { reason, perfFrom, perfTo, firstSeq, lastSeq });
  }

  /** A MARKER at `frame` (owner joins, Compare swaps, `Audio.capture.mark`), cut to 120 UTF-8 bytes. Allocates its text. */
  marker(text: string, frame: number): void {
    const p = { perfMs: this.now(), text: cutUtf8(text, CAPTURE_MARKER_MAX_BYTES) };
    const off = this.ring.record(RecordType.MARKER, 0, this.epochNumber, frame, markerBytes(p));
    if (off >= 0) encodeMarker(this.ring.view, off, p);
  }

  /**
   * A start from Held (§2.1, R16): a GAP `held` from `heldSincePerf` to now, then a segment opened at once at `frame`
   * (a KEYFRAME) that the new take starts at. Older takes stay in the ring.
   */
  newTake(frame: number, heldSincePerf: number): void {
    this.gap(GapReason.held, frame, heldSincePerf, this.now());
    this.writeKeyframe(frame, true);
    this.takeStart = this.ring.openSegment;
  }

  /** The next STATUS opens a segment (a keyframe) whatever its frame. */
  requestKeyframe(): void {
    this.keyframeDue = true;
  }

  /**
   * Reserves any other record (Rc3's EVENT, NAMES, MIXOP): writes its head in the current epoch and returns the payload
   * offset in `ring.view`, or -1 when dropped. The caller writes exactly `len` bytes there before the next record.
   */
  record(type: number, frame: number, len: number, flags = 0): number {
    if (this.epochNumber < 0 || len > CAPTURE_RECORD_MAX_BYTES) return -1;
    return this.ring.record(type, flags, this.epochNumber, frame, len);
  }

  /** The latest take's span for the save (Rc4): from its start segment, or the oldest kept when truncated. */
  takeSpan(): RingSpan {
    return this.ring.copyRecords(this.takeStart < 0 ? this.ring.firstSegment : this.takeStart);
  }

  /** The take's `truncatedFromSeq` (§5.4): the first kept seq when truncated, else 0. */
  get truncatedFromSeq(): number {
    return this.truncated ? this.ring.segFirstSeq[this.ring.rowOf(this.ring.firstSegment)]! : 0;
  }

  /** `Audio.debug().recorder`'s ring fields (allocates the result; debug only). */
  debug(): RecorderRingDebug {
    const r = this.ring;
    return { bytes: r.usedBytes, capacity: r.capacity, segments: r.segments, evicted: r.evicted, dropped: r.dropped, truncated: this.truncated };
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  private openEpoch(reason: number, frame: number, context: EpochContext): void {
    this.epochNumber++;
    this.sampleRate = context.sampleRate;
    this.sealOpen();
    const off = this.ring.record(RecordType.EPOCH, 0, this.epochNumber, frame, EPOCH_BYTES, true, this.sampleRate);
    if (off >= 0) {
      encodeEpoch(this.ring.view, off, {
        reason, sampleRate: context.sampleRate, limiterLatencyFrames: context.limiterLatencyFrames,
        outputLatencyFrames: context.outputLatencyFrames, timeOffset: context.timeOffset, perfMs: this.now(),
      });
    }
    this.newestStatusFrame = frame;
    this.writeKeyframe(frame, false);
  }

  /**
   * A KEYFRAME at `frame`, encoded straight into the ring (R13). `opens`: it opens a new segment (sealing the previous
   * one); otherwise it follows its segment's EPOCH. A pending dropped-records GAP follows it.
   */
  private writeKeyframe(frame: number, opens: boolean): void {
    const p = this.keyframeSource();
    const len = this.codec.bytes(p);
    if (opens) this.sealOpen();
    const off = this.ring.record(RecordType.KEYFRAME, 0, this.epochNumber, frame, len, opens, this.sampleRate);
    if (off >= 0) this.codec.encode(this.ring.view, off, p);
    this.lastKeyframeFrame = frame;
    this.keyframeDue = false;
    const ring = this.ring;
    if (ring.droppedFirstSeq !== 0) {
      const first = ring.droppedFirstSeq;
      const last = ring.droppedLastSeq;
      ring.clearDropped();
      const t = this.now();
      this.gap(GapReason.dropped, frame, t, t, first, last);
    }
  }

  /** Hands the open segment to `onSegmentSealed` (a copy) before the next one opens. */
  private sealOpen(): void {
    const ring = this.ring;
    const id = ring.openSegment;
    const live = this.live;
    if (id < 0 || (!this.onSegmentSealed && !live)) return;
    const r = ring.rowOf(id);
    const info = this.sealed;
    info.segment = id;
    info.epoch = ring.segEpoch[r]!;
    info.firstSeq = ring.segFirstSeq[r]!;
    info.records = ring.segRecords[r]!;
    info.frame = ring.segFrame[r]!;
    info.endFrame = ring.segEndFrame[r]!;
    info.sampleRate = ring.segRate[r]!;
    const copy = ring.copySegment(id);
    this.onSegmentSealed?.(copy, info);
    if (live) this.postSegment(id, copy);
  }

  /**
   * Posts segment `id` to the live view, transferring `bytes` (so a caller's `onSegmentSealed` must be done with its copy
   * by then, as it is: the callback runs first and a copy it keeps is detached). Segments go in order; one the ring
   * evicted before its turn ends the view (`liveLost`), since the Worker's decoder checks seq continuity.
   */
  private postSegment(id: number, bytes: Uint8Array): void {
    const live = this.live;
    if (!live || this.liveLost) return;
    if (live.next >= 0 && id !== live.next) {
      this.liveLost = true;
      return;
    }
    live.next = id + 1;
    this.liveSegments++;
    const buffer = bytes.buffer as ArrayBuffer;
    live.post({ type: "appendSegment", id: live.nextId(), bytes: buffer }, [buffer]);
  }
}

/** The chunk's factory (Rc4: `capture.ts` calls it once the module loads). */
export function createRecorder(opts: RecorderOptions = {}): Recorder {
  return new Recorder(opts);
}
