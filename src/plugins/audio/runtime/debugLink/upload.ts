// The audio topic's take upload, build side (plan task A2; schema in `schema.ts`): `take.upload` makes the take's file
// bytes and keeps them as one upload; an `upload` subscription sends them as `AUDIO_TAKE_CHUNK` records of at most
// `TAKE_CHUNK_BYTES`, one chunk per sample, in order, on the topic's reliable channel (64 KiB messages on every
// transport, plan §7a). Closing the subscription before the last chunk abandons it (the upload stays until the next
// `take.upload`, so the tool may subscribe again from chunk 0). The topic (`topic.ts`, A1) dispatches to it.
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import { AudioLinkRecord, encodeTakeChunk, TAKE_CHUNK_BYTES, type TakeUploadParams, type TakeUploadReply } from "./schema";

/** Where an upload's bytes come from: the build's take (`take.ts`'s `takeFileBytes` and `Audio.take.seconds`). */
export interface TakeUploadSource {
  /**
   * The bytes to upload, for the request's params: the stopped take's file bytes (stops a running take first; rejects
   * with "nothing recorded: …" when there is none), or a build file's (ADR 0410, `buildAudio.ts`).
   */
  bytes(params: unknown): Promise<Uint8Array>;
  /** The take's length, seconds. */
  seconds(): number;
}

/** A build's uploads: at most one kept at a time. */
export interface TakeUploads {
  /** `take.upload`: makes the bytes and keeps them as a new upload (dropping the last); resolves with the reply. */
  begin(params: unknown): Promise<TakeUploadReply>;
  /** An `upload` subscription for upload `upload`; refused when that upload isn't the one kept. */
  subscribe(upload: number): DebugSubscription | { readonly refused: string };
  /** The link closed: drops the kept upload. */
  dispose(): void;
}

/** The uploads for one link's audio topic, reading bytes from `source`; their ids start at `firstId` (default 1). */
export function createTakeUploads(source: TakeUploadSource, firstId = 1): TakeUploads {
  let nextId = firstId;
  let disposed = false;
  /** True while `begin` makes bytes. */
  let making = false;
  let kept: { id: number; bytes: Uint8Array; chunks: number; sent: number; sub: DebugSubscription | null } | null = null;

  /** An upload is in flight from its subscription's start until its last chunk is out or it closes. */
  const busy = () => making || (kept !== null && kept.sub !== null);

  return {
    async begin(params) {
      if (disposed) throw new Error("the link closed");
      if (busy()) throw new Error("an upload is already in progress: wait for it to finish or cancel it first");
      making = true;
      try {
        const bytes = await source.bytes(params);
        if (disposed) throw new Error("the link closed");
        const chunks = Math.max(1, Math.ceil(bytes.byteLength / TAKE_CHUNK_BYTES));
        const id = nextId++;
        kept = { id, bytes, chunks, sent: 0, sub: null };
        return { upload: id, bytes: bytes.byteLength, chunks, chunkBytes: TAKE_CHUNK_BYTES, seconds: source.seconds() };
      } finally {
        making = false;
      }
    },
    subscribe(upload) {
      const up = kept;
      if (disposed || !up || up.id !== upload) return { refused: `upload ${upload} isn't the one kept (ask for it first)` };
      if (up.sub) return { refused: `upload ${upload} is already being sent` };
      up.sent = 0;
      const sub: DebugSubscription = {
        sample(out, frame) {
          if (up.sub !== sub || up.sent >= up.chunks) return;
          const from = up.sent * TAKE_CHUNK_BYTES;
          const piece = up.bytes.subarray(from, Math.min(up.bytes.byteLength, from + TAKE_CHUNK_BYTES));
          out.write(AudioLinkRecord.takeChunk, up.sent, frame, encodeTakeChunk({ upload: up.id, index: up.sent, total: up.chunks, bytes: piece }));
          up.sent++;
          // The last chunk is out: the upload is done and a new one may begin (the tool unsubscribes when it has them all).
          if (up.sent >= up.chunks) up.sub = null;
        },
        close() {
          if (up.sub === sub) up.sub = null;
        },
      };
      up.sub = sub;
      return sub;
    },
    dispose() {
      disposed = true;
      if (kept) kept.sub = null;
      kept = null;
    },
  };
}
