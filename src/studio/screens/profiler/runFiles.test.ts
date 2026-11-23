// The Takes and Captures trees' files (spec §2.16, §4.5.2; the prototype's file systems): which folders the trees show,
// empty ones included; each row's meta (duration, and the folders while searching); where moves send files and folders
// (a take's notes go with it); and delete through the project's trash, with Undo bringing the files back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { captureTree, durationText, isCapturePath, isTakePath, rowMeta, runTreeFolders } from "./captureTree";
import { moveIntoPlan, movedTo } from "./runFileActions";
import { restoreFiles, trashFiles } from "./runFileTrash";
import { takeDeletion } from "../take/takeFiles";

describe("the trees' folders", () => {
  const files = ["project.json", "scenes/main.scene.json", "audio/boom.wav", "takes/HoverBike/run.mycotake", "captures/a.mycap", "Mixes/old.playlist.json"];
  const folders = ["scenes", "scripts", ".myco", "audio", "takes", "takes/HoverBike", "takes/Empty", "captures", "Mixes", "New Folder"];

  it("Takes shows the folders holding takes and empty folders, not the game's or the samples'", () => {
    expect(runTreeFolders(folders, files, isTakePath)).toEqual(["takes", "takes/HoverBike", "takes/Empty", "New Folder"]);
    expect(runTreeFolders(folders, files, isCapturePath)).toEqual(["takes", "takes/HoverBike", "takes/Empty", "captures", "New Folder"]);
  });

  it("an empty folder is a tree node, so a file can be moved into it", () => {
    const tree = captureTree(["takes/HoverBike/run.mycotake"], ["takes", "takes/HoverBike", "takes/Empty"]);
    expect(tree).toEqual([
      { kind: "folder", path: "takes", name: "takes", children: [
        { kind: "folder", path: "takes/Empty", name: "Empty", children: [] },
        { kind: "folder", path: "takes/HoverBike", name: "HoverBike", children: [{ kind: "file", path: "takes/HoverBike/run.mycotake", name: "run.mycotake", take: true }] },
      ] },
    ]);
  });
});

describe("row meta", () => {
  it("is the duration, in seconds under a minute", () => {
    expect(durationText(32)).toBe("32.0 s");
    expect(durationText(65)).toBe("1:05");
    expect(rowMeta("takes/a.mycotake", 19, false)).toBe("19.0 s");
    expect(rowMeta("takes/a.mycotake", null, false)).toBe("");
  });

  it("names the folders while searching", () => {
    expect(rowMeta("HoverBike/Canyon/run.mycotake", 41, true)).toBe("HoverBike › Canyon · 41.0 s");
    expect(rowMeta("run.mycotake", null, true)).toBe("Top level");
  });
});

describe("moves", () => {
  const kind = { companions: takeDeletion };
  const files = ["takes/a.mycotake", "takes/a.mycotake.notes.json", "takes/b.mycotake", "takes/Boss/c.mycotake"];
  const folders = ["takes", "takes/Boss"];

  it("a take moves with its notes; a folder moves whole; nothing moves into where it is or into itself", () => {
    expect(moveIntoPlan(kind, files, folders, ["takes/a.mycotake"], "takes/Boss")).toEqual([
      ["takes/a.mycotake", "takes/Boss/a.mycotake"],
      ["takes/a.mycotake.notes.json", "takes/Boss/a.mycotake.notes.json"],
    ]);
    expect(moveIntoPlan(kind, files, folders, ["takes/Boss"], "")).toEqual([["takes/Boss", "Boss"]]);
    expect(moveIntoPlan(kind, files, folders, ["takes/b.mycotake"], "takes")).toEqual([]);
    expect(moveIntoPlan(kind, files, folders, ["takes"], "takes/Boss")).toEqual([]);
  });

  it("the open file follows a move of its folder", () => {
    expect(movedTo("takes/Boss/c.mycotake", [["takes/Boss", "Boss"]])).toBe("Boss/c.mycotake");
    expect(movedTo("takes/a.mycotake", [["takes/a.mycotake", "x/a.mycotake"]])).toBe("x/a.mycotake");
    expect(movedTo("takes/b.mycotake", [["takes/Boss", "Boss"]])).toBe("takes/b.mycotake");
  });
});

describe("delete through the trash", () => {
  let fs: MemoryFileSystem;
  let project: EditorProject;
  const TAKE = "takes/run.mycotake";
  const NOTES = "takes/run.mycotake.notes.json";
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
    expect(await restoreFiles(project, r.trashed)).toEqual({ refused: "run.mycotake is there again" });
  });
});
