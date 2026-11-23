/**
 * The `webrtc` transport (ADR 0380 "Transports"): a connection that is a peer-to-peer `RTCPeerConnection` alone, for
 * pairs where neither side can reach a listener on the other (a page on http ↔ a page on http, a page on https ↔
 * anything). "Two data channels, one reliable and ordered (`myco-r`) and 0333's unreliable one (`myco-u`), on the page's
 * own `RTCPeerConnection`. On one network it uses host candidates only (browsers' `.local` names included): no STUN or
 * TURN. ICE servers are a setting for later use beyond the LAN."
 *
 * Unlike 0333's lane (`datagramLane.ts`), nothing rides beside a socket: the offer, answer and candidates cross through
 * an injected `WebRtcSignaller` (in the link, a rendezvous client, `debugLink/rendezvous/`), and both channels carry the
 * connection's traffic. The transport's two ends map to the `Transport` interface as:
 * - `listen(address)`: the waiting side (it showed the room code): it answers the offer arriving through the signaller
 *   the factory makes for `address`; one connection per signaller session;
 * - `connect(address)`: the joining side (it typed the code): it makes the offer through its signaller for `address`.
 * `address` is opaque here (the link passes the rendezvous URL and room); only the signaller factory reads it.
 *
 * Message size (plan §7a, O5): a data channel message is at most `WEBRTC_MAX_MESSAGE_BYTES` (64 KiB), the existing
 * ceiling of 0333's lane (`webrtc.maxDatagramBytes` up to 65,536). A larger reliable message is fragmented on `myco-r`
 * and reassembled before delivery (up to `maxMessageBytes`); an unreliable message larger than the ceiling travels on
 * `myco-r` too, as the WebSocket transport sends one too big for its lane on the socket. Stale unreliable messages are
 * dropped as the `Channel` contract says. Close rules match `websocket.ts`: either channel closing, the peer connection
 * failing or the signaller failing before open closes the connection with a reason.
 *
 * Not registered with `createTransport` yet (R2 fills it, R5 registers it). Reached only from the debug link, so a
 * release export holds none of it (the `DEBUG_LINK` rule in `vite.shared.ts`).
 */
import type { Transport,TransportConnection, TransportEvent } from "../Transport";
import type { PeerConnectionConstructor } from "./datagramLane";

/** The reliable, ordered data channel's label. */
export const RELIABLE_CHANNEL = "myco-r";
/** The unreliable, unordered data channel's label (0333's, `datagramLane.ts` `DATAGRAM_CHANNEL`). */
export const UNRELIABLE_CHANNEL = "myco-u";
/** The largest data channel message, bytes (64 KiB). */
export const WEBRTC_MAX_MESSAGE_BYTES = 65_536;
/** The largest message a connection reassembles from `myco-r` fragments, by default (the WebSocket transport's 1 MiB). */
export const DEFAULT_WEBRTC_MAX_MESSAGE_BYTES = 1024 * 1024;
/** A connection whose channels haven't opened by then is given up, ms, by default. */
export const DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS = 15_000;

/** A signal between the two peers (the rendezvous relays it unread: `RendezvousSignal`). */
export type WebRtcSignal =
  | { readonly t: "offer" | "answer"; readonly sdp: string }
  /** `candidate` "" with `mid` null is the end of candidates. */
  | { readonly t: "candidate"; readonly candidate: string; readonly mid: string | null };

/**
 * One signalling session with the other peer (a rendezvous room seat). Polled, as transports are (ADR 0033): the
 * transport calls `poll()` once per `Transport.poll()`.
 */
export interface WebRtcSignaller {
  /** `connecting` until the other peer is there to signal, `open` while it is, `closed` after (the room expired or failed). */
  readonly state: "connecting" | "open" | "closed";
  /** Why it closed ("" while it hasn't). */
  readonly closedReason: string;
  /** Sends a signal to the other peer. Ignored unless `open`. */
  send(signal: WebRtcSignal): void;
  /** The signals that arrived since the last call, in order. */
  poll(): WebRtcSignal[];
  /** The peer connection opened: the signaller may let the rendezvous forget the room, and close. */
  connected(): void;
  /** Gives up the session. */
  close(): void;
}

/** One `RTCIceServer`: `urls` and optional credentials (`debug.iceServers`, Preferences). */
export interface WebRtcIceServer {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/** `createTransport("webrtc", options)`'s options. */
export interface WebRtcTransportOptions {
  /**
   * Makes the signalling session for `address` and this side's `role` (`answer` for `listen`, `offer` for `connect`).
   * Required: without one the transport can't connect.
   */
  readonly signaller: (address: string, role: "offer" | "answer") => WebRtcSignaller;
  /** STUN/TURN servers. Default none: host candidates only (0380: "On one network it uses host candidates only"). */
  readonly iceServers?: readonly WebRtcIceServer[];
  /** The largest message a connection reassembles, bytes (default `DEFAULT_WEBRTC_MAX_MESSAGE_BYTES`); a bigger one closes it. */
  readonly maxMessageBytes?: number;
  /** Give up on a connection whose channels haven't opened by then, ms (default `DEFAULT_WEBRTC_CONNECT_TIMEOUT_MS`). */
  readonly connectTimeoutMs?: number;
  /**
   * The `RTCPeerConnection` constructor (default the global one). Node has none; the Node side passes
   * node-datachannel's polyfill, as the WebSocket server does for 0333's lane.
   */
  readonly PeerConnection?: PeerConnectionConstructor;
}

/** The `webrtc` transport: both ends connect through a signaller; neither opens a socket. */
export class WebRtcTransport implements Transport {
  constructor(options: WebRtcTransportOptions) {
    void options;
    throw new Error("R2: not implemented");
  }

  /** Waits for an offer through the signaller for `address`; resolves once the signaller session is set up. */
  listen(address: string): Promise<void> {
    void address;
    throw new Error("R2: not implemented");
  }

  /** Offers a connection through the signaller for `address`; the connection opens when both channels do. */
  connect(address: string): TransportConnection {
    void address;
    throw new Error("R2: not implemented");
  }

  poll(): TransportEvent[] {
    throw new Error("R2: not implemented");
  }

  close(): void {
    throw new Error("R2: not implemented");
  }
}
