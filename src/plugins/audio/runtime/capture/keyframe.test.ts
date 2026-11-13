// ADR 0171 amended by 0172 (M5a, Rc1b; leaf L-Rc1ba folded in; api-and-models §5.5, §5.3 NAMES, rulings R13): the
// KEYFRAME codec at its caps (8,192 voices fit one 256 KB record and round-trip exactly), each cap refused one past it,
// the framing and value refusals, a hand-assembled byte vector, and the NAMES codec for every table.
import { describe, expect, it } from "vitest";
import {
  CAPTURE_NAME_MAX_BYTES,
  CAPTURE_RECORD_MAX_BYTES,
  CaptureError,
  KEYFRAME_BUS_BYTES,
  KEYFRAME_EVENT_BYTES,
  KEYFRAME_MAX_BUSES,
  KEYFRAME_MAX_EVENTS,
  KEYFRAME_MAX_METERED,
  KEYFRAME_MAX_MUSIC,
  KEYFRAME_MAX_VOICES,
  KEYFRAME_METERED_BYTES,
  KEYFRAME_MIX_BYTES,
  KEYFRAME_MUSIC_BYTES,
  KEYFRAME_VOICE_BYTES,
  NAME_TABLES,
  RecordType,
  assembleCapture,
  checkKeyframe,
  decodeKeyframe,
  decodeNames,
  encodeKeyframe,
  encodeNames,
  keyframeBytes,
  namesBytes,
  type CaptureRecordInit,
  type KeyframeBus,
  type KeyframeEvent,
  type KeyframeMetered,
  type KeyframeMusic,
  type KeyframePayload,
  type KeyframeVoice,
} from "./format";
import { decodeRecordAt, openCapture } from "./reader";
import { EMPTY_KEYFRAME_PAYLOAD, SAMPLE_HEADER, SAMPLE_META } from "./testSupport";

const f32 = Math.fround;

/** A keyframe with `n` rows per section (capped per section), every field varied and f32-exact. */
function keyframe(n: { voices: number; buses: number; metered: number; events: number; music: number }): KeyframePayload {
  const voices: KeyframeVoice[] = Array.from({ length: n.voices }, (_, i) => ({
    id: (i * 2_654_435_761) >>> 0, clip: i + 1, slot: i % 32, state: i % 6, priority: i % 256, reason: (i * 7) % 256,
    gain: f32(i / 8192), pitch: (i * 13) & 0xffff, audibility: (i * 31) & 0xffff, playheadFrames: (i * 48_000 + 7) >>> 0,
  }));
  const buses: KeyframeBus[] = Array.from({ length: n.buses }, (_, i) => ({
    slot: i, gen: (i * 977) & 0xffff, flags: i & 0x3f,
    lanes: Array.from({ length: 10 }, (_, k) => f32((i + 1) * 0.01 + k * 0.1)),
    duck: f32(1 - i / 64), automation: f32(i / 32),
  }));
  const metered: KeyframeMetered[] = Array.from({ length: n.metered }, (_, i) => ({
    slot: i * 3, flags: i & 0xf,
    momentary: i === 0 ? Number.NEGATIVE_INFINITY : f32(-23 - i), shortTerm: f32(-22.5 - i), integrated: i === 1 ? Number.NEGATIVE_INFINITY : f32(-24 + i / 4),
    lra: f32(i * 0.5), maxTruePeak: f32(-1 - i / 10), maxMomentary: f32(-18 + i), elapsed: f32(i * 12.25),
  }));
  const events: KeyframeEvent[] = Array.from({ length: n.events }, (_, i) => ({
    id: 100_000 + i, asset: i % 50, voices: i % 65_536, state: i % 4, paramsHash: (i * 0x9e3779b9) >>> 0,
  }));
  const music: KeyframeMusic[] = Array.from({ length: n.music }, (_, i) => ({
    id: 500 + i, segment: i * 3, state: i % 3, pass: i, bar: i * 17, beat: i % 4, tick: (i * 9) % 256, tempo: 120 + i,
    pendingTo: i === 0 ? 0 : i + 900, pendingTimeSec: f32(i * 0.375),
  }));
  return {
    voices, buses, metered, events, music,
    mix: { slotTableVersion: 4242, monitorActive: 1, loudnessPausedMask: 0b101, targetIndex: 2, snapshotName: 77, masterVolume: f32(0.8), hiddenMute: 1 },
  };
}

