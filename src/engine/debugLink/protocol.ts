// The debug link's envelope (ADR 0376): every message between a running build and a tool (the editor, the Studio) is
// one binary transport message, `{ topic, kind, id, payload }` behind a version byte:
//
//   u8  version   DEBUG_LINK_VERSION; a peer refuses another (it says so in an `error` and closes)
//   u8  kind      EnvelopeKind
//   u16 topicLen  then the topic's UTF-8 bytes ("" for link-level messages: hello, welcome, error)
//   u32 id        a subscription's id (subscribe, unsubscribe, sample) or a request's (request, reply, error)
//   ...           the payload, to the end of the message
//
// Payloads of pair, paired, hello, welcome, subscribe, request, reply, command and error are UTF-8 JSON; a sample's payload
// is a run of records in the capture and take framing (`records.ts`, audio 0348), so the link, captures and takes share
// one encoding. Requests and replies travel on the reliable channel; samples on the topic's channel (`DebugTopic.channel`,
// unreliable by default; the session picks).
//
// **Connecting (version 2, ADR 0403).** Whichever side can listen does; the other connects. The connecting side's first
// message is `pair` (`DebugPair`: its role, its endpoint kind, the token from the code the listening side shows, and its
// name for a prompt), and the listening side answers with `paired` (`DebugPairReply`: accepted, or refused with a reason,
// after which it closes). Then the build says `hello` and the tool `welcome`s it, as in version 1, whichever side
// connected:
//
//   build connects out (`--debug-link`, `debug.link`):  build `pair` (role build) -> tool `paired` -> build `hello` -> tool `welcome`
//   tool connects to a listening build:                 tool `pair` (role tool)   -> build `paired` -> build `hello` -> tool `welcome`
//
// A valid token skips the tool's accept prompt (0376); a tokenless connection from another machine gets the prompt (the
// tool's, after the hello) or, on a build with no prompt, a `paired` refusal (`no-token`). Connections from the same
// machine need no token. A listener that receives `hello` before any `pair` treats the connection as a build's tokenless
// `pair` (so a build that says hello first is still understood). Version 1 peers are refused: the envelope's version byte
// differs, and each side says so in its own log.
//
// Decoding is lenient and never throws: a message that doesn't parse decodes to a refusal with the reason, and either end
// answers it with an `error` and closes the link.

/** The protocol version both ends must speak. */
export const DEBUG_LINK_VERSION = 2;
/** The longest topic name, UTF-8 bytes. */
export const DEBUG_TOPIC_MAX_BYTES = 64;
/** The fixed part of an envelope before the topic's bytes. */
export const ENVELOPE_HEAD_BYTES = 4;

/** What a message is. */
export const EnvelopeKind = {
  /** Build → tool, first message: who the build is (`DebugHello`). */
  hello: 1,
  /** Tool → build: the tool accepted the build (after its prompt for a non-local one). */
  welcome: 2,
  /** Tool → build: start sending a topic's samples for `id` (payload: the topic's parameters). */
  subscribe: 3,
  /** Tool → build: stop subscription `id`. */
  unsubscribe: 4,
  /** Build → tool: subscription `id`'s samples (records). */
  sample: 5,
  /** Tool → build: a request (`{ method, params }`), answered by a reply or an error with the same id. */
  request: 6,
  /** Build → tool: a request's result. */
  reply: 7,
  /** Tool → build: a command (`{ name, params }`), applied at the build's next frame start. */
  command: 8,
  /** Either way: what went wrong with message `id` (`{ message }`); id 0 for the link itself. */
  error: 9,
  /** Connecting side → listening side, first message (version 2, ADR 0403): who connects and its token (`DebugPair`). */
  pair: 10,
  /** Listening side → connecting side: the answer to `pair` (`DebugPairReply`); a refusal is followed by the close. */
  paired: 11,
} as const;
export type EnvelopeKindCode = (typeof EnvelopeKind)[keyof typeof EnvelopeKind];
const KIND_NAMES = new Map<number, string>(Object.entries(EnvelopeKind).map(([k, v]) => [v, k]));

/** One message. */
export interface Envelope {
  readonly kind: EnvelopeKindCode;
  readonly topic: string;
  readonly id: number;
  readonly payload: Uint8Array;
}

/** Who a connecting build is: its first message. */
export interface DebugHello {
  /** The game's name (`game.json`'s). */
  readonly name: string;
  /** `web` or `desktop`. */
  readonly platform: string;
  /** The topics the build registered. */
  readonly topics: readonly string[];
}

/** What a debug-link endpoint can do on a network (ADR 0403's three kinds): a Tauri desktop or Android app, a page on http, a page on https. */
export type EndpointKind = "native" | "page-http" | "page-https";
/** The endpoint kinds, in 0403's order. */
export const ENDPOINT_KINDS: readonly EndpointKind[] = ["native", "page-http", "page-https"];

/** Which topic role a side plays (ADR 0376): the build serves topics, the tool subscribes and commands. */
export type DebugRole = "build" | "tool";

