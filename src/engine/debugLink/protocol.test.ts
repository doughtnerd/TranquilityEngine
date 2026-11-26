// The debug link's envelope and sample records (ADR 0376): every kind round-trips, malformed messages and records are
// refused with a reason (never a throw), JSON payloads and hellos read leniently.
import { describe, expect, it } from "vitest";
import {
  DEBUG_LINK_VERSION, DEBUG_PAIR_NAME_MAX, DEBUG_PAIR_TOKEN_MAX, DEBUG_TOPIC_MAX_BYTES, ENDPOINT_KINDS, EnvelopeKind, PAIR_REFUSAL_REASONS, decodeEnvelope, encodeEnvelope,
  jsonPayload, pairEnvelope, pairRefusalMessage, pairedEnvelope, readHello, readJsonPayload, readPair, readPairReply, type DebugPair, type DebugPairReply, type Envelope,
} from "./protocol";
import { RECORD_HEAD_BYTES, RECORD_MAX_BYTES, RecordWriter, readRecords } from "./records";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("the envelope", () => {
  it("round-trips every kind, with its topic, id and payload", () => {
    for (const kind of Object.values(EnvelopeKind)) {
      const e: Envelope = { kind, topic: kind === EnvelopeKind.hello ? "" : "animation", id: 0xfffffffe, payload: jsonPayload({ kind, s: "é" }) };
      const read = decodeEnvelope(encodeEnvelope(e));
      expect(read).toEqual({ envelope: { ...e, payload: expect.any(Uint8Array) } });
      if ("envelope" in read) expect(Array.from(read.envelope.payload)).toEqual(Array.from(e.payload));
    }
  });

  it("reads an envelope inside a larger buffer (a transport's view)", () => {
    const inner = encodeEnvelope({ kind: EnvelopeKind.sample, topic: "t", id: 3, payload: bytes(1, 2, 3) });
    const outer = new Uint8Array(inner.length + 8);
    outer.set(inner, 4);
    const read = decodeEnvelope(outer.subarray(4, 4 + inner.length));
    expect("envelope" in read && Array.from(read.envelope.payload)).toEqual([1, 2, 3]);
  });

  it("refuses another version, an unknown kind, a short message, a topic that doesn't fit or isn't UTF-8", () => {
    const good = encodeEnvelope({ kind: EnvelopeKind.request, topic: "ab", id: 1, payload: new Uint8Array(0) });
    const other = good.slice();
    other[0] = DEBUG_LINK_VERSION + 1;
    expect(decodeEnvelope(other)).toEqual({ refused: expect.stringContaining(`version ${DEBUG_LINK_VERSION + 1}`) });
    const kind = good.slice();
    kind[1] = 99;
    expect(decodeEnvelope(kind)).toEqual({ refused: "unknown debug link message kind 99" });
    expect(decodeEnvelope(good.subarray(0, 5))).toEqual({ refused: expect.stringContaining("at least") });
    const long = good.slice();
    long[2] = 200;
    expect(decodeEnvelope(long)).toEqual({ refused: expect.stringContaining("doesn't fit") });
    const utf = good.slice();
    utf[4] = 0xff;
    expect(decodeEnvelope(utf)).toEqual({ refused: "the topic isn't UTF-8" });
  });

  it("won't encode a topic past its cap", () => {
    expect(() => encodeEnvelope({ kind: EnvelopeKind.request, topic: "x".repeat(DEBUG_TOPIC_MAX_BYTES + 1), id: 1, payload: new Uint8Array(0) })).toThrow(/at most/);
  });

  it("JSON payloads: no bytes is undefined, bad JSON is refused", () => {
    expect(readJsonPayload(jsonPayload(undefined))).toEqual({ value: undefined });
    expect(readJsonPayload(jsonPayload({ a: [1, true] }))).toEqual({ value: { a: [1, true] } });
    expect(readJsonPayload(bytes(0x7b))).toEqual({ refused: "the payload isn't JSON" });
  });

  it("speaks version 2 and refuses a version 1 peer with a message naming both versions", () => {
    expect(DEBUG_LINK_VERSION).toBe(2);
    const hello = encodeEnvelope({ kind: EnvelopeKind.hello, topic: "", id: 0, payload: jsonPayload({ name: "Flappy", platform: "desktop", topics: ["animation"] }) });
    expect(hello[0]).toBe(2);
    const read = decodeEnvelope(hello);
    const json = "envelope" in read ? readJsonPayload(read.envelope.payload) : { refused: "" };
    expect("value" in json && readHello(json.value).name).toBe("Flappy");
    // What a version 1 build sends first: its hello behind version byte 1.
    const v1 = hello.slice();
    v1[0] = 1;
    expect(decodeEnvelope(v1)).toEqual({ refused: "the other end speaks debug link version 1; this one speaks 2" });
  });

  it("reads a hello leniently", () => {
    expect(readHello({ name: "Flappy", platform: "desktop", topics: ["animation", 3] })).toEqual({ name: "Flappy", platform: "desktop", topics: ["animation"] });
    expect(readHello(null)).toEqual({ name: "A game", platform: "web", topics: [] });
    expect(readHello({ name: "  " }).name).toBe("A game");
  });
});

