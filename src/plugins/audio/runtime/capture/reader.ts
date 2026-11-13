// ADR 0171 amended by 0172 (M5a, task Rc1; api-and-models §5.1, §5.3, §5.4, §5.7; architecture §3.7, §4.1): the
// bounds-checked capture decoder the Worker wraps (Rc5 `capture/worker.ts`; Rc6 live `appendSegment`). Pure functions
// over byte views, synchronous except the inflate; no DOM, runs in a Worker.
//
// **Refusal, never a partial profile (§5.7).** Every step throws `CaptureError` (`code`, `offset`, `message`); the open
// is all or nothing. The decoder never reads past `recordBytes`. **No header count sizes an allocation:** the record
// table grows by the records actually read, by doubling, up to `recordCount` (itself ≤ `uncompressedBytes / 20`); the
// inflate keeps chunks and stops at `uncompressedBytes + 1`; strings and arrays are allocated only after the record's
// own fields agree with its `len`. `ReaderOptions.onAllocate` reports each allocation the reader sizes, so tests prove
// none passes the caps.
import {
  CAPTURE_DISORDER_SECONDS, CAPTURE_FLAG_COMPRESSED, CAPTURE_FLAG_HAS_INDEX, CAPTURE_FLAG_MAIN_SIDE_ONLY, CAPTURE_FLAG_TRUNCATED,
  CAPTURE_HEADER_BYTES, CAPTURE_MAX_NAMES, CAPTURE_MAX_UNCOMPRESSED_BYTES, CAPTURE_RECORD_HEAD_BYTES, CaptureError,
  DEFERRED_STAMP_BYTES, NAME_TABLES, RECORD_FLAG_DEFERRED, RecordType, checkKeyframe, checkStatusPayload, decodeCaptureMeta,
  decodeEpoch, decodeEvent, decodeGap, decodeIndex, decodeMarker, decodeMixOpRecord, decodeNames, readCaptureHeader,
  readRecordHead, CAPTURE_KEYFRAME_INTERVAL_MS, decodeKeyframe,
  type CaptureHeader, type CaptureMeta, type CaptureSnapshot, type CaptureSummary, type EpochPayload, type EventPayload,
  type GapPayload, type IndexPayload, type KeyframePayload, type MarkerPayload, type MixOpPayload, type NameTable,
  type NamesPayload, type RecordHead,
} from "./format";
import { readStatus, type StatusBlock } from "../wire.generated";

/** What an open can be given. */
export interface ReaderOptions {
  /** Called with the size of each allocation the reader sizes from the input (record table growth, inflate chunks, the joined payload). */
  onAllocate?(bytes: number, what: "records" | "inflate" | "payload"): void;
  /** Progress: inflated bytes, then records scanned (of `recordCount`). */
  onProgress?(phase: "inflate" | "records", done: number, total: number): void;
  /** Checked between inflate chunks and every `CANCEL_CHECK_RECORDS` records; when set the open throws `cancelled`. */
  signal?: { readonly aborted: boolean };
  /**
   * The inflater (tests, or a runtime without `DecompressionStream`): inflate `compressed`, stopping as soon as more than
   * `maxBytes` would be produced (return what it has, at least `maxBytes` long, so the reader refuses `inflateOverrun`).
   * Default: `DecompressionStream("deflate-raw")`. `pause`, when given, is awaited after each chunk.
   */
  inflate?(compressed: Uint8Array, maxBytes: number, onChunk: (bytes: number) => void, pause?: () => Promise<void>): Promise<Uint8Array>;
  /**
   * Rc5: awaited after each inflate chunk and every `CANCEL_CHECK_RECORDS` records, so the open yields to its event loop
   * (a Worker then sees `cancel` and sets `signal`). Without it the records scan is one synchronous loop.
   */
  pause?(): Promise<void>;
}

/** Records between cancel checks and progress calls. */
export const CANCEL_CHECK_RECORDS = 4096;
/** The record table's first capacity. */
export const RECORD_TABLE_INITIAL = 1024;

/**
 * Every record's head and where its payload is, in struct-of-arrays form (no object per record). Row `i` is the i-th
 * record in seq order. `offset` is the payload's offset (after the head and any deferred stamp) in `segments[segment]`.
 */
export class RecordTable {
  count = 0;
  capacity = 0;
  type = new Uint8Array(0);
  flags = new Uint8Array(0);
  epoch = new Uint16Array(0);
  segment = new Uint16Array(0);
  len = new Uint32Array(0);
  seq = new Uint32Array(0);
  offset = new Uint32Array(0);
  frame = new Float64Array(0);
  /** Bytes per row across the arrays. */
  static readonly ROW_BYTES = 1 + 1 + 2 + 2 + 4 + 4 + 4 + 8;

  /** Room for one more row, growing by doubling up to `limit` rows (`tooManyRecords` past it). */
  reserve(limit: number, at: number, onAllocate?: ReaderOptions["onAllocate"]): void {
    if (this.count < this.capacity) return;
    if (this.count >= limit) throw new CaptureError("tooManyRecords", at, `more than ${limit} records`);
    const cap = Math.min(limit, Math.max(RECORD_TABLE_INITIAL, this.capacity * 2));
    onAllocate?.(cap * RecordTable.ROW_BYTES, "records");
    const grow = <T extends Uint8Array | Uint16Array | Uint32Array | Float64Array>(old: T, make: (n: number) => T): T => {
      const next = make(cap);
      next.set(old as never);
      return next;
    };
    this.type = grow(this.type, (n) => new Uint8Array(n));
    this.flags = grow(this.flags, (n) => new Uint8Array(n));
    this.epoch = grow(this.epoch, (n) => new Uint16Array(n));
    this.segment = grow(this.segment, (n) => new Uint16Array(n));
    this.len = grow(this.len, (n) => new Uint32Array(n));
    this.seq = grow(this.seq, (n) => new Uint32Array(n));
    this.offset = grow(this.offset, (n) => new Uint32Array(n));
    this.frame = grow(this.frame, (n) => new Float64Array(n));
    this.capacity = cap;
  }
}

