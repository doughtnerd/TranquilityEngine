// The audio debug-link topic's schema (plan contract C4): subscriptions read, capture pieces and upload chunks
// round-trip within the 64 KiB message rule, and `mix.op` carries an op in its byte form with its names beside it.
import { describe, expect, it } from "vitest";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { RECORD_HEAD_BYTES, RecordWriter } from "../../../../engine/debugLink/records";
import { EnvelopeKind, encodeEnvelope } from "../../../../engine/debugLink/protocol";
import {
  AUDIO_MESSAGE_BYTES, AUDIO_TOPIC, AudioLinkRecord, CAPTURE_PIECE_BYTES, TAKE_CHUNK_BYTES, decodeCapturePiece, decodeTakeChunk, encodeCapturePiece, encodeTakeChunk, mixOpCommand,
  readAudioSubscription, readMixOpCommand,
} from "./schema";

describe("the audio topic's schema", () => {
  it("reads the capture and upload subscriptions and refuses others", () => {
    expect(readAudioSubscription({ kind: "capture" })).toEqual({ kind: "capture" });
    expect(readAudioSubscription({ kind: "upload", upload: 3 })).toEqual({ kind: "upload", upload: 3 });
    expect(readAudioSubscription({ kind: "upload" })).toEqual({ refused: expect.stringContaining("upload's id") });
    expect(readAudioSubscription({ kind: "meters" })).toEqual({ refused: expect.stringContaining('"meters"') });
    expect(readAudioSubscription(null)).toEqual({ refused: expect.any(String) });
  });

  it("keeps a full capture piece's and a full upload chunk's sample message within 64 KiB", () => {
    for (const [type, payload] of [
      [AudioLinkRecord.captureSegment, encodeCapturePiece({ part: 9, index: 0, count: 1, bytes: new Uint8Array(CAPTURE_PIECE_BYTES) })],
      [AudioLinkRecord.takeChunk, encodeTakeChunk({ upload: 1, index: 0, total: 1, bytes: new Uint8Array(TAKE_CHUNK_BYTES) })],
    ] as const) {
      const w = new RecordWriter();
      w.write(type, 0xffffffff, 1e9, payload);
      const message = encodeEnvelope({ kind: EnvelopeKind.sample, topic: AUDIO_TOPIC, id: 0xffffffff, payload: w.take() });
      expect(message.byteLength).toBeLessThanOrEqual(AUDIO_MESSAGE_BYTES);
      expect(payload.byteLength + RECORD_HEAD_BYTES).toBeGreaterThan(AUDIO_MESSAGE_BYTES - 128);
    }
    expect(() => encodeTakeChunk({ upload: 1, index: 0, total: 1, bytes: new Uint8Array(TAKE_CHUNK_BYTES + 1) })).toThrow(RangeError);
    expect(() => encodeCapturePiece({ part: 0, index: 0, count: 1, bytes: new Uint8Array(CAPTURE_PIECE_BYTES + 1) })).toThrow(RangeError);
  });

  it("round-trips capture pieces and upload chunks, and refuses ones that can't exist", () => {
    const piece = decodeCapturePiece(encodeCapturePiece({ part: 0xfffffffe, index: 2, count: 3, bytes: new Uint8Array([1, 2, 3]) }));
    expect(piece).toEqual({ part: 0xfffffffe, index: 2, count: 3, bytes: new Uint8Array([1, 2, 3]) });
    const chunk = decodeTakeChunk(encodeTakeChunk({ upload: 7, index: 4099, total: 4100, bytes: new Uint8Array([9]) }));
    expect(chunk).toEqual({ upload: 7, index: 4099, total: 4100, bytes: new Uint8Array([9]) });
    expect(decodeCapturePiece(new Uint8Array(4))).toEqual({ refused: expect.stringContaining("shorter") });
    expect(decodeCapturePiece(encodeCapturePiece({ part: 1, index: 3, count: 3, bytes: new Uint8Array(0) }))).toEqual({ refused: expect.stringContaining("doesn't exist") });
    expect(decodeTakeChunk(new Uint8Array(11))).toEqual({ refused: expect.stringContaining("shorter") });
    expect(decodeTakeChunk(encodeTakeChunk({ upload: 1, index: 0, total: 0, bytes: new Uint8Array(0) }))).toEqual({ refused: expect.stringContaining("doesn't exist") });
  });

  it("carries a mix op in its byte form with its names and buses, through JSON", () => {
    const ops: MixOp[] = [
      { op: "setBus", bus: "Music", key: "volume", value: 0.5 },
      { op: "renameBus", from: "SFX", to: "Effects" },
      { op: "moveBus", bus: "Music", parent: "Master" },
    ];
    for (const op of ops) {
      const sent = JSON.parse(JSON.stringify(mixOpCommand(op))) as unknown;
      expect(readMixOpCommand(sent)).toEqual({ op });
    }
    expect(mixOpCommand({ op: "moveBus", bus: "Music", parent: "Master" }).buses).toEqual(["Music", "Master"]);
  });

  it("refuses a mix.op it can't read, never throwing", () => {
    expect(readMixOpCommand(null)).toEqual({ refused: expect.stringContaining("needs") });
    expect(readMixOpCommand({ op: 0, class: 4, words: [-1], names: [], buses: [] })).toEqual({ refused: expect.stringContaining("needs") });
    const good = mixOpCommand({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    expect(readMixOpCommand({ ...good, buses: [] })).toEqual({ refused: expect.stringContaining("bus 0") });
    expect(readMixOpCommand({ ...good, op: 250 })).toEqual({ refused: expect.stringContaining("unknown op") });
  });
});
