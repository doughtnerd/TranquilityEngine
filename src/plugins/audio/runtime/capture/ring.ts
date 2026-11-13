// ADR 0171 amended by 0172 (M5a, task Rc2; architecture §4.2, §3.6, §6; api-and-models §5.3, §5.4, §5.7): the recorder
// ring. One preallocated `ArrayBuffer` of R bytes holds records in seq order, contiguous, each a 20 B head then its
// payload (§5.3); a record that doesn't fit before the buffer's end follows a ring-only WRAP marker and is written at
// offset 0. A preallocated segment table (`KEYFRAME_INDEX_SLOTS` = 4,096 rows, struct of arrays) says where each
// keyframe segment starts; eviction drops whole segments from the oldest, so the tail is always a segment's first
// record and any kept span decodes alone (§3.6, [S3]).
//
// **Zero allocation per record** (ground rules): placing, wrapping, evicting and the STATUS word copy touch only the
// preallocated buffer and tables. `copySegment` (the live hand-off, R17) and `copyRecords` (the save, R16) allocate
// their output: those, names and saves are the only allocations (§4.2).
//
// Loaded only inside the recorder chunk: `capture/recorder.ts` is its one importer (and is itself loaded only through
// `capture/capture.ts`'s dynamic import), so a game that never captures loads neither.
import { CAPTURE_RECORD_HEAD_BYTES, CAPTURE_RECORD_MAX_BYTES, RecordType, type IndexEntry } from "./format";

/** Segment table rows (R13): 4,096 one-second segments, 68 minutes. A new segment past it evicts the oldest. */
export const KEYFRAME_INDEX_SLOTS = 4096;
/** The smallest ring on any device (§4.2: "never below 4 MiB"). */
export const RING_MIN_BYTES = 4 * 1024 * 1024;
/** §4.2: the ring is at most this many bytes per GB `navigator.deviceMemory` reports (16 MiB on a 2 GB device). */
export const RING_BYTES_PER_GB = 8 * 1024 * 1024;

/** The ring's size class: the audio preset, or the editor's Play (§4.2's table). */
export type RingPreset = "low" | "default" | "high" | "editor";

/** §4.2: the preset sizes (record §8, est.). */
export const RING_PRESET_BYTES: Readonly<Record<RingPreset, number>> = {
  low: 4 * 1024 * 1024,
  default: 16 * 1024 * 1024,
  high: 32 * 1024 * 1024,
  editor: 32 * 1024 * 1024,
};

/**
 * §4.2: R = min(preset size, 8 MiB x `deviceMemory`), never below 4 MiB; without `deviceMemory` (WebKit, Firefox, or a
 * value that isn't a positive finite number) R is the preset size. A 2 GB device gets at most 16 MiB (a real platform
 * limit, not a tripwire).
 */
export function ringBytesFor(preset: RingPreset, deviceMemory?: number): number {
  const size = RING_PRESET_BYTES[preset];
  if (deviceMemory === undefined || !(Number.isFinite(deviceMemory) && deviceMemory > 0)) return size;
  return Math.max(RING_MIN_BYTES, Math.min(size, Math.floor(RING_BYTES_PER_GB * deviceMemory)));
}

/** Segment ids are monotonic from 0; a row is `id % KEYFRAME_INDEX_SLOTS`. */
function row(id: number): number {
  return id % KEYFRAME_INDEX_SLOTS;
}

/** What `copyRecords` returns: the span the save (Rc4) compresses, and its INDEX entries (§5.4). */
export interface RingSpan {
  /** The records in seq order, WRAP markers stripped. */
  bytes: Uint8Array;
  recordCount: number;
  /** One per KEYFRAME, `byteOffset` from the start of `bytes` (the INDEX's "from the start of the records"). */
  keyframes: IndexEntry[];
  /** The first kept segment's keyframe frame (the header's `firstFrame`) and its epoch's sample rate. */
  firstFrame: number;
  sampleRate: number;
  /** The span's first record's seq. */
  firstSeq: number;
}

/**
 * The ring (§4.2). Records are written by `record` (head, then the caller fills the payload at the returned offset in
 * `view`) or `copyStatus` (head and the raw block). The first record of a segment is written with `opensSegment`; the
 * segment's KEYFRAME sets its frame. The recorder (`capture/recorder.ts`) drives cadence, epochs and gaps.
 */