/** One epoch: its first record and its EPOCH payload (absent for a truncated file's first epoch, whose rate is the header's). */
export interface EpochInfo {
  epoch: number;
  firstRecord: number;
  sampleRate: number;
  payload: EpochPayload | null;
}

/** A decoded capture: everything the Worker needs to answer `seek` and `range`. */
export interface CaptureContents {
  header: CaptureHeader;
  meta: CaptureMeta;
  records: RecordTable;
  /** The records regions: one for a file, one per appended segment for a live view. */
  segments: Uint8Array[];
  /** Record indices of every KEYFRAME, in seq order. */
  keyframes: number[];
  epochs: EpochInfo[];
  /** META's names plus every NAMES record. */
  names: Record<NameTable, Map<number, string>>;
  /** The INDEX record when present and consistent with the scan; null otherwise. */
  index: IndexPayload | null;
  truncated: boolean;
  mainSideOnly: boolean;
  warnings: string[];
}

/** One record decoded (`decodeRecordAt`). STATUS and KEYFRAME payloads are views (no copy); `readStatus` and Rc1b's `decodeKeyframe` parse them. */
export type DecodedRecord = RecordHead & { stamp?: number } & (
  | { kind: "epoch"; payload: EpochPayload }
  | { kind: "gap"; payload: GapPayload }
  | { kind: "status"; payload: Uint8Array }
  | { kind: "keyframe"; payload: Uint8Array }
  | { kind: "event"; payload: EventPayload }
  | { kind: "marker"; payload: MarkerPayload }
  | { kind: "names"; payload: NamesPayload }
  | { kind: "mixop"; payload: MixOpPayload }
  | { kind: "index"; payload: IndexPayload }
  | { kind: "unknown"; payload: Uint8Array }
);

/** A segment being scanned (`CaptureDecoder`'s cursor between slices). */
interface SegmentScan {
  bytes: Uint8Array;
  base: number;
  segment: number;
  view: DataView;
  off: number;
}

/**
 * The incremental decoder: header and META at construction, then records by `appendRecords` (a file's records region
 * once, or a live view's sealed segments), then `finish` for a file (the count and INDEX checks). Each call validates
 * everything it appends; on a throw the decoder is unusable (the open fails whole).
 */
export class CaptureDecoder {
  readonly contents: CaptureContents;
  private readonly live: boolean;
  private readonly opts: ReaderOptions;
  private lastSeq = -1;
  private lastEpoch = -1;
  private epochRate = 0;
  private epochMaxFrame = 0;
  private nameCount = 0;
  private indexRecord = -1;
  private heldBytes = 0;

  constructor(header: CaptureHeader, meta: CaptureMeta, live: boolean, opts: ReaderOptions = {}) {
    this.live = live;
    this.opts = opts;
    for (const t of NAME_TABLES) this.nameCount += meta.names[t].size;
    this.contents = {
      header, meta, records: new RecordTable(), segments: [], keyframes: [], epochs: [], names: meta.names, index: null,
      truncated: (header.flags & CAPTURE_FLAG_TRUNCATED) !== 0, mainSideOnly: (header.flags & CAPTURE_FLAG_MAIN_SIDE_ONLY) !== 0, warnings: [],
    };
    this.epochRate = header.sampleRate;
  }

  /** The most records this view may hold. */
  private get recordLimit(): number {
    return this.live ? Math.floor(CAPTURE_MAX_UNCOMPRESSED_BYTES / CAPTURE_RECORD_HEAD_BYTES) : this.contents.header.recordCount;
  }

  /**
   * Validates and indexes every record in `bytes` (whole records only). `base` is `bytes`' offset in the uncompressed
   * payload, for error offsets. Refuses, per record: the head (`readRecordHead`'s order), `tooManyRecords`, `badSeq`,
   * `badEpoch`, `disorder`, a deferred stamp (`badLength`, `badValue`), then the type's payload.
   */
  appendRecords(bytes: Uint8Array, base = 0): void {
    const scan = this.beginSegment(bytes, base);
    this.scanRecords(scan, Infinity);
    this.endSegment(scan);
  }

  /**
   * Rc5: `appendRecords` that awaits `pause` every `CANCEL_CHECK_RECORDS` records, so a Worker can take a `cancel`
   * message while it opens a large file (the scan is otherwise one synchronous loop). Refuses exactly as `appendRecords`.
   */
  async appendRecordsAsync(bytes: Uint8Array, base: number, pause: () => Promise<void>): Promise<void> {
    const scan = this.beginSegment(bytes, base);
    while (!this.scanRecords(scan, CANCEL_CHECK_RECORDS)) {
      await pause();
      if (this.opts.signal?.aborted) throw new CaptureError("cancelled", base + scan.off, "the open was cancelled");
    }
    this.endSegment(scan);
  }

