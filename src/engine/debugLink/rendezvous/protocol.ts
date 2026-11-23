// The rendezvous's messages (ADR 0380 "Rendezvous"): "both sides connect out with the room code, the rendezvous passes
// the offer, answer and candidates between them, and forgets the room once they connect or after 5 minutes. It never
// carries debug traffic." One TypeScript implementation (`server.ts`, `client.ts`, task R1) speaks this over any
// listening `websocket` transport at path `/myco-rendezvous` (0067): a native Myco app, the dev server, a debug
// export's `serve.mjs`, or a hosted service (R3).
//
// Each message is one reliable transport message: UTF-8 JSON, an object with `t` (the type) and the fields below, at
// most `RENDEZVOUS_MAX_MESSAGE_BYTES`. The first message on a connection is `join`; the server answers `joined` or an
// `error` (and closes). A room has two seats: the side that shows the room code (`waiting`, it creates the room) and
// the side that typed it (`joining`). Once both sit, each hears `peer-joined`; the joining side then sends the offer
// (it is the `webrtc` transport's connecting side) and the waiting side answers, candidates flowing both ways. Signals
// are relayed to the other seat as they are, never read. When either side sends `connected`, or both leave, or the
// room has lived `ROOM_EXPIRY_MS`, the server forgets it (an `expired` tells whoever is still there, then closes).
//
// Limits (plan §7a, a tripwire against abuse of a hosted instance): `RENDEZVOUS_MAX_ROOMS` rooms, each relaying at most
// `ROOM_MAX_BYTES` in all; past either the server answers `error` (`full`, `too-big`). Five joins with a wrong token
// to one room lock that room's joins for a minute (`locked`), as the token gate does (0380 "Pairing code").
import type { EndpointKind } from "../protocol";

/** The rendezvous protocol's version: a `join` with another is refused (`version`). */
export const RENDEZVOUS_VERSION = 1;
/** The path a rendezvous answers on (0380, 0067). */
export const RENDEZVOUS_PATH = "/myco-rendezvous";
/** The largest message, bytes (an SDP offer is a few KB). */
export const RENDEZVOUS_MAX_MESSAGE_BYTES = 16 * 1024;
/** How long a room lives, ms (0380: "or after 5 minutes"). */
export const ROOM_EXPIRY_MS = 5 * 60_000;
/** Rooms at once (plan §7a). */
export const RENDEZVOUS_MAX_ROOMS = 64;
/** Bytes a room may relay in all (plan §7a). */
export const ROOM_MAX_BYTES = 16 * 1024;

/** Which seat a side takes in a room. */
export type RoomSeat = "waiting" | "joining";

/** A WebRTC signal, relayed unread (`webrtc.ts`'s `WebRtcSignal`'s wire form). */
export type RendezvousSignal =
  | { readonly t: "offer"; readonly sdp: string }
  | { readonly t: "answer"; readonly sdp: string }
  /** `candidate` "" with `mid` null is the end of candidates. */
  | { readonly t: "candidate"; readonly candidate: string; readonly mid: string | null };

/** Why the server refused or ended something. */
export type RendezvousErrorReason =
  /** The `join` named another protocol version. */
  | "version"
  /** A message that isn't one of these, or doesn't fit its fields; or a signal before both seats are taken. */
  | "bad-message"
  /** A joining side named a room that doesn't exist (never made, or forgotten). */
  | "no-room"
  /** A waiting side named a room that exists (it draws another room and tries again). */
  | "room-taken"
  /** The seat asked for is taken. */
  | "seat-taken"
  /** The joining side's token isn't the room's. */
  | "bad-token"
  /** Five wrong tokens locked this room's joins for a minute. */
  | "locked"
  /** `RENDEZVOUS_MAX_ROOMS` rooms exist. */
  | "full"
  /** A message past `RENDEZVOUS_MAX_MESSAGE_BYTES`, or the room past `ROOM_MAX_BYTES`. */
  | "too-big";

/** Client → server. */
export type RendezvousClientMessage =
  /**
   * The first message: take `seat` in `room` (from the room code, `pairing/code.ts`). The waiting side creates the room
   * with its token; the joining side's token must match it. `kind` is the sender's endpoint kind, passed to the other
   * seat in `peer-joined`.
   */
  | { readonly t: "join"; readonly v: number; readonly room: number; readonly token: number; readonly seat: RoomSeat; readonly kind: EndpointKind }
  /** A signal for the other seat. */
  | RendezvousSignal
  /** The peer connection opened: forget the room. */
  | { readonly t: "connected" }
  /** Leave the room (the connection may close instead). */
  | { readonly t: "leave" };

/** Server → client. */
export type RendezvousServerMessage =
  /** The seat is yours; the room is forgotten `expiresIn` ms from now. */
  | { readonly t: "joined"; readonly room: number; readonly seat: RoomSeat; readonly expiresIn: number }
  /** The other seat is taken (sent to both once both sit); its endpoint kind. */
  | { readonly t: "peer-joined"; readonly kind: EndpointKind }
  /** The other seat left before `connected`. */
  | { readonly t: "peer-left" }
  /** A signal from the other seat. */
  | RendezvousSignal
  /** Something was refused; after a refused `join` the server closes the connection. */
  | { readonly t: "error"; readonly reason: RendezvousErrorReason; readonly message: string }
  /** The room lived `ROOM_EXPIRY_MS` (or was forgotten after `connected`); the server closes the connection. */
  | { readonly t: "expired" };

/** `m` as one transport message (UTF-8 JSON). Throws for a message past `RENDEZVOUS_MAX_MESSAGE_BYTES`. */
export function encodeRendezvousMessage(m: RendezvousClientMessage | RendezvousServerMessage): Uint8Array {
  void m;
  throw new Error("R1: not implemented");
}

/** A client's message as the server reads it, or why it isn't one (answered with `error` `bad-message` or `too-big`). Never throws. */
export function decodeClientMessage(bytes: Uint8Array): { message: RendezvousClientMessage } | { refused: string; reason: "bad-message" | "too-big" } {
  void bytes;
  throw new Error("R1: not implemented");
}

/** The server's message as a client reads it, or why it isn't one. Never throws. */
export function decodeServerMessage(bytes: Uint8Array): { message: RendezvousServerMessage } | { refused: string } {
  void bytes;
  throw new Error("R1: not implemented");
}