const FULL = { voices: KEYFRAME_MAX_VOICES, buses: KEYFRAME_MAX_BUSES, metered: KEYFRAME_MAX_METERED, events: KEYFRAME_MAX_EVENTS, music: KEYFRAME_MAX_MUSIC };

function encoded(p: KeyframePayload, pad = 0): { bytes: Uint8Array; view: DataView; len: number } {
  const len = keyframeBytes(p);
  const bytes = new Uint8Array(len + 2 * pad);
  const view = new DataView(bytes.buffer);
  expect(encodeKeyframe(view, pad, p)).toBe(len);
  return { bytes, view, len };
}

/** The code a thunk throws (a `CaptureError`'s code, or the class name of anything else). */
function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof CaptureError ? e.code : (e as Error).constructor.name;
  }
  return "ok";
}

/** Offsets of each section's count in a payload with these row counts. */
function countOffsets(n: { voices: number; buses: number; metered: number; events: number; music: number }): number[] {
  const rows = [n.voices * KEYFRAME_VOICE_BYTES, n.buses * KEYFRAME_BUS_BYTES, n.metered * KEYFRAME_METERED_BYTES, n.events * KEYFRAME_EVENT_BYTES, n.music * KEYFRAME_MUSIC_BYTES];
  const out = [0];
  for (const r of rows) out.push(out[out.length - 1]! + 2 + r);
  return out;
}

