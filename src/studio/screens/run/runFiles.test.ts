// The Takes and Captures trees' files (spec §2.16, §4.5.2; the prototype's file systems): which folders the trees show,
// empty ones included, and each row's meta (duration, and the folders while searching). Their file actions are the
// Studio asset library's (`library/studioLibrary.test.ts`, ADR 0445).
import { describe, expect, it } from "vitest";
import { captureTree, durationText, isCaptureFile, isTakePath, rowMeta, runMoveFolders, runTreeFolders, whyNotCaptureFile } from "./captureTree";

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