/** The longest name a `pair` carries, characters. */
export const DEBUG_PAIR_NAME_MAX = 200;
/** The largest token a pairing code carries (30 bits, `pairing/code.ts`). */
export const DEBUG_PAIR_TOKEN_MAX = 0x3fffffff;

/** The connecting side's first message (version 2, ADR 0403). */
export interface DebugPair {
  /** The connecting side's topic role. */
  readonly role: DebugRole;
  /** The connecting side's endpoint kind. */
  readonly kind: EndpointKind;
  /** The token from the code the listening side shows (`pairing/code.ts`); absent: none was typed (same machine, or a prompt). */
  readonly token?: number;
  /** Who connects, for the listening side's prompt and its list ("Audio Studio on DESKTOP-1"); absent: unnamed. */
  readonly name?: string;
}

/**
 * Why a listening side refused a `pair` (ADR 0403 "Pairing code"):
 * - `bad-token`: not the token of the code shown now;
 * - `expired`: the token of a code that expired (5 minutes);
 * - `used`: the token of a code already used (single use);
 * - `locked`: five wrong tokens locked this listener's LAN connections for a minute;
 * - `no-token`: a connection from another machine without a token, where nobody can be asked (a build without a prompt);
 * - `declined`: the person asked said no;
 * - `role`: the connecting side plays the role the listening side plays too (two builds, or two tools).
 */
export type PairRefusalReason = "bad-token" | "expired" | "used" | "locked" | "no-token" | "declined" | "role";
/** The refusal reasons, for validation. */
export const PAIR_REFUSAL_REASONS: readonly PairRefusalReason[] = ["bad-token", "expired", "used", "locked", "no-token", "declined", "role"];

/**
 * The listening side's answer to `pair`. Accepted: `via` says why (`token`: a valid token; `same-machine`: no token is
 * needed; `prompt`: the tool will ask a person after the hello before it welcomes the build, or a build's own prompt said
 * yes). Refused: the reason, and a sentence for the person; the listening side closes the connection after it.
 */
export type DebugPairReply =
  | { readonly accepted: true; readonly via: "token" | "same-machine" | "prompt" }
  | { readonly accepted: false; readonly reason: PairRefusalReason; readonly message: string };

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The message for `e`. Throws only for a topic past `DEBUG_TOPIC_MAX_BYTES` (a programming error). */
export function encodeEnvelope(e: Envelope): Uint8Array {
  const topic = enc.encode(e.topic);
  if (topic.byteLength > DEBUG_TOPIC_MAX_BYTES) throw new Error(`A debug link topic is at most ${DEBUG_TOPIC_MAX_BYTES} bytes ("${e.topic}").`);
  const out = new Uint8Array(ENVELOPE_HEAD_BYTES + topic.byteLength + 4 + e.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, DEBUG_LINK_VERSION);
  view.setUint8(1, e.kind);
  view.setUint16(2, topic.byteLength, true);
  out.set(topic, ENVELOPE_HEAD_BYTES);
  view.setUint32(ENVELOPE_HEAD_BYTES + topic.byteLength, e.id >>> 0, true);
  out.set(e.payload, ENVELOPE_HEAD_BYTES + topic.byteLength + 4);
  return out;
}

/** `bytes` as an envelope, or why it isn't one. */
export function decodeEnvelope(bytes: Uint8Array): { envelope: Envelope } | { refused: string } {
  if (bytes.byteLength < ENVELOPE_HEAD_BYTES + 4) return { refused: `a debug link message needs at least ${ENVELOPE_HEAD_BYTES + 4} bytes (got ${bytes.byteLength})` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== DEBUG_LINK_VERSION) return { refused: `the other end speaks debug link version ${version}; this one speaks ${DEBUG_LINK_VERSION}` };
  const kind = view.getUint8(1);
  if (!KIND_NAMES.has(kind)) return { refused: `unknown debug link message kind ${kind}` };
  const topicLen = view.getUint16(2, true);
  if (topicLen > DEBUG_TOPIC_MAX_BYTES || ENVELOPE_HEAD_BYTES + topicLen + 4 > bytes.byteLength) return { refused: `a topic of ${topicLen} bytes doesn't fit` };
  let topic: string;
  try {
    topic = dec.decode(bytes.subarray(ENVELOPE_HEAD_BYTES, ENVELOPE_HEAD_BYTES + topicLen));
  } catch {
    return { refused: "the topic isn't UTF-8" };
  }
  const id = view.getUint32(ENVELOPE_HEAD_BYTES + topicLen, true);
  return { envelope: { kind: kind as EnvelopeKindCode, topic, id, payload: bytes.subarray(ENVELOPE_HEAD_BYTES + topicLen + 4) } };
}

/** The name of a kind, for messages. */
export const kindName = (kind: number): string => KIND_NAMES.get(kind) ?? `kind ${kind}`;

/** A JSON payload. `undefined` encodes as no bytes. */
export function jsonPayload(value: unknown): Uint8Array {
  return value === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(value));
}

