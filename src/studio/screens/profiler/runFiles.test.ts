// The Takes and Captures trees' files (spec §2.16, §4.5.2; the prototype's file systems): which folders the trees show,
// empty ones included; each row's meta (duration, and the folders while searching); where moves send files and folders
// (a take's notes go with it); and delete through the project's trash, with Undo bringing the files back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { captureTree, durationText, isCaptureFile, isTakePath, rowMeta, runMoveFolders, runTreeFolders, whyNotCaptureFile } from "./captureTree";
import { moveIntoPlan, movedTo } from "./runFileActions";
import { restoreFiles, trashFiles } from "./runFileTrash";
import { takeDeletion } from "../take/takeFiles";

describe("the trees' folders", () => {
  const files = ["project.json", "scenes/main.scene.json", "audio/boom.wav", "recordings/HoverBike/run.sporesample", "recordings/a.sporesample", "Mixes/old.playlist.json"];
  const folders = ["scenes", "scripts", ".myco", "audio", "recordings", "recordings/HoverBike", "recordings/Empty", "Mixes", "New Folder"];

  it("Takes shows the folders holding recordings and empty folders, not the game's or the samples'", () => {
    expect(runTreeFolders(folders, files, isTakePath)).toEqual(["recordings", "recordings/HoverBike", "recordings/Empty", "New Folder"]);
  });

  it("Captures lists the same recordings: one folder holds takes and captures alike (ADR 0409), empty subfolders included (journeys walk 2, J10.3)", () => {
    expect(runTreeFolders(folders, files, isCaptureFile)).toEqual(["recordings", "recordings/HoverBike", "recordings/Empty", "New Folder"]);
    expect(runMoveFolders(folders, files, isCaptureFile)).toEqual(["audio", "recordings", "recordings/HoverBike", "recordings/Empty", "Mixes", "New Folder"]);
    expect(isCaptureFile("recordings/a.SPORESAMPLE")).toBe(true);
    expect(isCaptureFile("recordings/a.mycap")).toBe(false); // the old extensions aren't recognised
    expect(isCaptureFile("recordings/run.mycotake")).toBe(false);
    expect(isTakePath("recordings/run.sporesample")).toBe(true);
    expect(whyNotCaptureFile("run.sporesample")).toBeNull();
  });

  it("an empty folder is a tree node, so a file can be moved into it", () => {
    const tree = captureTree(["recordings/HoverBike/run.sporesample"], ["recordings", "recordings/HoverBike", "recordings/Empty"]);
    expect(tree).toEqual([
      { kind: "folder", path: "recordings", name: "recordings", children: [
        { kind: "folder", path: "recordings/Empty", name: "Empty", children: [] },
        { kind: "folder", path: "recordings/HoverBike", name: "HoverBike", children: [{ kind: "file", path: "recordings/HoverBike/run.sporesample", name: "run.sporesample", take: true }] },
      ] },
    ]);
  });
});

describe("row meta", () => {
  it("is the duration, in seconds under a minute", () => {
    expect(durationText(32)).toBe("32.0 s");
    expect(durationText(65)).toBe("1:05");
    expect(rowMeta("recordings/a.sporesample", 19, false)).toBe("19.0 s");
    expect(rowMeta("recordings/a.sporesample", null, false)).toBe("");
  });

  it("names the folders while searching", () => {
    expect(rowMeta("HoverBike/Canyon/run.sporesample", 41, true)).toBe("HoverBike › Canyon · 41.0 s");
    expect(rowMeta("run.sporesample", null, true)).toBe("Top level");
  });
});

describe("moves", () => {
  const kind = { companions: takeDeletion };
  const files = ["recordings/a.sporesample", "recordings/a.sporesample.notes.json", "recordings/b.sporesample", "recordings/Boss/c.sporesample"];
  const folders = ["recordings", "recordings/Boss"];

  it("a take moves with its notes; a folder moves whole; nothing moves into where it is or into itself", () => {
    expect(moveIntoPlan(kind, files, folders, ["recordings/a.sporesample"], "recordings/Boss")).toEqual([
      ["recordings/a.sporesample", "recordings/Boss/a.sporesample"],
      ["recordings/a.sporesample.notes.json", "recordings/Boss/a.sporesample.notes.json"],
    ]);
    expect(moveIntoPlan(kind, files, folders, ["recordings/Boss"], "")).toEqual([["recordings/Boss", "Boss"]]);
    expect(moveIntoPlan(kind, files, folders, ["recordings/b.sporesample"], "recordings")).toEqual([]);
    expect(moveIntoPlan(kind, files, folders, ["recordings"], "recordings/Boss")).toEqual([]);
  });

  it("the open file follows a move of its folder", () => {
    expect(movedTo("recordings/Boss/c.sporesample", [["recordings/Boss", "Boss"]])).toBe("Boss/c.sporesample");
    expect(movedTo("recordings/a.sporesample", [["recordings/a.sporesample", "x/a.sporesample"]])).toBe("x/a.sporesample");
    expect(movedTo("recordings/b.sporesample", [["recordings/Boss", "Boss"]])).toBe("recordings/b.sporesample");
  });
});

describe("delete through the trash", () => {
  let fs: MemoryFileSystem;
  let project: EditorProject;
  const TAKE = "recordings/run.sporesample";
  const NOTES = "recordings/run.sporesample.notes.json";
  const BYTES = new Uint8Array([1, 2, 3]);

  beforeEach(async () => {
    fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, TAKE), BYTES);
    fs.files.set(joinPath(ROOT, NOTES), '{"markers":[]}');
    project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
  });
  afterEach(() => {
    currentProject.value = null;
  });

  it("moves the take and its notes out of the project, and Undo puts both back", async () => {
    const r = await trashFiles(project, takeDeletion(project.files, TAKE));
    if ("refused" in r) throw new Error(r.refused);
    expect(project.files).not.toContain(TAKE);
    expect(project.files).not.toContain(NOTES);
    expect(fs.files.get(joinPath(ROOT, `.myco/trash/1/${TAKE}`))).toEqual(BYTES);
    expect(await restoreFiles(project, r.trashed)).toEqual({ restored: TAKE });
    expect(project.files).toEqual(expect.arrayContaining([TAKE, NOTES]));
    expect(fs.files.get(joinPath(ROOT, TAKE))).toEqual(BYTES);
  });

  it("Undo is refused when the name was taken meanwhile", async () => {
    const r = await trashFiles(project, [TAKE]);
    if ("refused" in r) throw new Error(r.refused);
    fs.files.set(joinPath(ROOT, TAKE), new Uint8Array([9]));
    await project.rereadFiles([TAKE]);
    expect(await restoreFiles(project, r.trashed)).toEqual({ refused: "run.sporesample is there again" });
  });
});