export class RecorderRing {
  /** The one buffer (R bytes); never replaced. */
  readonly bytes: Uint8Array;
  /** A `DataView` over `bytes`; record payloads are written through it. */
  readonly view: DataView;
  readonly capacity: number;

  // Segment table (struct of arrays, preallocated, never grown).
  /** Byte offset of the segment's first record. */
  readonly segStart = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  /** Byte offset of the segment's KEYFRAME head (0xffffffff until written). */
  readonly segKeyframe = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  /** The KEYFRAME's seq. */
  readonly segKeySeq = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  /** The segment's first record's seq. */
  readonly segFirstSeq = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  /** Records and bytes in the segment (WRAP markers excluded). */
  readonly segRecords = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  readonly segBytes = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  readonly segEpoch = new Uint16Array(KEYFRAME_INDEX_SLOTS);
  /** The epoch's sample rate. */
  readonly segRate = new Uint32Array(KEYFRAME_INDEX_SLOTS);
  /** The KEYFRAME's frame, and the largest frame written in the segment. */
  readonly segFrame = new Float64Array(KEYFRAME_INDEX_SLOTS);
  readonly segEndFrame = new Float64Array(KEYFRAME_INDEX_SLOTS);

  /** The oldest kept segment's id, and one past the open segment's (`firstSegment === nextSegment` while empty). */
  firstSegment = 0;
  nextSegment = 0;
  /** Next write offset; the oldest kept byte (the first segment's start); where the WRAP marker sits while wrapped. */
  head = 0;
  tail = 0;
  wrapAt = -1;
  /** The next record's seq (capture-wide, +1 per record, §5.3). */
  seq = 1;
  /** Segments evicted, records dropped (a record that couldn't fit beside the open segment), and their seq range. */
  evicted = 0;
  dropped = 0;
  droppedFirstSeq = 0;
  droppedLastSeq = 0;
  /** Bytes held by kept records (WRAP markers excluded). */
  usedBytes = 0;
  /** Called with a segment's id when it is evicted (before its row is reused). */
  onEvict: ((segment: number) => void) | null = null;

  constructor(capacity: number) {
    if (!(Number.isInteger(capacity) && capacity >= 2 * (CAPTURE_RECORD_MAX_BYTES + 2 * CAPTURE_RECORD_HEAD_BYTES))) {
      throw new Error(`RecorderRing: capacity ${capacity} is too small for two of the largest records`);
    }
    this.capacity = capacity;
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
  }

  /** The open segment's id, or -1 while empty. */
  get openSegment(): number {
    return this.nextSegment > this.firstSegment ? this.nextSegment - 1 : -1;
  }

  /** Kept segments, the open one included. */
  get segments(): number {
    return this.nextSegment - this.firstSegment;
  }

  /** Whether segment `id` is still in the ring. */
  holds(id: number): boolean {
    return id >= this.firstSegment && id < this.nextSegment;
  }

  /** Row of a kept segment (for reading the `seg*` tables). */
  rowOf(id: number): number {
    return row(id);
  }

  /** Seconds of rendered frames the kept segments span (each segment at its epoch's rate). */
  get seconds(): number {
    let s = 0;
    for (let id = this.firstSegment; id < this.nextSegment; id++) {
      const r = row(id);
      if (this.segRate[r]! > 0) s += (this.segEndFrame[r]! - this.segFrame[r]!) / this.segRate[r]!;
    }
    return s;
  }