describe("KEYFRAME codec (Rc1b, §5.5)", () => {
  it("a keyframe at every cap (8,192 voices, 32 buses, 9 metered, 1,024 events, 16 music, mix) fits 256 KB and round-trips exactly", () => {
    const p = keyframe(FULL);
    const { view, len } = encoded(p);
    expect(len).toBe(215_777);
    expect(len).toBeLessThanOrEqual(CAPTURE_RECORD_MAX_BYTES);
    checkKeyframe(view, 0, len);
    expect(decodeKeyframe(view, 0, len)).toEqual(p);
  });

  it("round-trips at an offset with a base, and writes nothing outside its bytes", () => {
    const p = keyframe({ voices: 3, buses: 2, metered: 2, events: 2, music: 2 });
    const pad = 11;
    const len = keyframeBytes(p);
    const bytes = new Uint8Array(len + 2 * pad).fill(0xa5);
    const view = new DataView(bytes.buffer);
    expect(encodeKeyframe(view, pad, p)).toBe(len);
    expect(Array.from(bytes.subarray(0, pad)).every((b) => b === 0xa5)).toBe(true);
    expect(Array.from(bytes.subarray(pad + len)).every((b) => b === 0xa5)).toBe(true);
    expect(decodeKeyframe(view, pad, len, 1000)).toEqual(p);
  });

  it("the empty keyframe is 29 B: six counts and the mix row", () => {
    expect(keyframeBytes(EMPTY_KEYFRAME_PAYLOAD)).toBe(6 * 2 + KEYFRAME_MIX_BYTES);
    const { view, len } = encoded(EMPTY_KEYFRAME_PAYLOAD);
    expect(decodeKeyframe(view, 0, len)).toEqual(EMPTY_KEYFRAME_PAYLOAD);
  });

  it("matches a vector assembled field by field from §5.5's layout", () => {
    const p = keyframe({ voices: 1, buses: 1, metered: 1, events: 1, music: 1 });
    const out = new Uint8Array(12 + 24 + 56 + 36 + 16 + 40 + 17);
    const v = new DataView(out.buffer);
    let at = 0;
    const u8 = (x: number) => { v.setUint8(at, x); at += 1; };
    const u16 = (x: number) => { v.setUint16(at, x, true); at += 2; };
    const u32 = (x: number) => { v.setUint32(at, x, true); at += 4; };
    const fl = (x: number) => { v.setFloat32(at, x, true); at += 4; };
    const [vo, b, m, e, mu] = [p.voices[0]!, p.buses[0]!, p.metered[0]!, p.events[0]!, p.music[0]!];
    u16(1); u32(vo.id); u32(vo.clip); u8(vo.slot); u8(vo.state); u8(vo.priority); u8(vo.reason); fl(vo.gain); u16(vo.pitch); u16(vo.audibility); u32(vo.playheadFrames);
    u16(1); u8(b.slot); u8(0); u16(b.gen); u16(b.flags); u16(0); b.lanes.forEach(fl); fl(b.duck); fl(b.automation);
    u16(1); u16(m.slot); u16(m.flags); [m.momentary, m.shortTerm, m.integrated, m.lra, m.maxTruePeak, m.maxMomentary, m.elapsed].forEach(fl); u32(0);
    u16(1); u32(e.id); u32(e.asset); u16(e.voices); u8(e.state); u8(0); u32(e.paramsHash);
    u16(1); u32(mu.id); u32(mu.segment); u8(mu.state); u8(mu.pass); u16(mu.bar); u8(mu.beat); u8(mu.tick); u16(mu.tempo); u32(mu.pendingTo); fl(mu.pendingTimeSec); at += 16;
    u16(1); u32(p.mix.slotTableVersion); u8(p.mix.monitorActive); u8(p.mix.loudnessPausedMask); u8(p.mix.targetIndex); u8(0); u32(p.mix.snapshotName); fl(p.mix.masterVolume); u8(p.mix.hiddenMute);
    expect(at).toBe(out.byteLength);
    expect(Array.from(encoded(p).bytes)).toEqual(Array.from(out));
  });

  it("goes through a whole file: the reader's open checks it and decodeRecordAt's bytes decode to the payload", async () => {
    const p = keyframe(FULL);
    const records: CaptureRecordInit[] = [
      { type: RecordType.EPOCH, epoch: 0, seq: 1, frame: 0, payload: { reason: 0, sampleRate: 48_000, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1 } },
      { type: RecordType.KEYFRAME, epoch: 0, seq: 2, frame: 0, payload: p },
    ];
    const c = await openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, records, { index: true }));
    expect(c.keyframes).toEqual([1]);
    const r = decodeRecordAt(c, 1);
    if (r.kind !== "keyframe") throw new Error("not a keyframe");
    expect(r.payload.byteLength).toBe(215_777);
    expect(decodeKeyframe(new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength), 0, r.payload.byteLength)).toEqual(p);
  });

  describe("every cap refused one past it", () => {
    const sections = [
      ["voices", KEYFRAME_MAX_VOICES],
      ["buses", KEYFRAME_MAX_BUSES],
      ["metered", KEYFRAME_MAX_METERED],
      ["events", KEYFRAME_MAX_EVENTS],
      ["music", KEYFRAME_MAX_MUSIC],
    ] as const;
    for (const [name, cap] of sections) {
      it(`${name}: ${cap} accepted, ${cap + 1} refused by the encoder (RangeError) and the decoder (badValue, before any allocation)`, () => {
        const atCap = keyframe({ voices: 0, buses: 0, metered: 0, events: 0, music: 0, [name]: cap });
        const { view, len } = encoded(atCap);
        expect(codeOf(() => decodeKeyframe(view, 0, len))).toBe("ok");
        const over = keyframe({ voices: 0, buses: 0, metered: 0, events: 0, music: 0, [name]: cap + 1 });
        expect(codeOf(() => encodeKeyframe(new DataView(new ArrayBuffer(keyframeBytes(over))), 0, over))).toBe("RangeError");
        // The decoder: the count patched to cap + 1, with the bytes the rows would need, still refuses on the count.
        const rows = { voices: 0, buses: 0, metered: 0, events: 0, music: 0, [name]: cap + 1 };
        const raw = new Uint8Array(keyframeBytes(over));
        const rv = new DataView(raw.buffer);
        const offs = countOffsets(rows);
        const s = sections.findIndex(([n]) => n === name);
        rv.setUint16(offs[s]!, cap + 1, true);
        rv.setUint16(offs[5]!, 1, true);
        const at = offs[s]!;
        let err: unknown;
        try { decodeKeyframe(rv, 0, raw.byteLength, 500); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(CaptureError);
        expect((err as CaptureError).code).toBe("badValue");
        expect((err as CaptureError).offset).toBe(500 + at);
        expect(codeOf(() => checkKeyframe(rv, 0, raw.byteLength))).toBe("badValue");
      });
    }

    it("the mix section must hold exactly one row (0 and 2 refused)", () => {
      const { bytes, view, len } = encoded(EMPTY_KEYFRAME_PAYLOAD);
      view.setUint16(10, 0, true);
      expect(codeOf(() => decodeKeyframe(view, 0, len))).toBe("badValue");
      view.setUint16(10, 2, true);
      expect(codeOf(() => checkKeyframe(view, 0, len))).toBe("badValue");
      expect(bytes.byteLength).toBe(29);
    });

    it("a bus row without exactly 10 lane floats is refused by the encoder", () => {
      const p = keyframe({ voices: 0, buses: 1, metered: 0, events: 0, music: 0 });
      const bad = { ...p, buses: [{ ...p.buses[0]!, lanes: [1, 1, 1] }] };
      expect(codeOf(() => encodeKeyframe(new DataView(new ArrayBuffer(512)), 0, bad))).toBe("RangeError");
    });
  });

  describe("framing refusals (badLength)", () => {
    const p = keyframe({ voices: 4, buses: 2, metered: 1, events: 3, music: 1 });

    it("one byte short, one byte over, and a len too short for the first count", () => {
      const { view, len } = encoded(p, 4);
      expect(codeOf(() => decodeKeyframe(view, 4, len - 1))).toBe("badLength");
      expect(codeOf(() => decodeKeyframe(view, 4, len + 1))).toBe("badLength");
      expect(codeOf(() => checkKeyframe(view, 4, 1))).toBe("badLength");
      expect(codeOf(() => checkKeyframe(view, 4, 0))).toBe("badLength");
    });

    it("a count that runs past len, and one that leaves bytes over", () => {
      // The music count (the last counted section before the mix) raised by one: its rows run past len.
      const { view, len } = encoded(p, 2);
      const music = 2 + countOffsets({ voices: 4, buses: 2, metered: 1, events: 3, music: 1 })[4]!;
      view.setUint16(music, 2, true);
      expect(codeOf(() => decodeKeyframe(view, 2, len))).toBe("badLength");
      expect(codeOf(() => checkKeyframe(view, 2, len))).toBe("badLength");
      // Intact sections with two zero bytes after them inside len: bytes left over.
      view.setUint16(music, 1, true);
      expect(codeOf(() => checkKeyframe(view, 2, len))).toBe("ok");
      expect(codeOf(() => checkKeyframe(view, 2, len + 2))).toBe("badLength");
    });

    it("the reader's open refuses a file holding a bad keyframe", async () => {
      const { bytes } = encoded(p);
      const bad = bytes.slice(0, bytes.byteLength - 1);
      const records: CaptureRecordInit[] = [{ type: RecordType.KEYFRAME, epoch: 0, seq: 1, frame: 0, payload: bad }];
      await expect(openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, records))).rejects.toMatchObject({ code: "badLength" });
    });
  });

  describe("value refusals (badValue)", () => {
    const base = keyframe({ voices: 1, buses: 1, metered: 1, events: 1, music: 1 });
    const offs = countOffsets({ voices: 1, buses: 1, metered: 1, events: 1, music: 1 });
    const cases: [string, (v: DataView) => void][] = [
      ["voice state 6", (v) => v.setUint8(offs[0]! + 2 + 9, 6)],
      ["voice gain NaN", (v) => v.setFloat32(offs[0]! + 2 + 12, NaN, true)],
      ["bus flag bit 6", (v) => v.setUint16(offs[1]! + 2 + 4, 1 << 6, true)],
      ["bus lane 9 NaN", (v) => v.setFloat32(offs[1]! + 2 + 8 + 36, NaN, true)],
      ["bus duck NaN", (v) => v.setFloat32(offs[1]! + 2 + 48, NaN, true)],
      ["bus automation NaN", (v) => v.setFloat32(offs[1]! + 2 + 52, NaN, true)],
      ["metered flag bit 4", (v) => v.setUint16(offs[2]! + 2 + 2, 1 << 4, true)],
      ["metered elapsed NaN", (v) => v.setFloat32(offs[2]! + 2 + 28, NaN, true)],
      ["music pendingTimeSec NaN", (v) => v.setFloat32(offs[4]! + 2 + 20, NaN, true)],
      ["mix masterVolume NaN", (v) => v.setFloat32(offs[5]! + 2 + 12, NaN, true)],
    ];
    for (const [name, corrupt] of cases) {
      it(name, () => {
        const { view, len } = encoded(base);
        corrupt(view);
        expect(codeOf(() => decodeKeyframe(view, 0, len))).toBe("badValue");
      });
    }

    it("every voice state 0..5 and every known flag bit is accepted; ±Infinity readings decode as written", () => {
      const p = keyframe({ voices: 6, buses: 1, metered: 1, events: 0, music: 0 });
      p.buses[0]!.flags = 0x3f;
      p.metered[0]!.flags = 0xf;
      p.metered[0]!.momentary = Number.NEGATIVE_INFINITY;
      p.metered[0]!.maxTruePeak = Number.POSITIVE_INFINITY;
      const { view, len } = encoded(p);
      expect(decodeKeyframe(view, 0, len)).toEqual(p);
    });
  });
});

