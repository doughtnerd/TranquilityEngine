// The rendezvous's messages (ADR 0403 "Rendezvous"; plan task R1).
import { describe, expect, it } from "vitest";
import {
  RENDEZVOUS_MAX_MESSAGE_BYTES,
  RENDEZVOUS_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  encodeRendezvousMessage,
  type RendezvousClientMessage,
  type RendezvousErrorReason,
  type RendezvousServerMessage,
} from "./protocol";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the rendezvous messages", () => {
  it("round-trips every client message: join (each seat and endpoint kind), offer, answer, candidate, end of candidates, connected, leave", () => {
    const messages: RendezvousClientMessage[] = [];
    for (const seat of ["waiting", "joining"] as const) {
      for (const kind of ["native", "page-http", "page-https"] as const) messages.push({ t: "join", v: RENDEZVOUS_VERSION, room: 255, token: 1048575, seat, kind });
    }
    messages.push(
      { t: "offer", sdp: "v=0\r\n" },
      { t: "answer", sdp: "v=0\r\n" },
      { t: "candidate", candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host", mid: "0" },
      { t: "candidate", candidate: "", mid: null },
      { t: "connected" },
      { t: "leave" },
    );
    for (const m of messages) expect(decodeClientMessage(encodeRendezvousMessage(m))).toEqual({ message: m });
  });

  it("round-trips every server message: joined, peer-joined, peer-left, the three signals, error (each reason), expired", () => {
    const reasons: RendezvousErrorReason[] = ["version", "bad-message", "no-room", "room-taken", "seat-taken", "bad-token", "locked", "full", "too-big"];
    const messages: RendezvousServerMessage[] = [
      { t: "joined", room: 7, seat: "waiting", expiresIn: 300000 },
      { t: "peer-joined", kind: "page-https" },
      { t: "peer-left" },
      { t: "offer", sdp: "x" },
      { t: "answer", sdp: "y" },
      { t: "candidate", candidate: "c", mid: "audio" },
      ...reasons.map((reason): RendezvousServerMessage => ({ t: "error", reason, message: `why ${reason}` })),
      { t: "expired" },
    ];
    for (const m of messages) expect(decodeServerMessage(encodeRendezvousMessage(m))).toEqual({ message: m });
  });

  it("refuses JSON that isn't an object, an unknown type, or a field of the wrong type (bad-message)", () => {
    for (const text of ["[]", "7", "null", '"join"', "{", '{"t":"data"}', '{"t":"offer","sdp":4}', '{"t":"candidate","candidate":"c"}', '{"t":"join","v":1,"room":-1,"token":0,"seat":"waiting","kind":"native"}', '{"t":"join","v":1,"room":1.5,"token":0,"seat":"waiting","kind":"native"}', '{"t":"join","v":1,"room":1,"token":0,"seat":"third","kind":"native"}', '{"t":"join","v":1,"room":1,"token":0,"seat":"waiting","kind":"phone"}']) {
      const r = decodeClientMessage(bytes(text));
      expect(r, text).toMatchObject({ reason: "bad-message" });
    }
    for (const text of ["[]", '{"t":"hello"}', '{"t":"error","reason":"nope","message":"x"}', '{"t":"joined","room":1,"seat":"waiting"}']) {
      expect(decodeServerMessage(bytes(text)), text).toHaveProperty("refused");
    }
  });

  it("refuses a message past RENDEZVOUS_MAX_MESSAGE_BYTES (too-big), and won't encode one", () => {
    const big = new Uint8Array(RENDEZVOUS_MAX_MESSAGE_BYTES + 1).fill(32);
    expect(decodeClientMessage(big)).toMatchObject({ reason: "too-big" });
    expect(decodeServerMessage(big)).toHaveProperty("refused");
    expect(() => encodeRendezvousMessage({ t: "offer", sdp: "x".repeat(RENDEZVOUS_MAX_MESSAGE_BYTES) })).toThrow(RangeError);
    expect(encodeRendezvousMessage({ t: "offer", sdp: "x".repeat(RENDEZVOUS_MAX_MESSAGE_BYTES - 30) }).byteLength).toBeLessThanOrEqual(RENDEZVOUS_MAX_MESSAGE_BYTES);
  });

  it("refuses bytes that aren't UTF-8", () => {
    const bad = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(decodeClientMessage(bad)).toMatchObject({ reason: "bad-message" });
    expect(decodeServerMessage(bad)).toHaveProperty("refused");
  });

  it("reads a join of another version (the server answers version)", () => {
    const r = decodeClientMessage(bytes('{"t":"join","v":2,"room":1,"token":2,"seat":"waiting","kind":"native"}'));
    expect(r).toEqual({ message: { t: "join", v: 2, room: 1, token: 2, seat: "waiting", kind: "native" } });
  });

  it("keeps only a signal's known fields, so nothing extra is relayed", () => {
    const r = decodeClientMessage(bytes('{"t":"offer","sdp":"s","extra":{"debug":1}}'));
    expect(r).toEqual({ message: { t: "offer", sdp: "s" } });
  });
});
