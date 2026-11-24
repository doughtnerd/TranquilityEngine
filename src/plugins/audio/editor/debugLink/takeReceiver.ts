// The tool side of the audio topic's take upload (plan task A2; the chunk record is `TakeChunk` in the build's
// `schema.ts`): takes the chunks of one upload in order and yields the take file's bytes when the last arrives. Any
// chunk that isn't the next one, a wrong upload or total, or more bytes than the reply promised fails the receiver for
// good: the caller unsubscribes and shows the error.
import type { TakeChunk, TakeUploadReply } from "../../runtime/debugLink/schema";

/** What `push` says. */
export type TakeReceiveResult =
  /** The chunk was taken; more are due. `received` of `bytes` so far. */
  | { readonly status: "more"; readonly received: number; readonly bytes: number }
  /** The last chunk arrived: the take file's bytes. */
  | { readonly status: "done"; readonly bytes: Uint8Array }
  /** The upload failed (and the receiver takes nothing more). */
  | { readonly status: "error"; readonly error: string };

/** Reassembles one upload (`reply` is `take.upload`'s answer). */
export interface TakeReceiver {
  /** Takes the next chunk, in order. */
  push(chunk: TakeChunk): TakeReceiveResult;
  /** Bytes received so far. */
  readonly received: number;
}

export function createTakeReceiver(reply: TakeUploadReply): TakeReceiver {
  const out = new Uint8Array(reply.bytes);
  let next = 0;
  let received = 0;
  let failure: string | null = null;
  let done = false;
  const fail = (error: string): TakeReceiveResult => {
    failure = error;
    return { status: "error", error };
  };
  return {
    get received() {
      return received;
    },
    push(chunk) {
      if (failure) return { status: "error", error: failure };
      if (done) return fail("the upload already finished");
      if (chunk.upload !== reply.upload) return fail(`chunk of upload ${chunk.upload}, expected upload ${reply.upload}`);
      if (chunk.total !== reply.chunks) return fail(`chunk says ${chunk.total} chunks in all, the upload has ${reply.chunks}`);
      if (chunk.index < next) return fail(`chunk ${chunk.index} arrived twice`);
      if (chunk.index > next) return fail(`chunk ${next} is missing (got ${chunk.index})`);
      const n = chunk.bytes.byteLength;
      const last = chunk.index === reply.chunks - 1;
      if (received + n > reply.bytes) return fail(`more bytes than the ${reply.bytes} the upload promised`);
      if (!last && n !== reply.chunkBytes) return fail(`chunk ${chunk.index} holds ${n} bytes, expected ${reply.chunkBytes}`);
      out.set(chunk.bytes, received);
      received += n;
      next++;
      if (!last) return { status: "more", received, bytes: reply.bytes };
      if (received !== reply.bytes) return fail(`the upload ended at ${received} of ${reply.bytes} bytes`);
      done = true;
      return { status: "done", bytes: out };
    },
  };
}
