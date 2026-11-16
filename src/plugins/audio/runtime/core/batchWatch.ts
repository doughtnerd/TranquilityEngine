// Test support: what a core backend sends the core, read off the link it was constructed with. `watchBatches(link)` wraps
// the link's `post` (the message still goes on to the core) and keeps a decoded copy of every BATCH and REPLAY
// (`batchRecords.ts`): tests read the records the backend wrote, never its command writer.
import { batchRecords, type BatchRecord, type PostedBatch } from "./batchRecords";

/** Anything with a `post(buffer, ...)` (a `CoreLink`, a recording fake). */
export interface PostingLink {
  post(buffer: ArrayBuffer, ...rest: never[]): unknown;
}

export interface BatchWatch {
  /** The batches posted since the last `take` (or since the watch began), oldest first; `take` empties the list. */
  take(): PostedBatch[];
  /** Every record of the batches posted since the last `take`, in order (empties the list). */
  takeRecords(): BatchRecord[];
  /** The records of opcode `op` posted since the last `take`, in order (empties the list). */
  takeOps(op: number): BatchRecord[];
  /** The batches posted since the last `take`, without taking them. */
  readonly pending: readonly PostedBatch[];
  /** Puts the link's own `post` back. */
  stop(): void;
}

export function watchBatches(link: PostingLink): BatchWatch {
  const posted: PostedBatch[] = [];
  const own = link.post;
  link.post = function (this: unknown, buffer: ArrayBuffer, ...rest: never[]) {
    // A copy: pooled BATCH buffers are transferred to the core and come back reused.
    const batch = buffer instanceof ArrayBuffer ? batchRecords(buffer.slice(0)) : null;
    if (batch) posted.push(batch);
    return own.call(link, buffer, ...rest);
  } as PostingLink["post"];
  const take = () => posted.splice(0);
  return {
    take,
    takeRecords: () => take().flatMap((b) => b.records),
    takeOps: (op) => take().flatMap((b) => b.records.filter((r) => r.opcode === op)),
    get pending() {
      return posted;
    },
    stop() {
      link.post = own;
    },
  };
}
