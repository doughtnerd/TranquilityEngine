// Re-import mapping (ADR 0342 "Source versions"): edits kept in seconds or scaled to a new length (snapshots, tempo
// and automation with them), the tempo and root from the new file where they came from the file, and items past a
// shorter file flagged, never dropped.
import { describe, expect, it } from "vitest";
import { defaultSampleEdits } from "./format";
import { remapToNewSource } from "./remap";
import { parseSourceVersions, sourceVersionsToJson, versionFor, withVersion } from "./sourceVersions";
import type { SampleEdits } from "./types";

const edits = (): SampleEdits => ({
  ...defaultSampleEdits("sustain"),
  trim: [0.1, 1.9],
  loops: [{ id: "l1", start: 0.5, end: 1.5, direction: "forward", crossfadeMs: 20, count: 0, active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore", file: { chunk: "smpl", index: 0, start: 0.5, end: 1.5, direction: "forward", count: 0 } }],
  markers: [
    { id: "m1", type: "note", name: "Cue 1", at: 0.2, file: { chunk: "cue", id: 1, at: 0.2, name: "Cue 1" } },
    { id: "m2", type: "note", name: "Swell", at: 0.6, end: 1.8, file: null },
    { id: "m3", type: "exit", name: "Exit", at: 1.6, file: null },
  ],
  tempo: { bpm: 120, meter: "4/4", map: [{ at: 1, bpm: 140, meter: "4/4" }], source: "detected" },
  root: { note: "C3", cents: 0, source: "file" },
  cuts: [1.2], deleted: [1.2], closedGaps: [[0.8, 0.1]],
  automation: [{ id: "a1", target: "fx:f:gain", input: "clipTime", curve: [[0, -6], [2, 0, "bezier", { in: [-0.2, 0], out: [0.2, 0] }]], bypass: false }],
});

describe("remapToNewSource", () => {
  it("keeps every time in seconds and flags what a shorter file leaves past its end", () => {
    const r = remapToNewSource(edits(), 2, 1.55, "seconds");
    expect(r.edits.markers.map((m) => m.at)).toEqual([0.2, 0.6, 1.6]);
    expect(r.edits.loops[0]).toMatchObject({ start: 0.5, end: 1.5 });
    expect(r.outside).toEqual({ markers: ["m2", "m3"], loops: [], trim: true });
    expect(r.edits.markers).toHaveLength(3); // nothing dropped
  });

  it("scales every time, snapshot, tempo map and automation key to a new length, and the tempo the other way", () => {
    const r = remapToNewSource(edits(), 2, 4, "scale");
    const e = r.edits;
    expect(e.trim).toEqual([0.2, 3.8]);
    expect(e.markers.map((m) => [m.at, m.end])).toEqual([[0.4, undefined], [1.2, 3.6], [3.2, undefined]]);
    expect(e.markers[0].file).toEqual({ chunk: "cue", id: 1, at: 0.4, name: "Cue 1" });
    expect(e.loops[0]).toMatchObject({ start: 1, end: 3, file: { start: 1, end: 3 } });
    expect([e.cuts, e.deleted, e.closedGaps]).toEqual([[2.4], [2.4], [[1.6, 0.2]]]);
    expect(e.tempo).toEqual({ bpm: 60, meter: "4/4", map: [{ at: 2, bpm: 70, meter: "4/4" }], source: "detected" });
    expect(e.automation[0].curve).toEqual([[0, -6], [4, 0, "bezier", { in: [-0.4, 0], out: [0.4, 0] }]]);
    expect(r.outside).toEqual({ markers: [], loops: [], trim: false });
  });

  it("takes the new file's tempo and root where they came from the file, and keeps detected and set ones", () => {
    const fromFile = { tempo: { bpm: 98, meter: "3/4", map: [], source: "file" as const }, root: { note: "D3", cents: 5, source: "file" as const } };
    const r = remapToNewSource(edits(), 2, 2, "seconds", fromFile);
    expect(r.edits.root).toEqual(fromFile.root);
    expect(r.edits.tempo?.source).toBe("detected");
    const fileTempo = { ...edits(), tempo: { bpm: 120, meter: "4/4", map: [], source: "file" as const } };
    expect(remapToNewSource(fileTempo, 2, 2, "seconds", fromFile).edits.tempo).toEqual(fromFile.tempo);
    expect(remapToNewSource(fileTempo, 2, 2, "seconds", { tempo: null, root: null }).edits.tempo?.bpm).toBe(120);
  });
});

describe("source versions list", () => {
  it("reads leniently, finds the original for no sourceVersion, and adds versions", () => {
    const s = parseSourceVersions({ current: 2, versions: [{ n: 2, file: "v2.wav", kind: "reimport", name: "new.wav", at: "x", length: 1.5 }, { n: 1, file: "v1.wav", kind: "original", name: "a.wav" }, { n: 0, file: "bad" }, "junk"] });
    expect(s.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(s.current).toBe(2);
    expect(versionFor(s, undefined)?.n).toBe(1);
    expect(versionFor(s, 2)?.name).toBe("new.wav");
    expect(versionFor(s, 7)).toBeNull();
    expect(parseSourceVersions(sourceVersionsToJson(s))).toEqual(s);
    expect(withVersion(s, { n: 3, file: "v3.wav", kind: "reimport", name: "c.wav", at: "", length: null }).current).toBe(3);
    expect(parseSourceVersions(null)).toEqual({ current: 0, versions: [] });
  });
});
