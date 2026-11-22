// ADR 0328: what a sample path plays, through `resolveSample` with a reader over an in-memory project.
import { describe, expect, it } from "vitest";
import { derivedSampleToJson, forkSample, parseSampleEdits } from "./format";
import { resolveSample, type SampleReader } from "./resolve";
import type { SampleEdits } from "./types";

const block = (raw: Record<string, unknown>): SampleEdits => parseSampleEdits(raw, "test", []);

/** A reader over `files` (path → JSON value; audio files as strings, sidecars as `<file>.meta.json` objects). */
function reader(files: Record<string, unknown>): SampleReader {
  return {
    has: (p) => p in files,
    json: (p) => files[p],
    sidecar: (p) => {
      const side = files[`${p}.meta.json`] as { sample?: Record<string, unknown>; loopStart?: number; loopEnd?: number } | undefined;
      return { sample: side?.sample ? block(side.sample) : null, loopStart: side?.loopStart ?? null, loopEnd: side?.loopEnd ?? null };
    },
  };
}

const derived = (source: string, extra: Record<string, unknown> = {}) => ({ format: "myco.sample@1", source, range: null, lineage: { kind: "duplicate", parent: source, mode: "pin" }, ...extra });
const LOOP = { id: "l1", start: 0.5, end: 1.5 };

