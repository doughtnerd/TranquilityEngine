// Flatten (ADR 0328): the render is written beside the source, `sample.source` points at it as one step of the
// sidecar's asset document, undo and Unflatten clear it; the audition's render path follows the runtime's rule.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEffect } from "../../../engine/audio/effects/catalogue";
import { readWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { hasRenderableEdits } from "../../../engine/audio/sample/sampleRender";
import { RENDER_CACHE_DIR } from "../../../engine/audio/sample/renderCache";
import { flatPathFor, flattenSample, renderPathOf, unflattenSample } from "./sampleFlatten";
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
/** How many times Flatten decoded the source (a cache hit decodes nothing). */
let decodes = 0;
const src = { bytes: wav(), pcm: async () => (decodes++, pcm) };
const cacheFiles = () => [...fs.files.keys()].filter((k) => k.startsWith(joinPath(ROOT, RENDER_CACHE_DIR)));

beforeEach(async () => {
  decodes = 0;
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
    const r = await flattenSample(session, src);
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

    // Re-flatten takes the next free name, from the render cache; Unflatten is a step of its own.
    expect(cacheFiles()).toHaveLength(1);
    const again = await flattenSample(session, src);
    expect("path" in again && again.path).toBe("audio/brake_skid.flat2.wav");
    expect("hit" in again && again.hit).toBe(true);
    expect(decodes).toBe(1);
    expect(unflattenSample(session)).toBe(true);
    expect(session.edits.value.source).toBeUndefined();
    session.undo();
    expect(session.edits.value.source).toBe("audio/brake_skid.flat2.wav");
    expect(unflattenSample(sampleSession(project, WAV))).toBe(true);
    expect(unflattenSample(sampleSession(project, WAV))).toBe(false);
  });

  it("Re-flatten of unchanged edits changes nothing; a changed automation lane renders again and the render follows it", async () => {
    const session = sampleSession(project, WAV);
    const gain = { ...defaultEffect("gain", "fx1"), params: { gain: 0 } };
    const lane = (db: number) => ({ id: "a1", target: "fx:fx1:gain" as const, input: "clipTime" as const, curve: [[0, db], [1, db]] as [number, number][], bypass: false });
    session.commit({ next: { ...session.edits.peek(), effects: [gain], automation: [lane(-6)] }, label: "Automate gain" });
    const first = await flattenSample(session, src);
    expect(first).toMatchObject({ path: "audio/brake_skid.flat1.wav", hit: false, unchanged: false });
    const level = (path: string) => new DataView((fs.files.get(joinPath(ROOT, path)) as Uint8Array).buffer).getFloat32(58, true);
    expect(level("audio/brake_skid.flat1.wav")).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 4);

    const same = await flattenSample(session, src);
    expect(same).toEqual({ path: "audio/brake_skid.flat1.wav", hit: true, unchanged: true, warnings: [] });
    expect(project.files).not.toContain("audio/brake_skid.flat2.wav");
    expect(decodes).toBe(1);

    session.commit({ next: { ...session.edits.peek(), automation: [lane(-12)] }, label: "Edit automation" });
    const moved = await flattenSample(session, src);
    expect(moved).toMatchObject({ path: "audio/brake_skid.flat2.wav", hit: false, unchanged: false });
    expect(level("audio/brake_skid.flat2.wav")).toBeCloseTo(0.5 * Math.pow(10, -12 / 20), 4);
    expect(cacheFiles()).toHaveLength(2);
  });

  it("refuses when nothing would be baked", async () => {
    const session = sampleSession(project, "audio/other.wav");
    expect(await flattenSample(session, src)).toEqual({ refused: "nothing to flatten: the sample plays its source as it is" });
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