  private beginSegment(bytes: Uint8Array, base: number): SegmentScan {
    const c = this.contents;
    if (this.live) {
      if (this.heldBytes + bytes.byteLength > CAPTURE_MAX_UNCOMPRESSED_BYTES - c.header.metaBytes) {
        throw new CaptureError("tooLarge", base, `a live view past ${CAPTURE_MAX_UNCOMPRESSED_BYTES} B`);
      }
    }
    if (c.segments.length >= 0xffff) throw new CaptureError("tooLarge", base, "more than 65,535 segments");
    return { bytes, base, segment: c.segments.length, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), off: 0 };
  }

  private endSegment(scan: SegmentScan): void {
    this.contents.segments.push(scan.bytes);
    this.heldBytes += scan.bytes.byteLength;
  }

  /** Scans up to `max` records of `scan`; true when the segment is done. */
  private scanRecords(scan: SegmentScan, max: number): boolean {
    const c = this.contents;
    const { view, base, segment } = scan;
    const end = scan.bytes.byteLength;
    const t = c.records;
    let off = scan.off;
    let n = 0;
    while (off < end && n < max) {
      n++;
      const at = base + off;
      const h = readRecordHead(view, off, end, c.header.statusBytesMax, base);
      t.reserve(this.recordLimit, at, this.opts.onAllocate);
      if (this.indexRecord >= 0) throw new CaptureError("badIndex", at, "a record after the INDEX record");
      if (h.seq <= this.lastSeq) throw new CaptureError("badSeq", at + 8, `seq ${h.seq} after ${this.lastSeq}`);
      if (h.epoch < this.lastEpoch) throw new CaptureError("badEpoch", at + 2, `epoch ${h.epoch} after ${this.lastEpoch}`);
      if (h.epoch !== this.lastEpoch) {
        c.epochs.push({ epoch: h.epoch, firstRecord: t.count, sampleRate: this.epochRate, payload: null });
        this.lastEpoch = h.epoch;
        this.epochMaxFrame = h.frame;
      } else if (h.frame < this.epochMaxFrame - CAPTURE_DISORDER_SECONDS * this.epochRate) {
        throw new CaptureError("disorder", at + 12, `frame ${h.frame} is more than ${CAPTURE_DISORDER_SECONDS} s before frame ${this.epochMaxFrame} written earlier in epoch ${h.epoch}`);
      }
      let p = off + CAPTURE_RECORD_HEAD_BYTES;
      let len = h.len;
      if (h.flags & RECORD_FLAG_DEFERRED) {
        if (len < DEFERRED_STAMP_BYTES) throw new CaptureError("badLength", at + 4, `a deferred record of ${len} B has no stamp`);
        const stamp = view.getFloat64(p, true);
        if (!(Number.isFinite(stamp) && stamp >= 0)) throw new CaptureError("badValue", base + p, `deferred stamp ${stamp}`);
        p += DEFERRED_STAMP_BYTES;
        len -= DEFERRED_STAMP_BYTES;
      }
      this.checkPayload(h, view, p, len, base, at);
      const i = t.count++;
      t.type[i] = h.type;
      t.flags[i] = h.flags;
      t.epoch[i] = h.epoch;
      t.segment[i] = segment;
      t.len[i] = len;
      t.seq[i] = h.seq;
      t.offset[i] = p;
      t.frame[i] = h.frame;
      if (h.type === RecordType.KEYFRAME) c.keyframes.push(i);
      if (h.type === RecordType.INDEX) this.indexRecord = i;
      if (h.frame > this.epochMaxFrame) this.epochMaxFrame = h.frame;
      this.lastSeq = h.seq;
      off += CAPTURE_RECORD_HEAD_BYTES + h.len;
      if (t.count % CANCEL_CHECK_RECORDS === 0) {
        if (this.opts.signal?.aborted) throw new CaptureError("cancelled", at, "the open was cancelled");
        this.opts.onProgress?.("records", t.count, c.header.recordCount);
      }
    }
    scan.off = off;
    return off >= end;
  }

  private checkPayload(h: RecordHead, view: DataView, p: number, len: number, base: number, at: number): void {
    const c = this.contents;
    switch (h.type) {
      case RecordType.EPOCH: {
        const e = decodeEpoch(view, p, len, base);
        const info = c.epochs[c.epochs.length - 1]!;
        if (info.payload !== null || info.firstRecord !== c.records.count) {
          // An EPOCH opens its epoch: it is the epoch's first record (§5.3, ARCH §4.1).
          throw new CaptureError("badEpoch", at + 2, `EPOCH record inside epoch ${h.epoch}, not at its start`);
        }
        info.payload = e;
        info.sampleRate = e.sampleRate;
        this.epochRate = e.sampleRate;
        break;
      }
      case RecordType.GAP: decodeGap(view, p, len, base); break;
      case RecordType.STATUS:
        if (c.mainSideOnly) throw new CaptureError("badRecord", at, "a STATUS record in a main-side-only capture");
        checkStatusPayload(view, p, len, h.frame, base);
        break;
      case RecordType.KEYFRAME: checkKeyframe(view, p, len, base); break;
      case RecordType.EVENT: decodeEvent(view, p, len, base); break;
      case RecordType.MARKER: decodeMarker(view, p, len, base); break;
      case RecordType.NAMES: {
        const n = decodeNames(view, p, len, base);
        const table = c.names[NAME_TABLES[n.table]!];
        if (!table.has(n.id)) {
          if (++this.nameCount > CAPTURE_MAX_NAMES) throw new CaptureError("tooManyNames", at, `more than ${CAPTURE_MAX_NAMES} names`);
        }
        table.set(n.id, n.name);
        break;
      }
      case RecordType.MIXOP: decodeMixOpRecord(view, p, len, base); break;
      case RecordType.WRAP: throw new CaptureError("badRecord", at, "a WRAP marker (ring only; the saver strips it)");
      case RecordType.INDEX:
        if (this.live) throw new CaptureError("badIndex", at, "an INDEX record in a live segment");
        decodeIndex(view, p, len, base);
        break;
      default: break; // an unknown type below 0x80: skipped by `len` (§5.3)
    }
  }

  /** A file's end: `recordCount` met (`countMismatch`), the INDEX where the header says (`badIndex`), its entries checked against the scan (a mismatch only warns: the scan stands). */
  finish(): CaptureContents {
    const c = this.contents;
    const h = c.header;
    if (c.records.count !== h.recordCount) throw new CaptureError("countMismatch", h.metaBytes + h.recordBytes, `${c.records.count} records, the header says ${h.recordCount}`);
    const hasIndex = (h.flags & CAPTURE_FLAG_HAS_INDEX) !== 0;
    if (hasIndex !== this.indexRecord >= 0) throw new CaptureError("badIndex", 10, hasIndex ? "hasIndex is set but there is no INDEX record" : "an INDEX record without hasIndex");
    if (hasIndex) {
      const i = this.indexRecord;
      const t = c.records;
      const headLen = CAPTURE_RECORD_HEAD_BYTES + t.len[i]! + (t.flags[i]! & RECORD_FLAG_DEFERRED ? DEFERRED_STAMP_BYTES : 0);
      if (headLen !== h.indexBytes) throw new CaptureError("badIndex", 76, `indexBytes ${h.indexBytes}, the INDEX record is ${headLen} B`);
      const seg = c.segments[t.segment[i]!]!;
      const index = decodeIndex(new DataView(seg.buffer, seg.byteOffset, seg.byteLength), t.offset[i]!, t.len[i]!, h.metaBytes);
      if (this.indexMatches(index)) c.index = index;
      else c.warnings.push("the INDEX record failed its bounds; keyframes were found by scanning");
    }
    return c;
  }

  private indexMatches(index: IndexPayload): boolean {
    const c = this.contents;
    const t = c.records;
    if (index.entries.length !== c.keyframes.length) return false;
    for (let k = 0; k < c.keyframes.length; k++) {
      const i = c.keyframes[k]!;
      const e = index.entries[k]!;
      const head = t.offset[i]! - CAPTURE_RECORD_HEAD_BYTES - (t.flags[i]! & RECORD_FLAG_DEFERRED ? DEFERRED_STAMP_BYTES : 0);
      if (e.epoch !== t.epoch[i] || e.frame !== t.frame[i] || e.seq !== t.seq[i] || e.byteOffset !== head) return false;
    }
    return true;
  }
}

