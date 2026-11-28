import { describe, expect, it } from "vitest";
import { firstForwardLoop, readWavMetadata, walkWavChunks, wavSampleRate, writeWavMetadata, type WavBext } from "./wavChunks";

// --- synthetic WAV bytes, from the documented layouts --------------------------------------------------------------

const enc = (text: string) => new TextEncoder().encode(text);
const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const i16 = (n: number) => u16(n & 0xffff);
const f32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); return [...b]; };
function concat(parts: readonly (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const chunk = (id: string, body: Uint8Array | number[]) => concat([enc(id), u32(body.length), body, body.length % 2 ? [0] : []]);
const wav = (chunks: Uint8Array[]) => { const inner = concat([enc("WAVE"), ...chunks]); return concat([enc("RIFF"), u32(inner.length), inner]); };
const fmt = (rate = 48000, channels = 2) => chunk("fmt ", [...u16(1), ...u16(channels), ...u32(rate), ...u32(rate * channels * 2), ...u16(channels * 2), ...u16(16)]);
/** `data` of `frames` frames, filled with a recognisable pattern. */
const data = (frames: number, channels = 2) => chunk("data", Uint8Array.from({ length: frames * channels * 2 }, (_, i) => (i * 7) & 0xff));
const cue = (points: { id: number; frame: number }[]) => chunk("cue ", concat([u32(points.length), ...points.map((p, i) => concat([u32(p.id), u32(i), enc("data"), u32(0), u32(0), u32(p.frame)]))]));
const text = (id: string, cueId: number, t: string) => chunk(id, concat([u32(cueId), enc(t), [0]]));
const ltxt = (cueId: number, length: number, t: string) => chunk("ltxt", concat([u32(cueId), u32(length), enc("rgn "), u16(0), u16(0), u16(0), u16(0), enc(t), [0]]));
const adtl = (subs: Uint8Array[]) => chunk("LIST", concat([enc("adtl"), ...subs]));
const smpl = (unity: number, fraction: number, loops: { type?: number; start: number; end: number; count?: number }[], samplerData: number[] = []) =>
  chunk("smpl", concat([u32(0x47), u32(0x11), u32(20833), u32(unity), u32(fraction), u32(0), u32(0), u32(loops.length), u32(samplerData.length),
    ...loops.map((l, i) => concat([u32(i), u32(l.type ?? 0), u32(l.start), u32(l.end), u32(0), u32(l.count ?? 0)])), samplerData]));
const acid = (o: { flags?: number; root?: number; beats?: number; num?: number; den?: number; bpm: number }) =>
  chunk("acid", concat([u32(o.flags ?? 0), u16(o.root ?? 60), u16(0x8000), f32(0), u32(o.beats ?? 0), u16(o.den ?? 4), u16(o.num ?? 4), f32(o.bpm)]));
function bext(o: { description?: string; timeReference?: number; version?: number; loudness?: number[]; history?: string }): Uint8Array {
  const body = new Uint8Array(602);
  body.set(enc(o.description ?? ""), 0);
  body.set(enc("Myco"), 256);
  body.set(enc("2026-11-22"), 320);
  body.set(enc("10:00:00"), 330);
  const tr = o.timeReference ?? 0;
  body.set(u32(tr % 2 ** 32), 338);
  body.set(u32(Math.floor(tr / 2 ** 32)), 342);
  body.set(u16(o.version ?? 2), 346);
  (o.loudness ?? [0x7fff, 0x7fff, 0x7fff, 0x7fff, 0x7fff]).forEach((v, i) => body.set(i16(v), 412 + i * 2));
  body.set([0xee, 0xee], 422); // reserved bytes a writer must keep
  return chunk("bext", concat([body, enc(o.history ?? "")]));
}
const info = () => chunk("LIST", concat([enc("INFO"), chunk("INAM", concat([enc("Skid"), [0]]))]));

/** A file with every kind of metadata, as a sampler and a DAW would write it. */
function richFile(): Uint8Array {
  return wav([
    bext({ description: "Brake skid", timeReference: 48000 * 3600, loudness: [-1640, 720, -60, -1420, -1580], history: "A=PCM,F=48000" }),
    fmt(), info(), data(1000),
    cue([{ id: 1, frame: 100 }, { id: 2, frame: 400 }, { id: 7, frame: 600 }]),
    adtl([text("labl", 1, "Lock-up"), text("note", 1, "tyres bite"), text("labl", 2, "Release"), text("labl", 7, "Creak"), ltxt(7, 200, "the creak")]),
    smpl(60, 2 ** 31, [{ start: 100, end: 299 }, { type: 1, start: 500, end: 899, count: 3 }], [9, 9, 9, 9]),
    acid({ flags: 0x02 | 0x04, root: 48, beats: 8, num: 3, den: 4, bpm: 120 }),
  ]);
}

/** The bytes of every chunk except the ones named, in order, for comparing what a write must keep. */
function keptChunks(bytes: Uint8Array, managed: string[]): string[] {
  return walkWavChunks(bytes)!.chunks
    .filter((c) => !managed.includes(c.id) && !(c.id === "LIST" && new TextDecoder().decode(c.body.subarray(0, 4)) === "adtl"))
    .map((c) => `${c.id}:${[...c.body].join(",")}`);
}

describe("readWavMetadata", () => {
  it("reads every chunk kind", () => {
    const m = readWavMetadata(richFile());
    expect(m).toMatchObject({ sampleRate: 48000, frames: 1000, channels: 2 });
    expect(m.cues).toEqual([{ id: 1, frame: 100, label: "Lock-up", note: "tyres bite" }, { id: 2, frame: 400, label: "Release", note: "" }]);
    expect(m.regions).toEqual([{ id: 7, frame: 600, length: 200, label: "Creak", note: "", purpose: "rgn ", text: "the creak" }]);
    expect(m.loops).toEqual([
      { cueId: 0, type: 0, start: 100, end: 300, fraction: 0, playCount: 0 },
      { cueId: 1, type: 1, start: 500, end: 900, fraction: 0, playCount: 3 },
    ]);
    expect(m.root).toEqual({ midiNote: 60, cents: 50 });
    expect(m.tempo).toEqual({ bpm: 120, beats: 8, meterNumerator: 3, meterDenominator: 4, oneShot: false, rootNote: 48 });
    expect(m.bext).toMatchObject({
      description: "Brake skid", originator: "Myco", originationDate: "2026-11-22", originationTime: "10:00:00", timeReference: 172800000, version: 2, umid: "",
      loudnessValue: -16.4, loudnessRange: 7.2, maxTruePeakLevel: -0.6, maxMomentaryLoudness: -14.2, maxShortTermLoudness: -15.8, codingHistory: "A=PCM,F=48000",
    });
  });

  it("normalises a root fine tune above 50 cents to the next note", () => {
    const m = readWavMetadata(wav([fmt(), data(10), smpl(60, Math.round(0.9 * 2 ** 32), [])]));
    expect(m.root?.midiNote).toBe(61);
    expect(m.root?.cents).toBeCloseTo(-10, 1);
  });

  it("reads loudness as absent for bext version 1 and for unused values", () => {
    expect(readWavMetadata(wav([bext({ version: 1, loudness: [-1600, 0, 0, 0, 0] }), fmt(), data(1)])).bext?.loudnessValue).toBeNull();
    expect(readWavMetadata(wav([bext({}), fmt(), data(1)])).bext?.loudnessRange).toBeNull();
  });

  it("is empty for a file that isn't a WAV and never throws on garbage or truncation", () => {
    expect(readWavMetadata(enc("OggS....")).cues).toEqual([]);
    const file = richFile();
    for (let n = 0; n < file.length; n += 37) expect(() => readWavMetadata(file.subarray(0, n))).not.toThrow();
    for (let seed = 1; seed < 50; seed++) {
      const junk = Uint8Array.from({ length: 200 }, (_, i) => (i * seed * 31 + seed) & 0xff);
      junk.set(enc("RIFF"), 0);
      junk.set(enc("WAVE"), 8);
      expect(() => readWavMetadata(junk)).not.toThrow();
    }
  });

  it("counts the frames of a data chunk cut short", () => {
    const whole = wav([fmt(48000, 1), data(100, 1)]);
    expect(readWavMetadata(whole.subarray(0, whole.length - 50)).frames).toBe(75);
  });
});

describe("writeWavMetadata", () => {
  it("keeps the file identical when nothing is edited", () => {
    const file = richFile();
    expect(writeWavMetadata(file, {})).toEqual(file);
  });

  it("rewrites what it reads into an equal file", () => {
    const file = richFile();
    const m = readWavMetadata(file);
    const out = writeWavMetadata(file, { cues: m.cues, regions: m.regions, loops: m.loops, root: m.root, tempo: m.tempo, bext: m.bext });
    expect(readWavMetadata(out)).toEqual(m);
    expect(keptChunks(out, ["cue ", "smpl", "acid", "bext"])).toEqual(keptChunks(file, ["cue ", "smpl", "acid", "bext"]));
  });

  it("replaces cues and regions and keeps every other chunk byte for byte", () => {
    const file = richFile();
    const out = writeWavMetadata(file, {
      cues: [{ id: 0, frame: 50, label: "Start", note: "" }, { id: 2, frame: 450, label: "Release", note: "later" }],
      regions: [{ id: 2, frame: 700, length: 100, label: "Tail", note: "", purpose: "", text: "" }],
    });
    const m = readWavMetadata(out);
    expect(m.cues).toEqual([{ id: 1, frame: 50, label: "Start", note: "" }, { id: 2, frame: 450, label: "Release", note: "later" }]);
    expect(m.regions).toEqual([{ id: 3, frame: 700, length: 100, label: "Tail", note: "", purpose: "rgn ", text: "" }]);
    // The other groups are untouched.
    expect(m.loops).toEqual(readWavMetadata(file).loops);
    expect(m.bext).toEqual(readWavMetadata(file).bext);
    expect(keptChunks(out, ["cue "])).toEqual(keptChunks(file, ["cue "]));
    // The RIFF size is right.
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it("puts replaced chunks where the old ones were", () => {
    const order = (b: Uint8Array) => walkWavChunks(b)!.chunks.map((c) => c.id);
    const file = richFile();
    expect(order(writeWavMetadata(file, { tempo: { bpm: 90, beats: 4, meterNumerator: 4, meterDenominator: 4, oneShot: true, rootNote: null } }))).toEqual(order(file));
  });

  it("removes a group given null or empty lists", () => {
    const file = richFile();
    const out = writeWavMetadata(file, { cues: [], regions: [], loops: [], root: null, tempo: null, bext: null });
    expect(walkWavChunks(out)!.chunks.map((c) => c.id)).toEqual(["fmt ", "LIST", "data"]);
    expect(readWavMetadata(out)).toMatchObject({ cues: [], regions: [], loops: [], root: null, tempo: null, bext: null, frames: 1000 });
  });

  it("adds chunks to a bare file: bext before fmt, the rest after the data", () => {
    const file = wav([fmt(44100, 1), data(64, 1)]);
    const bx: WavBext = {
      description: "Door", originator: "Myco", originatorReference: "", originationDate: "2026-11-22", originationTime: "12:00:00",
      timeReference: 44100 * 3600 * 25, version: 1, umid: "", loudnessValue: -23, loudnessRange: null, maxTruePeakLevel: -1, maxMomentaryLoudness: null,
      maxShortTermLoudness: null, codingHistory: "",
    };
    const out = writeWavMetadata(file, {
      cues: [{ id: 1, frame: 10, label: "Latch", note: "" }],
      loops: [{ cueId: 0, type: 2, start: 8, end: 40, fraction: 0, playCount: 0 }],
      root: { midiNote: 48, cents: -20 },
      tempo: { bpm: 96.5, beats: 0, meterNumerator: 0, meterDenominator: 0, oneShot: false, rootNote: null },
      bext: bx,
    });
    expect(walkWavChunks(out)!.chunks.map((c) => c.id)).toEqual(["bext", "fmt ", "data", "cue ", "LIST", "smpl", "acid"]);
    const m = readWavMetadata(out);
    expect(m.cues).toEqual([{ id: 1, frame: 10, label: "Latch", note: "" }]);
    expect(m.loops).toEqual([{ cueId: 0, type: 2, start: 8, end: 40, fraction: 0, playCount: 0 }]);
    expect(m.root?.midiNote).toBe(48);
    expect(m.root?.cents).toBeCloseTo(-20, 1);
    expect(m.tempo?.bpm).toBeCloseTo(96.5, 4);
    // Loudness forces version 2; the timecode origin survives past 32 bits.
    expect(m.bext).toEqual({ ...bx, version: 2 });
    // The audio is untouched.
    const audio = (b: Uint8Array) => [...walkWavChunks(b)!.chunks.find((c) => c.id === "data")!.body];
    expect(audio(out)).toEqual(audio(file));
  });

  it("keeps smpl's header fields and sampler data, acid's other flags and bext's reserved bytes", () => {
    const file = richFile();
    const out = writeWavMetadata(file, {
      loops: [{ cueId: 0, type: 0, start: 10, end: 20, fraction: 0, playCount: 0 }],
      tempo: { ...readWavMetadata(file).tempo!, bpm: 100 },
      bext: { ...readWavMetadata(file).bext!, description: "Renamed" },
    });
    const body = (b: Uint8Array, id: string) => walkWavChunks(b)!.chunks.find((c) => c.id === id)!.body;
    const s = body(out, "smpl");
    expect([...s.subarray(0, 8)]).toEqual([0x47, 0, 0, 0, 0x11, 0, 0, 0]);
    expect([...s.subarray(s.length - 4)]).toEqual([9, 9, 9, 9]);
    expect(body(out, "acid")[0] & 0x04).toBe(0x04);
    expect([...body(out, "bext").subarray(422, 424)]).toEqual([0xee, 0xee]);
    expect(readWavMetadata(out).bext?.description).toBe("Renamed");
  });

  it("keeps a chunk that runs past the end of the file last", () => {
    const whole = wav([fmt(), data(100)]);
    const cut = whole.subarray(0, whole.length - 40);
    const out = writeWavMetadata(cut, { cues: [{ id: 1, frame: 5, label: "", note: "" }] });
    expect(walkWavChunks(out)!.chunks.map((c) => c.id)).toEqual(["fmt ", "cue "]);
    expect(walkWavChunks(out)!.overrun?.id).toBe("data");
    expect([...out.subarray(out.length - 20)]).toEqual([...cut.subarray(cut.length - 20)]);
  });

  it("pads odd chunks and returns non-WAV input unchanged", () => {
    const file = wav([fmt(), chunk("junk", [1, 2, 3]), data(2)]);
    const out = writeWavMetadata(file, { cues: [{ id: 1, frame: 1, label: "odd", note: "" }] });
    expect(walkWavChunks(out)!.chunks.map((c) => c.id)).toEqual(["fmt ", "junk", "data", "cue ", "LIST"]);
    expect(readWavMetadata(out).cues[0].label).toBe("odd");
    const ogg = enc("OggS not a wav");
    expect(writeWavMetadata(ogg, { tempo: null })).toEqual(ogg);
  });
});

describe("ADR 0463: the sample rate and the loop a clip plays", () => {
  it("wavSampleRate reads a whole fmt chunk of at least 14 bytes, as readWavMetadata does", () => {
    const rate = (f: Uint8Array) => wavSampleRate(walkWavChunks(f)!);
    expect(rate(wav([fmt(22050), data(4)]))).toBe(22050);
    // A 10-byte fmt (format, channels, rate, then cut short) states no usable rate.
    const short = wav([chunk("fmt ", [...u16(1), ...u16(1), ...u32(44100), ...u16(0)]), data(4)]);
    expect(rate(short)).toBeNull();
    expect(readWavMetadata(short).sampleRate).toBeNull();
    // A fmt chunk that runs past the end of the file is not read.
    const cut = wav([fmt(44100)]);
    expect(rate(cut.subarray(0, cut.length - 4))).toBeNull();
    expect(rate(wav([fmt(0), data(4)]))).toBeNull();
  });

  it("firstForwardLoop picks the first type-0 loop in record order; the metadata keeps every loop", () => {
    const f = wav([fmt(), data(1000), smpl(60, 0, [{ type: 1, start: 100, end: 199 }, { type: 0, start: 300, end: 400 }])]);
    const loops = readWavMetadata(f).loops;
    expect(loops.map((l) => [l.type, l.start, l.end])).toEqual([[1, 100, 200], [0, 300, 401]]);
    expect(firstForwardLoop(loops)).toMatchObject({ type: 0, start: 300, end: 401 });
    expect(firstForwardLoop(loops.filter((l) => l.type !== 0))).toBeNull();
    expect(firstForwardLoop([])).toBeNull();
  });
});
