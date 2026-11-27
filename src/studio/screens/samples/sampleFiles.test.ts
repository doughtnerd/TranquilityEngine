// The Samples panel's file actions (`sampleFiles`, ADR 0433) where they differ from the library's: deleting a sample
// (owner decision 2) writes its pending edit first, so Undo brings the sample, its sidecar and that edit back; the open
// sample follows a rename and closes on a delete; and Save (owner decision 3) writes a pending edit at once. Driven as
// the panel drives them, over an in-memory project, with the toast's Undo as the person presses it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sidecarPath } from "../../../engine/scene/importSettings";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { createRouter } from "../../shell/route";
import { provideStudio, studioRouter, toasts } from "../../shell/studioServices";
import type { StudioAudioRuntime } from "../../runtime/studioAudioHost";
import { sampleFiles } from "./sampleFiles";
import { sampleSession } from "./sampleSession";
import { openSample, openSamplePath } from "./samplesState";

const WAV = "audio/door.wav";
const SIDE = sidecarPath(WAV);
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

let fs: MemoryFileSystem;
let project: EditorProject;
// One router for the file: the screen's computed signals keep the router they first read.
let hash = "#/samples";
provideStudio({ router: createRouter({ get: () => hash, set: (h) => void (hash = h), listen: () => () => {} }), runtime: {} as StudioAudioRuntime });
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));
const sidecarText = () => onDisk(SIDE) as string;
/** Press the newest toast's Undo (what it does finishes later: wait for it). */
function undoLast(): void {
  expect(toasts.undo(toasts.toasts.peek().at(-1)!.id)).toBe(true);
}

beforeEach(async () => {
  openSample(null);
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, WAV), AUDIO);
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  const s = sampleSession(project, WAV);
  s.commit({ next: { ...s.edits.peek(), markers: [{ id: "m1", type: "note", name: "Slam", at: 0.5, file: null }] }, label: "Add Slam" });
  await s.flush();
});

afterEach(() => {
  for (const t of toasts.toasts.peek()) toasts.dismiss(t.id);
  currentProject.value = null;
  status.value = null;
});

describe("deleting a sample", () => {
  it("moves the sample and its sidecar out of the project, and Undo puts both back with their edits", async () => {
    const before = sidecarText();
    expect(await sampleFiles.deleteFile(WAV)).toBe(true);
    expect(project.files).not.toContain(WAV);
    expect(project.files).not.toContain(SIDE);
    expect(onDisk(WAV)).toBeUndefined();
    expect(toasts.toasts.peek().at(-1)?.text).toBe("Deleted door.wav");

    undoLast();
    await vi.waitFor(() => expect(project.files).toContain(WAV));
    expect(project.files).toContain(SIDE);
    expect(onDisk(WAV)).toEqual(AUDIO);
    expect(sidecarText()).toBe(before);
    expect(sampleSession(project, WAV).edits.value.markers.map((m) => m.name)).toEqual(["Slam"]);
  });

  it("writes a pending edit before the file goes, so Undo brings it back too", async () => {
    const s = sampleSession(project, WAV);
    s.commit({ next: { ...s.edits.peek(), markers: [] }, label: "Delete Slam" }, { coalesce: true });
    expect(await sampleFiles.deleteFile(WAV)).toBe(true);
    undoLast();
    await vi.waitFor(() => expect(project.files).toContain(WAV));
    expect(sampleSession(project, WAV).edits.value.markers).toEqual([]);
  });

  it("closes the open sample, and Undo opens it again", async () => {
    openSample(WAV);
    expect(openSamplePath.value).toBe(WAV);
    await sampleFiles.deleteFile(WAV);
    expect(studioRouter().route.value.asset).toBeUndefined();
    undoLast();
    await vi.waitFor(() => expect(studioRouter().route.value.asset).toBe(WAV));
  });

  it("refuses a sample that isn't in the project", async () => {
    expect(await sampleFiles.deleteFile("audio/none.wav")).toBe(false);
    expect(status.value?.text).toBe("Can't delete none.wav: it's gone already.");
  });
});

describe("renaming a sample", () => {
  it("keeps its extension, takes its sidecar, and the open sample follows", async () => {
    openSample(WAV);
    expect(await sampleFiles.renameFile(WAV, "slam")).toBe(true);
    expect(project.files).toEqual(expect.arrayContaining(["audio/slam.wav", sidecarPath("audio/slam.wav")]));
    expect(studioRouter().route.value.asset).toBe("audio/slam.wav");
  });
});

describe("save", () => {
  it("writes a pending edit at once", async () => {
    const s = sampleSession(project, WAV);
    s.commit({ next: { ...s.edits.peek(), markers: [] }, label: "Delete Slam" }, { coalesce: true });
    expect(sidecarText()).toContain("Slam"); // a drag's edit waits for a quiet moment before it's written
    await s.flush();
    expect(sidecarText()).not.toContain("Slam");
  });
});