/** Decodes the uncompressed payload (META then records) of a file whose header is `header`; synchronous and pure. `payload.byteLength` must be `uncompressedBytes` (`sizeMismatch`). */
export function readCapturePayload(header: CaptureHeader, payload: Uint8Array, opts: ReaderOptions = {}): CaptureContents {
  if (payload.byteLength !== header.uncompressedBytes) throw new CaptureError("sizeMismatch", CAPTURE_HEADER_BYTES, `payload is ${payload.byteLength} B, the header says ${header.uncompressedBytes}`);
  const meta = decodeCaptureMeta(payload.subarray(0, header.metaBytes), 0);
  const d = new CaptureDecoder(header, meta, false, opts);
  d.appendRecords(payload.subarray(header.metaBytes), header.metaBytes);
  return d.finish();
}

/**
 * The payload after the header: inflated (`compressed` set) with a hard stop at `uncompressedBytes + 1`
 * (`inflateOverrun`), or the stored bytes, which must be exactly `uncompressedBytes` long (`sizeMismatch`).
 */
export async function capturePayload(header: CaptureHeader, body: Uint8Array, opts: ReaderOptions = {}): Promise<Uint8Array> {
  const expected = header.uncompressedBytes;
  if ((header.flags & CAPTURE_FLAG_COMPRESSED) === 0) {
    if (body.byteLength !== expected) throw new CaptureError("sizeMismatch", CAPTURE_HEADER_BYTES, `stored payload is ${body.byteLength} B, the header says ${expected}`);
    return body;
  }
  let produced = 0;
  const onChunk = (n: number): void => {
    produced += n;
    opts.onAllocate?.(n, "inflate");
    opts.onProgress?.("inflate", Math.min(produced, expected), expected);
    if (opts.signal?.aborted) throw new CaptureError("cancelled", CAPTURE_HEADER_BYTES, "the open was cancelled");
    if (produced > expected) throw new CaptureError("inflateOverrun", CAPTURE_HEADER_BYTES, `inflate passed the declared ${expected} B`);
  };
  const out = await (opts.inflate ?? inflateDeflateRaw)(body, expected + 1, onChunk, opts.pause);
  if (out.byteLength > expected) throw new CaptureError("inflateOverrun", CAPTURE_HEADER_BYTES, `inflate passed the declared ${expected} B`);
  if (out.byteLength < expected) throw new CaptureError("sizeMismatch", CAPTURE_HEADER_BYTES, `inflated ${out.byteLength} B, the header says ${expected}`);
  return out;
}

/**
 * The default inflater: `DecompressionStream("deflate-raw")`, read chunk by chunk; `onChunk` runs before a chunk is kept
 * and throws to stop (the stream is cancelled), so no more than `maxBytes` plus one chunk is ever held. A corrupt stream
 * is `inflateFailed`.
 */
