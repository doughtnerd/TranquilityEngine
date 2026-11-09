// A0.2-L5: the TypeScript packers against the byte vectors (ADR 0157 section 4.4, "Round-trip test").
// The `test-hooks` wasm cases (decode_batch, schema hash export) belong to later tasks and stay out of this file.
import { describe, expect, it } from "vitest";
import * as wire from "./wire.generated";
import wireVectors from "../../../../native/audio/crates/audio-wire/vectors/wire.json";

type Json = number | string | Json[] | { [key: string]: Json };
type Rec = { [key: string]: Json };

interface Vector {
  name: string;
  subject: { type: string; name?: string };
  values: Rec;
  hex: string;
}

/** Every case in the shared vector file. Empty until A0.2-L4 fills it; the loops below then cover each case. */
const VECTORS = wireVectors as unknown as Vector[];

/**
 * A generated writer and reader. The writers take their own record type, so the record is passed
 * as `never` (assignable to any parameter) and call sites hand in plain JSON-shaped objects.
 */
interface Codec {
  write: (view: DataView, off: number, rec: never) => number;
  read: (view: DataView, off: number) => unknown;
}

/** One record of a BATCH or REPLAY: the opcode name (as in `Op`) and its fields. */
interface Step {
  op: string;
  rec: Rec;
}

const OPCODES: Record<string, Codec> = {
  PLAY: { write: wire.writePlay, read: wire.readPlay },
  STOP: { write: wire.writeStop, read: wire.readStop },
  SET_PARAMS: { write: wire.writeSetParams, read: wire.readSetParams },
  FADE: { write: wire.writeFade, read: wire.readFade },
  SET_MIXED: { write: wire.writeSetMixed, read: wire.readSetMixed },
  SET_PAUSED: { write: wire.writeSetPaused, read: wire.readSetPaused },
  SEEK: { write: wire.writeSeek, read: wire.readSeek },
  BUS_CONFIG: { write: wire.writeBusConfig, read: wire.readBusConfig },
  BUS_MIX: { write: wire.writeBusMix, read: wire.readBusMix },
  MASTER: { write: wire.writeMaster, read: wire.readMaster },
  RESET: { write: wire.writeReset, read: wire.readReset },
};

/** Kind bodies: the writer fills offsets 16 and up of a whole message; the envelope is written after. */
const KIND_BODIES: Record<string, Codec> = {
  CLIP_BEGIN: { write: wire.writeClipBegin, read: wire.readClipBegin },
  CLIP_CHUNK: { write: wire.writeClipChunk, read: wire.readClipChunk },
  CLIP_UNLOAD: { write: wire.writeClipUnload, read: wire.readClipUnload },
  STREAM_OPEN: { write: wire.writeStreamOpen, read: wire.readStreamOpen },
  STREAM_CHUNK: { write: wire.writeStreamChunk, read: wire.readStreamChunk },
  STREAM_CLOSE: { write: wire.writeStreamClose, read: wire.readStreamClose },
  TIME_PING: { write: wire.writeTimePing, read: wire.readTimePing },
  STREAM_CREDIT: { write: wire.writeStreamCredit, read: wire.readStreamCredit },
};

const OPCODE_BY_CODE = new Map<number, Codec>(
  Object.entries(OPCODES).map(([name, codec]): [number, Codec] => [wire.Op[name as keyof typeof wire.Op], codec]),
);
const KIND_NAME_BY_CODE = new Map<number, string>(
  Object.entries(wire.Kind).map(([name, code]): [number, string] => [code, name]),
);

const SCRATCH_BYTES = 1 << 16;

function newView(): DataView {
  return new DataView(new ArrayBuffer(SCRATCH_BYTES));
}

