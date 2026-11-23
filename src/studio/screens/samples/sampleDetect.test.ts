// Detection wired into the Samples screen (ADR 0342, the owner's "use the tempo and root note detection UI"): the
// import's "Detect what's missing" is on by default and fills only what the file lacks; Detect on a sample commits the
// detected tempo or root as one undoable step with `source: "detected"`; at import a "set" value is never overwritten.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import type { SampleDetection } from "../../../engine/audio/sample/detect/detect";
import type { WavMetadata } from "../../../engine/audio/sample/wavChunks";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { kindOn, kindsFound, sampleBlockFor } from "./importPlan";
import { detectInto } from "./sampleDetect";
import { detectedEdit } from "./sampleDetectModel";
import { sampleSession } from "./sampleSession";

const found: SampleDetection = {
  tempo: { bpm: 128, confidence: 0.9, candidates: [{ bpm: 64, confidence: 0.6, relation: "half" }, { bpm: 256, confidence: 0.3, relation: "double" }], map: [] },
  root: { note: "A3", midi: 57, cents: -12, hz: 216.5, confidence: 0.95 },
};
const weak: SampleDetection = {
  tempo: { bpm: 97, confidence: 0.1, candidates: [], map: [] },
  root: { note: "C2", midi: 36, cents: 3, hz: 65.5, confidence: 0.2 },
};

const meta = (extra: Partial<WavMetadata> = {}): WavMetadata => ({
  sampleRate: 1000, frames: 3000, channels: 1, bext: null, tempo: null, root: null, cues: [], regions: [], loops: [], ...extra,
});

describe("the import's Detect what's missing", () => {
  it("is offered for files without tempo or root and is on unless turned off", () => {
    expect(kindOn({}, "detect")).toBe(true);
    expect(kindOn({ detect: false }, "detect")).toBe(false);
    expect(kindsFound([{ rel: "a.wav", meta: meta() }, { rel: "b.ogg", meta: null }]).find((k) => k.kind.id === "detect")?.files).toBe(2);
  });

  it("fills a missing tempo and root as detected, keeps what the file says, and skips weak results", () => {
    const fromFile = sampleBlockFor(meta({ root: { midiNote: 48, cents: 0 } }), {}, found)!;
    expect(fromFile.root).toEqual({ note: "C3", cents: 0, source: "file" });
    expect(fromFile.tempo).toEqual({ bpm: 128, meter: "4/4", map: [], source: "detected" });
    expect(sampleBlockFor(meta(), {}, weak)).toBeNull();
    expect(sampleBlockFor(meta(), { detect: false }, found)).toBeNull();
    expect(sampleBlockFor(null, {}, found)?.root).toEqual({ note: "A3", cents: -12, source: "detected" });
  });

  it("never overwrites a set value, and replaces a detected one", () => {
    const set = { ...defaultSampleEdits(), tempo: { bpm: 90, meter: "3/4", map: [], source: "set" as const }, root: { note: "D4", cents: 0, source: "set" as const } };
    expect(detectedEdit(set, found, ["tempo", "root"], "import")).toEqual({ refused: "the tempo and root note are already set" });
    const detected = { ...set, tempo: { ...set.tempo, source: "detected" as const } };
    const r = detectedEdit(detected, found, ["tempo", "root"], "import");
    expect("next" in r && r.next.tempo).toEqual({ bpm: 128, meter: "3/4", map: [], source: "detected" });
    expect("next" in r && r.next.root?.source).toBe("set");
  });

  it("on demand replaces any value, but refuses a result too weak to use", () => {
    const set = { ...defaultSampleEdits(), root: { note: "D4", cents: 0, source: "set" as const } };
    const r = detectedEdit(set, found, ["root"], "demand");
    expect(r).toEqual({ next: { ...set, root: { note: "A3", cents: -12, source: "detected" } }, label: "Detect root note" });
    expect(detectedEdit(set, weak, ["tempo"], "demand")).toEqual({ refused: "no clear tempo was found (confidence 10 %)" });
  });
});

describe("Detect on an open sample", () => {
  let project: EditorProject;
  beforeEach(async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "audio/loop.wav"), new Uint8Array(44));
    project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
  });
  afterEach(() => {
    currentProject.value = null;
    status.value = null;
  });

  it("analyses the audio and commits the tempo as one undoable step", async () => {
    const rate = 22050;
    const pcm = new Float32Array(rate * 12);
    for (let t = 0.05; t < 12; t += 0.5) for (let i = 0; i < 200; i++) pcm[Math.round(t * rate) + i] = Math.exp(-i / 40) * Math.sin(i);
    const session = sampleSession(project, "audio/loop.wav");
    const out = await detectInto(session, { pcm, channels: 1, rate }, "tempo");
    expect(out.applied).toBe(true);
    expect(session.edits.value.tempo?.source).toBe("detected");
    expect(Math.abs(session.edits.value.tempo!.bpm - 120)).toBeLessThan(0.5);
    session.undo();
    expect(session.edits.value.tempo).toBeNull();
  });
});