export async function inflateDeflateRaw(compressed: Uint8Array, maxBytes: number, onChunk: (bytes: number) => void, pause?: () => Promise<void>): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new CaptureError("inflateFailed", CAPTURE_HEADER_BYTES, "this runtime has no DecompressionStream");
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(compressed as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        throw new CaptureError("inflateFailed", CAPTURE_HEADER_BYTES, `the deflate stream is corrupt (${e instanceof Error ? e.message : String(e)})`);
      }
      if (r.done) break;
      onChunk(r.value.byteLength);
      total += r.value.byteLength;
      if (total > maxBytes) throw new CaptureError("inflateOverrun", CAPTURE_HEADER_BYTES, `inflate passed ${maxBytes - 1} B`);
      chunks.push(r.value);
      if (pause) await pause();
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Opens a whole file: header (§5.1's order), payload (inflate or stored), META, records, INDEX. With `opts.pause` the records scan yields between slices (Rc5's Worker). */
export async function openCapture(file: Uint8Array, opts: ReaderOptions = {}): Promise<CaptureContents> {
  const header = readCaptureHeader(file);
  const payload = await capturePayload(header, file.subarray(CAPTURE_HEADER_BYTES), opts);
  if (header.flags & CAPTURE_FLAG_COMPRESSED) opts.onAllocate?.(payload.byteLength, "payload");
  if (!opts.pause) return readCapturePayload(header, payload, opts);
  if (payload.byteLength !== header.uncompressedBytes) throw new CaptureError("sizeMismatch", CAPTURE_HEADER_BYTES, `payload is ${payload.byteLength} B, the header says ${header.uncompressedBytes}`);
  const meta = decodeCaptureMeta(payload.subarray(0, header.metaBytes), 0);
  const d = new CaptureDecoder(header, meta, false, opts);
  await d.appendRecordsAsync(payload.subarray(header.metaBytes), header.metaBytes, opts.pause);
  return d.finish();
}

/**
 * A live view (R17, Rc6): `head` is the 96 B header (stored, `recordCount` 0, `recordBytes` 0) and the raw META; the
 * returned decoder takes each sealed segment through `appendRecords`.
 */
export function openLiveCapture(head: Uint8Array, opts: ReaderOptions = {}): CaptureDecoder {
  const header = readCaptureHeader(head);
  if (header.recordCount !== 0 || header.recordBytes !== 0 || (header.flags & (CAPTURE_FLAG_COMPRESSED | CAPTURE_FLAG_HAS_INDEX)) !== 0) {
    throw new CaptureError("badHeader", 64, "a live head carries no records, no index and is stored raw");
  }
  if (head.byteLength !== CAPTURE_HEADER_BYTES + header.metaBytes) throw new CaptureError("sizeMismatch", CAPTURE_HEADER_BYTES, `live head is ${head.byteLength} B, the header says ${CAPTURE_HEADER_BYTES + header.metaBytes}`);
  const meta = decodeCaptureMeta(head.subarray(CAPTURE_HEADER_BYTES), 0);
  return new CaptureDecoder(header, meta, true, opts);
}

/** Record `i` decoded. The open already validated it, so this can't throw on a decoded capture. */
export function decodeRecordAt(c: CaptureContents, i: number): DecodedRecord {
  const t = c.records;
  if (!(i >= 0 && i < t.count)) throw new RangeError(`decodeRecordAt: no record ${i}`);
  const seg = c.segments[t.segment[i]!]!;
  const view = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const off = t.offset[i]!;
  const len = t.len[i]!;
  const deferred = (t.flags[i]! & RECORD_FLAG_DEFERRED) !== 0;
  const head = {
    type: t.type[i]!, flags: t.flags[i]!, epoch: t.epoch[i]!, len: len + (deferred ? DEFERRED_STAMP_BYTES : 0), seq: t.seq[i]!, frame: t.frame[i]!,
    ...(deferred ? { stamp: view.getFloat64(off - DEFERRED_STAMP_BYTES, true) } : {}),
  };
  const raw = () => seg.subarray(off, off + len);
  switch (head.type) {
    case RecordType.EPOCH: return { ...head, kind: "epoch", payload: decodeEpoch(view, off, len) };
    case RecordType.GAP: return { ...head, kind: "gap", payload: decodeGap(view, off, len) };
    case RecordType.STATUS: return { ...head, kind: "status", payload: raw() };
    case RecordType.KEYFRAME: return { ...head, kind: "keyframe", payload: raw() };
    case RecordType.EVENT: return { ...head, kind: "event", payload: decodeEvent(view, off, len) };
    case RecordType.MARKER: return { ...head, kind: "marker", payload: decodeMarker(view, off, len) };
    case RecordType.NAMES: return { ...head, kind: "names", payload: decodeNames(view, off, len) };
    case RecordType.MIXOP: return { ...head, kind: "mixop", payload: decodeMixOpRecord(view, off, len) };
    case RecordType.INDEX: return { ...head, kind: "index", payload: decodeIndex(view, off, len) };
    default: return { ...head, kind: "unknown", payload: raw() };
  }
}

/** The profiler's continuous axis: record `i`'s heard time in seconds, f / rate + its epoch's `timeOffset` (§5.4, R14; 0 offset for an epoch without its EPOCH record). */
export function recordSeconds(c: CaptureContents, i: number): number {
  const ep = epochOf(c, i);
  return c.records.frame[i]! / ep.sampleRate + (ep.payload?.timeOffset ?? 0);
}