describe("NAMES codec (§5.3)", () => {
  const roundTrip = (table: number, id: number, name: string) => {
    const len = namesBytes({ name });
    const view = new DataView(new ArrayBuffer(len));
    expect(encodeNames(view, 0, { table, id, name })).toBe(len);
    return decodeNames(view, 0, len);
  };

  it("round-trips every table, including non-ASCII names", () => {
    const names = ["jump.ogg", "Musique d'ambiance", "爆発", "Ñandú → ✓", "snapshot 🎚️", "Konsole Ü"];
    NAME_TABLES.forEach((_, t) => {
      expect(roundTrip(t, 0xfffffff0 + t, names[t]!)).toEqual({ table: t, id: 0xfffffff0 + t, name: names[t]! });
    });
  });

  it(`a name of exactly ${CAPTURE_NAME_MAX_BYTES} B (multi-byte) is accepted; one byte over is refused (textTooLong)`, () => {
    const exact = "é".repeat(CAPTURE_NAME_MAX_BYTES / 2);
    expect(new TextEncoder().encode(exact).byteLength).toBe(CAPTURE_NAME_MAX_BYTES);
    expect(roundTrip(1, 7, exact).name).toBe(exact);
    const over = `${exact}a`;
    const len = namesBytes({ name: over });
    const view = new DataView(new ArrayBuffer(len));
    encodeNames(view, 0, { table: 1, id: 7, name: over });
    expect(codeOf(() => decodeNames(view, 0, len))).toBe("textTooLong");
  });

  it("a file's NAMES records land in the reader's tables, for every table", async () => {
    const records: CaptureRecordInit[] = NAME_TABLES.map((_, t) => ({ type: RecordType.NAMES, epoch: 0, seq: t + 1, frame: 0, payload: { table: t, id: 1000 + t, name: `名前 ${t}` } }));
    const c = await openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, records));
    NAME_TABLES.forEach((t, i) => expect(c.names[t].get(1000 + i)).toBe(`名前 ${i}`));
  });
});
