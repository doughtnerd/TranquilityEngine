import { describe, expect, it } from "vitest";
import { ENVELOPE_BYTES, Kind, writeEnvelope } from "./wire.generated";
import { peekKind, peekMessageBytes } from "./wireEnvelope";

describe("envelope peeks", () => {
  it("read the kind and the message's length the generated writer wrote, at any offset", () => {
    const view = new DataView(new ArrayBuffer(64));
    writeEnvelope(view, 0, { kind: Kind.STATUS, seq: 7, bodyBytes: 40 });
    writeEnvelope(view, 24, { kind: Kind.STREAM_CREDIT, seq: 0xffffffff, bodyBytes: 0x01020304 });
    expect(peekKind(view)).toBe(Kind.STATUS);
    expect(peekMessageBytes(view)).toBe(ENVELOPE_BYTES + 40);
    expect(peekKind(view, 24)).toBe(Kind.STREAM_CREDIT);
    expect(peekMessageBytes(view, 24)).toBe(ENVELOPE_BYTES + 0x01020304);
  });

  it("give 0, no kind, where there is no message: too short, or not the MYA1 magic", () => {
    const short = new DataView(new ArrayBuffer(ENVELOPE_BYTES - 1));
    expect(peekKind(short)).toBe(0);
    const view = new DataView(new ArrayBuffer(32));
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: 1, bodyBytes: 0 });
    expect(peekKind(view, 20)).toBe(0); // 12 bytes left
    view.setUint32(0, 0x12345678, true);
    expect(peekKind(view)).toBe(0);
    expect(Object.values(Kind)).not.toContain(0);
  });
});