/** The epoch record `i` belongs to (binary search over `epochs`). */
export function epochOf(c: CaptureContents, i: number): EpochInfo {
  let lo = 0;
  let hi = c.epochs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.epochs[mid]!.firstRecord <= i) lo = mid;
    else hi = mid - 1;
  }
  return c.epochs[lo]!;
}

// --- Rc5: the Worker's time index, seek and range (api-and-models §5.4, §5.5, §7; architecture §3.7) ---------------

/**
 * The STATUS header scalars `range` can return, by their `StatusBlock` name: byte offset in the block and type. The
 * header is fixed (176 B before M5, 256 B now; `readStatus`), and the capture's wire hash equals this build's
 * (`wireMismatch` otherwise), so the offsets hold for every capture that opens. `reader.test.ts` checks each against
 * `writeStatus`/`readStatus`.
 */
export const STATUS_COLUMNS = {
  currentFrame: [16, "f64"], dateMs: [24, "f64"], underruns: [40, "u32"], lateCommands: [44, "u32"], workUnits: [48, "u32"],
  workUnitsMax: [52, "u32"], mixedVoices: [56, "u16"], liveVoices: [58, "u16"], flags: [60, "u32"], mixedCap: [78, "u16"],
  loadPermille: [80, "u16"], traps: [82, "u16"], minSlackFrames: [84, "i32"], underrunFrames: [88, "u32"], arenaUsedKB: [92, "u32"],
  maxLatenessFrames: [104, "u32"], hrtfVoices: [108, "u16"], bedVoices: [112, "u16"], fxVoices: [116, "u16"], zonesActive: [120, "u16"],
  m3Shed: [130, "u16"], workBed: [136, "u32"], workZones: [140, "u32"], musicRingsOpen: [148, "u16"], streamStartsLate: [150, "u16"],
  maxSlipFrames: [160, "u32"], splitQuanta: [164, "u32"], voiceSplits: [168, "u32"], busyMsTotal: [176, "f64"], quantaTotal: [184, "f64"],
  wuVoices: [192, "f64"], wuBuses: [200, "f64"], wuSpatial: [208, "f64"], wuMusic: [216, "f64"], wuLoudness: [224, "f64"],
  clockStepMs: [238, "u16"], clockSteps: [244, "u16"], loudShed: [246, "u16"], busRecordsEarly: [248, "u16"], sidechainLate: [250, "u16"],
} as const satisfies Record<string, readonly [number, "f64" | "u32" | "i32" | "u16"]>;
export type StatusColumn = keyof typeof STATUS_COLUMNS;

/** `range`'s columns beyond the STATUS scalars: `seconds` (each sample's time; in bucket mode each bucket's start). */
export const RANGE_SECONDS = "seconds";
/** The most buckets one `range` may ask for. */
export const RANGE_MAX_BUCKETS = 65_536;

/** A STATUS scalar read in place (no allocation). */
export function readStatusColumn(view: DataView, off: number, column: StatusColumn): number {
  const [at, kind] = STATUS_COLUMNS[column];
  switch (kind) {
    case "f64": return view.getFloat64(off + at, true);
    case "u32": return view.getUint32(off + at, true);
    case "i32": return view.getInt32(off + at, true);
    case "u16": return view.getUint16(off + at, true);
  }
}

/** A MARKER on the axis. */
export interface CaptureMarkerAt { seq: number; seconds: number; text: string }
/** A GAP on the axis. */
export interface CaptureGapAt { seq: number; seconds: number; payload: GapPayload }

/**
 * What the Worker builds once per open (and extends per live segment): every STATUS and KEYFRAME on the continuous
 * axis, sorted, plus the markers and gaps. Arrays grow by doubling from the records read (never from a header count)
 * and report through `onAllocate` like the record table.
 *
 * **Search keys.** A STATUS's time is its `currentFrame` (§5.3), so STATUS times rise within an epoch; across epochs the
 * axis carries each EPOCH's `timeOffset` (R14). A key is clamped to the largest before it, so the arrays stay sorted for
 * binary search even if an epoch's `timeOffset` stepped back (the cursor then holds, never jumps backwards).
 */
export class CaptureTimeIndex {
  /** Records indexed so far (a live view extends from here). */
  indexed = 0;
  statusCount = 0;
  statusRecord = new Uint32Array(0);
  statusSeconds = new Float64Array(0);
  keyframeCount = 0;
  keyframeRecord = new Uint32Array(0);
  keyframeSeconds = new Float64Array(0);
  markers: CaptureMarkerAt[] = [];
  gaps: CaptureGapAt[] = [];
  /** The smallest and largest record time seen (NaN before any record). */
  startSeconds = NaN;
  endSeconds = NaN;
  private lastKey = -Infinity;
  private readonly onAllocate: ReaderOptions["onAllocate"];

  constructor(onAllocate?: ReaderOptions["onAllocate"]) {
    this.onAllocate = onAllocate;
  }

