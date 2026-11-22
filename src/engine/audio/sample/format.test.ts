import { describe, expect, it } from "vitest";
import {
  defaultSampleEdits, derivedSampleToJson, forkSample, isDerivedSamplePath, parentChangedSincePin, parseDerivedSample, parseSampleEdits,
  resolveSampleEdits, sampleEditsFromSidecar, sampleEditsHash, sampleEditsToJson,
} from "./format";
import { midiToNoteName, noteNameToMidi } from "./noteNames";
import type { SampleEdits } from "./types";

/** The ADR 0328 example block. */
const ADR_BLOCK = {
  kind: "oneshot",
  trim: [0.02, 2.58],
  loops: [{ id: "l1", start: 0.45, end: 1.55, direction: "forward", crossfadeMs: 35, count: 0, active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore",
    file: { chunk: "smpl", index: 0, start: 0.45, end: 1.55, direction: "forward", count: 0 } }],
  markers: [{ id: "m1", type: "cue", name: "brake_lockup", at: 0.3, note: "Game spawns tyre smoke", file: null }],
  tempo: { bpm: 120, meter: "4/4", map: [], source: "file" },
  root: { note: "C3", cents: 0, source: "file" },
  normalize: { mode: "loudness", target: -16, gainDb: 3.5 },
  effects: [{ id: "fx1", type: "fades", on: true, params: { out: 80 } }], frozen: false,
  cuts: [1.2], deleted: [1.2], closedGaps: [[0.8, 0.4]],
  stinger: false, snapToZero: true,
};

const parse = (raw: unknown) => {
  const problems: string[] = [];
  return { edits: parseSampleEdits(raw, "sample", problems), problems };
};

