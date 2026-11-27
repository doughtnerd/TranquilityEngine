// The Code panel's buffers (ADR 0308), through their own interface, without Monaco: tabs, unsaved text, moves,
// deletes, the unsaved list the discard guard reads, and the buffer as a file owner for project-wide edits.
import { beforeEach, describe, expect, it } from "vitest";
import { layout, resetLayout } from "../layout/store";
import { instancesOf } from "../layout/model";
import { joinPath, openFolderProject, type EditorProject } from "../projects";
import { currentProject } from "../state";
import { MemoryFileSystem, ROOT, useBuiltinPanels, useCoreAssetKinds } from "../testing";
import {
  activeScript,
  bufferText,
  closeAllScripts,
  closeScript,
  codeBufferOwner,
  codeBuffersDeleted,
  codeBuffersMoved,
  codeFilePath,
  codeFileText,
  codeFileUri,
  codeFiles,
  dirtyScripts,
  editBuffer,
  openScript,
  openScripts,
  saveBuffer,
  showScript,
  unsavedWithin,
  whyBuffersCantFollow,
} from "./codeBuffers";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)
useBuiltinPanels(); // and the built-in panels, the Code panel among them (ADR 0182)

let fs: MemoryFileSystem;
let project: EditorProject;
const LEVEL = `{ "sprite": "asset:images/bird.png", "speed": 4 }\n`;

beforeEach(async () => {
  closeAllScripts();
  resetLayout();
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), JSON.stringify({ name: "Buffers" }));
  fs.files.set(joinPath(ROOT, "scripts/a.ts"), "export const a = 1;\n");
  fs.files.set(joinPath(ROOT, "scripts/b.ts"), "export const b = 2;\n");
  fs.files.set(joinPath(ROOT, "data/level.json"), LEVEL);
  fs.files.set(joinPath(ROOT, "data/main.scene.json"), `{ "format": "myco.scene@1", "nodes": [] }`);
  fs.files.set(joinPath(ROOT, "images/bird.png"), new Uint8Array([137, 80, 78, 71]));
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

describe("Code panel tabs", () => {
  it("open once each, bring the Code panel forward, and close to the neighbouring tab", () => {
    openScript("scripts/a.ts");
    openScript("scripts/b.ts");
    openScript("scripts/a.ts");
    expect(openScripts.value).toEqual(["scripts/a.ts", "scripts/b.ts"]);
    expect(activeScript.value).toBe("scripts/a.ts");
    const [code] = instancesOf(layout.value, "code");
    const group = layout.value.docks.flatMap((d) => d.groups).find((g) => g.panels.includes(code!))!;
    expect(group.active).toBe(code);

    showScript("scripts/b.ts");
    expect(activeScript.value).toBe("scripts/b.ts");
    showScript("scripts/a.ts");
    closeScript("scripts/a.ts");
    expect(activeScript.value).toBe("scripts/b.ts");
    closeScript("scripts/b.ts");
    expect(activeScript.value).toBeNull();
  });

});

describe("which files the buffers hold", () => {
  it("scripts and text files, never scenes or prefabs, with one rule for the list and for one file", () => {
    expect([...codeFiles(project).keys()].sort()).toEqual(["data/level.json", "input/default.input.json", "project.json", "scripts/a.ts", "scripts/b.ts"]);
    expect(codeFileText(project, "data/level.json")).toBe(LEVEL);
    expect(codeFileText(project, "data/main.scene.json")).toBeUndefined();
    expect(codeFileText(project, "images/bird.png")).toBeUndefined();
  });

  it("name their models in one URI scheme, and read a model's path back from it", () => {
    expect(codeFileUri("scripts/a.ts")).toBe("file:///project/scripts/a.ts");
    expect(codeFilePath({ scheme: "file", path: "/project/scripts/a b.ts" })).toBe("scripts/a b.ts");
    expect(codeFilePath({ scheme: "file", path: "/node_modules/myco/index.d.ts" })).toBeNull();
    expect(codeFilePath({ scheme: "inmemory", path: "/project/a.ts" })).toBeNull();
    expect(codeFilePath(null)).toBeNull();
  });
});