/** A JSON payload read back: no bytes read as `undefined`; one that doesn't parse as a refusal. */
export function readJsonPayload(payload: Uint8Array): { value: unknown } | { refused: string } {
  if (payload.byteLength === 0) return { value: undefined };
  try {
    return { value: JSON.parse(dec.decode(payload)) as unknown };
  } catch {
    return { refused: "the payload isn't JSON" };
  }
}

/** A hello's fields read leniently (missing or bad ones fall back). */
export function readHello(value: unknown): DebugHello {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const name = typeof v.name === "string" && v.name.trim() ? v.name.slice(0, 200) : "A game";
  const platform = typeof v.platform === "string" ? v.platform.slice(0, 40) : "web";
  const topics = Array.isArray(v.topics) ? v.topics.filter((t): t is string => typeof t === "string").slice(0, 64) : [];
  return { name, platform, topics };
}

/** The `pair` envelope for `p` (link-level: topic "", id 0). */
export function pairEnvelope(p: DebugPair): Envelope {
  const body: Record<string, unknown> = { role: p.role, kind: p.kind };
  if (p.token !== undefined) body.token = p.token;
  if (p.name !== undefined) body.name = p.name;
  return { kind: EnvelopeKind.pair, topic: "", id: 0, payload: jsonPayload(body) };
}

/**
 * A `pair` payload's fields, or why they aren't one. Role and kind must be known values and a token a whole number in
 * 0..`DEBUG_PAIR_TOKEN_MAX` (a bad one is refused, never guessed: the listening side answers with an `error` and closes);
 * a name is trimmed and cut to `DEBUG_PAIR_NAME_MAX`, and one that isn't a non-blank string is dropped.
 */
export function readPair(value: unknown): { pair: DebugPair } | { refused: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { refused: "a pair message should be an object" };
  const v = value as Record<string, unknown>;
  if (v.role !== "build" && v.role !== "tool") return { refused: `a pair message's role should be "build" or "tool" (got ${JSON.stringify(v.role)})` };
  if (typeof v.kind !== "string" || !(ENDPOINT_KINDS as readonly string[]).includes(v.kind)) return { refused: `a pair message's kind should be one of ${ENDPOINT_KINDS.join(", ")} (got ${JSON.stringify(v.kind)})` };
  const pair: { role: DebugRole; kind: EndpointKind; token?: number; name?: string } = { role: v.role, kind: v.kind as EndpointKind };
  if (v.token !== undefined) {
    if (typeof v.token !== "number" || !Number.isInteger(v.token) || v.token < 0 || v.token > DEBUG_PAIR_TOKEN_MAX) return { refused: `a pair message's token should be a whole number from 0 to ${DEBUG_PAIR_TOKEN_MAX}` };
    pair.token = v.token;
  }
  if (typeof v.name === "string" && v.name.trim()) pair.name = v.name.trim().slice(0, DEBUG_PAIR_NAME_MAX);
  return { pair };
}

/** The `paired` envelope for `r` (link-level: topic "", id 0). */
export function pairedEnvelope(r: DebugPairReply): Envelope {
  return { kind: EnvelopeKind.paired, topic: "", id: 0, payload: jsonPayload(r) };
}

/**
 * A `paired` payload's fields, or why they aren't one. An unknown refusal reason or an accepted reply's unknown `via`
 * is refused (the connecting side then reports the link as refused with that line); a refusal's missing message falls
 * back to `pairRefusalMessage`.
 */
export function readPairReply(value: unknown): { reply: DebugPairReply } | { refused: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { refused: "a paired message should be an object" };
  const v = value as Record<string, unknown>;
  if (v.accepted === true) {
    if (v.via !== "token" && v.via !== "same-machine" && v.via !== "prompt") return { refused: `a paired message's via should be "token", "same-machine" or "prompt" (got ${JSON.stringify(v.via)})` };
    return { reply: { accepted: true, via: v.via } };
  }
  if (v.accepted !== false) return { refused: "a paired message should say whether it was accepted" };
  if (typeof v.reason !== "string" || !(PAIR_REFUSAL_REASONS as readonly string[]).includes(v.reason)) return { refused: `a paired message's reason should be one of ${PAIR_REFUSAL_REASONS.join(", ")} (got ${JSON.stringify(v.reason)})` };
  const reason = v.reason as PairRefusalReason;
  const message = typeof v.message === "string" && v.message.trim() ? v.message.slice(0, 500) : pairRefusalMessage(reason);
  return { reply: { accepted: false, reason, message } };
}

/** A sentence for a refusal, for the connecting side's person. */
export function pairRefusalMessage(reason: PairRefusalReason): string {
  switch (reason) {
    case "bad-token":
      return "That code doesn't match the one shown. Check it and try again.";
    case "expired":
      return "That code expired. Use the new code shown.";
    case "used":
      return "That code was already used. Use the new code shown.";
    case "locked":
      return "Too many wrong codes: connections from other machines are locked for a minute.";
    case "no-token":
      return "A connection from another machine needs the code shown.";
    case "declined":
      return "The connection was declined.";
    case "role":
      return "Both ends play the same role: connect a tool to a build.";
  }
}
