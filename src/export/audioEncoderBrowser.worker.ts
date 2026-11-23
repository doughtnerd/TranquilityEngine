// An encoder thread in the browser (ADR 0351 §4): a module Worker spawned by `audioEncoderBrowser.ts`. Vite bundles the
// wasm as an asset; the Worker fetches and compiles it on its first request.
import type { ThreadReply, ThreadRequest } from "./audioEncoder";
import { serveEncoder } from "./audioEncoderThread";

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<ThreadRequest>) => void) | null;
  postMessage(reply: ThreadReply, transfer: Transferable[]): void;
};

serveEncoder(
  {
    onMessage: (handler) => {
      scope.onmessage = (ev) => handler(ev.data);
    },
    post: (reply, transfer) => scope.postMessage(reply, transfer),
  },
  async () => {
    const res = await fetch(new URL("./wasm/myco_audio_encode.wasm", import.meta.url));
    if (!res.ok) throw new Error(`myco_audio_encode.wasm didn't load (${res.status})`);
    return WebAssembly.compile(await res.arrayBuffer());
  },
);
