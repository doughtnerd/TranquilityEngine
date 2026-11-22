/**
 * Internal (ADR 0337 §4): the body of an encoder thread, for a browser Worker (`audioEncoderBrowser.worker.ts`) and a
 * `worker_threads` thread (`audioEncoderNodeWorker.mjs`) alike. It instantiates the encoder on the first request (`load`
 * gives the wasm) and answers each `ThreadRequest` with a `ThreadReply`, transferring the encoded bytes.
 */
import { AudioEncodeError, type ThreadReply, type ThreadRequest } from "./audioEncoder";
import { instantiateEncoder, type EncoderInstance } from "./audioEncoderWasm";

/** A thread's side of the channel: a Worker's global scope or a `MessagePort`-like object. */
export interface ThreadPort {
  onMessage(handler: (message: ThreadRequest) => void): void;
  post(reply: ThreadReply, transfer: ArrayBuffer[]): void;
}

/** Serves encode requests on `port` with the encoder `load` gives (bytes or a compiled module). */
export function serveEncoder(port: ThreadPort, load: () => Promise<BufferSource | WebAssembly.Module>): void {
  let encoder: Promise<EncoderInstance> | null = null;
  let chain = Promise.resolve();
  port.onMessage((message) => {
    // One at a time, in order.
    chain = chain.then(async () => {
      try {
        encoder ??= load().then((wasm) => instantiateEncoder(wasm));
        const result = (await encoder).encode(message.request);
        port.post({ id: message.id, result }, [result.bytes.buffer as ArrayBuffer]);
      } catch (err) {
        if (!(err instanceof AudioEncodeError)) encoder = null; // a failed load or a trap: start afresh next time
        const kind = err instanceof AudioEncodeError ? err.kind : "encode";
        port.post({ id: message.id, error: { kind, message: err instanceof Error ? err.message : String(err) } }, []);
      }
    });
  });
}
