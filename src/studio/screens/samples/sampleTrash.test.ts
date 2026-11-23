// Deleting a sample through the project's trash (owner decision 2) and Save (owner decision 3): the sample and its
// sidecar leave the project for `.myco/trash/<n>/`, Undo brings both back as they were (a pending edit included),
// a name taken meanwhile refuses Undo; Save writes a pending edit at once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sidecarPath } from "../../../engine/scene/importSettings";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { sampleSession } from "./sampleSession";
import { restoreSample, trashSample, TRASH_FOLDER } from "./sampleTrash";

const WAV = "audio/door.wav";
const SIDE = sidecarPath(WAV);
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));
const sidecarText = () => onDisk(SIDE) as string;

beforeEach(async () => {
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
  currentProject.value = null;
  status.value = null;
});

describe("delete through the trash", () => {
  it("moves the sample and its sidecar to the trash, and Undo puts both back", async () => {
    const before = sidecarText();
    const r = await trashSample(project, WAV);
    if ("refused" in r) throw new Error(r.refused);
    expect(project.files).not.toContain(WAV);
    expect(project.files).not.toContain(SIDE);
    expect(onDisk(WAV)).toBeUndefined();
    expect(onDisk(`${TRASH_FOLDER}/1/${WAV}`)).toEqual(AUDIO);
    expect(onDisk(`${TRASH_FOLDER}/1/${SIDE}`)).toBe(before);

    expect(await restoreSample(project, r.trashed)).toEqual({ restored: WAV });
    expect(project.files).toContain(WAV);
    expect(project.files).toContain(SIDE);
    expect(onDisk(WAV)).toEqual(AUDIO);
    expect(sidecarText()).toBe(before);
    expect(onDisk(`${TRASH_FOLDER}/1/${WAV}`)).toBeUndefined();
    expect(sampleSession(project, WAV).edits.value.markers.map((m) => m.name)).toEqual(["Slam"]);
  });

  it("writes a pending edit before the file goes, so Undo brings it back too", async () => {
    const s = sampleSession(project, WAV);
    s.commit({ next: { ...s.edits.peek(), markers: [] }, label: "Delete Slam" }, { coalesce: true });
    const r = await trashSample(project, WAV);
    if ("refused" in r) throw new Error(r.refused);
    await restoreSample(project, r.trashed);
    expect(sampleSession(project, WAV).edits.value.markers).toEqual([]);
  });

  it("refuses Undo when a file has taken the name meanwhile", async () => {
    const r = await trashSample(project, WAV);
    if ("refused" in r) throw new Error(r.refused);
    await project.writeBinary(WAV, new Uint8Array([9]));
    expect(await restoreSample(project, r.trashed)).toEqual({ refused: "door.wav is there again" });
    expect(onDisk(`${TRASH_FOLDER}/1/${WAV}`)).toEqual(AUDIO);
  });

  it("refuses a sample that isn't in the project", async () => {
    expect(await trashSample(project, "audio/none.wav")).toEqual({ refused: "it's gone already" });
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
