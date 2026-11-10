// The decoder worker (ADR 0157; architecture section 1): clips decode here, off the main thread. A module worker; the
// client posts `init` with the wasm's URL first (protocol.ts). All logic is in handler.ts so tests run it in Node.
import hash from "../wasm/hash.json";
import { createDecoderHandler } from "./handler";
import type { DecoderRequest } from "./protocol";

const scope = self as unknown as { onmessage: ((e: MessageEvent<DecoderRequest>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

const handler = createDecoderHandler({
  post: (reply, transfer) => scope.postMessage(reply, transfer ?? []),
  expectedSourceHash: hash.sourceHash,
  fetchBytes: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`audio decoder: fetching myco_audio_decode.wasm failed (HTTP ${response.status})`);
    return response.arrayBuffer();
  },
});

scope.onmessage = (e) => {
  void handler.handle(e.data);
};