describe("pairing (version 2)", () => {
  const roundTrip = (e: Envelope) => {
    const read = decodeEnvelope(encodeEnvelope(e));
    if (!("envelope" in read)) throw new Error(read.refused);
    const json = readJsonPayload(read.envelope.payload);
    if (!("value" in json)) throw new Error(json.refused);
    return { envelope: read.envelope, value: json.value };
  };

  it("round-trips a pair for each role and endpoint kind, with and without a token and a name", () => {
    for (const role of ["build", "tool"] as const) {
      for (const kind of ENDPOINT_KINDS) {
        const full: DebugPair = { role, kind, token: DEBUG_PAIR_TOKEN_MAX, name: "Audio Studio on DESKTOP-1" };
        const { envelope, value } = roundTrip(pairEnvelope(full));
        expect([envelope.kind, envelope.topic, envelope.id]).toEqual([EnvelopeKind.pair, "", 0]);
        expect(readPair(value)).toEqual({ pair: full });
        expect(readPair(roundTrip(pairEnvelope({ role, kind })).value)).toEqual({ pair: { role, kind } });
      }
    }
    expect(readPair(roundTrip(pairEnvelope({ role: "tool", kind: "native", token: 0 })).value)).toEqual({ pair: { role: "tool", kind: "native", token: 0 } });
  });

  it("refuses a pair with an unknown role or kind or a bad token; trims and caps the name", () => {
    expect(readPair(null)).toEqual({ refused: expect.stringContaining("object") });
    expect(readPair({ role: "editor", kind: "native" })).toEqual({ refused: expect.stringContaining("role") });
    expect(readPair({ role: "tool", kind: "page-ftp" })).toEqual({ refused: expect.stringContaining("kind") });
    for (const token of [-1, 1.5, DEBUG_PAIR_TOKEN_MAX + 1, "12"]) expect(readPair({ role: "tool", kind: "native", token })).toEqual({ refused: expect.stringContaining("token") });
    expect(readPair({ role: "build", kind: "page-http", name: "  Flappy  " })).toEqual({ pair: { role: "build", kind: "page-http", name: "Flappy" } });
    expect(readPair({ role: "build", kind: "page-http", name: "   " })).toEqual({ pair: { role: "build", kind: "page-http" } });
    expect(readPair({ role: "build", kind: "page-http", name: 7 })).toEqual({ pair: { role: "build", kind: "page-http" } });
    expect((readPair({ role: "build", kind: "native", name: "x".repeat(500) }) as { pair: DebugPair }).pair.name).toHaveLength(DEBUG_PAIR_NAME_MAX);
  });

  it("round-trips paired: accepted by each way, refused for each reason", () => {
    for (const via of ["token", "same-machine", "prompt"] as const) {
      const { envelope, value } = roundTrip(pairedEnvelope({ accepted: true, via }));
      expect(envelope.kind).toBe(EnvelopeKind.paired);
      expect(readPairReply(value)).toEqual({ reply: { accepted: true, via } });
    }
    for (const reason of PAIR_REFUSAL_REASONS) {
      const r: DebugPairReply = { accepted: false, reason, message: pairRefusalMessage(reason) };
      expect(readPairReply(roundTrip(pairedEnvelope(r)).value)).toEqual({ reply: r });
      expect(pairRefusalMessage(reason)).toMatch(/\.$/);
    }
  });

  it("refuses a paired it can't read; a refusal without a message gets its reason's sentence", () => {
    expect(readPairReply("yes")).toEqual({ refused: expect.stringContaining("object") });
    expect(readPairReply({ accepted: true, via: "magic" })).toEqual({ refused: expect.stringContaining("via") });
    expect(readPairReply({ accepted: "maybe" })).toEqual({ refused: expect.stringContaining("accepted") });
    expect(readPairReply({ accepted: false, reason: "tired" })).toEqual({ refused: expect.stringContaining("reason") });
    expect(readPairReply({ accepted: false, reason: "locked" })).toEqual({ reply: { accepted: false, reason: "locked", message: pairRefusalMessage("locked") } });
  });
});