  /** Indexes records `indexed..count` of `c`. */
  extend(c: CaptureContents): void {
    const t = c.records;
    for (let i = this.indexed; i < t.count; i++) {
      const s = recordSeconds(c, i);
      if (!(s >= this.startSeconds)) this.startSeconds = Number.isNaN(this.startSeconds) ? s : Math.min(this.startSeconds, s);
      if (!(s <= this.endSeconds)) this.endSeconds = Number.isNaN(this.endSeconds) ? s : Math.max(this.endSeconds, s);
      const type = t.type[i]!;
      if (type === RecordType.STATUS || type === RecordType.KEYFRAME) {
        const key = Math.max(this.lastKey, s);
        this.lastKey = key;
        if (type === RecordType.STATUS) {
          if (this.statusCount === this.statusRecord.length) [this.statusRecord, this.statusSeconds] = this.grow(this.statusRecord, this.statusSeconds);
          this.statusRecord[this.statusCount] = i;
          this.statusSeconds[this.statusCount++] = key;
        } else {
          if (this.keyframeCount === this.keyframeRecord.length) [this.keyframeRecord, this.keyframeSeconds] = this.grow(this.keyframeRecord, this.keyframeSeconds);
          this.keyframeRecord[this.keyframeCount] = i;
          this.keyframeSeconds[this.keyframeCount++] = key;
        }
      } else if (type === RecordType.MARKER) {
        const d = decodeRecordAt(c, i);
        if (d.kind === "marker") this.markers.push({ seq: d.seq, seconds: s, text: d.payload.text });
      } else if (type === RecordType.GAP) {
        const d = decodeRecordAt(c, i);
        if (d.kind === "gap") this.gaps.push({ seq: d.seq, seconds: s, payload: d.payload });
      }
    }
    this.indexed = t.count;
  }

  private grow(rec: Uint32Array, sec: Float64Array): [Uint32Array<ArrayBuffer>, Float64Array<ArrayBuffer>] {
    const cap = Math.max(256, rec.length * 2);
    this.onAllocate?.(cap * (Uint32Array.BYTES_PER_ELEMENT + Float64Array.BYTES_PER_ELEMENT), "records");
    const r = new Uint32Array(cap);
    r.set(rec);
    const s = new Float64Array(cap);
    s.set(sec);
    return [r, s];
  }
}

