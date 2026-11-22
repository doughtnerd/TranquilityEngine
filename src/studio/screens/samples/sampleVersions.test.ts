// Re-import and source versions (ADR 0328): the new audio replaces the file, the old and new audio are kept as
// versions, the edits are carried over as one step that names the version, the file's changed cues open the merge
// review, edits past a shorter file are flagged; undo puts the old audio back, Restore brings a version back, and
// versions move with their sample.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWavMetadata, writeWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { sampleEditsFromWav } from "../../../engine/audio/sample/wavSample";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { diskChange } from "./sampleDisk";
import { sampleSession } from "./sampleSession";
import { moveSourceVersions, readSourceVersions, reimportSample, restoreSourceVersion, syncSourceVersion } from "./sampleVersions";

const RATE = 1000;
const WAV = "audio/door.wav";

/** A 16-bit mono WAV `seconds` long (a ramp, so versions differ), with a cue point `cue` at `cueAt` seconds. */
function wav(seconds: number, cueAt: number, level = 1): Uint8Array {
  const frames = Math.round(seconds * RATE);
  const b = new Uint8Array(44 + frames * 2);
  const v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); v.setUint32(4, 36 + frames * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); ascii(36, "data"); v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) v.setInt16(44 + i * 2, Math.round(level * 1000 * (i / frames)), true);
  return writeWavMetadata(b, { cues: [{ id: 1, frame: Math.round(cueAt * RATE), label: "Creak", note: "" }], regions: [] });
}

let fs: MemoryFileSystem;
let project: EditorProject;
const v1 = wav(1, 0.2);
const disk = (path: string) => fs.files.get(joinPath(ROOT, path)) as Uint8Array;

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, WAV), v1);
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  const session = sampleSession(project, WAV);
  const fromFile = sampleEditsFromWav(readWavMetadata(v1));
  session.commit({
    next: { ...session.edits.peek(), markers: [{ ...fromFile.markers[0], id: "m1" }, { id: "m2", type: "note", name: "Slam", at: 0.9, file: null }, { id: "m3", type: "exit", name: "Exit", at: 0.95, file: null }] },
    label: "Import",
  });
});

afterEach(() => {
  currentProject.value = null;
  status.value = null;
  diskChange.value = null;
});

describe("re-import", () => {
  it("keeps the old and new audio as versions, carries the edits over as one step, and opens the merge review", async () => {
    const session = sampleSession(project, WAV);
    const v2 = wav(0.5, 0.3, 0.5);
    const r = await reimportSample(session, v2, "door_take2.wav", "seconds");
    expect(r).toEqual({ version: 2, oldLength: 1, newLength: 0.5, outside: 2, changes: 1 });
    expect(disk(WAV)).toEqual(v2);
    const versions = await readSourceVersions(project, WAV);
    expect(versions.current).toBe(2);
    expect(versions.versions.map((v) => [v.n, v.kind, v.name, v.length])).toEqual([[1, "original", "door.wav", 1], [2, "reimport", "door_take2.wav", 0.5]]);
    expect(disk(".myco/sample-versions/audio/door.wav/v1.wav")).toEqual(v1);
    // The edits: kept in seconds (the Slam note and the Exit now past the end, flagged not dropped), the version named.
    const e = session.edits.value;
    expect(e.sourceVersion).toBe(2);
    expect(e.markers.map((m) => [m.id, m.at])).toEqual([["m1", 0.2], ["m2", 0.9], ["m3", 0.95]]);
    // The file's moved cue is for the merge review (unedited: "Use file" by default).
    expect(diskChange.value?.rows.map((row) => [row.title, row.choice])).toEqual([["Moved cue", "file"]]);

    // Undo puts the old audio back; the version sync follows the undo tree.
    session.undo();
    expect(session.edits.value.sourceVersion).toBeUndefined();
    expect(await syncSourceVersion(project, WAV, session.edits.value)).toBe(1);
    expect(disk(WAV)).toEqual(v1);
    expect((await readSourceVersions(project, WAV)).current).toBe(1);
    expect(await syncSourceVersion(project, WAV, session.edits.value)).toBeNull();

    // Restore brings v2 back as a step of its own, without a new version.
    const back = await restoreSourceVersion(session, 2, "seconds");
    expect(back).toMatchObject({ version: 2 });
    expect(disk(WAV)).toEqual(v2);
    expect(session.edits.value.sourceVersion).toBe(2);
    expect((await readSourceVersions(project, WAV)).versions).toHaveLength(2);
  });

  it("scales the edits to a time-stretched file", async () => {
    const session = sampleSession(project, WAV);
    const r = await reimportSample(session, wav(2, 0.4), "door_slow.wav", "scale");
    expect(r).toMatchObject({ outside: 0, changes: 0 });
    expect(session.edits.value.markers.map((m) => m.at)).toEqual([0.4, 1.8, 1.9]);
  });

  it("refuses a file of another format", async () => {
    expect(await reimportSample(sampleSession(project, WAV), new Uint8Array(4), "door.ogg", "seconds")).toEqual({ refused: "pick a .wav file: the sample's file keeps its name and format" });
    expect(disk(WAV)).toEqual(v1);
  });

  it("moves versions with their sample or folder", async () => {
    await reimportSample(sampleSession(project, WAV), wav(0.5, 0.3), "b.wav", "seconds");
    await moveSourceVersions(project, [["audio", "sfx/audio"]]);
    expect(fs.files.has(joinPath(ROOT, ".myco/sample-versions/sfx/audio/door.wav/v1.wav"))).toBe(true);
    expect(fs.files.has(joinPath(ROOT, ".myco/sample-versions/audio/door.wav/v1.wav"))).toBe(false);
  });
});
