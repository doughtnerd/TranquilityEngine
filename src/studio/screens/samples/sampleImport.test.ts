// Importing samples (ADR 0342 "Import"): every picked file is counted in the status line, and a file's own cues and
// loops don't read as "changed on disk" right after the import (the sidecar's file snapshots are on disk before the
// audio's write is announced).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWavMetadata, writeWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { runImport } from "./ImportDialog";
import { diskChange, installDiskWatch } from "./sampleDisk";

const RATE = 1000;

/** A 16-bit mono WAV one second long with a cue point and a sampler loop. */
function wav(): Uint8Array {
  const frames = RATE;
  const b = new Uint8Array(44 + frames * 2);
  const v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); v.setUint32(4, 36 + frames * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); ascii(36, "data"); v.setUint32(40, frames * 2, true);
  return writeWavMetadata(b, {
    cues: [{ id: 1, frame: 200, label: "Creak", note: "" }],
    regions: [],
    loops: [{ cueId: 0, type: 0, start: 300, end: 800, fraction: 0, playCount: 0 }],
    root: null,
  });
}

let fs: MemoryFileSystem;
let project: EditorProject;
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  // A disk slower to write text than the browser is to read a blob back (OPFS, a network drive): the order of writes shows.
  const write = fs.writeText.bind(fs);
  fs.writeText = async (path: string, text: string) => {
    await new Promise((r) => setTimeout(r, 20));
    return write(path, text);
  };
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  installDiskWatch();
});

afterEach(() => {
  currentProject.value = null;
  status.value = null;
  diskChange.value = null;
});

describe("import", () => {
  const picked = (rel: string) => {
    const bytes = wav();
    return { rel, meta: readWavMetadata(bytes), read: async () => bytes };
  };

  it("counts every imported file in the status line", async () => {
    const done = await runImport(project, [picked("a.wav"), picked("b.wav"), picked("c.wav")], { detect: false }, "sfx", true, false);
    expect(done).toEqual(["sfx/a.wav", "sfx/b.wav", "sfx/c.wav"]);
    expect(status.value).toMatchObject({ kind: "info", text: "Imported 3 samples into sfx." });
  });

  it("doesn't report the file's own cues and loops as changed on disk", async () => {
    const done = await runImport(project, [picked("door.wav")], { detect: false }, "", true, false);
    expect(done).toEqual(["door.wav"]);
    expect(project.files).toContain("door.wav.meta.json");
    await settle();
    expect(diskChange.value).toBeNull();
  });
});