/** The last index in `keys[0..n)` whose value is ≤ `t`, or -1. */
export function lastAtOrBefore(keys: Float64Array, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The first index in `keys[0..n)` whose value is ≥ `t` (`n` when none). */
export function firstAtOrAfter(keys: Float64Array, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The summary `open` and `appendSegment` answer, with the overview's markers, gaps and names (data, structured-cloneable). */
export interface CaptureOpenSummary extends CaptureSummary {
  statusCount: number;
  markers: readonly CaptureMarkerAt[];
  gaps: readonly CaptureGapAt[];
  /** META's names plus every NAMES record, per table. */
  names: Record<NameTable, readonly (readonly [number, string])[]>;
}

/** The summary of an opened (or extended) capture. */
export function summarizeCapture(c: CaptureContents, idx: CaptureTimeIndex): CaptureOpenSummary {
  const names = {} as Record<NameTable, (readonly [number, string])[]>;
  for (const t of NAME_TABLES) names[t] = [...c.names[t]];
  return {
    header: c.header, meta: c.meta, recordCount: c.records.count, keyframeCount: c.keyframes.length, epochCount: c.epochs.length,
    startSeconds: Number.isNaN(idx.startSeconds) ? 0 : idx.startSeconds, endSeconds: Number.isNaN(idx.endSeconds) ? 0 : idx.endSeconds,
    truncated: c.truncated, warnings: [...c.warnings], statusCount: idx.statusCount, markers: [...idx.markers], gaps: [...idx.gaps], names,
  };
}

/** An EVENT or MIXOP between the snapshot's base and its instant. */
export type CaptureSeekRecord =
  | { kind: "event"; seq: number; seconds: number; payload: EventPayload }
  | { kind: "mixop"; seq: number; seconds: number; payload: MixOpPayload };

/**
 * The table at one instant (`seek`). The cursor fields are the last STATUS at or before t (or, before any STATUS, the
 * first record). The state is the keyframe at or before t plus the records from it to t (§5.5): `keyframe` is
 * `decodeKeyframe`'s payload (null without one, and until Rc1b fills the codec), `records` the EVENTs and MIXOPs after
 * it, in seq order, for the models to apply (Pf2's voice table, Pf6's loudness). Without a keyframe at or before t the
 * base is the STATUS one keyframe interval before t (the records of that last second only).
 */
export interface CaptureSeekState extends CaptureSnapshot {
  /** The requested time, clamped to the capture. */
  seconds: number;
  /** -1 when there is no keyframe at or before t. */
  keyframeSeq: number;
  keyframe: KeyframePayload | null;
  /** The last STATUS at or before t, parsed; null before the first. */
  status: StatusBlock | null;
  records: CaptureSeekRecord[];
  /** Record heads the seek visited (the work it did): the keyframe's interval plus at most `CAPTURE_DISORDER_SECONDS` past t. */
  recordsScanned: number;
}

/** Rebuilds the state at `t` seconds (`CaptureSeekState`). Work: two binary searches, then the records of one keyframe interval. */
export function seekCapture(c: CaptureContents, idx: CaptureTimeIndex, t: number): CaptureSeekState {
  if (!Number.isFinite(t)) throw new CaptureError("badValue", -1, `seek to ${t}`);
  const seconds = idx.indexed === 0 ? 0 : Math.min(Math.max(t, idx.startSeconds), idx.endSeconds);
  const s = lastAtOrBefore(idx.statusSeconds, idx.statusCount, seconds);
  const k = lastAtOrBefore(idx.keyframeSeconds, idx.keyframeCount, seconds);
  const tbl = c.records;
  const cursor = s >= 0 ? idx.statusRecord[s]! : 0;
  const state: CaptureSeekState = {
    seconds, epoch: tbl.count ? tbl.epoch[cursor]! : 0, frame: tbl.count ? tbl.frame[cursor]! : 0, seq: tbl.count ? tbl.seq[cursor]! : 0,
    keyframeSeq: -1, keyframe: null, status: null, records: [], recordsScanned: 0,
  };
  if (s >= 0) {
    const seg = c.segments[tbl.segment[cursor]!]!;
    state.status = readStatus(seg.subarray(tbl.offset[cursor]!, tbl.offset[cursor]! + tbl.len[cursor]!));
  }
  let base: number;
  if (k >= 0) {
    base = idx.keyframeRecord[k]!;
    state.keyframeSeq = tbl.seq[base]!;
    state.keyframe = keyframeAt(c, base);
    base++;
  } else {
    const b = lastAtOrBefore(idx.statusSeconds, idx.statusCount, seconds - CAPTURE_KEYFRAME_INTERVAL_MS / 1000);
    base = b >= 0 ? idx.statusRecord[b]! : 0;
  }
  // Records after `base` up to t. A record written later may be stamped up to CAPTURE_DISORDER_SECONDS earlier than one
  // before it in its epoch (§5.3), so the scan runs until a record lies that far past t.
  const stop = seconds + CAPTURE_DISORDER_SECONDS;
  for (let i = base; i < tbl.count; i++) {
    state.recordsScanned++;
    const at = recordSeconds(c, i);
    if (at > stop) break;
    if (at > seconds) continue;
    const type = tbl.type[i]!;
    if (type !== RecordType.EVENT && type !== RecordType.MIXOP) continue;
    const d = decodeRecordAt(c, i);
    if (d.kind === "event" || d.kind === "mixop") state.records.push({ kind: d.kind, seq: d.seq, seconds: at, payload: d.payload } as CaptureSeekRecord);
  }
  return state;
}

/** KEYFRAME `i`'s payload, or null while Rc1b's `decodeKeyframe` is the H3 stub (it throws a plain `Error`; a `CaptureError` still propagates). */
function keyframeAt(c: CaptureContents, i: number): KeyframePayload | null {
  const t = c.records;
  const seg = c.segments[t.segment[i]!]!;
  try {
    return decodeKeyframe(new DataView(seg.buffer, seg.byteOffset, seg.byteLength), t.offset[i]!, t.len[i]!);
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    return null;
  }
}

/** `range`'s answer: typed arrays keyed by column (transferred by the Worker). */
export type CaptureRangeColumns = Record<string, Float64Array | Uint32Array>;

/**
 * The STATUS columns over [t0, t1]. Without `buckets`: one sample per STATUS in the span, `seconds` plus each column.
 * With `buckets` (1..`RANGE_MAX_BUCKETS`): the span cut into that many equal buckets, `seconds` (each bucket's start),
 * `count` (STATUS records in it) and per column `<column>.min` and `<column>.max` (NaN for an empty bucket), so a
 * timeline draws min/max columns without receiving every sample. Unknown columns and a bad span are `badValue`.
 */
export function rangeCapture(c: CaptureContents, idx: CaptureTimeIndex, t0: number, t1: number, columns: readonly string[], buckets?: number): CaptureRangeColumns {
  if (!(Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0)) throw new CaptureError("badValue", -1, `range [${t0}, ${t1}]`);
  if (buckets !== undefined && !(Number.isInteger(buckets) && buckets >= 1 && buckets <= RANGE_MAX_BUCKETS)) throw new CaptureError("badValue", -1, `range buckets ${buckets}`);
  for (const col of columns) if (!Object.hasOwn(STATUS_COLUMNS, col)) throw new CaptureError("badValue", -1, `unknown range column "${col}"`);
  const cols = columns as readonly StatusColumn[];
  const from = firstAtOrAfter(idx.statusSeconds, idx.statusCount, t0);
  const to = lastAtOrBefore(idx.statusSeconds, idx.statusCount, t1) + 1;
  const n = Math.max(0, to - from);
  const tbl = c.records;
  const read = (s: number, col: StatusColumn): number => {
    const i = idx.statusRecord[s]!;
    const seg = c.segments[tbl.segment[i]!]!;
    return readStatusColumn(new DataView(seg.buffer, seg.byteOffset, seg.byteLength), tbl.offset[i]!, col);
  };
  const out: CaptureRangeColumns = {};
  if (buckets === undefined) {
    out[RANGE_SECONDS] = idx.statusSeconds.slice(from, from + n);
    for (const col of cols) {
      const a = new Float64Array(n);
      for (let j = 0; j < n; j++) a[j] = read(from + j, col);
      out[col] = a;
    }
    return out;
  }
  const width = (t1 - t0) / buckets;
  const starts = new Float64Array(buckets);
  for (let b = 0; b < buckets; b++) starts[b] = t0 + b * width;
  const count = new Uint32Array(buckets);
  const bucketOf = (s: number): number => (width > 0 ? Math.min(buckets - 1, Math.floor((idx.statusSeconds[s]! - t0) / width)) : 0);
  for (let j = 0; j < n; j++) count[bucketOf(from + j)]!++;
  out[RANGE_SECONDS] = starts;
  out.count = count;
  for (const col of cols) {
    const lo = new Float64Array(buckets).fill(NaN);
    const hi = new Float64Array(buckets).fill(NaN);
    for (let j = 0; j < n; j++) {
      const b = bucketOf(from + j);
      const v = read(from + j, col);
      if (!(v >= lo[b]!)) lo[b] = v;
      if (!(v <= hi[b]!)) hi[b] = v;
    }
    out[`${col}.min`] = lo;
    out[`${col}.max`] = hi;
  }
  return out;
}
