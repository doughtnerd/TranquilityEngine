// Peeking at a message's envelope without reading it: the kind and the message's length, straight
// from the buffer, for the routing hot paths (the STATUS port, stream credits, the seam recorder) that
// must not allocate. The envelope's layout is the schema's (`Envelope` in wire.generated.ts: magic u32,
// version u16, kind u16, seq u32, bodyBytes u32); `readEnvelope` reads all of it into an object.
import { ENVELOPE_BYTES, MAGIC } from "./wire.generated";

/** Byte offsets of the envelope fields the peeks read (`Envelope`'s field order). */
const KIND_AT = 6;
const BODY_BYTES_AT = 12;

/**
 * The kind of the message at `off` in `view` (one of `Kind`), or 0, which no kind is, when there is
 * no message there: fewer bytes than an envelope, or not the `MYA1` magic.
 */
export function peekKind(view: DataView, off = 0): number {
  if (view.byteLength - off < ENVELOPE_BYTES || view.getUint32(off, true) !== MAGIC) return 0;
  return view.getUint16(off + KIND_AT, true);
}

/** Bytes of the message at `off` in `view`, envelope included (`ENVELOPE_BYTES + bodyBytes`). The caller has checked it is one (`peekKind`). */
export function peekMessageBytes(view: DataView, off = 0): number {
  return ENVELOPE_BYTES + view.getUint32(off + BODY_BYTES_AT, true);
}
