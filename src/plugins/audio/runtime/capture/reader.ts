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
  readRecordHead,
  type CaptureHeader, type CaptureMeta, type EpochPayload, type EventPayload, type GapPayload, type IndexPayload,
  type MarkerPayload, type MixOpPayload, type NameTable, type NamesPayload, type RecordHead,
} from "./format";

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
   * Default: `DecompressionStream("deflate-raw")`.
   */
  inflate?(compressed: Uint8Array, maxBytes: number, onChunk: (bytes: number) => void): Promise<Uint8Array>;
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
    const c = this.contents;
    if (this.live) {
      if (this.heldBytes + bytes.byteLength > CAPTURE_MAX_UNCOMPRESSED_BYTES - c.header.metaBytes) {
        throw new CaptureError("tooLarge", base, `a live view past ${CAPTURE_MAX_UNCOMPRESSED_BYTES} B`);
      }
    }
    if (c.segments.length >= 0xffff) throw new CaptureError("tooLarge", base, "more than 65,535 segments");
    const segment = c.segments.length;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.byteLength;
    const t = c.records;
    let off = 0;
    while (off < end) {
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
    c.segments.push(bytes);
    this.heldBytes += bytes.byteLength;
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
  const out = await (opts.inflate ?? inflateDeflateRaw)(body, expected + 1, onChunk);
  if (out.byteLength > expected) throw new CaptureError("inflateOverrun", CAPTURE_HEADER_BYTES, `inflate passed the declared ${expected} B`);
  if (out.byteLength < expected) throw new CaptureError("sizeMismatch", CAPTURE_HEADER_BYTES, `inflated ${out.byteLength} B, the header says ${expected}`);
  return out;
}

/**
 * The default inflater: `DecompressionStream("deflate-raw")`, read chunk by chunk; `onChunk` runs before a chunk is kept
 * and throws to stop (the stream is cancelled), so no more than `maxBytes` plus one chunk is ever held. A corrupt stream
 * is `inflateFailed`.
 */
export async function inflateDeflateRaw(compressed: Uint8Array, maxBytes: number, onChunk: (bytes: number) => void): Promise<Uint8Array> {
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

/** Opens a whole file: header (§5.1's order), payload (inflate or stored), META, records, INDEX. */
export async function openCapture(file: Uint8Array, opts: ReaderOptions = {}): Promise<CaptureContents> {
  const header = readCaptureHeader(file);
  const payload = await capturePayload(header, file.subarray(CAPTURE_HEADER_BYTES), opts);
  if (header.flags & CAPTURE_FLAG_COMPRESSED) opts.onAllocate?.(payload.byteLength, "payload");
  return readCapturePayload(header, payload, opts);
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
