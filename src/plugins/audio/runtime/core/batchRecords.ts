// The command stream's records, walked (api-and-models §4.2, the wire's BATCH layout): a BATCH or REPLAY message is an
// envelope and batch header (`BATCH_HEADER_FIXED_END` bytes) followed by `count` records, each a record head (opcode,
// length in words, voice, frame offset after `firstFrame`, or `ASAP`) and its body. `batchRecords` lists them with each
// record's absolute frame; the generated readers (`wire.generated.ts` `readBusRamp`, `readPlay`, ...) decode a body at
// the listed offset. Any reader of posted batches (a recorder of main's commands, a harness that watches the link) walks
// them through this, so the layout is spelled out once beside the generated codec.
import { ASAP, BATCH_HEADER_FIXED_END, Kind, readBatchHeader, readEnvelope, readRecordHead } from "../wire.generated";

/** One record of a posted batch. */
export interface BatchRecord {
  /** The record's opcode (`Op`). */
  readonly opcode: number;
  /** The record head's voice (or bus index, or 0). */
  readonly voiceId: number;
  /** The absolute frame it applies at (`firstFrame + frameOffset`), or -1 for `ASAP`. */
  readonly frame: number;
  /** The message's bytes, and where this record starts in them, for the generated reader of its opcode. */
  readonly view: DataView;
  readonly off: number;
}

/** A posted batch: its kind (`Kind.BATCH` or `Kind.REPLAY`), header and records. */
export interface PostedBatch {
  readonly kind: number;
  readonly firstFrame: number;
  readonly flags: number;
  readonly records: BatchRecord[];
}

/** The batch `message` carries, or null when it is not a BATCH or REPLAY (a clip message, a RECYCLE, ...). */
export function batchRecords(message: ArrayBuffer): PostedBatch | null {
  const view = new DataView(message);
  if (view.byteLength < BATCH_HEADER_FIXED_END) return null;
  const kind = readEnvelope(view, 0).kind;
  if (kind !== Kind.BATCH && kind !== Kind.REPLAY) return null;
  const header = readBatchHeader(view, 0);
  const records: BatchRecord[] = [];
  let off = BATCH_HEADER_FIXED_END;
  for (let i = 0; i < header.count; i++) {
    const head = readRecordHead(view, off);
    records.push({ opcode: head.opcode, voiceId: head.voiceId, frame: head.frameOffset === ASAP ? -1 : header.firstFrame + head.frameOffset, view, off });
    if (head.words === 0) break; // a malformed record would loop here forever
    off += head.words * 4;
  }
  return { kind, firstFrame: header.firstFrame, flags: header.flags, records };
}
