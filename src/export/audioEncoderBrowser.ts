/**
 * Internal (ADR 0351 §4–§6, 0359 §3): the audio encoder in the editor and the Studio — Web Workers
 * (`audioEncoderBrowser.worker.ts`), spawned on demand, at most [`STUDIO_ENCODE_CONCURRENCY`] (2) encoding at once.
 */
import { createEncoderPool, STUDIO_ENCODE_CONCURRENCY, type AudioEncoder, type EncoderThread, type ThreadReply } from "./audioEncoder";

/** A Worker running the encoder thread. */
function spawnWorker(): EncoderThread {
  const worker = new Worker(new URL("./audioEncoderBrowser.worker.ts", import.meta.url), { type: "module" });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer),
    listen(onReply, onFail) {
      worker.onmessage = (ev: MessageEvent<ThreadReply>) => onReply(ev.data);
      worker.onerror = (ev) => {
        ev.preventDefault();
        onFail(new Error(ev.message || "the worker failed"));
      };
    },
    terminate: () => worker.terminate(),
  };
}

/** The browser's encoder: `concurrency` workers at most (default 2). */
export function createBrowserAudioEncoder(options: { concurrency?: number } = {}): AudioEncoder {
  return createEncoderPool({ size: options.concurrency ?? STUDIO_ENCODE_CONCURRENCY, spawn: spawnWorker });
}
