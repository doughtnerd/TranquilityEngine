import { beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import type { DirEntry, FileSystem } from "../engine/platform/FileSystem";
import { SetField } from "./document";
import { confirmDiscard } from "./dialogs";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile, saveOpenScene } from "./project";
import { editorSettings, joinPath, listAssetFiles, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";

/** An in-memory FileSystem with Windows-style paths, like Tauri's on Windows. */
class MemoryFileSystem implements FileSystem {
  readonly canWrite = true;
  readonly files = new Map<string, string | Uint8Array>();
  readonly writes: string[] = [];
  private key = (p: string) => p.replace(/\//g, "\\");
  async readText(p: string) {
    const v = this.files.get(this.key(p));
    if (typeof v !== "string") throw new Error(`no text file ${p}`);
    return v;
  }
  async writeText(p: string, text: string) {
    this.writes.push(this.key(p));
    this.files.set(this.key(p), text);
  }
  async readBinary(p: string) {
    const v = this.files.get(this.key(p));
    if (!(v instanceof Uint8Array)) throw new Error(`no binary file ${p}`);
    return v;
  }
  async writeBinary(p: string, data: Uint8Array) {
    this.files.set(this.key(p), data);
  }
  async list(dir: string): Promise<DirEntry[]> {
    const prefix = this.key(dir).replace(/\\$/, "") + "\\";
    const names = new Map<string, boolean>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length).split("\\");
      names.set(rest[0], rest.length > 1 || names.get(rest[0]) === true);
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async exists(p: string) {
    return this.files.has(this.key(p));
  }
  async mkdir() {}
  async remove(p: string) {
    this.files.delete(this.key(p));
  }
  async pickFolder() {
    return null;
  }
}

const ROOT = "C:\\Games\\flappy";
const raw = import.meta.glob("../demo/flappy/**/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

function demoFolder(): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  for (const [key, text] of Object.entries(raw)) fs.files.set(joinPath(ROOT, key.slice("../demo/flappy/".length)), text);
  for (const img of ["PipeDown.png", "PipeUp.png", "background.png", "flappyBird.png", "flower.jpg", "ground.jpg", "moderncraft.png"]) {
    fs.files.set(joinPath(ROOT, `images/${img}`), new Uint8Array([137, 80, 78, 71]));
  }
  for (const mp3 of ["foo.mp3", "town.mp3"]) fs.files.set(joinPath(ROOT, `music/${mp3}`), new Uint8Array([1, 2, 3]));
  fs.files.set(joinPath(ROOT, "behaviors/Bird.ts"), "// not an asset");
  fs.files.set(joinPath(ROOT, "node_modules/pkg/package.json"), "{}");
  fs.files.set(joinPath(ROOT, ".git/config.json"), "{}");
  return fs;
}

describe("project folders (ADR 0026)", () => {
  it("joins paths with the folder's separator", () => {
    expect(joinPath("C:\\Games\\flappy", "scenes/main.scene.json")).toBe("C:\\Games\\flappy\\scenes\\main.scene.json");
    expect(joinPath("/home/me/flappy/", "scenes/main.scene.json")).toBe("/home/me/flappy/scenes/main.scene.json");
  });

  it("lists asset files, skipping scripts, hidden folders and node_modules", async () => {
    const files = await listAssetFiles(demoFolder(), ROOT);
    expect(files).toContain("scenes/main.scene.json");
    expect(files).toContain("images/flappyBird.png");
    expect(files.some((f) => f.endsWith(".ts") || f.startsWith("node_modules") || f.startsWith(".git"))).toBe(false);
  });

  it("refuses a folder without project.json", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set("C:\\Elsewhere\\notes.json", "{}");
    await expect(openFolderProject(fs, "C:\\Elsewhere")).rejects.toThrow(/no project.json/);
  });

  it("opens the demo folder with its settings, scenes and main scene", async () => {
    const project = await openFolderProject(demoFolder(), ROOT);
    expect(project.name).toBe("flappy");
    expect(project.canSave).toBe(true);
    expect(project.mainScene).toBe("scenes/main.scene.json");
    expect(project.settings.render?.sortingLayers).toContain("Pipes");
    expect(typeof project.assets.get("images/flappyBird.png")).toBe("string"); // an object URL
  });
});

describe("saving (ADR 0026)", () => {
  let fs: MemoryFileSystem;
  let project: EditorProject;

  beforeEach(async () => {
    Input.reset();
    fs = demoFolder();
    project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, project.mainScene!);
  });

  it("writes only the edited line, marks the scene saved and serves the new data", async () => {
    const path = joinPath(ROOT, "scenes/main.scene.json");
    const before = (fs.files.get(path) as string).replace(/\r\n/g, "\n");
    const { stack } = openScene.value!;
    stack.execute(new SetField("ceiling", "engine.Transform", "position", [0, 12, 0]));
    expect(stack.dirty).toBe(true);

    await saveOpenScene();
    expect(fs.writes).toEqual([path]);
    const after = fs.files.get(path) as string;
    const changed = after.split("\n").filter((line, i) => line !== before.split("\n")[i]);
    expect(changed).toEqual(['        { "type": "engine.Transform", "data": { "position": [0, 12, 0] } },']);
    expect(stack.dirty).toBe(false);
    expect(project.textOf("scenes/main.scene.json")).toBe(after);
    expect((project.assets.get("scenes/main.scene.json") as { nodes: { id: string }[] }).nodes.length).toBeGreaterThan(0);
  });

  it("saves a second time from the new text (layout kept across saves)", async () => {
    const { stack } = openScene.value!;
    stack.execute(new SetField("ceiling", "engine.Transform", "position", [0, 12, 0]));
    await saveOpenScene();
    stack.execute(new SetField("ceiling", "engine.Transform", "position", [0, 11, 0]));
    await saveOpenScene();
    const text = (fs.files.get(joinPath(ROOT, "scenes/main.scene.json")) as string).replace(/\r\n/g, "\n");
    expect(text).toBe(Object.entries(raw).find(([k]) => k.endsWith("main.scene.json"))![1].replace(/\r\n/g, "\n"));
  });

  it("keeps CRLF line endings", async () => {
    const path = joinPath(ROOT, "scenes/main.scene.json");
    const crlf = (fs.files.get(path) as string).replace(/\r?\n/g, "\r\n");
    fs.files.set(path, crlf);
    project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    openScene.value!.stack.execute(new SetField("ceiling", "engine.Transform", "position", [0, 12, 0]));
    await saveOpenScene();
    const after = fs.files.get(path) as string;
    expect(after.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("asks before discarding unsaved changes", async () => {
    expect(await confirmDiscard()).toBe(true); // nothing to lose
    openScene.value!.stack.execute(new SetField("ceiling", "engine.Transform", "position", [0, 12, 0]));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    expect(await confirmDiscard()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to scenes/main.scene.json?");
    vi.unstubAllGlobals();
  });
});