describe("unsaved text", () => {
  it("is held while it differs from the file on disk, and is the buffer's text", () => {
    openScript("scripts/a.ts");
    editBuffer("scripts/a.ts", "export const a = 10;\n");
    expect(dirtyScripts.value).toEqual(new Set(["scripts/a.ts"]));
    expect(bufferText("scripts/a.ts")).toBe("export const a = 10;\n");
    editBuffer("scripts/a.ts", "export const a = 1;\n"); // typed back to what's on disk
    expect(dirtyScripts.value.size).toBe(0);
    expect(bufferText("scripts/a.ts")).toBe("export const a = 1;\n");
  });

  it("goes when its tab closes, and with every tab when the project changes", () => {
    openScript("scripts/a.ts");
    openScript("scripts/b.ts");
    editBuffer("scripts/a.ts", "changed");
    closeScript("scripts/a.ts");
    expect(dirtyScripts.value.size).toBe(0);
    expect(bufferText("scripts/a.ts")).toBe("export const a = 1;\n");
    editBuffer("scripts/b.ts", "changed");
    closeAllScripts();
    expect(openScripts.value).toEqual([]);
    expect(dirtyScripts.value.size).toBe(0);
  });

  it("is written by a save and then matches the disk; typing during the write stays unsaved", async () => {
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "speed": 5 }\n`);
    await saveBuffer("data/level.json", async (path, text) => {
      editBuffer(path, `{ "speed": 6 }\n`); // typed while the write was in flight
      await project.writeFile(path, text);
    });
    expect(fs.files.get(joinPath(ROOT, "data/level.json"))).toBe(`{ "speed": 5 }\n`);
    expect(bufferText("data/level.json")).toBe(`{ "speed": 6 }\n`);
    expect(dirtyScripts.value.has("data/level.json")).toBe(true);
    await saveBuffer("data/level.json", (path, text) => project.writeFile(path, text));
    expect(dirtyScripts.value.size).toBe(0);
  });
});

describe("moves and deletes", () => {
  it("tabs, the tab showing and unsaved text follow a moved file or folder", () => {
    openScript("scripts/a.ts");
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "speed": 9 }\n`);
    codeBuffersMoved([["data", "levels"]]);
    expect(openScripts.value).toEqual(["scripts/a.ts", "levels/level.json"]);
    expect(activeScript.value).toBe("levels/level.json");
    expect(dirtyScripts.value).toEqual(new Set(["levels/level.json"]));
    expect(bufferText("levels/level.json")).toBe(`{ "speed": 9 }\n`);
    codeBuffersMoved([["scripts/a.ts", "scripts/c.ts"]]);
    expect(openScripts.value).toEqual(["scripts/c.ts", "levels/level.json"]);
  });

  it("say which deleted files hold unsaved text, and close their tabs", () => {
    openScript("scripts/a.ts");
    openScript("data/level.json");
    editBuffer("data/level.json", "{}");
    expect(unsavedWithin(["data"])).toEqual(["data/level.json"]);
    expect(unsavedWithin(["scripts/a.ts"])).toEqual([]);
    codeBuffersDeleted(["data"]);
    expect(openScripts.value).toEqual(["scripts/a.ts"]);
    expect(dirtyScripts.value.size).toBe(0);
  });
});

describe("the buffer as a file's owner (ADR 0302)", () => {
  it("only a buffer with unsaved text owns its file", () => {
    openScript("data/level.json");
    expect(codeBufferOwner(project, "data/level.json")).toBeNull();
    editBuffer("data/level.json", `{ "sprite": "asset:images/bird.png", "speed": 5 }`);
    expect(codeBufferOwner(project, "data/level.json")?.text).toContain('"speed": 5');
  });

  it("rewrites the unsaved text with the change, keeping it unsaved, so a save keeps the new reference", () => {
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "sprite": "asset:images/bird.png", "speed": 5 }`);
    const owner = codeBufferOwner(project, "data/level.json")!;
    expect(owner.follow((json) => ({ ...(json as object), sprite: "asset:images/crow.png" }))).toBe(true);
    expect(JSON.parse(bufferText("data/level.json")!)).toEqual({ sprite: "asset:images/crow.png", speed: 5 });
    expect(dirtyScripts.value.has("data/level.json")).toBe(true);
    expect(owner.follow(() => null)).toBe(false); // no change
  });

  it("can't rewrite unsaved text that isn't valid JSON, and a move it would need is refused with the reason", () => {
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "sprite": "asset:images/bird.png", `);
    expect(codeBufferOwner(project, "data/level.json")!.follow(() => ({}))).toBe(false);
    expect(whyBuffersCantFollow(["images/bird.png"])).toMatch(/data\/level\.json has unsaved changes in the Code panel that aren't valid JSON/);
    expect(whyBuffersCantFollow(["images/other.png"])).toBeNull();
  });
});
