// A debug link sample's records (ADR 0376: "samples reuse each feature's capture and take records"): the record framing
// of captures and takes (audio 0171/0172 §5.3, 0348), so a feature encodes a record once and the same bytes go into a
// take file, a capture or a link sample. Each record is a 20 B head then its payload:
//
//   u8  type    the feature's record type (below 0x80: a reader that doesn't know it passes over it by `len`)
//   u8  flags   0 (no flag is defined for link samples; a record with flags set is refused)
//   u16 epoch   0 on the link
//   u32 len     payload bytes after the head
//   u32 seq     the record's sequence number within its subscription (wraps)
//   f64 frame   the build's frame number when it was written (finite, non-negative)
//
// The audio capture format (`plugins/audio/runtime/capture/format.ts`) owns the same head for files; this is the link's
// reader and writer of it, which the engine needs without the audio plugin. Reading never throws: a run that stops making
// sense ends the read, and the records before it are kept.

/** The head's size. */
export const RECORD_HEAD_BYTES = 20;
/** The largest record payload a link sample carries (the capture format's per-record cap, 256 KB). */
export const RECORD_MAX_BYTES = 262_144;
/** The first type a reader must know (capture §5.3); link records stay below it. */
export const RECORD_TYPE_REQUIRED_FIRST = 0x80;

/** One record. */
export interface LinkRecord {
  readonly type: number;
  readonly seq: number;
  readonly frame: number;
  readonly payload: Uint8Array;
}

/** Collects records for one sample. */
export class RecordWriter {
  private readonly parts: Uint8Array[] = [];
  private size = 0;

  /** Records written so far. */
  get count(): number {
    return this.parts.length;
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.size;
  }

  /** Adds a record. Throws for a type at or above 0x80 or a payload past the cap (programming errors). */
  write(type: number, seq: number, frame: number, payload: Uint8Array): void {
    if (!(Number.isInteger(type) && type >= 0 && type < RECORD_TYPE_REQUIRED_FIRST)) throw new Error(`A debug link record type is 0..0x7f (got ${type}).`);
    if (payload.byteLength > RECORD_MAX_BYTES) throw new Error(`A debug link record is at most ${RECORD_MAX_BYTES} bytes (got ${payload.byteLength}).`);
    const out = new Uint8Array(RECORD_HEAD_BYTES + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint8(0, type);
    view.setUint8(1, 0);
    view.setUint16(2, 0, true);
    view.setUint32(4, payload.byteLength, true);
    view.setUint32(8, seq >>> 0, true);
    view.setFloat64(12, Number.isFinite(frame) && frame >= 0 ? frame : 0, true);
    out.set(payload, RECORD_HEAD_BYTES);
    this.parts.push(out);
    this.size += out.byteLength;
  }

  /** The records back to back; the writer is empty again. */
  take(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    this.parts.length = 0;
    this.size = 0;
    return out;
  }
}

/** The records in `bytes`, and why the read stopped early (null: it read them all). */
export function readRecords(bytes: Uint8Array): { records: LinkRecord[]; stopped: string | null } {
  const records: LinkRecord[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at < bytes.byteLength) {
    if (at + RECORD_HEAD_BYTES > bytes.byteLength) return { records, stopped: `a record head at byte ${at} is cut off` };
    const type = view.getUint8(at);
    if (type >= RECORD_TYPE_REQUIRED_FIRST) return { records, stopped: `unknown required record type 0x${type.toString(16)} at byte ${at}` };
    if (view.getUint8(at + 1) !== 0) return { records, stopped: `unknown record flags at byte ${at + 1}` };
    const len = view.getUint32(at + 4, true);
    if (len > RECORD_MAX_BYTES || at + RECORD_HEAD_BYTES + len > bytes.byteLength) return { records, stopped: `a record of ${len} bytes at byte ${at} doesn't fit` };
    const frame = view.getFloat64(at + 12, true);
    if (!(Number.isFinite(frame) && frame >= 0)) return { records, stopped: `a record's frame at byte ${at + 12} isn't a frame number` };
    records.push({ type, seq: view.getUint32(at + 8, true), frame, payload: bytes.subarray(at + RECORD_HEAD_BYTES, at + RECORD_HEAD_BYTES + len) });
    at += RECORD_HEAD_BYTES + len;
  }
  return { records, stopped: null };
}
