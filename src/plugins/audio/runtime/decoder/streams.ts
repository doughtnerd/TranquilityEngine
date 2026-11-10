// Stream decode (K7, `streams.ts` half): a STUB until B3. The message shapes are final (protocol.ts: `streamOpen`,
// `streamCredit`, `streamSeek` with an epoch, `streamClose`, answered by `streamOpened`, `streamChunk`, `streamClosed`
// and `error` with `streamId` and `asset`); every request is refused with an `error` reply so a caller that runs ahead of
// B3 sees a clear failure, never silence.
import type { DecoderReply, StreamRequest } from "./protocol";

export interface StreamHost {
  post(reply: DecoderReply, transfer?: Transferable[]): void;
}

/** B3 replaces the body; the signature (one request in, replies out through `host`) stays. */
export function handleStreamRequest(host: StreamHost, request: StreamRequest): void {
  const asset = request.type === "streamOpen" ? request.asset : undefined;
  host.post({ type: "error", streamId: request.streamId, asset, message: `audio decoder: streams are not implemented yet (${request.type})` });
}
