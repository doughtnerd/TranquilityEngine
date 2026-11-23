/**
 * Internal (ADR 0351 §5, 0359 §3): the audio encoder for `npm run export` — `worker_threads` threads
 * (`audioEncoderNodeWorker.mjs`), cores − 1 by default (encoding scales linearly to three workers in the A0 spike). The
 * wasm is read and compiled once here and handed to each thread.
 */
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { createEncoderPool, type AudioEncoder, type EncoderThread, type ThreadReply } from "./audioEncoder";

const WASM = new URL("./wasm/myco_audio_encode.wasm", import.meta.url);
const ENTRY = new URL("./audioEncoderNodeWorker.mjs", import.meta.url);

let compiled: Promise<WebAssembly.Module> | null = null;
/** The encoder module, compiled once per process. */
function encoderModule(): Promise<WebAssembly.Module> {
  compiled ??= readFile(WASM).then((bytes) => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>));
  return compiled;
}

/** A pool thread that buffers requests until its Worker exists (the module compiles asynchronously). */
function spawnThread(): EncoderThread {
  let worker: Worker | null = null;
  let dead = false;
  const pending: [unknown, ArrayBuffer[]][] = [];
  let handlers: { onReply(r: ThreadReply): void; onFail(e: Error): void } | null = null;
  encoderModule().then(
    (module) => {
      if (dead) return;
      worker = new Worker(ENTRY, { workerData: { module } });
      worker.on("message", (reply: ThreadReply) => handlers?.onReply(reply));
      worker.on("error", (err: Error) => handlers?.onFail(err));
      worker.on("exit", (code) => code !== 0 && !dead && handlers?.onFail(new Error(`exited with code ${code}`)));
      for (const [m, t] of pending.splice(0)) worker.postMessage(m, t);
    },
    (err: Error) => handlers?.onFail(err),
  );
  return {
    post(message, transfer) {
      if (worker) worker.postMessage(message, transfer);
      else pending.push([message, transfer]);
    },
    listen(onReply, onFail) {
      handlers = { onReply, onFail };
    },
    terminate() {
      dead = true;
      void worker?.terminate();
    },
  };
}

/** Node's encoder: `workers` threads at most (default: cores − 1, at least 1). */
export function createNodeAudioEncoder(options: { workers?: number } = {}): AudioEncoder {
  return createEncoderPool({ size: options.workers ?? Math.max(1, availableParallelism() - 1), spawn: spawnThread });
}