describe("parseSampleEdits", () => {
  it("reads the ADR 0328 example without problems", () => {
    const { edits, problems } = parse(ADR_BLOCK);
    expect(problems).toEqual([]);
    expect(edits.loops[0]).toMatchObject({ id: "l1", crossfadeMs: 35, active: "held", file: { chunk: "smpl", index: 0 } });
    expect(edits.markers[0]).toMatchObject({ id: "m1", type: "cue", name: "brake_lockup", note: "Game spawns tyre smoke", file: null });
    expect(edits.effects[0].params).toEqual({ in: 0, out: 80 });
    expect(edits.closedGaps).toEqual([[0.8, 0.4]]);
  });

  it("fills defaults for an empty block", () => {
    expect(parse({}).edits).toEqual(defaultSampleEdits());
    expect(parse({ kind: "music" }).edits.snapToZero).toBe(false);
  });

  it("falls back to defaults for a non-object", () => {
    const { edits, problems } = parse("loops");
    expect(edits).toEqual(defaultSampleEdits());
    expect(problems).toEqual(["sample: must be an object; using the defaults."]);
  });

  it("defaults a loop's activation from its repeat count", () => {
    const { edits } = parse({ loops: [{ id: "a", start: 0, end: 1 }, { id: "b", start: 2, end: 3, count: 4 }] });
    expect(edits.loops.map((l) => l.active)).toEqual(["held", "always"]);
    expect(edits.loops[0]).toMatchObject({ direction: "forward", crossfadeMs: 20, exit: "finish", exitFadeMs: 40, reentry: "ignore", file: null });
  });

  it("sorts loops, drops overlapping ones and keeps touching ones and hold points", () => {
    const { edits, problems } = parse({ loops: [
      { id: "c", start: 3, end: 4 }, { id: "a", start: 0, end: 1 }, { id: "b", start: 1, end: 2 }, { id: "x", start: 1.5, end: 1.8 }, { id: "h", start: 2.5, end: 2.5 },
    ] });
    expect(edits.loops.map((l) => l.id)).toEqual(["a", "b", "h", "c"]);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain('loop "x" (1.5..1.8) overlaps loop "b" (1..2); dropped.');
  });

  it("widens a trim that doesn't contain every loop", () => {
    const { edits, problems } = parse({ trim: [0.5, 1], loops: [{ id: "a", start: 0.2, end: 1.4 }] });
    expect(edits.trim).toEqual([0.2, 1.4]);
    expect(problems).toEqual(["sample.trim: must contain every loop; widened to [0.2, 1.4]."]);
  });

  it("rejects a bad trim", () => {
    const { edits, problems } = parse({ trim: [2, 1] });
    expect(edits.trim).toBeNull();
    expect(problems).toHaveLength(1);
  });

  it("sorts markers and enforces the note-only fields", () => {
    const { edits, problems } = parse({ markers: [
      { id: "b", type: "exit", at: 2, end: 3, color: 2 },
      { id: "a", type: "note", at: 1, end: 1.5, color: "#ff0000" },
      { id: "c", type: "note", at: 4, end: 3, color: "red" },
    ] });
    expect(edits.markers.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(edits.markers[0]).toMatchObject({ name: "Marker", end: 1.5, color: "#ff0000" });
    expect(edits.markers[1]).toEqual({ id: "b", type: "exit", name: "Exit", at: 2, file: null });
    expect(edits.markers[2].end).toBeUndefined();
    expect(problems).toHaveLength(5);
  });

  it("makes loop and marker ids unique", () => {
    const { edits, problems } = parse({ loops: [{ start: 0, end: 1 }, { id: "l1", start: 2, end: 3 }], markers: [{ id: "m", at: 0 }, { id: "m", at: 1 }] });
    expect(edits.loops.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(edits.markers.map((m) => m.id)).toEqual(["m", "m1"]);
    expect(problems).toHaveLength(3);
  });

  it("checks tempo, root and normalisation", () => {
    const { edits, problems } = parse({
      tempo: { bpm: 1000, meter: "4-4", map: [{ at: 8, bpm: 100 }, { at: 2, bpm: 90, meter: "3/4" }] },
      root: { note: "H2" },
      normalize: { mode: "peak" },
    });
    expect(edits.tempo).toEqual({ bpm: 400, meter: "4/4", map: [{ at: 2, bpm: 90, meter: "3/4" }, { at: 8, bpm: 100, meter: "4/4" }], source: "set" });
    expect(edits.root).toBeNull();
    expect(edits.normalize).toEqual({ mode: "peak", target: -1, gainDb: 0 });
    expect(problems).toHaveLength(4);
  });

  it("sorts and dedupes cut times and drops bad gaps", () => {
    const { edits, problems } = parse({ cuts: [2, 1, 1, -1], closedGaps: [[0, 0], [1, 0.5]] });
    expect(edits.cuts).toEqual([1, 2]);
    expect(edits.closedGaps).toEqual([[1, 0.5]]);
    expect(problems).toHaveLength(3);
  });

  it("keeps sample-level effects and flags others", () => {
    const { edits, problems } = parse({ effects: [{ id: "r", type: "reverb" }, { id: "g", type: "gain", params: { gain: 6 } }] });
    expect(edits.effects.map((e) => e.type)).toEqual(["reverb", "gain"]);
    expect(problems).toHaveLength(1);
  });

  it("reads effect automation over sample time: fx targets only, clipTime input", () => {
    const { edits, problems } = parse({
      effects: [{ id: "f", type: "fades" }],
      automation: [
        { id: "a1", target: "fx:f:out", curve: [[0, 10], [2, 80]] },
        { id: "a2", target: "volume", curve: [[0, 0]] },
        { id: "a3", target: "fx:f:in", input: "voiceTime", curve: [[0, 5]], bypass: true },
        { id: "a4", target: "fx:f:in", curve: [] },
      ],
    });
    expect(edits.automation).toEqual([
      { id: "a1", target: "fx:f:out", input: "clipTime", curve: [[0, 10], [2, 80]], bypass: false },
      { id: "a3", target: "fx:f:in", input: "clipTime", curve: [[0, 5]], bypass: true },
    ]);
    expect(problems).toEqual([
      "sample.automation[1].target: must be fx:<effect id>:<parameter>; dropped.",
      'sample.automation[2].input: a sample\'s automation reads sample time; using "clipTime".',
      "sample.automation[3].curve: needs keys; dropped.",
    ]);
    expect(parse(sampleEditsToJson(edits))).toEqual({ edits, problems: [] });
  });
});

describe("sampleEditsToJson", () => {
  it("writes nothing for the defaults", () => {
    expect(sampleEditsToJson(defaultSampleEdits())).toEqual({});
    expect(sampleEditsToJson(defaultSampleEdits("music"))).toEqual({ kind: "music" });
  });

  it("round-trips: parse(write(x)) equals x", () => {
    const x = parse(ADR_BLOCK).edits;
    const json = sampleEditsToJson(x);
    expect(parse(json)).toEqual({ edits: x, problems: [] });
    expect(json.kind).toBeUndefined();
    expect(json.snapToZero).toBeUndefined();
    const y = parse({ kind: "music", snapToZero: true, normalize: { mode: "off", target: -14 }, source: "a.flat1.wav", markers: [{ id: "n", type: "note", at: 1, end: 2, color: 3, note: "x" }] }).edits;
    expect(parse(sampleEditsToJson(y)).edits).toEqual(y);
  });
});

describe("Entry markers (ADR 0336 pre-entry)", () => {
  it("read, take the default name, refuse a range, and round-trip", () => {
    const problems: string[] = [];
    const e = parseSampleEdits({ markers: [{ id: "e", type: "entry", at: 0.5 }, { id: "x", type: "exit", at: 2 }] }, "s", problems);
    expect(problems).toEqual([]);
    expect(e.markers).toEqual([{ id: "e", type: "entry", name: "Entry", at: 0.5, file: null }, { id: "x", type: "exit", name: "Exit", at: 2, file: null }]);
    expect(parseSampleEdits(sampleEditsToJson(e), "s", [])).toEqual(e);
    const ranged: string[] = [];
    expect(parseSampleEdits({ markers: [{ type: "entry", at: 0.5, end: 1 }] }, "s", ranged).markers[0].end).toBeUndefined();
    expect(ranged).toContain("s.markers[0].end: only a note can be a range; dropped.");
  });
});

describe("sampleEditsFromSidecar", () => {
  it("reads legacy loopStart/loopEnd as one loop when there is no block", () => {
    const e = sampleEditsFromSidecar({ sample: null, loopStart: 1.5, loopEnd: 7.25 });
    expect(e.loops).toHaveLength(1);
    expect(e.loops[0]).toMatchObject({ id: "l1", start: 1.5, end: 7.25, active: "always", count: 0 });
    expect(e.kind).toBe("loop");
  });

  it("prefers the block and ignores half a legacy loop", () => {
    const block = parse({ loops: [{ id: "x", start: 0, end: 1 }] }).edits;
    expect(sampleEditsFromSidecar({ sample: block, loopStart: 2, loopEnd: 3 })).toBe(block);
    expect(sampleEditsFromSidecar({ sample: null, loopStart: 2, loopEnd: null }).loops).toEqual([]);
  });
});

describe("derived samples", () => {
  const ADR_DERIVED = {
    format: "myco.sample@1", source: "audio/brake_skid.wav", range: [0.8, 1.6],
    lineage: { kind: "fork", parent: "audio/brake_skid.wav", mode: "follow", baseline: { trim: [0, 2] } },
    sample: { trim: [0, 2] },
  };

  it("parses and writes the ADR example", () => {
    const { sample, problems } = parseDerivedSample(ADR_DERIVED, "audio/skid_fork.sample.json");
    expect(problems).toEqual([]);
    expect(sample.lineage.baseline?.trim).toEqual([0, 2]);
    expect(derivedSampleToJson(sample)).toEqual(ADR_DERIVED);
    expect(parseDerivedSample(derivedSampleToJson(sample)).sample).toEqual(sample);
    expect(isDerivedSamplePath("a/B.Sample.JSON")).toBe(true);
  });

  it("is lenient about format, source, range and lineage", () => {
    const { sample, problems } = parseDerivedSample({ format: "x", range: [2, 1], lineage: { kind: "snippet" } }, "s");
    expect(sample.source).toBe("");
    expect(sample.range).toBeNull();
    expect(sample.lineage).toEqual({ kind: "snippet", parent: "", mode: "pin" });
    expect(problems).toHaveLength(4);
    expect(parseDerivedSample(null).problems[0]).toContain("must be a JSON object");
  });
});

describe("forks", () => {
  const parent = (over: Record<string, unknown>): SampleEdits => parse({ trim: [0, 2], loops: [{ id: "l1", start: 0.5, end: 1 }], ...over }).edits;

  it("a following fork reads unchanged fields live from the parent", () => {
    const fork = forkSample("audio/a.wav", "audio/a.wav", parent({}), "follow");
    expect(fork.lineage.baseline).toEqual(parent({}));
    // The fork changes its trim; the parent later changes its loops and tempo.
    fork.sample = { ...fork.sample, trim: [0.1, 1.9] };
    const now = parent({ loops: [{ id: "l1", start: 0.6, end: 1.2 }], tempo: { bpm: 100 } });
    const resolved = resolveSampleEdits(fork, now);
    expect(resolved.trim).toEqual([0.1, 1.9]);
    expect(resolved.loops).toBe(now.loops);
    expect(resolved.tempo).toBe(now.tempo);
  });

  it("a pinned fork plays its own block and knows when the parent changed", () => {
    const p = parent({});
    const fork = forkSample("audio/a.wav", "audio/a.wav", p, "pin");
    expect(fork.lineage.pinnedHash).toBe(sampleEditsHash(p));
    const changed = parent({ tempo: { bpm: 90 } });
    expect(resolveSampleEdits(fork, changed)).toBe(fork.sample);
    expect(parentChangedSincePin(fork, p)).toBe(false);
    expect(parentChangedSincePin(fork, changed)).toBe(true);
  });

  it("snippets and duplicates play their own block", () => {
    const own = parse({ trim: [1, 2] }).edits;
    const snippet = { format: "myco.sample@1" as const, source: "a.wav", range: [1, 2] as [number, number], lineage: { kind: "snippet" as const, parent: "a.wav", mode: "follow" as const, baseline: own }, sample: own };
    expect(resolveSampleEdits(snippet, parent({}))).toBe(own);
    expect(parentChangedSincePin(snippet, parent({}))).toBe(false);
  });

  it("hashes equal edits equally, whatever the key order", () => {
    const a = parse({ tempo: { bpm: 120, meter: "3/4" }, root: { note: "A4", cents: 3 } }).edits;
    const b = parse({ root: { cents: 3, note: "A4" }, tempo: { meter: "3/4", bpm: 120 } }).edits;
    expect(sampleEditsHash(a)).toBe(sampleEditsHash(b));
    expect(sampleEditsHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(sampleEditsHash(a)).not.toBe(sampleEditsHash(defaultSampleEdits()));
  });
});

describe("note names", () => {
  it("maps MIDI numbers and names both ways (MIDI 60 = C4)", () => {
    expect(midiToNoteName(60)).toBe("C4");
    expect(midiToNoteName(69)).toBe("A4");
    expect(midiToNoteName(0)).toBe("C-1");
    expect(midiToNoteName(128)).toBeNull();
    expect(noteNameToMidi("C4")).toBe(60);
    expect(noteNameToMidi("Db4")).toBe(61);
    expect(noteNameToMidi("F♯3")).toBe(54);
    expect(noteNameToMidi("H4")).toBeNull();
    expect(noteNameToMidi("Cb-1")).toBeNull();
    for (let n = 0; n < 128; n++) expect(noteNameToMidi(midiToNoteName(n)!)).toBe(n);
  });
});