  /**
   * Writes a record head of `len` payload bytes and returns the payload's offset in `bytes`/`view` (the caller writes
   * exactly `len` bytes there, now), or -1 when the record was dropped: it can't fit beside the open segment, or no
   * segment is open and `opensSegment` is false. With `opensSegment` a new segment starts at this record (the segment
   * table full evicts the oldest first). Consumes one seq either way (a dropped record is a seq jump, §4.1).
   */
  record(type: number, flags: number, epoch: number, frame: number, len: number, opensSegment = false, rate = 0): number {
    const seq = this.seq++;
    if (!opensSegment && this.nextSegment === this.firstSegment) return this.drop(seq);
    if (opensSegment && this.nextSegment - this.firstSegment >= KEYFRAME_INDEX_SLOTS) this.evictOldest(true);
    const n = CAPTURE_RECORD_HEAD_BYTES + len;
    const off = this.place(n, opensSegment);
    if (off < 0) return this.drop(seq);
    if (opensSegment) {
      const r = row(this.nextSegment++);
      this.segStart[r] = off;
      this.segKeyframe[r] = 0xffffffff;
      this.segKeySeq[r] = 0;
      this.segFirstSeq[r] = seq;
      this.segRecords[r] = 0;
      this.segBytes[r] = 0;
      this.segEpoch[r] = epoch;
      this.segRate[r] = rate;
      this.segFrame[r] = frame;
      this.segEndFrame[r] = frame;
      if (this.nextSegment - this.firstSegment === 1) this.tail = off;
    }
    const r = row(this.nextSegment - 1);
    const v = this.view;
    v.setUint8(off, type);
    v.setUint8(off + 1, flags);
    v.setUint16(off + 2, epoch, true);
    v.setUint32(off + 4, len, true);
    v.setUint32(off + 8, seq, true);
    v.setFloat64(off + 12, frame, true);
    if (type === RecordType.KEYFRAME && this.segKeyframe[r] === 0xffffffff) {
      this.segKeyframe[r] = off;
      this.segKeySeq[r] = seq;
      this.segFrame[r] = frame;
    }
    if (frame > this.segEndFrame[r]!) this.segEndFrame[r] = frame;
    this.segRecords[r]!++;
    this.segBytes[r] += n;
    this.usedBytes += n;
    this.head = off + n;
    return off + CAPTURE_RECORD_HEAD_BYTES;
  }

  /**
   * A STATUS record holding the raw block (§5.3, architecture §3.1): the head, then `byteLength` bytes of `src` copied in
   * 32-bit words (little-endian both sides, so bytes and NaN payloads survive). No decode beyond what the caller read.
   * Returns false when dropped.
   */
  copyStatus(src: DataView, byteLength: number, epoch: number, frame: number): boolean {
    const off = this.record(RecordType.STATUS, 0, epoch, frame, byteLength);
    if (off < 0) return false;
    const dst = this.view;
    const words = byteLength & ~3;
    let i = 0;
    for (; i < words; i += 4) dst.setUint32(off + i, src.getUint32(i, true), true);
    for (; i < byteLength; i++) dst.setUint8(off + i, src.getUint8(i));
    return true;
  }

  /** Clears the dropped-record range once the recorder has written its GAP (`dropped`). */
  clearDropped(): void {
    this.droppedFirstSeq = 0;
    this.droppedLastSeq = 0;
  }

  /** Bytes the segment's records take (WRAP stripped): what `copySegment` returns. */
  segmentBytes(id: number): number {
    return this.segBytes[row(id)]!;
  }

  /**
   * A copy of segment `id`'s records, WRAP stripped (the live view's hand-off to the Worker, R17): whole records in seq
   * order, ready for `CaptureDecoder.appendRecords`. Allocates its output (once a second).
   */
  copySegment(id: number): Uint8Array {
    if (!this.holds(id)) throw new Error(`RecorderRing.copySegment: segment ${id} isn't in the ring`);
    const out = new Uint8Array(this.segBytes[row(id)]!);
    this.copyRange(this.segStart[row(id)]!, out.byteLength, out, 0);
    return out;
  }

  /**
   * The span from segment `from` (clamped to the oldest kept) to the newest record, WRAP stripped, with its records
   * counted and its keyframes indexed (the save, R16, §5.4). Allocates its output.
   */
  copyRecords(from: number): RingSpan {
    const first = Math.max(from, this.firstSegment);
    let total = 0;
    let count = 0;
    for (let id = first; id < this.nextSegment; id++) {
      total += this.segBytes[row(id)]!;
      count += this.segRecords[row(id)]!;
    }
    const bytes = new Uint8Array(total);
    const keyframes: IndexEntry[] = [];
    let at = 0;
    for (let id = first; id < this.nextSegment; id++) {
      const r = row(id);
      const start = this.segStart[r]!;
      if (this.segKeyframe[r] !== 0xffffffff) {
        keyframes.push({ epoch: this.segEpoch[r]!, frame: this.segFrame[r]!, byteOffset: at + this.distance(start, this.segKeyframe[r]!), seq: this.segKeySeq[r]! });
      }
      at = this.copyRange(start, this.segBytes[r]!, bytes, at);
    }
    const r0 = row(first);
    const empty = first >= this.nextSegment;
    return { bytes, recordCount: count, keyframes, firstFrame: empty ? 0 : this.segFrame[r0]!, sampleRate: empty ? 0 : this.segRate[r0]!, firstSeq: empty ? this.seq : this.segFirstSeq[r0]! };
  }