describe("resolveSample (ADR 0328)", () => {
  it("an audio file plays itself with its sidecar block (null without one)", () => {
    const files = { "a.wav": "data:", "a.wav.meta.json": { sample: { trim: [0.1, 2] } }, "b.wav": "data:" };
    expect(resolveSample("a.wav", reader(files))).toMatchObject({ source: "a.wav", derived: false, edits: { trim: [0.1, 2] }, problems: [] });
    expect(resolveSample("b.wav", reader(files)).edits).toBeNull();
  });

  it("a duplicate plays its source with its own block, whatever the parent holds", () => {
    const files = {
      "a.wav": "data:", "a.wav.meta.json": { sample: { kind: "loop", loops: [LOOP] } },
      "a.dup.sample.json": derived("a.wav", { lineage: { kind: "duplicate", parent: "a.wav", mode: "follow" }, sample: { trim: [0.2, 1.8] } }),
    };
    const r = resolveSample("a.dup.sample.json", reader(files));
    expect(r).toMatchObject({ source: "a.wav", derived: true, problems: [] });
    expect(r.edits?.trim).toEqual([0.2, 1.8]);
    expect(r.edits?.loops).toEqual([]);
  });

  it("a pinned fork plays its own frozen block", () => {
    const parent = block({ kind: "loop", loops: [LOOP] });
    const fork = forkSample("a.wav", "a.wav", parent, "pin");
    const files = { "a.wav": "data:", "a.wav.meta.json": { sample: { kind: "loop", loops: [{ ...LOOP, end: 1.9 }] } }, "f.sample.json": derivedSampleToJson(fork) };
    expect(resolveSample("f.sample.json", reader(files)).edits?.loops[0]?.end).toBe(1.5);
  });

  it("a following fork reads the fields it didn't change from its parent's sidecar, live", () => {
    const parent = block({ kind: "loop", loops: [LOOP], normalize: { mode: "peak", target: -1, gainDb: 2 } });
    const fork = forkSample("a.wav", "a.wav", parent, "follow");
    fork.sample = { ...fork.sample, normalize: { mode: "peak", target: -3, gainDb: 0 } }; // the fork's own change
    const files: Record<string, unknown> = { "a.wav": "data:", "a.wav.meta.json": { sample: { kind: "loop", loops: [LOOP], normalize: { mode: "peak", target: -1, gainDb: 2 } } }, "f.sample.json": derivedSampleToJson(fork) };
    let r = resolveSample("f.sample.json", reader(files));
    expect([r.edits?.loops[0]?.end, r.edits?.normalize.target]).toEqual([1.5, -3]);
    // The parent's loop moves: the fork follows; its own normalize stays.
    files["a.wav.meta.json"] = { sample: { kind: "loop", loops: [{ ...LOOP, end: 1.9 }], normalize: { mode: "peak", target: -6, gainDb: 5 } } };
    r = resolveSample("f.sample.json", reader(files));
    expect([r.edits?.loops[0]?.end, r.edits?.normalize.target]).toEqual([1.9, -3]);
  });

  it("a following fork of a following fork resolves through both parents", () => {
    const base = block({ kind: "loop", loops: [LOOP] });
    const f1 = forkSample("a.wav", "a.wav", base, "follow");
    const f2 = forkSample("f1.sample.json", "a.wav", base, "follow");
    const files = { "a.wav": "data:", "a.wav.meta.json": { sample: { kind: "loop", loops: [{ ...LOOP, start: 0.25 }] } }, "f1.sample.json": derivedSampleToJson(f1), "f2.sample.json": derivedSampleToJson(f2) };
    expect(resolveSample("f2.sample.json", reader(files)).edits?.loops[0]?.start).toBe(0.25);
  });

  it("a snippet's range is its trim, narrowed by the block's own trim where they overlap", () => {
    const snip = (range: [number, number], sample: Record<string, unknown> = {}) => derived("a.wav", { range, lineage: { kind: "snippet", parent: "a.wav", mode: "pin" }, sample });
    const files = {
      "a.wav": "data:",
      "s1.sample.json": snip([0.8, 1.6]),
      "s2.sample.json": snip([0.8, 1.6], { trim: [1, 2] }),
      "s3.sample.json": snip([0.8, 1.6], { trim: [2, 3] }),
    };
    expect(resolveSample("s1.sample.json", reader(files)).edits?.trim).toEqual([0.8, 1.6]);
    expect(resolveSample("s2.sample.json", reader(files)).edits?.trim).toEqual([1, 1.6]);
    expect(resolveSample("s3.sample.json", reader(files)).edits?.trim).toEqual([0.8, 1.6]);
  });

  it("a source that is a derived sample is followed to its audio file", () => {
    const files = { "a.wav": "data:", "x.sample.json": derived("a.wav"), "y.sample.json": derived("x.sample.json"), "z.sample.json": derived("y.sample.json", { sample: { trim: [0, 1] } }) };
    const r = resolveSample("z.sample.json", reader(files));
    expect([r.source, r.edits?.trim, r.problems]).toEqual(["a.wav", [0, 1], []]);
  });

  it("a source cycle plays nothing, with a problem naming the chain", () => {
    const files = { "x.sample.json": derived("y.sample.json"), "y.sample.json": derived("x.sample.json") };
    const r = resolveSample("x.sample.json", reader(files));
    expect(r.source).toBe("");
    expect(r.problems.join("\n")).toMatch(/x\.sample\.json → y\.sample\.json → x\.sample\.json comes back to itself/);
  });

  it("a lineage cycle plays the derived sample's own block, with a problem", () => {
    const base = block({ trim: [0, 1] });
    const x = forkSample("y.sample.json", "a.wav", base, "follow");
    const y = forkSample("x.sample.json", "a.wav", base, "follow");
    x.sample = { ...x.sample, trim: [0.1, 0.9] };
    const files = { "a.wav": "data:", "x.sample.json": derivedSampleToJson(x), "y.sample.json": derivedSampleToJson(y) };
    const r = resolveSample("x.sample.json", reader(files));
    expect(r.source).toBe("a.wav");
    expect(r.edits?.trim).toEqual([0.1, 0.9]);
    expect(r.problems.join("\n")).toMatch(/lineage .* comes back to itself/);
  });

  it("a missing derived sample, a missing source and a broken file each say so, naming the file", () => {
    const files = { "m.sample.json": derived("gone.wav"), "bad.sample.json": 42 };
    expect(resolveSample("none.sample.json", reader(files))).toMatchObject({ source: "", edits: null });
    expect(resolveSample("none.sample.json", reader(files)).problems[0]).toMatch(/none\.sample\.json: the derived sample isn't in the project/);
    expect(resolveSample("m.sample.json", reader(files)).problems[0]).toMatch(/m\.sample\.json: its source "gone\.wav" isn't in the project/);
    const bad = resolveSample("bad.sample.json", reader(files));
    expect(bad.source).toBe("");
    expect(bad.problems.join("\n")).toMatch(/bad\.sample\.json/);
  });
});
