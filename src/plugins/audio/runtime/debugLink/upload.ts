// The audio topic's take upload, build side (plan task A2; schema in `schema.ts`): `take.upload` makes the take's file
// bytes and keeps them as one upload; an `upload` subscription sends them as `AUDIO_TAKE_CHUNK` records of at most
// `TAKE_CHUNK_BYTES`, one chunk per sample, in order, on the topic's reliable channel (64 KiB messages on every
// transport, plan §7a). Closing the subscription before the last chunk abandons it (the upload stays until the next
// `take.upload`, so the tool may subscribe again from chunk 0). The topic (`topic.ts`, A1) dispatches to it.
import type { DebugSubscription } from "../../../../engine/debugLink/topics";
import type { TakeUploadParams, TakeUploadReply } from "./schema";

/** Where an upload's bytes come from: the build's take (`take.ts`'s `takeFileBytes` and `Audio.take.seconds`). */
export interface TakeUploadSource {
  /** The stopped take's file bytes (stops a running take first); rejects with "nothing recorded: …" when there is none. */
  bytes(): Promise<Uint8Array>;
  /** The take's length, seconds. */
  seconds(): number;
}

/** A build's uploads: at most one kept at a time. */
export interface TakeUploads {
  /** `take.upload`: makes the bytes and keeps them as a new upload (dropping the last); resolves with the reply. */
  begin(params: TakeUploadParams): Promise<TakeUploadReply>;
  /** An `upload` subscription for upload `upload`; refused when that upload isn't the one kept. */
  subscribe(upload: number): DebugSubscription | { readonly refused: string };
  /** The link closed: drops the kept upload. */
  dispose(): void;
}

/** The uploads for one link's audio topic, reading bytes from `source`. */
export function createTakeUploads(source: TakeUploadSource): TakeUploads {
  void source;
  throw new Error("A2: not implemented");
}
