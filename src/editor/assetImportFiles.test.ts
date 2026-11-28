// Importing files dropped from the OS (ADR 0085): name collisions, folders, sidecars, text assets.
import { beforeEach, describe, expect, it } from "vitest";
import { Input } from "../engine";
import { filesOfPaths, importFiles, type IncomingFile } from "./assetImportFiles";
import { numberedName } from "./freePath";
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
    const result = await importFiles(project, "", [file("ui/Menu.svelte", "<div></div>"), file("ui/theme.css", "a{}")]);
    expect(result.failed).toEqual([]);
    expect(project.folders).toContain("ui");
    expect(project.textOf("ui/Menu.svelte")).toBe("<div></div>");
  });

  it("keeps a sidecar beside its renamed file", async () => {
    await importFiles(project, "", [file("a.png"), file("a.png.meta.json", '{"format":"myco.import@1"}')]);
    const again = await importFiles(project, "", [file("a.png"), file("a.png.meta.json", '{"format":"myco.import@1"}')]);
    expect(again.imported.sort()).toEqual(["a (1).png", "a (1).png.meta.json"]);
  });

  it("numbers taken names, folders as a whole, and sidecars with their file", async () => {
    await importFiles(project, "images", [file("a.png"), file("a (1).png"), file("sprites/x.png")]);
    const result = await importFiles(project, "images", [file("a.png"), file("a.png.meta.json", '{"format":"myco.import@1"}'), file("sprites/b.png"), file("c.png")]);
    expect(result.imported.sort()).toEqual(["images/a (2).png", "images/a (2).png.meta.json", "images/c.png", "images/sprites (1)/b.png"]);
  });
});

describe("importFiles never overwrites", () => {
  it("treats a name that differs only in case as taken", async () => {
    await importFiles(project, "", [file("Hero.png", "old")]);
    const result = await importFiles(project, "", [file("hero.png", "new"), file("HERO.PNG.meta.json", "{}")]);
    expect(result.imported).toEqual(["hero (1).png", "HERO.PNG.meta.json"]);
    expect(new TextDecoder().decode(onDisk("Hero.png") as Uint8Array)).toBe("old");
  });

  it("gives same-named dropped files and folders names of their own", async () => {
    const result = await importFiles(project, "", [file("a.png", "1"), file("a.png", "2"), file("A.PNG", "3"), file("pack/x.png", "4"), file("pack/y.png", "5"), file("pack/x.png", "6")]);
    expect(result.imported).toEqual(["a (1).png", "a (2).png", "A.PNG", "pack/x.png", "pack/y.png", "pack (1)/x.png"]);
    const text = (p: string) => new TextDecoder().decode(onDisk(p) as Uint8Array);
    expect(["a (1).png", "a (2).png", "A.PNG", "pack/x.png", "pack (1)/x.png"].map(text)).toEqual(["1", "2", "3", "4", "6"]);
  });

  it("checks the disk too, for files added since the project was read", async () => {
    fs.files.set(joinPath(ROOT, "late.png"), bytes("outside"));
    const result = await importFiles(project, "", [file("late.png", "new")]);
    expect(result.imported).toEqual(["late (1).png"]);
    expect(new TextDecoder().decode(onDisk("late.png") as Uint8Array)).toBe("outside");
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