  /** Empties the ring (a released recorder reused). Keeps the buffers; `seq` keeps counting. */
  reset(): void {
    this.firstSegment = this.nextSegment;
    this.head = 0;
    this.tail = 0;
    this.wrapAt = -1;
    this.usedBytes = 0;
  }

  // --- internals ------------------------------------------------------------------------------------------------------

  /** Bytes of records (WRAP stripped) from `from` to `to` walking the ring. */
  private distance(from: number, to: number): number {
    let off = from;
    let d = 0;
    while (off !== to) {
      if (this.bytes[off] === RecordType.WRAP) { off = 0; continue; }
      const n = CAPTURE_RECORD_HEAD_BYTES + this.view.getUint32(off + 4, true);
      d += n;
      off += n;
    }
    return d;
  }

  /**
   * Copies `count` record bytes starting at `from` into `out` at `at`; returns the end offset in `out`. A span in the
   * upper part while wrapped (`from >= tail`) runs to the WRAP and continues at 0.
   */
  private copyRange(from: number, count: number, out: Uint8Array, at: number): number {
    if (count === 0) return at;
    if (this.wrapAt >= 0 && from >= this.tail) {
      const first = Math.min(count, this.wrapAt - from);
      out.set(this.bytes.subarray(from, from + first), at);
      if (count > first) out.set(this.bytes.subarray(0, count - first), at + first);
    } else {
      out.set(this.bytes.subarray(from, from + count), at);
    }
    return at + count;
  }

  /**
   * Where `n` contiguous bytes go, evicting whole oldest segments until they fit (§3.6), or -1. Room for a WRAP head is
   * always kept before the buffer's end. The open segment is evicted only for a record `opening` a new segment (whose
   * keyframe follows at once); otherwise the record is dropped.
   */
  private place(n: number, opening: boolean): number {
    for (;;) {
      const empty = this.nextSegment === this.firstSegment;
      if (empty) {
        this.head = 0;
        this.tail = 0;
        this.wrapAt = -1;
        return 0;
      }
      if (this.wrapAt < 0) {
        if (this.head + n + CAPTURE_RECORD_HEAD_BYTES <= this.capacity) return this.head;
        if (n <= this.tail) {
          this.writeWrap(this.head);
          this.wrapAt = this.head;
          this.head = 0;
          return 0;
        }
      } else if (this.head + n <= this.tail) {
        return this.head;
      }
      if (!this.evictOldest(opening)) return -1;
    }
  }

  /** Drops the oldest segment; false when only the open one remains (unless `andOpen`: a new segment is opening). */
  private evictOldest(andOpen: boolean): boolean {
    if (this.nextSegment - this.firstSegment <= (andOpen ? 0 : 1)) return false;
    const id = this.firstSegment++;
    this.onEvict?.(id);
    this.evicted++;
    this.usedBytes -= this.segBytes[row(id)]!;
    if (this.firstSegment === this.nextSegment) {
      this.head = 0;
      this.tail = 0;
      this.wrapAt = -1;
      return true;
    }
    const next = this.segStart[row(this.firstSegment)]!;
    if (this.wrapAt >= 0 && next <= this.head && next < this.tail) {
      // The tail crossed the WRAP: the upper part is free again.
      this.wrapAt = -1;
    }
    this.tail = next;
    return true;
  }

  private writeWrap(off: number): void {
    const v = this.view;
    v.setUint8(off, RecordType.WRAP);
    v.setUint8(off + 1, 0);
    v.setUint16(off + 2, 0, true);
    v.setUint32(off + 4, 0, true);
    v.setUint32(off + 8, 0, true);
    v.setFloat64(off + 12, 0, true);
  }

  private drop(seq: number): number {
    if (this.droppedFirstSeq === 0) this.droppedFirstSeq = seq;
    this.droppedLastSeq = seq;
    this.dropped++;
    return -1;
  }
}
