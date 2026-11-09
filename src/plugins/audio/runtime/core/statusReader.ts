// The status reader (ADR 0157; api-and-models §4.3): decodes a STATUS message into one preallocated `StatusBlock`,
// so the main thread allocates nothing per block (the generated `readStatus` builds a fresh block, and fresh arrays
// and items, for every message; #66). The same checks and errors as `readStatus` (`WireError`s with codes), the
// same field offsets. The block it returns is the reader's own and is overwritten by the next `read`: consumers
// (the mirror, in `onmessage`) use it before returning.
import type { StatusBlock } from "../wire.generated";

export class StatusReader {
  /** The reused block. Its section arrays keep their capacity between reads; `length` is set per read. */
  readonly block: StatusBlock;

  constructor() {
    this.block = undefined as unknown as StatusBlock;
    throw new Error("not implemented: A1.4 (StatusReader)");
  }

  /** Decodes `buffer` (envelope first) into `block` and returns it. Throws `WireError` as `readStatus` does. */
  read(buffer: ArrayBuffer | ArrayBufferView): StatusBlock {
    void buffer;
    throw new Error("not implemented: A1.4 (StatusReader.read)");
  }
}
