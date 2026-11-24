import { DebugLinkListener, type DebugLinkPeer } from "../../src/engine/debugLink/client";
import { DEBUG_LINK_PATH } from "../../src/engine/debugLink/config";
import { createWebSocketServerTransport } from "../../src/server/websocketServer";

// The debug-link spec's tool: a Node process playing the editor or the Studio (ADR 0376, 0403). It listens with the engine's
// `DebugLinkListener` over the Node WebSocket transport on a free loopback port, polls it on a timer (the listener is polled by
// its owner, as the editor's clock does), and hands the test the first build that says hello.

export interface DebugLinkTool {
  /** The address a build connects to (`ws://127.0.0.1:<port>/myco-debug`); the port was free when the tool bound it. */
  readonly address: string;
  /** Resolves with the first build that says hello (accepted, if it arrived pending: a same-machine build the tool lets in). */
  nextPeer(timeoutMs?: number): Promise<DebugLinkPeer>;
  close(): void;
}

/** Starts the listener on a free port (port 0, so the real one is read back) and polls it every 10 ms. */
export async function startDebugLinkTool(): Promise<DebugLinkTool> {
  const transport = createWebSocketServerTransport();
  const waiting: ((peer: DebugLinkPeer) => void)[] = [];
  const arrived: DebugLinkPeer[] = [];
  const listener = new DebugLinkListener(transport, {
    onPeer: (peer) => {
      if (peer.state === "pending") peer.accept(); // a build from this machine says hello first: the tool lets it in
      const w = waiting.shift();
      if (w) w(peer);
      else arrived.push(peer);
    },
  });
  await listener.listen(`ws://127.0.0.1:0${DEBUG_LINK_PATH}`);
  const bound = transport.address;
  if (!bound) throw new Error("the debug-link tool's listener isn't bound");
  const timer = setInterval(() => listener.poll(), 10);
  return {
    address: `ws://127.0.0.1:${bound.port}${DEBUG_LINK_PATH}`,
    nextPeer(timeoutMs = 30_000) {
      const ready = arrived.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no build said hello within ${timeoutMs} ms`)), timeoutMs);
        waiting.push((p) => (clearTimeout(t), resolve(p)));
      });
    },
    close() {
      clearInterval(timer);
      listener.close();
    },
  };
}
