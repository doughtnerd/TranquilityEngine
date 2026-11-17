// Test support: what a core backend sends the core, read where the core receives it. ADR 0223: nothing wraps a link.
// On the loopback, `LoopbackAudio.watch()` / `LoopbackHost.watch()` (`runtime/testing.ts`) is the watch; a unit test
// whose fake port stands in for the core feeds a `batchRecorder` from that port's `postMessage`. Either keeps a decoded
// copy of every BATCH and REPLAY (`batchRecords.ts`): tests read the records the backend wrote, never its command writer.
import { batchRecords, type BatchRecord, type PostedBatch } from "./batchRecords";

export interface BatchWatch {
  /** The batches received since the last `take` (or since the watch began), oldest first; `take` empties the list. */
  take(): PostedBatch[];
  /** Every record of the batches received since the last `take`, in order (empties the list). */
  takeRecords(): BatchRecord[];
  /** The records of opcode `op` received since the last `take`, in order (empties the list). */
  takeOps(op: number): BatchRecord[];
  /** The batches received since the last `take`, without taking them. */
  readonly pending: readonly PostedBatch[];
  /** Stops watching. */
  stop(): void;
}

/** A watch fed by hand: a fake core port's `postMessage` hands it every message (`receive`), as the core would get it. */
export interface BatchRecorder extends BatchWatch {
  /** A message the port was handed; BATCH and REPLAY buffers are decoded (from a copy) and kept, the rest ignored. */
  receive(message: unknown): void;
}

export function batchRecorder(): BatchRecorder {
  const received: PostedBatch[] = [];
  let watching = true;
  const take = () => received.splice(0);
  return {
    receive(message) {
      if (!watching || !(message instanceof ArrayBuffer)) return;
      // A copy: pooled BATCH buffers go back to the link and are reused.
      const batch = batchRecords(message.slice(0));
      if (batch) received.push(batch);
    },
    take,
    takeRecords: () => take().flatMap((b) => b.records),
    takeOps: (op) => take().flatMap((b) => b.records.filter((r) => r.opcode === op)),
    get pending() {
      return received;
    },
    stop() {
      watching = false;
    },
  };
}