function bytesOf(view: DataView, length: number): Uint8Array {
  return new Uint8Array(view.buffer, 0, length).slice();
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd hex length ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function codecFor(table: Record<string, Codec>, name: string, what: string): Codec {
  const codec: Codec | undefined = Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
  if (codec === undefined) throw new Error(`no generated ${what} codec for ${name}`);
  return codec;
}

function codeOf(table: Record<string, number>, name: string, what: string): number {
  if (!Object.prototype.hasOwnProperty.call(table, name)) throw new Error(`unknown ${what} ${name}`);
  return table[name];
}

function opCode(name: string): number {
  return codeOf(wire.Op, name, "opcode");
}

function num(value: Json | undefined, what: string): number {
  if (typeof value !== "number") throw new Error(`${what} must be a number`);
  return value;
}

function numbers(value: Json | undefined, what: string): number[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "number")) throw new Error(`${what} must be a number array`);
  return value as number[];
}

function recs(value: Json | undefined, what: string): Rec[] {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`);
  return value as unknown as Rec[];
}

function subjectName(v: Vector): string {
  if (v.subject.name === undefined) throw new Error(`${v.name}: subject needs a name`);
  return v.subject.name;
}

/** Deep check that `actual` carries every field `expected` states (a reader may return more). */
function expectMatch(actual: unknown, expected: Json, path: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    if (Number.isInteger(expected)) expect(actual, path).toBe(expected);
    else expect(actual as number, path).toBeCloseTo(expected, 5);
    return;
  }
  if (typeof expected === "string") {
    expect(actual, path).toBe(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    const got = actual as unknown[];
    expect(got.length, `${path}.length`).toBe(expected.length);
    expected.forEach((item, i) => expectMatch(got[i], item, `${path}[${i}]`));
    return;
  }
  expect(typeof actual, path).toBe("object");
  for (const [key, item] of Object.entries(expected)) {
    if (key === "op") continue;
    expect(actual as object, path).toHaveProperty(key);
    expectMatch((actual as Record<string, unknown>)[key], item, `${path}.${key}`);
  }
}

function expectEnvelope(view: DataView, kind: number, seq: number, length: number, label: string): void {
  const env = wire.readEnvelope(view, 0);
  expect(env.magic, label).toBe(wire.MAGIC);
  expect(env.version, label).toBe((wire.VERSION_MAJOR << 8) | wire.VERSION_MINOR);
  expect(env.kind, label).toBe(kind);
  expect(env.seq, label).toBe(seq);
  expect(env.bodyBytes, label).toBe(length - wire.ENVELOPE_BYTES);
}

/** Writes a BATCH or REPLAY: the header, then each record through its generated writer, then the envelope. */
function writeMessage(kind: number, seq: number, firstFrame: number, flags: number, steps: Step[]): Uint8Array {
  const view = newView();
  let off = wire.writeBatchHeader(view, 0, { firstFrame, count: steps.length, flags });
  for (const step of steps) off += codecFor(OPCODES, step.op, "opcode").write(view, off, step.rec as never);
  wire.writeEnvelope(view, 0, { kind, seq, bodyBytes: off - wire.ENVELOPE_BYTES });
  return bytesOf(view, off);
}

/** Kinds with no body: the envelope is the whole message (RECYCLE). */
const EMPTY_KINDS = new Set(["RECYCLE"]);

function encodeKind(name: string, values: Rec): Uint8Array {
  const view = newView();
  const bodyEnd = EMPTY_KINDS.has(name) ? wire.ENVELOPE_BYTES : codecFor(KIND_BODIES, name, "kind body").write(view, 0, values as never);
  const payload = values.payload === undefined ? [] : numbers(values.payload, "payload");
  payload.forEach((b, i) => view.setUint8(bodyEnd + i, b));
  const total = bodyEnd + payload.length;
  wire.writeEnvelope(view, 0, {
    kind: codeOf(wire.Kind, name, "kind"),
    seq: num(values.seq, "seq"),
    bodyBytes: total - wire.ENVELOPE_BYTES,
  });
  return bytesOf(view, total);
}

function encodeVector(v: Vector): Uint8Array {
  const view = newView();
  switch (v.subject.type) {
    case "Envelope":
      return bytesOf(view, wire.writeEnvelope(view, 0, v.values as unknown as wire.Envelope));
    case "HrirHeader":
      return bytesOf(view, wire.writeHrirHeader(view, 0, v.values as unknown as wire.HrirHeader));
    case "Opcode":
      return bytesOf(view, codecFor(OPCODES, subjectName(v), "opcode").write(view, 0, v.values as never));
    case "Kind":
      return encodeKind(subjectName(v), v.values);
    case "Batch": {
      const name = subjectName(v);
      if (name !== "BATCH" && name !== "REPLAY") throw new Error(`${v.name}: batch kind must be BATCH or REPLAY`);
      const steps = recs(v.values.records, "records").map((rec): Step => ({ op: String(rec.op), rec }));
      return writeMessage(
        codeOf(wire.Kind, name, "kind"),
        num(v.values.seq, "seq"),
        num(v.values.firstFrame, "firstFrame"),
        num(v.values.flags, "flags"),
        steps,
      );
    }
    case "Status":
      return bytesOf(
        view,
        wire.writeStatus(view, 0, v.values as unknown as wire.StatusBlock, num(v.values.seq, "seq")),
      );
    default:
      throw new Error(`${v.name}: unknown subject ${v.subject.type}`);
  }
}

interface Walked {
  opcode: number;
  words: number;
  off: number;
}

/** Walks records by their `words` count; refuses a record that is shorter than its head or runs past `end`. */
function walkRecords(view: DataView, start: number, end: number): Walked[] {
  const out: Walked[] = [];
  let off = start;
  while (off < end) {
    const head = wire.readRecordHead(view, off);
    if (head.words * 4 < wire.RECORD_HEAD_BYTES) throw new wire.WireError(wire.ErrorCode.MALFORMED, "record: words below the head size");
    if (off + head.words * 4 > end) throw new wire.WireError(wire.ErrorCode.TRUNCATED, "record: runs past the end");
    out.push({ opcode: head.opcode, words: head.words, off });
    off += head.words * 4;
  }
  return out;
}

function expectSteps(view: DataView, length: number, steps: Step[], label: string): void {
  const walked = walkRecords(view, wire.BATCH_HEADER_FIXED_END, length);
  expect(walked.map((w) => w.opcode), label).toEqual(steps.map((s) => opCode(s.op)));
  walked.forEach((w, i) => {
    const step = steps[i];
    expectMatch(codecFor(OPCODES, step.op, "opcode").read(view, w.off), step.rec, `${label}[${i}] ${step.op}`);
  });
}

/** Reads back whatever the vector's subject names, through the generated readers. */
function expectReadBack(v: Vector, bytes: Uint8Array): void {
  const view = viewOf(bytes);
  const label = v.name;
  switch (v.subject.type) {
    case "Envelope":
      expectMatch(wire.readEnvelope(view, 0), v.values, label);
      return;
    case "HrirHeader":
      expectMatch(wire.readHrirHeader(view, 0), v.values, label);
      return;
    case "Opcode": {
      const name = subjectName(v);
      const head = wire.readRecordHead(view, 0);
      expect(head.opcode, label).toBe(opCode(name));
      expect(head.words * 4, label).toBe(bytes.length);
      expectMatch(codecFor(OPCODES, name, "opcode").read(view, 0), v.values, label);
      return;
    }
    case "Kind": {
      const name = subjectName(v);
      expectEnvelope(view, codeOf(wire.Kind, name, "kind"), num(v.values.seq, "seq"), bytes.length, label);
      if (EMPTY_KINDS.has(name)) return;
      const codec = codecFor(KIND_BODIES, name, "kind body");
      const body: Rec = { ...v.values };
      delete body.seq;
      delete body.payload;
      expectMatch(codec.read(view, 0), body, label);
      const payload = v.values.payload === undefined ? [] : numbers(v.values.payload, "payload");
      expect(Array.from(bytes.slice(bytes.length - payload.length)), label).toEqual(payload);
      return;
    }
    case "Batch": {
      const name = subjectName(v);
      const steps = recs(v.values.records, "records").map((rec): Step => ({ op: String(rec.op), rec }));
      expectEnvelope(view, codeOf(wire.Kind, name, "kind"), num(v.values.seq, "seq"), bytes.length, label);
      const header = wire.readBatchHeader(view, 0);
      expectMatch(header, { firstFrame: v.values.firstFrame, count: steps.length, flags: v.values.flags }, label);
      expectSteps(view, bytes.length, steps, label);
      return;
    }
    case "Status": {
      const fields: Rec = { ...v.values };
      expectEnvelope(view, wire.Kind.STATUS, num(fields.seq, "seq"), bytes.length, label);
      delete fields.seq;
      expectMatch(wire.readStatus(bytes), fields, label);
      return;
    }
    default:
      throw new Error(`${v.name}: unknown subject ${v.subject.type}`);
  }
}

/** A PLAY record's fields, with the values a test overrides. */
function playRec(over: Rec = {}): Rec {
  return {
    voiceId: 1,
    frameOffset: 0,
    clip: 2,
    bus: 0,
    flags: 0,
    group: 0,
    reserved: 0,
    gain: 1,
    pitch: 1,
    dirX: 0,
    dirY: 0,
    dirZ: -1,
    lpHz: 24000,
    score: 0.5,
    startOffsetFrames: 0,
    ...over,
  };
}

describe("wire round trip", () => {
  it("every vector packs to its hex bytes", () => {
    expect(Array.isArray(VECTORS)).toBe(true);
    for (const v of VECTORS) expect(toHex(encodeVector(v)), v.name).toBe(v.hex);
  });

  it("every vector reads back to its values (readers where generated: envelope, record head, STATUS)", () => {
    for (const v of VECTORS) expectReadBack(v, fromHex(v.hex));
  });

  it("the asap sentinel 0xFFFFFFFF is written and read as an unsigned value", () => {
    expect(wire.ASAP).toBe(0xffffffff);

    const view = newView();
    wire.writeRecordHead(view, 0, { opcode: wire.Op.STOP, words: 5, voiceId: 0, frameOffset: wire.ASAP });
    expect(view.getUint32(8, true)).toBe(0xffffffff);
    expect(toHex(bytesOf(view, 12)).slice(16, 24)).toBe("ffffffff");
    expect(wire.readRecordHead(view, 0).frameOffset).toBe(4294967295);

    const play = codecFor(OPCODES, "PLAY", "opcode");
    const asap = newView();
    play.write(asap, 0, playRec({ frameOffset: wire.ASAP }) as never);
    expect((play.read(asap, 0) as wire.Play).frameOffset).toBe(4294967295);

    // A stamped frame above 2^31 is also unsigned on the way back.
    const stamped = newView();
    play.write(stamped, 0, playRec({ frameOffset: 0x80000001 }) as never);
    expect((play.read(stamped, 0) as wire.Play).frameOffset).toBe(2147483649);
  });

  it("PLAY panner bits 5-6 and the reserved group field survive a round trip", () => {
    expect(wire.PLAY_FLAGS_PANNER_SHIFT).toBe(5);
    expect(wire.PLAY_FLAGS_PANNER_MASK).toBe(0x60);

    for (const panner of Object.values(wire.Panner)) {
      const flags = wire.PLAY_FLAGS_SPATIAL | wire.PLAY_FLAGS_LOOP | (panner << wire.PLAY_FLAGS_PANNER_SHIFT);
      const view = newView();
      const n = codecFor(OPCODES, "PLAY", "opcode").write(view, 0, playRec({ flags, group: 0xbeef, reserved: 0x1234 }) as never);
      expect(n).toBe(wire.PLAY_FIXED_END);
      expect(view.getUint16(18, true)).toBe(flags);

      const back = wire.readPlay(view, 0);
      expect(back.flags).toBe(flags);
      expect((back.flags & wire.PLAY_FLAGS_PANNER_MASK) >> wire.PLAY_FLAGS_PANNER_SHIFT).toBe(panner);
      expect(back.group).toBe(0xbeef);
      expect(back.reserved).toBe(0x1234);
    }

    // SET_PARAMS carries the same panner bits.
    for (const panner of Object.values(wire.Panner)) {
      const flags = wire.PLAY_FLAGS_SPATIAL | (panner << wire.PLAY_FLAGS_PANNER_SHIFT);
      const view = newView();
      codecFor(OPCODES, "SET_PARAMS", "opcode").write(
        view,
        0,
        { voiceId: 3, frameOffset: 96, mask: wire.SET_PARAMS_MASK_FLAGS, gain: 0.5, pitch: 1, dirX: 0, dirY: 0, dirZ: 0, lpHz: 24000, score: 0, bus: 0, rampFrames: 0, flags } as never,
      );
      const back = wire.readSetParams(view, 0);
      expect((back.flags & wire.PLAY_FLAGS_PANNER_MASK) >> wire.PLAY_FLAGS_PANNER_SHIFT).toBe(panner);
    }
  });

  it("REPLAY chunk flags (first, last) and a BATCH overflowed flag", () => {
    expect(wire.REPLAY_FLAGS_FIRST_CHUNK).toBe(wire.BATCH_HEADER_FLAGS_FIRST_CHUNK);
    expect(wire.REPLAY_FLAGS_LAST_CHUNK).toBe(wire.BATCH_HEADER_FLAGS_LAST_CHUNK);

    const replayFlags = wire.REPLAY_FLAGS_FIRST_CHUNK | wire.REPLAY_FLAGS_LAST_CHUNK;
    const replay = writeMessage(wire.Kind.REPLAY, 3, 1000, replayFlags, [
      { op: "RESET", rec: { voiceId: 0, frameOffset: wire.ASAP, keepClips: 0 } },
      { op: "PLAY", rec: playRec({ frameOffset: 480 }) },
    ]);
    const rv = viewOf(replay);
    expectEnvelope(rv, wire.Kind.REPLAY, 3, replay.length, "REPLAY");
    const rh = wire.readBatchHeader(rv, 0);
    expect(rh.flags).toBe(replayFlags);
    expect(rh.flags & wire.REPLAY_FLAGS_FIRST_CHUNK).toBeTruthy();
    expect(rh.flags & wire.REPLAY_FLAGS_LAST_CHUNK).toBeTruthy();
    expect(rh.flags & wire.REPLAY_FLAGS_OVERFLOWED).toBe(0);
    expect(rh.firstFrame).toBe(1000);
    expect(rh.count).toBe(2);

    const batch = writeMessage(wire.Kind.BATCH, 4, 0, wire.BATCH_HEADER_FLAGS_OVERFLOWED, [{ op: "PLAY", rec: playRec() }]);
    const bv = viewOf(batch);
    expectEnvelope(bv, wire.Kind.BATCH, 4, batch.length, "BATCH");
    const bh = wire.readBatchHeader(bv, 0);
    expect(bh.flags & wire.BATCH_HEADER_FLAGS_OVERFLOWED).toBeTruthy();
    expect(bh.flags & (wire.BATCH_HEADER_FLAGS_FIRST_CHUNK | wire.BATCH_HEADER_FLAGS_LAST_CHUNK)).toBe(0);
  });

  it("REPLAY and BATCH bytes walk record by record using words", () => {
    const replaySteps: Step[] = [
      { op: "RESET", rec: { voiceId: 0, frameOffset: wire.ASAP, keepClips: 0 } },
      {
        op: "BUS_CONFIG",
        rec: {
          voiceId: 0,
          frameOffset: wire.ASAP,
          buses: [
            {
              parent: wire.BUS_ROOT,
              effects: [
                { type: wire.EffectType.Lowpass, p: [1000, 0.5, 0, 0, 0, 0, 0] },
                { type: wire.EffectType.Compressor, p: [-12, 4, 2, 0.5, 0.25, 0, 0] },
              ],
            },
            { parent: 0, effects: [] },
          ],
        },
      },
      { op: "PLAY", rec: playRec({ frameOffset: 480, startOffsetFrames: 12 }) },
      {
        op: "SET_PARAMS",
        rec: {
          voiceId: 1,
          frameOffset: 512,
          mask: wire.SET_PARAMS_MASK_GAIN | wire.SET_PARAMS_MASK_FLAGS,
          gain: 0.5,
          pitch: 1,
          dirX: 0,
          dirY: 0,
          dirZ: 0,
          lpHz: 24000,
          score: 0,
          bus: 0,
          rampFrames: 64,
          flags: wire.PLAY_FLAGS_SPATIAL | (wire.Panner.Hrtf << wire.PLAY_FLAGS_PANNER_SHIFT),
        },
      },
      { op: "STOP", rec: { voiceId: 1, frameOffset: wire.ASAP, fadeFrames: 0, reason: 0 } },
    ];
    const replay = writeMessage(
      wire.Kind.REPLAY,
      7,
      0,
      wire.REPLAY_FLAGS_FIRST_CHUNK | wire.REPLAY_FLAGS_LAST_CHUNK,
      replaySteps,
    );
    expectEnvelope(viewOf(replay), wire.Kind.REPLAY, 7, replay.length, "REPLAY");
    expectSteps(viewOf(replay), replay.length, replaySteps, "REPLAY");

    const batchSteps: Step[] = [
      { op: "PLAY", rec: playRec({ frameOffset: wire.ASAP }) },
      { op: "PLAY", rec: playRec({ frameOffset: 0x80000001, clip: 9 }) },
      { op: "STOP", rec: { voiceId: 1, frameOffset: 700, fadeFrames: 240, reason: 2 } },
    ];
    const batch = writeMessage(wire.Kind.BATCH, 8, 1234.5, 0, batchSteps);
    expectEnvelope(viewOf(batch), wire.Kind.BATCH, 8, batch.length, "BATCH");
    expectSteps(viewOf(batch), batch.length, batchSteps, "BATCH");
  });

  it("STATUS with every header field and every section, including negative minSlackFrames", () => {
    const status: wire.StatusBlock = {
      currentFrame: 123456789.5,
      dateMs: 1732000000000.25,
      pingSeq: 7,
      pingFrameLo: 0xdeadbeef,
      underruns: 2,
      lateCommands: 3,
      workUnits: 4000000000,
      workUnitsMax: 4294967295,
      mixedVoices: 40,
      liveVoices: 96,
      flags: wire.STATUS_FLAGS_VERSION_MISMATCH | wire.STATUS_FLAGS_ARENA_FULL | wire.STATUS_FLAGS_INBOX_OVERFLOW |
        wire.STATUS_FLAGS_ADAPTIVE_CAP_ACTIVE | wire.STATUS_FLAGS_READY | wire.STATUS_FLAGS_TRAP_CAUGHT,
      mixedCap: 32,
      loadPermille: 870,
      traps: 1,
      minSlackFrames: -17,
      underrunFrames: 512,
      arenaUsedKB: 1024,
      arenaLargestFreeKB: 256,
      abiVersion: 0x00010000,
      maxLatenessFrames: 99,
      hrtfVoices: 5,
      hrtfLoadFailure: wire.HrtfLoadFailure.Data,
      ended: [1, 2, 9],
      demoted: [4],
      starved: [5, 6],
      playheads: [
        { id: 1, clipFrame: 44100 },
        { id: 9, clipFrame: 0 },
      ],
      clipEvents: [
        { clipId: 10, code: wire.ClipEvent.Resident },
        { clipId: 0xffff0001, code: wire.ClipEvent.HrtfReady },
      ],
      streamEvents: [{ id: 3, code: wire.StreamEvent.Eos }],
      peaks: [
        { l: 0.5, r: 0.25 },
        { l: 0, r: 1 },
      ],
    };
    const seq = 42;
    const bytes = handStatus(status, seq);

    // The generated writer produces the same bytes as the offsets written by hand.
    const written = newView();
    const n = wire.writeStatus(written, 0, status, seq);
    expect(toHex(bytesOf(written, n))).toBe(toHex(bytes));

    expect(wire.readStatus(bytes)).toEqual(status);
    // A view with a leading offset reads the same message.
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 8);
    expect(wire.readStatus(padded.subarray(8))).toEqual(status);
    expect(wire.readEnvelope(viewOf(bytes), 0).seq).toBe(seq);
  });

  it("truncated, oversize and unknown-opcode records are rejected or skipped by length, never read out of bounds", () => {
    const full = writeMessage(wire.Kind.BATCH, 1, 0, 0, [{ op: "PLAY", rec: playRec() }]);
    expect(full.length).toBe(32 + wire.PLAY_FIXED_END);

    // Only part of the record head is there.
    const shortHead = viewOf(full.slice(0, 40));
    expect(() => wire.readRecordHead(shortHead, 32)).toThrow(/truncated/);

    // The head fits but the payload does not.
    const shortPayload = viewOf(full.slice(0, 60));
    expect(wire.readRecordHead(shortPayload, 32).words * 4).toBe(wire.PLAY_FIXED_END);
    expect(() => wire.readPlay(shortPayload, 32)).toThrow(/truncated/);

    // Oversize: the record claims 0xFFFF words in a buffer that holds 56 bytes of it.
    const oversize = full.slice();
    viewOf(oversize).setUint16(32 + 2, 0xffff, true);
    expect(() => wire.readPlay(viewOf(oversize), 32)).toThrow(/truncated/);
    expect(() => walkRecords(viewOf(oversize), 32, oversize.length)).toThrow(wire.WireError);

    // Unknown opcode 0x7F: the walker skips it by its length, and the typed reader refuses it.
    const unknown = newView();
    wire.writeRecordHead(unknown, 0, { opcode: 0x7f, words: 4, voiceId: 0, frameOffset: 0 });
    const stop = codecFor(OPCODES, "STOP", "opcode").write(unknown, 16, { voiceId: 1, frameOffset: 0, fadeFrames: 0, reason: 0 } as never);
    const mixed = bytesOf(unknown, 16 + stop);
    expect(walkRecords(viewOf(mixed), 0, mixed.length).map((w) => w.opcode)).toEqual([0x7f, opCode("STOP")]);
    expect(() => wire.readPlay(viewOf(mixed), 0)).toThrow(/wrong opcode/);

    // A record with words below its own head would not advance: the walker refuses it.
    const zeroWords = newView();
    wire.writeRecordHead(zeroWords, 0, { opcode: wire.Op.STOP, words: 0, voiceId: 0, frameOffset: 0 });
    expect(() => walkRecords(zeroWords, 0, 12)).toThrow(wire.WireError);

    // A STATUS shorter than its header is refused.
    expect(() => wire.readStatus(new Uint8Array(100))).toThrow(/truncated/);
  });

  it("fuzz 1,000 seeded random batches (no throw other than a refusal, no out-of-bounds reads)", () => {
    const next = lcg(0x5eed1234);
    const below = (n: number): number => Math.floor((next() / 0x100000000) * n);
    const kinds = Array.from(KIND_NAME_BY_CODE.keys());
    const opcodes = Array.from(OPCODE_BY_CODE.keys());
    let refused = 0;
    let accepted = 0;

    for (let i = 0; i < 1000; i++) {
      const length = below(320);
      const bytes = new Uint8Array(length);
      for (let j = 0; j < length; j++) bytes[j] = below(256);
      const view = viewOf(bytes);

      // Most cases get a plausible envelope so the body parsers run, not only the envelope check.
      if (length >= 16 && below(4) !== 0) {
        wire.writeEnvelope(view, 0, {
          kind: below(14),
          seq: below(1 << 30),
          bodyBytes: below(2) === 0 ? length - wire.ENVELOPE_BYTES : below(length),
        });
      }
      if (length >= 44 && below(2) === 0) {
        const kind = kinds[below(kinds.length)];
        if (kind === wire.Kind.BATCH || kind === wire.Kind.REPLAY) {
          wire.writeRecordHead(view, 32, {
            opcode: opcodes[below(opcodes.length)],
            words: below(8),
            voiceId: below(4),
            frameOffset: wire.ASAP,
          });
        }
      }

      try {
        parseAny(bytes);
        accepted++;
      } catch (error) {
        refused++;
        expect(error, `case ${i}`).toBeInstanceOf(wire.WireError);
        expect((error as InstanceType<typeof wire.WireError>).code, `case ${i}`).toBeLessThan(0);
      }
    }
    expect(accepted + refused).toBe(1000);
  });
});

/** Parses any message the way a reader would: envelope, then the body by kind. Throws only on refusal. */
function parseAny(bytes: Uint8Array): void {
  const view = viewOf(bytes);
  const env = wire.readEnvelope(view, 0);
  if (env.kind === wire.Kind.STATUS) {
    wire.readStatus(bytes);
    return;
  }
  if (env.kind === wire.Kind.BATCH || env.kind === wire.Kind.REPLAY) {
    wire.readBatchHeader(view, 0);
    for (const w of walkRecords(view, wire.BATCH_HEADER_FIXED_END, bytes.length)) {
      OPCODE_BY_CODE.get(w.opcode)?.read(view, w.off);
    }
    return;
  }
  const name = KIND_NAME_BY_CODE.get(env.kind);
  const codec: Codec | undefined = name === undefined ? undefined : KIND_BODIES[name];
  codec?.read(view, 0);
}

/** Seeded linear congruential generator (Numerical Recipes constants); the fuzz seed is fixed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

/** Writes a STATUS message by hand at the spec offsets (header 112 bytes including the envelope). */
function handStatus(s: wire.StatusBlock, seq: number): Uint8Array {
  const size =
    112 +
    4 * (s.ended.length + s.demoted.length + s.starved.length) +
    8 * (s.playheads.length + s.clipEvents.length + s.streamEvents.length + s.peaks.length);
  const view = new DataView(new ArrayBuffer(size));
  view.setUint32(0, 0x4d594131, true);
  view.setUint16(4, 0x0100, true);
  view.setUint16(6, wire.Kind.STATUS, true);
  view.setUint32(8, seq, true);
  view.setUint32(12, size - 16, true);
  view.setFloat64(16, s.currentFrame, true);
  view.setFloat64(24, s.dateMs, true);
  view.setUint32(32, s.pingSeq, true);
  view.setUint32(36, s.pingFrameLo, true);
  view.setUint32(40, s.underruns, true);
  view.setUint32(44, s.lateCommands, true);
  view.setUint32(48, s.workUnits, true);
  view.setUint32(52, s.workUnitsMax, true);
  view.setUint16(56, s.mixedVoices, true);
  view.setUint16(58, s.liveVoices, true);
  view.setUint32(60, s.flags, true);
  view.setUint16(64, s.ended.length, true);
  view.setUint16(66, s.demoted.length, true);
  view.setUint16(68, s.starved.length, true);
  view.setUint16(70, s.playheads.length, true);
  view.setUint16(72, s.peaks.length, true);
  view.setUint16(74, s.clipEvents.length, true);
  view.setUint16(76, s.streamEvents.length, true);
  view.setUint16(78, s.mixedCap, true);
  view.setUint16(80, s.loadPermille, true);
  view.setUint16(82, s.traps, true);
  view.setInt32(84, s.minSlackFrames, true);
  view.setUint32(88, s.underrunFrames, true);
  view.setUint32(92, s.arenaUsedKB, true);
  view.setUint32(96, s.arenaLargestFreeKB, true);
  view.setUint32(100, s.abiVersion, true);
  view.setUint32(104, s.maxLatenessFrames, true);
  view.setUint16(108, s.hrtfVoices, true);
  view.setUint16(110, s.hrtfLoadFailure, true);

  let cur = 112;
  for (const v of [...s.ended, ...s.demoted, ...s.starved]) {
    view.setUint32(cur, v, true);
    cur += 4;
  }
  for (const p of s.playheads) {
    view.setUint32(cur, p.id, true);
    view.setUint32(cur + 4, p.clipFrame, true);
    cur += 8;
  }
  for (const c of s.clipEvents) {
    view.setUint32(cur, c.clipId, true);
    view.setUint32(cur + 4, c.code, true);
    cur += 8;
  }
  for (const e of s.streamEvents) {
    view.setUint32(cur, e.id, true);
    view.setUint32(cur + 4, e.code, true);
    cur += 8;
  }
  for (const p of s.peaks) {
    view.setFloat32(cur, p.l, true);
    view.setFloat32(cur + 4, p.r, true);
    cur += 8;
  }
  expect(cur).toBe(size);
  return new Uint8Array(view.buffer);
}
