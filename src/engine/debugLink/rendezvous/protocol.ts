// The rendezvous's messages (ADR 0403 "Rendezvous"): "both sides connect out with the room code, the rendezvous passes
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
// are relayed to the other seat as they are, never read. When both sides have sent `connected`, or both have left, or
// the room has lived `ROOM_EXPIRY_MS`, the server forgets it (an `expired` tells whoever is still there, then closes).
// A side that already sent `connected` and leaves is not announced (`peer-left`) to the other, which may still be
// finishing its connection.
//
// Limits (plan §7a, a tripwire against abuse of a hosted instance): `RENDEZVOUS_MAX_ROOMS` rooms, each relaying at most
// `ROOM_MAX_BYTES` in all; past either the server answers `error` (`full`, `too-big`). Five joins with a wrong token
// to one room lock that room's joins for a minute (`locked`), as the token gate does (0403 "Pairing code").
import { ENDPOINT_KINDS, type EndpointKind } from "../protocol";

/** The rendezvous protocol's version: a `join` with another is refused (`version`). */
export const RENDEZVOUS_VERSION = 1;
/** The path a rendezvous answers on (0403, 0067). */
export const RENDEZVOUS_PATH = "/myco-rendezvous";
/** The largest message, bytes (an SDP offer is a few KB). */
export const RENDEZVOUS_MAX_MESSAGE_BYTES = 16 * 1024;
/** How long a room lives, ms (0403: "or after 5 minutes"). */
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
  /** The peer connection opened here; the room is forgotten once both seats have said so. */
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

const encoder = new TextEncoder();
const MAX_ROOM = 0x7fff;
const MAX_TOKEN = 0x3fffffff;

/** `m` as one transport message (UTF-8 JSON). Throws for a message past `RENDEZVOUS_MAX_MESSAGE_BYTES`. */
export function encodeRendezvousMessage(m: RendezvousClientMessage | RendezvousServerMessage): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(m));
  if (bytes.byteLength > RENDEZVOUS_MAX_MESSAGE_BYTES) {
    throw new RangeError(`A rendezvous message is at most ${RENDEZVOUS_MAX_MESSAGE_BYTES} bytes; this "${m.t}" is ${bytes.byteLength}.`);
  }
  return bytes;
}

type Fields = Record<string, unknown>;

function parse(bytes: Uint8Array): { fields: Fields } | { refused: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { refused: "The message isn't UTF-8 text." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { refused: "The message isn't JSON." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { refused: "The message isn't a JSON object." };
  return { fields: value as Fields };
}

function isInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

function isKind(v: unknown): v is EndpointKind {
  return typeof v === "string" && (ENDPOINT_KINDS as readonly string[]).includes(v);
}

const ERROR_REASONS: readonly string[] = ["version", "bad-message", "no-room", "room-taken", "seat-taken", "bad-token", "locked", "full", "too-big"];

/** A signal's fields, or null if `f` isn't one. Only the known fields are kept: the rest is never relayed. */
function readSignal(f: Fields): RendezvousSignal | null {
  if ((f.t === "offer" || f.t === "answer") && typeof f.sdp === "string") return { t: f.t, sdp: f.sdp };
  if (f.t === "candidate" && typeof f.candidate === "string" && (typeof f.mid === "string" || f.mid === null)) {
    return { t: "candidate", candidate: f.candidate, mid: f.mid };
  }
  return null;
}

/** A client's message as the server reads it, or why it isn't one (answered with `error` `bad-message` or `too-big`). Never throws. */
export function decodeClientMessage(bytes: Uint8Array): { message: RendezvousClientMessage } | { refused: string; reason: "bad-message" | "too-big" } {
  if (bytes.byteLength > RENDEZVOUS_MAX_MESSAGE_BYTES) {
    return { refused: `A rendezvous message is at most ${RENDEZVOUS_MAX_MESSAGE_BYTES} bytes.`, reason: "too-big" };
  }
  const parsed = parse(bytes);
  if ("refused" in parsed) return { refused: parsed.refused, reason: "bad-message" };
  const f = parsed.fields;
  const bad = (what: string): { refused: string; reason: "bad-message" } => ({ refused: what, reason: "bad-message" });
  switch (f.t) {
    case "join":
      if (typeof f.v !== "number") return bad("A join names a protocol version.");
      if (!isInt(f.room, MAX_ROOM) || !isInt(f.token, MAX_TOKEN)) return bad("A join names a room and a token, whole numbers in range.");
      if (f.seat !== "waiting" && f.seat !== "joining") return bad('A join takes the seat "waiting" or "joining".');
      if (!isKind(f.kind)) return bad("A join names the endpoint kind.");
      return { message: { t: "join", v: f.v, room: f.room, token: f.token, seat: f.seat, kind: f.kind } };
    case "connected":
      return { message: { t: "connected" } };
    case "leave":
      return { message: { t: "leave" } };
    default: {
      const signal = readSignal(f);
      return signal ? { message: signal } : bad("That isn't a rendezvous message.");
    }
  }
}

/** The server's message as a client reads it, or why it isn't one. Never throws. */
export function decodeServerMessage(bytes: Uint8Array): { message: RendezvousServerMessage } | { refused: string } {
  if (bytes.byteLength > RENDEZVOUS_MAX_MESSAGE_BYTES) return { refused: `A rendezvous message is at most ${RENDEZVOUS_MAX_MESSAGE_BYTES} bytes.` };
  const parsed = parse(bytes);
  if ("refused" in parsed) return parsed;
  const f = parsed.fields;
  const bad = { refused: "That isn't a rendezvous message." };
  switch (f.t) {
    case "joined":
      if (!isInt(f.room, MAX_ROOM) || (f.seat !== "waiting" && f.seat !== "joining") || typeof f.expiresIn !== "number" || !Number.isFinite(f.expiresIn)) return bad;
      return { message: { t: "joined", room: f.room, seat: f.seat, expiresIn: f.expiresIn } };
    case "peer-joined":
      return isKind(f.kind) ? { message: { t: "peer-joined", kind: f.kind } } : bad;
    case "peer-left":
      return { message: { t: "peer-left" } };
    case "expired":
      return { message: { t: "expired" } };
    case "error":
      if (typeof f.reason !== "string" || !ERROR_REASONS.includes(f.reason) || typeof f.message !== "string") return bad;
      return { message: { t: "error", reason: f.reason as RendezvousErrorReason, message: f.message } };
    default: {
      const signal = readSignal(f);
      return signal ? { message: signal } : bad;
    }
  }
}
