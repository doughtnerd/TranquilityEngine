import { afterEach, describe, expect, it } from "vitest";
import { Engine, GameObject, getComponentClass } from "../engine";
import { FsaFileSystem } from "./fsaFileSystem";
import { MemoryDirectoryHandle } from "./fsaMemory";
import { newMainScene, newProjectJson, scaffoldProject, whyNotProjectName } from "./newProject";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets } from "./projects";
import { TYPES_DIR } from "./scriptingSetup";
import { openScene } from "./state";
import { MemoryFileSystem } from "./testing";

const PARENT = "C:\\Games";
const ROOT = joinPath(PARENT, "My Game");
let engine: Engine | null = null;

afterEach(() => {
  openScene.value?.sync.dispose();
  openScene.value = null;
  engine?.dispose();
  engine = null;
});

describe("new projects", () => {
  it("checks the name", () => {
    expect(whyNotProjectName("My Game")).toBeNull();
    expect(whyNotProjectName("  ")).toMatch(/name/);
    expect(whyNotProjectName("a/b")).toMatch(/can't contain/);
    expect(whyNotProjectName("game.")).toMatch(/end with/);
    expect(whyNotProjectName("CON")).toMatch(/reserved/);
  });

  it("writes project.json, a main scene with a camera, scripts/ and the scripting files", async () => {
    const fs = new MemoryFileSystem();
    await scaffoldProject(fs, ROOT, { name: " My Game ", template: "2d", declarations: { "index.d.ts": "export {};" } });
    const settings = JSON.parse(fs.files.get(joinPath(ROOT, "project.json")) as string);
    expect(settings).toMatchObject({ name: "My Game", display: { width: 1280, height: 720 }, time: { fixedDeltaTime: 1 / 60, maxFrameTime: 0.25 }, autoload: [] });
    expect(fs.folders.has(joinPath(ROOT, "scripts"))).toBe(true);
    expect(fs.files.has(joinPath(ROOT, "tsconfig.json"))).toBe(true);
    expect(fs.files.get(joinPath(ROOT, `${TYPES_DIR}/index.d.ts`))).toBe("export {};");
    expect(fs.files.get(joinPath(ROOT, ".gitignore"))).toContain(".myco/");

    const project = await openFolderProject(fs, ROOT);
    expect(project.name).toBe("My Game");
    expect(project.mainScene).toBe("scenes/main.scene.json");
    expect(project.files).toEqual(["project.json", "scenes/main.scene.json", "tsconfig.json"]);
  });

  it.each(["2d", "3d"] as const)("the %s template's main scene opens in the editor with its camera", async (template) => {
    const fs = new MemoryFileSystem();
    await scaffoldProject(fs, ROOT, { name: "Game", template });
    const project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    openSceneFile(engine, project.mainScene!);
    const Camera = getComponentClass("engine.Camera") as never;
    const component = GameObject.findObjectOfType(Camera) as unknown as { projection: string; gameObject: { name: string } } | null;
    expect(component?.gameObject.name).toBe("Camera");
    expect(component?.projection).toBe(template === "2d" ? "orthographic" : "perspective");
  });

  it("refuses a folder that already has files in it, and a bad name", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "notes.txt"), "mine");
    await expect(scaffoldProject(fs, ROOT, { name: "My Game", template: "2d" })).rejects.toThrow(/isn't empty/);
    expect(fs.files.has(joinPath(ROOT, "project.json"))).toBe(false);
    await expect(scaffoldProject(new MemoryFileSystem(), ROOT, { name: "a:b", template: "2d" })).rejects.toThrow(/can't contain/);
  });

  it("creates a project in a browser folder (File System Access)", async () => {
    const parent = new MemoryDirectoryHandle("Games");
    const fs = new FsaFileSystem(async () => parent);
    const at = await fs.pickFolder();
    expect(at).toBe("/Games");
    await scaffoldProject(fs, joinPath(at!, "Space"), { name: "Space", template: "3d" });
    expect(JSON.parse(parent.read("Space/project.json")!).name).toBe("Space");
    expect(parent.read("Space/scenes/main.scene.json")).toBe(newMainScene("3d"));
    const project = await openFolderProject(fs, "/Games/Space");
    expect(project.canSave).toBe(true);
    expect(project.mainScene).toBe("scenes/main.scene.json");
  });

  it("writes every setting out in project.json", () => {
    const json = JSON.parse(newProjectJson("X", "3d"));
    expect(Object.keys(json)).toEqual(["name", "display", "time", "physics", "render", "autoload"]);
  });
});
