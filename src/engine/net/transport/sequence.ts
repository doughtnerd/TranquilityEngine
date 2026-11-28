/**
 * Unreliable sequence numbers (ADR 0471): what every transport numbers its unreliable messages with, so a receiver can
 * drop one that isn't newer than the newest it delivered (latest-wins, ADR 0333). Numbers are u32 that wrap, compared
 * by serial number arithmetic; on the wire one is 4 bytes, big-endian. Whose numbers they are (a connection's, or one
 * path's of a connection, ADR 0398) is the transport's choice: one `UnreliableSequence` per scope.
 *
 * Internal: not public API.
 */

/** @internal Bytes of a sequence number on the wire. */
export const SEQUENCE_BYTES = 4;

/** @internal Writes `seq` at `at` in `buf` (u32, big-endian). */
export function writeSeq(buf: Uint8Array, at: number, seq: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(at, seq);
}

/** @internal The sequence number at `at` in `buf`. */
export function readSeq(buf: Uint8Array, at: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(at);
}

/** @internal `data` after its sequence number: a new message of `SEQUENCE_BYTES + data.byteLength` bytes. */
export function withSeq(seq: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(SEQUENCE_BYTES + data.byteLength);
  writeSeq(out, 0, seq);
  out.set(data, SEQUENCE_BYTES);
  return out;
}

/** @internal One scope's unreliable sequence: the next number to send, and the newest delivered. */
export class UnreliableSequence {
  private nextSeq = 0;
  private newest: number | null = null;

  /** The number the next send takes, without taking it (for a send that may not go). */
  peek(): number {
    return this.nextSeq;
  }

  /** Takes the next number to send (0 first, wrapping after 2³² − 1). */
  next(): number {
    const seq = this.nextSeq;
    this.nextSeq = (seq + 1) >>> 0;
    return seq;
  }

  /**
   * Whether a received `seq` is to be delivered: the first one is, and later ones only when newer than the newest
   * delivered across the wrap (serial number arithmetic: up to 2³¹ − 1 ahead). An accepted one becomes the newest.
   */
  accept(seq: number): boolean {
    if (this.newest !== null && ((seq - this.newest) | 0) <= 0) return false;
    this.newest = seq;
    return true;
  }
}
