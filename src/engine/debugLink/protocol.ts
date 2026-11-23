// The debug link's envelope (ADR 0376): every message between a running build and a tool (the editor, the Studio) is
// one binary transport message, `{ topic, kind, id, payload }` behind a version byte:
//
//   u8  version   DEBUG_LINK_VERSION; a peer refuses another (it says so in an `error` and closes)
//   u8  kind      EnvelopeKind
//   u16 topicLen  then the topic's UTF-8 bytes ("" for link-level messages: hello, welcome, error)
//   u32 id        a subscription's id (subscribe, unsubscribe, sample) or a request's (request, reply, error)
//   ...           the payload, to the end of the message
//
// Payloads of hello, welcome, subscribe, request, reply, command and error are UTF-8 JSON; a sample's payload is a run of
// records in the capture and take framing (`records.ts`, audio 0348), so the link, captures and takes share one encoding.
// Requests and replies travel on the reliable channel, samples on the unreliable one (the session picks).
//
// Decoding is lenient and never throws: a message that doesn't parse decodes to null with the reason, and the session
// answers it with an `error`.

/** The protocol version both ends must speak. */
export const DEBUG_LINK_VERSION = 1;
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
