// Path choice (ADR 0403 "Which path each pair takes"): from the two endpoints' kinds and what can listen or signal, the
// transport a pairing uses. 0403's table, row by row, as this function answers it:
//
//   | Pair                        | Path                                                                                   | Needs                |
//   | Native ↔ native             | WebSocket, either side listening                                                       | Nothing else         |
//   | Page on http ↔ native       | WebSocket to the native listener                                                       | Nothing else         |
//   | Page on http ↔ page on http | WebRTC, signalled through the server that served the pages, or a native app's rendezvous | That server        |
//   | Page on https ↔ anything    | WebRTC, signalled through the hosted rendezvous                                        | A hosted rendezvous  |
//
// and its rules around the table: "WebSocket when the connecting side can reach a native listener [...] WebRTC
// otherwise"; "A browser endpoint on https (a hosted Studio or game) needs the hosted rendezvous; without one it
// exchanges takes as files"; and (plan risk table) "Linux desktop builds whose WebKitGTK lacks WebRTC fall back to
// WebSocket only".
//
// Precisely, for local kind L and remote kind R (symmetric in L and R):
// 1. Neither is `page-https`, and a native side can listen (`canListen`): `websocket`, the listener being the native
//    side that can (both native and both can: `either`).
// 2. Otherwise both sides need WebRTC (`webrtc`); a side without it makes the pair `unreachable` (`no-webrtc`).
// 3. With WebRTC: a `page-https` side needs the hosted rendezvous (`hostedRendezvous`), else `unreachable`
//    (`needs-hosted-rendezvous`): its page can't open `ws://` to a LAN rendezvous (mixed content).
// 4. No `page-https` side: a LAN rendezvous (`lanRendezvous`: the serving server's or a native app's) is used when there
//    is one, else the hosted one, else `unreachable` (`needs-rendezvous`).
import type { EndpointKind } from "../protocol";

/** What each side can do at pairing time, beyond its kind. */
export interface PathCapabilities {
  /** Whether each side can listen now (a native app with `ws-listener` and debugging on; a page never can). */
  readonly canListen: { readonly local: boolean; readonly remote: boolean };
  /** Whether each side has WebRTC (false: a WebKitGTK build without it). Default true for both. */
  readonly webrtc?: { readonly local: boolean; readonly remote: boolean };
  /** Whether a rendezvous on the LAN is known: the server that served the page (`/myco-rendezvous`) or a native app's. */
  readonly lanRendezvous: boolean;
  /** Whether a hosted rendezvous is configured (`debug.rendezvous`, Preferences). */
  readonly hostedRendezvous: boolean;
}

/** Why a pair can't connect. */
export type UnreachableReason = "no-webrtc" | "needs-hosted-rendezvous" | "needs-rendezvous";

/** The path a pairing takes. */
export type PairPath =
  /** A WebSocket to the side that listens (`local`, `remote`, or `either` when both native sides can). */
  | { readonly path: "websocket"; readonly listener: "local" | "remote" | "either" }
  /** A `webrtc` transport, signalled through this rendezvous. */
  | { readonly path: "webrtc"; readonly rendezvous: "lan" | "hosted" }
  /** No path: the reason, for the Connect dialog (and "exchange takes as files", 0348). */
  | { readonly path: "unreachable"; readonly reason: UnreachableReason };

/** The path between a `local` and a `remote` endpoint, per the rules above. */
export function choosePath(local: EndpointKind, remote: EndpointKind, capabilities: PathCapabilities): PairPath {
  const { canListen, webrtc, lanRendezvous, hostedRendezvous } = capabilities;
  // Only a native side can listen; a page never can, whatever it reports.
  const listens = { local: local === "native" && canListen.local, remote: remote === "native" && canListen.remote };
  // Rule 1: a WebSocket to the native side that can listen. A page on https can't open ws:// (mixed content).
  if (local !== "page-https" && remote !== "page-https" && (listens.local || listens.remote)) {
    if (listens.local && listens.remote) return { path: "websocket", listener: "either" };
    return { path: "websocket", listener: listens.local ? "local" : "remote" };
  }
  // Rule 2: otherwise both sides need WebRTC.
  const hasWebrtc = { local: webrtc?.local ?? true, remote: webrtc?.remote ?? true };
  if (!hasWebrtc.local || !hasWebrtc.remote) return { path: "unreachable", reason: "no-webrtc" };
  // Rule 3: a page on https signals only through the hosted rendezvous.
  if (local === "page-https" || remote === "page-https") {
    return hostedRendezvous ? { path: "webrtc", rendezvous: "hosted" } : { path: "unreachable", reason: "needs-hosted-rendezvous" };
  }
  // Rule 4: pages on http (or native sides that can't listen) signal through a LAN rendezvous when one is known, else the hosted one.
  if (lanRendezvous) return { path: "webrtc", rendezvous: "lan" };
  if (hostedRendezvous) return { path: "webrtc", rendezvous: "hosted" };
  return { path: "unreachable", reason: "needs-rendezvous" };
}
