// ADR 0340 §7: Rhubarb Lip Sync output (TSV and JSON) read into a sidecar's `lipsync` block, and the edit that sets it.
import { describe, expect, it } from "vitest";
import { defaultSampleEdits, parseSampleEdits, sampleEditsToJson } from "../sample/format";
import { isLipsyncFile, parseRhubarb, parseRhubarbJson, parseRhubarbTsv, withLipsync } from "./lipsync";

// What `rhubarb -f tsv intro_01.wav` writes: one row per mouth cue, X (rest) last.
const TSV = "0.00\tX\n0.05\tB\n0.27\tE\n0.41\tE\n0.48\tF\n0.62\tX\n";

const JSON_OUT = {
  metadata: { soundFile: "intro_01.wav", duration: 0.62 },
  mouthCues: [
    { start: 0.0, end: 0.05, value: "X" },
    { start: 0.05, end: 0.27, value: "B" },
    { start: 0.27, end: 0.48, value: "E" },
    { start: 0.48, end: 0.62, value: "F" },
    { start: 0.62, end: 0.7, value: "X" },
  ],
};

const KEYS: [number, string][] = [[0, "X"], [0.05, "B"], [0.27, "E"], [0.48, "F"], [0.62, "X"]];

describe("Rhubarb TSV", () => {
  it("reads every cue as a key, dropping a repeat of the viseme before it", () => {
    const r = parseRhubarbTsv(TSV);
    expect(r.problems).toEqual([]);
    expect(r.lipsync).toEqual({ set: "rhubarb", keys: KEYS });
  });

  it("accepts a BOM, CRLF, spaces and lower case; drops bad rows and visemes with a problem each", () => {
    const r = parseRhubarbTsv("﻿0.00 x\r\n\r\nnot a row\r\n0.10\tQ\r\n0.20\tc\r\n", "intro_01.txt");
    expect(r.lipsync).toEqual({ set: "rhubarb", keys: [[0, "X"], [0.2, "C"]] });
    expect(r.problems).toEqual([
      'intro_01.txt:3: must be "<seconds>\t<viseme>"; dropped.',
      'intro_01.txt.lipsync.keys[1]: "Q" isn\'t a Rhubarb viseme (A–H, X); dropped.',
    ]);
  });

  it("gives null with a problem when nothing is left", () => {
    const r = parseRhubarbTsv("hello\n");
    expect(r.lipsync).toBeNull();
    expect(r.problems.length).toBeGreaterThan(0);
  });
});

describe("Rhubarb JSON", () => {
  it("reads mouthCues' start and value, parsed or as text", () => {
    expect(parseRhubarbJson(JSON_OUT)).toEqual({ lipsync: { set: "rhubarb", keys: KEYS }, problems: [] });
    expect(parseRhubarbJson(JSON.stringify(JSON_OUT)).lipsync).toEqual({ set: "rhubarb", keys: KEYS });
  });

  it("says what is wrong with something that isn't Rhubarb's JSON", () => {
    expect(parseRhubarbJson("{nope", "a.json")).toMatchObject({ lipsync: null, problems: [expect.stringContaining("a.json: isn't JSON")] });
    expect(parseRhubarbJson({ cues: [] }, "a.json")).toEqual({ lipsync: null, problems: ["a.json: has no mouthCues list (is it Rhubarb's JSON output?)."] });
    const r = parseRhubarbJson({ mouthCues: [{ start: 0, value: "A" }, { value: "B" }] }, "a.json");
    expect(r.lipsync?.keys).toEqual([[0, "A"]]);
    expect(r.problems).toEqual(["a.json.mouthCues[1]: must be { start, end, value }; dropped."]);
  });
});

describe("importing into the sidecar", () => {
  it("picks the format by file name and knows Rhubarb's output files", () => {
    expect(parseRhubarb(TSV, "intro_01.txt").lipsync?.keys).toEqual(KEYS);
    expect(parseRhubarb(JSON.stringify(JSON_OUT), "intro_01.JSON").lipsync?.keys).toEqual(KEYS);
    expect(["a.txt", "a.tsv", "a.json", "a.wav", "a.xml"].map(isLipsyncFile)).toEqual([true, true, true, false, false]);
  });

  it("sets the sample's lipsync block as one step (it round-trips through the sidecar), clears it, and refuses an empty file", () => {
    const e = defaultSampleEdits();
    const set = withLipsync(e, parseRhubarb(TSV, "intro_01.txt"));
    if (!("next" in set)) throw new Error(set.refused);
    expect(set.label).toBe("Import lip-sync (5 keys)");
    expect(set.next.lipsync).toEqual({ set: "rhubarb", keys: KEYS });
    expect(parseSampleEdits(sampleEditsToJson(set.next), "s", []).lipsync).toEqual(set.next.lipsync);
    const cleared = withLipsync(set.next, null);
    expect("next" in cleared && cleared.next.lipsync).toBeUndefined();
    expect(withLipsync(e, null)).toEqual({ refused: "the sample has no lip-sync data" });
    expect(withLipsync(e, parseRhubarb("", "empty.txt"))).toMatchObject({ refused: expect.any(String) });
  });
});
