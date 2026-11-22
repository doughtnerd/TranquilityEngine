// Flatten (ADR 0328): the render is written beside the source, `sample.source` points at it as one step of the
// sidecar's asset document, undo and Unflatten clear it; the audition's render path follows the runtime's rule.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEffect } from "../../../engine/audio/effects/catalogue";
import { readWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { flatPathFor, flattenSample, hasRenderableEdits, renderPathOf, unflattenSample } from "./sampleFlatten";
import { sampleSession } from "./sampleSession";

const RATE = 48000;
const WAV = "audio/brake_skid.wav";
let fs: MemoryFileSystem;
let project: EditorProject;

/** A tiny 16-bit mono WAV (its bytes only stand in for the file; the render takes `pcm`). */
function wav(): Uint8Array {
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  [..."RIFF"].forEach((c, i) => (b[i] = c.charCodeAt(0)));
  v.setUint32(4, 36, true);
  [..."WAVEfmt "].forEach((c, i) => (b[8 + i] = c.charCodeAt(0)));
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  [..."data"].forEach((c, i) => (b[36 + i] = c.charCodeAt(0)));
  return b;
}
const pcm = { pcm: new Float32Array(RATE / 10).fill(0.5), channels: 1, rate: RATE };

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, WAV), wav());
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

afterEach(() => {
  currentProject.value = null;
  status.value = null;
});

describe("flatten", () => {
  it("writes the render beside the source, points the sample at it as one step, and undo clears it", async () => {
    const session = sampleSession(project, WAV);
    expect(session.commit({ next: { ...session.edits.peek(), effects: [{ ...defaultEffect("gain", "fx1"), params: { gain: 6 } }] }, label: "Add Gain" })).toBe(true);
    const r = await flattenSample(session, pcm);
    if ("refused" in r) throw new Error(r.refused);
    expect(r.path).toBe("audio/brake_skid.flat1.wav");
    expect(session.edits.value.source).toBe("audio/brake_skid.flat1.wav");
    expect(session.edits.value.effects).toHaveLength(1); // the chain stays (it renders again on Re-flatten)
    // The render is a float WAV of the source's length, the gain baked in.
    const bytes = fs.files.get(joinPath(ROOT, r.path)) as Uint8Array;
    expect(readWavMetadata(bytes).sampleRate).toBe(RATE);
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    expect(v.getFloat32(58, true)).toBeCloseTo(0.5 * Math.pow(10, 6 / 20), 5);
    expect(bytes.length).toBe(58 + (RATE / 10) * 4);
    expect(project.files).toContain(r.path);

    session.undo();
    expect(session.edits.value.source).toBeUndefined();
    expect(session.edits.value.effects).toHaveLength(1);
    expect(fs.files.has(joinPath(ROOT, r.path))).toBe(true); // the render file stays

    // Re-flatten takes the next free name; Unflatten is a step of its own.
    const again = await flattenSample(session, pcm);
    expect("path" in again && again.path).toBe("audio/brake_skid.flat2.wav");
    expect(unflattenSample(session)).toBe(true);
    expect(session.edits.value.source).toBeUndefined();
    session.undo();
    expect(session.edits.value.source).toBe("audio/brake_skid.flat2.wav");
    expect(unflattenSample(sampleSession(project, WAV))).toBe(true);
    expect(unflattenSample(sampleSession(project, WAV))).toBe(false);
  });

  it("refuses when nothing would be baked", async () => {
    const session = sampleSession(project, "audio/other.wav");
    expect(await flattenSample(session, pcm)).toEqual({ refused: "nothing to flatten: the sample plays its source as it is" });
    expect(hasRenderableEdits({ ...session.edits.peek(), effects: [defaultEffect("reverse", "r")] })).toBe(false);
  });

  it("names renders and finds them by project path or by name beside the source", () => {
    expect(flatPathFor(["a/x.wav", "a/x.flat1.wav"], "a/x.wav")).toBe("a/x.flat2.wav");
    expect(flatPathFor([], "x.flat3.wav")).toBe("x.flat1.wav");
    expect(renderPathOf(["a/x.flat1.wav"], "a/x.wav", { source: "a/x.flat1.wav" })).toBe("a/x.flat1.wav");
    expect(renderPathOf([], "a/x.wav", { source: "x.flat1.wav" })).toBe("a/x.flat1.wav");
    expect(renderPathOf([], "a/x.wav", {})).toBeNull();
  });
});
