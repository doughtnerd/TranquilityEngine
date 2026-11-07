// Importing files dropped from the OS (ADR 0085): name collisions, folders, sidecars, text assets.
import { beforeEach, describe, expect, it } from "vitest";
import { Input } from "../engine";
import { filesOfPaths, importFiles, numberedName, planImport, whyNotImportable, type IncomingFile } from "./assetImportFiles";
import { joinPath, openFolderProject, type EditorProject } from "./projects";
import { currentProject } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));
const bytes = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text = "x"): IncomingFile => ({ path, read: async () => bytes(text) });

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

describe("numberedName", () => {
  it("numbers before the extension", () => {
    expect(numberedName("a.png", 0)).toBe("a.png");
    expect(numberedName("a.png", 1)).toBe("a (1).png");
    expect(numberedName("x.scene.json", 2)).toBe("x (2).scene.json");
  });
});

describe("planImport", () => {
  it("numbers taken names, folders as a whole, and sidecars with their file", () => {
    const taken = new Set(["images/a.png", "images/sprites", "images/a (1).png"]);
    const plan = planImport((p) => taken.has(p), "images", ["a.png", "a.png.meta.json", "sprites/b.png", "c.png"]);
    expect(plan.get("a.png")).toBe("images/a (2).png");
    expect(plan.get("a.png.meta.json")).toBe("images/a (2).png.meta.json");
    expect(plan.get("sprites/b.png")).toBe("images/sprites (1)/b.png");
    expect(plan.get("c.png")).toBe("images/c.png");
  });
});

describe("importFiles", () => {
  it("copies files into the folder without overwriting", async () => {
    const existing = project.files.find((f) => f.startsWith("images/") && f.endsWith(".png"))!;
    const name = existing.split("/").pop()!;
    const before = onDisk(existing);
    const result = await importFiles(project, "images", [file(name, "new")]);
    expect(result.imported).toEqual([`images/${numberedName(name, 1)}`]);
    expect(onDisk(existing)).toBe(before);
    expect(project.files).toContain(`images/${numberedName(name, 1)}`);
  });

  it("creates the folders of a dropped folder and reads text assets as text", async () => {
    const result = await importFiles(project, "", [file("ui/menu.ui.xml", "<Canvas/>"), file("ui/menu.ui.css", "a{}")]);
    expect(result.failed).toEqual([]);
    expect(project.folders).toContain("ui");
    expect(project.textOf("ui/menu.ui.xml")).toBe("<Canvas/>");
  });

  it("keeps a sidecar beside its renamed file", async () => {
    await importFiles(project, "", [file("a.png"), file("a.png.meta.json", '{"format":"myco.import@1"}')]);
    const again = await importFiles(project, "", [file("a.png"), file("a.png.meta.json", '{"format":"myco.import@1"}')]);
    expect(again.imported.sort()).toEqual(["a (1).png", "a (1).png.meta.json"]);
  });

  it("refuses a read-only project", () => {
    expect(whyNotImportable(null)).toMatch(/no project/);
  });
});

describe("filesOfPaths", () => {
  it("walks folders on the file system", async () => {
    fs.files.set(joinPath(ROOT, "pack/a.png"), bytes("1"));
    fs.files.set(joinPath(ROOT, "pack/sub/b.png"), bytes("2"));
    const files = await filesOfPaths(fs, [joinPath(ROOT, "pack")]);
    expect(files.map((f) => f.path).sort()).toEqual(["pack/a.png", "pack/sub/b.png"]);
    expect(new TextDecoder().decode(await files[0].read())).toMatch(/[12]/);
  });
});
