// Path choice (ADR 0403 "Which path each pair takes"; plan task L5): one case per row of the pair table, in both
// directions, and the rules around it.
import { describe, expect, it } from "vitest";
import { ENDPOINT_KINDS, type EndpointKind } from "../protocol";
import { choosePath, type PathCapabilities } from "./path";

interface Setup {
  /** Whether each side can listen now: [local, remote]. */
  readonly listen?: readonly [boolean, boolean];
  /** Whether each side has WebRTC: [local, remote]. */
  readonly webrtc?: readonly [boolean, boolean];
  readonly lan?: boolean;
  readonly hosted?: boolean;
}

function capabilities(setup: Setup = {}): PathCapabilities {
  const [listenLocal, listenRemote] = setup.listen ?? [false, false];
  const [webrtcLocal, webrtcRemote] = setup.webrtc ?? [true, true];
  return {
    canListen: { local: listenLocal, remote: listenRemote },
    webrtc: { local: webrtcLocal, remote: webrtcRemote },
    lanRendezvous: setup.lan ?? false,
    hostedRendezvous: setup.hosted ?? false,
  };
}

describe("path choice", () => {
  it("native ↔ native: WebSocket, either side listening", () => {
    const both = capabilities({ listen: [true, true] });
    expect(choosePath("native", "native", both)).toEqual({ path: "websocket", listener: "either" });
  });

  it("native ↔ native where only one side can listen: WebSocket to that side", () => {
    expect(choosePath("native", "native", capabilities({ listen: [true, false] }))).toEqual({ path: "websocket", listener: "local" });
    expect(choosePath("native", "native", capabilities({ listen: [false, true] }))).toEqual({ path: "websocket", listener: "remote" });
  });

  it("page on http ↔ native: WebSocket to the native listener, from either end", () => {
    expect(choosePath("page-http", "native", capabilities({ listen: [false, true] }))).toEqual({ path: "websocket", listener: "remote" });
    expect(choosePath("native", "page-http", capabilities({ listen: [true, false] }))).toEqual({ path: "websocket", listener: "local" });
  });

  it("page on http ↔ page on http: WebRTC through the LAN rendezvous (the serving server or a native app's)", () => {
    expect(choosePath("page-http", "page-http", capabilities({ lan: true }))).toEqual({ path: "webrtc", rendezvous: "lan" });
    expect(choosePath("page-http", "page-http", capabilities({ lan: true, hosted: true }))).toEqual({ path: "webrtc", rendezvous: "lan" });
  });

  it("page on http ↔ page on http without a LAN rendezvous: the hosted one, else unreachable (needs-rendezvous)", () => {
    expect(choosePath("page-http", "page-http", capabilities({ hosted: true }))).toEqual({ path: "webrtc", rendezvous: "hosted" });
    expect(choosePath("page-http", "page-http", capabilities())).toEqual({ path: "unreachable", reason: "needs-rendezvous" });
  });

  it("page on https ↔ anything: WebRTC through the hosted rendezvous, else unreachable (needs-hosted-rendezvous)", () => {
    for (const other of ENDPOINT_KINDS) {
      const hosted = capabilities({ listen: [true, true], hosted: true });
      expect(choosePath("page-https", other, hosted)).toEqual({ path: "webrtc", rendezvous: "hosted" });
      expect(choosePath(other, "page-https", hosted)).toEqual({ path: "webrtc", rendezvous: "hosted" });
      const none = capabilities({ listen: [true, true] });
      expect(choosePath("page-https", other, none)).toEqual({ path: "unreachable", reason: "needs-hosted-rendezvous" });
      expect(choosePath(other, "page-https", none)).toEqual({ path: "unreachable", reason: "needs-hosted-rendezvous" });
    }
  });

  it("page on https never takes a LAN rendezvous, even when one is known (mixed content)", () => {
    const lanOnly = capabilities({ lan: true });
    expect(choosePath("page-https", "page-http", lanOnly)).toEqual({ path: "unreachable", reason: "needs-hosted-rendezvous" });
    expect(choosePath("page-https", "page-https", lanOnly)).toEqual({ path: "unreachable", reason: "needs-hosted-rendezvous" });
    const both = capabilities({ lan: true, hosted: true });
    expect(choosePath("page-http", "page-https", both)).toEqual({ path: "webrtc", rendezvous: "hosted" });
  });

  it("a native side that can't listen makes its pair use WebRTC through a rendezvous", () => {
    expect(choosePath("native", "native", capabilities({ lan: true }))).toEqual({ path: "webrtc", rendezvous: "lan" });
    expect(choosePath("native", "page-http", capabilities({ listen: [false, false], lan: true }))).toEqual({ path: "webrtc", rendezvous: "lan" });
    expect(choosePath("page-http", "native", capabilities({ listen: [false, false], hosted: true }))).toEqual({ path: "webrtc", rendezvous: "hosted" });
    expect(choosePath("native", "native", capabilities())).toEqual({ path: "unreachable", reason: "needs-rendezvous" });
  });

  it("a side without WebRTC that needs it makes the pair unreachable (no-webrtc); a WebSocket pair doesn't need it", () => {
    // WebRTC needed: the native side without it can't listen, so the pair must signal.
    expect(choosePath("native", "page-http", capabilities({ webrtc: [false, true], lan: true }))).toEqual({ path: "unreachable", reason: "no-webrtc" });
    expect(choosePath("page-http", "native", capabilities({ webrtc: [true, false], hosted: true }))).toEqual({ path: "unreachable", reason: "no-webrtc" });
    expect(choosePath("page-https", "native", capabilities({ webrtc: [true, false], hosted: true }))).toEqual({ path: "unreachable", reason: "no-webrtc" });
    // WebSocket pair: the listening native side reaches the other without WebRTC.
    expect(choosePath("native", "page-http", capabilities({ listen: [true, false], webrtc: [false, true] }))).toEqual({ path: "websocket", listener: "local" });
    expect(choosePath("native", "native", capabilities({ listen: [false, true], webrtc: [false, false] }))).toEqual({ path: "websocket", listener: "remote" });
  });

  it("is symmetric: swapping local and remote swaps only the listener side", () => {
    const listenerSwap = { local: "remote", remote: "local", either: "either" } as const;
    const setups: Setup[] = [
      {},
      { listen: [true, false] },
      { listen: [false, true] },
      { listen: [true, true] },
      { lan: true },
      { hosted: true },
      { lan: true, hosted: true, webrtc: [false, true] },
    ];
    const kinds: readonly EndpointKind[] = ENDPOINT_KINDS;
    for (const setup of setups) {
      const swapped: Setup = {
        ...setup,
        listen: setup.listen && [setup.listen[1], setup.listen[0]],
        webrtc: setup.webrtc && [setup.webrtc[1], setup.webrtc[0]],
      };
      for (const a of kinds) {
        for (const b of kinds) {
          const forward = choosePath(a, b, capabilities(setup));
          const backward = choosePath(b, a, capabilities(swapped));
          if (forward.path === "websocket") {
            expect(backward).toEqual({ path: "websocket", listener: listenerSwap[forward.listener] });
          } else {
            expect(backward).toEqual(forward);
          }
        }
      }
    }
  });
});