describe("sample records", () => {
  it("round-trip in the capture framing: a 20 B head, then the payload", () => {
    const w = new RecordWriter();
    w.write(0x40, 7, 12, bytes(1, 2));
    w.write(0x10, 0xffffffff, 0, new Uint8Array(0));
    expect(w.count).toBe(2);
    const out = w.take();
    expect(out.length).toBe(2 * RECORD_HEAD_BYTES + 2);
    expect(w.count).toBe(0);
    const view = new DataView(out.buffer);
    expect([view.getUint8(0), view.getUint8(1), view.getUint16(2, true), view.getUint32(4, true), view.getUint32(8, true), view.getFloat64(12, true)]).toEqual([0x40, 0, 0, 2, 7, 12]);
    const { records, stopped } = readRecords(out);
    expect(stopped).toBeNull();
    expect(records.map((r) => [r.type, r.seq, r.frame, Array.from(r.payload)])).toEqual([
      [0x40, 7, 12, [1, 2]],
      [0x10, 0xffffffff, 0, []],
    ]);
  });

  it("keeps the records before one that doesn't read, and says why", () => {
    const w = new RecordWriter();
    w.write(1, 0, 0, bytes(9));
    w.write(2, 1, 0, bytes(8));
    const good = w.take();
    const cut = readRecords(good.subarray(0, good.length - 1));
    expect(cut.records).toHaveLength(1);
    expect(cut.stopped).toMatch(/doesn't fit/);
    const required = good.slice();
    required[RECORD_HEAD_BYTES + 1] = 0x80;
    expect(readRecords(required)).toEqual({ records: [expect.objectContaining({ type: 1 })], stopped: expect.stringContaining("required record type 0x80") });
    const flags = good.slice();
    flags[1] = 1;
    expect(readRecords(flags)).toEqual({ records: [], stopped: expect.stringContaining("flags") });
    const frame = good.slice();
    new DataView(frame.buffer).setFloat64(12, -1, true);
    expect(readRecords(frame).stopped).toMatch(/frame/);
    expect(readRecords(good.subarray(0, 10)).stopped).toMatch(/cut off/);
  });

  it("won't write a required type or a record past the cap", () => {
    const w = new RecordWriter();
    expect(() => w.write(0x80, 0, 0, bytes())).toThrow(/0\.\.0x7f/);
    expect(() => w.write(1, 0, 0, new Uint8Array(RECORD_MAX_BYTES + 1))).toThrow(/at most/);
  });
});
