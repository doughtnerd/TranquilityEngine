import { afterEach, describe, expect, it, vi } from "vitest";
import { FsaFileSystem, ensureWritable } from "./fsaFileSystem";
import { MemoryDirectoryHandle } from "./fsaMemory";
import { openFolderProject } from "./projects";
import { projectSlots } from "./historyStore";

const folder = () =>
  new MemoryDirectoryHandle("game")
    .put("project.json", '{\n  "name": "Game"\n}\n')
    .put("scenes/main.scene.json", '{ "format": "myco.scene@1", "nodes": [] }')
    .put("scripts/Player.ts", "export {};");

async function mounted(handle = folder()) {
  const fs = new FsaFileSystem(async () => handle);
  const root = (await fs.pickFolder())!;
  return { fs, root, handle };
}

afterEach(() => vi.useRealTimers());

describe("the File System Access file system", () => {
  it("mounts a picked folder under a path, once per folder", async () => {
    const { fs, root, handle } = await mounted();
    expect(root).toBe("/game");
    expect(await fs.mount(handle)).toBe("/game");
    expect(await fs.mount(new MemoryDirectoryHandle("game"))).toBe("/game (2)");
    expect(await fs.directoryHandle("/game")).toBe(handle);
  });

  it("returns null when the picker is cancelled or missing", async () => {
    const cancel = new FsaFileSystem(async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    });
    expect(await cancel.pickFolder()).toBeNull();
    expect(await new FsaFileSystem(null).pickFolder()).toBeNull();
  });

  it("reads, writes (making folders), lists and checks files", async () => {
    const { fs, handle } = await mounted();
    expect(await fs.readText("/game/project.json")).toContain('"Game"');
    await fs.writeText("/game/prefabs/new/a.prefab.json", "{}");
    expect(handle.read("prefabs/new/a.prefab.json")).toBe("{}");
    await fs.writeBinary("/game/images/x.png", new Uint8Array([1, 2, 3]));
    expect([...(await fs.readBinary("/game/images/x.png"))]).toEqual([1, 2, 3]);
    expect((await fs.list("/game")).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "images", isDirectory: true },
      { name: "prefabs", isDirectory: true },
      { name: "project.json", isDirectory: false },
      { name: "scenes", isDirectory: true },
      { name: "scripts", isDirectory: true },
    ]);
    expect(await fs.exists("/game/scenes")).toBe(true);
    expect(await fs.exists("/game/scenes/main.scene.json")).toBe(true);
    expect(await fs.exists("/game/nope.json")).toBe(false);
    expect(await fs.exists("/game/nope/deeper.json")).toBe(false);
    expect(await fs.exists("/elsewhere/x")).toBe(false);
    await expect(fs.readText("/game/../x")).rejects.toThrow(/leaves/);
  });

  it("makes, removes and renames files and folders", async () => {
    const { fs, handle } = await mounted();
    await fs.mkdir("/game/a/b");
    expect(await fs.exists("/game/a/b")).toBe(true);
    await fs.rename("/game/scenes", "/game/levels");
    expect(handle.read("levels/main.scene.json")).toContain("myco.scene@1");
    expect(await fs.exists("/game/scenes")).toBe(false);
    await expect(fs.rename("/game/levels", "/game/project.json")).rejects.toThrow(/already exists/);
    await expect(fs.remove("/game/levels")).rejects.toThrow();
    await fs.remove("/game/levels", { recursive: true });
    expect(await fs.exists("/game/levels")).toBe(false);
    await fs.remove("/game/project.json");
    expect(handle.read("project.json")).toBeUndefined();
  });

  it("opens a project folder for editing: saves, scripts and edit history go to the folder", async () => {
    const { fs, root, handle } = await mounted();
    const project = await openFolderProject(fs, root);
    expect(project.canSave).toBe(true);
    expect(project.name).toBe("Game");
    expect([...project.scripts.keys()]).toEqual(["scripts/Player.ts"]);
    await project.writeText("project.json", '{ "name": "Renamed" }');
    expect(handle.read("project.json")).toBe('{ "name": "Renamed" }');
    expect(project.name).toBe("Renamed"); // follows project.json
    await project.writeScript("scripts/Enemy.ts", "export const e = 1;");
    expect(handle.read("scripts/Enemy.ts")).toBe("export const e = 1;");
    await project.move("scripts/Enemy.ts", "scripts/ai/Enemy.ts");
    expect(handle.read("scripts/ai/Enemy.ts")).toBe("export const e = 1;");
    const slots = projectSlots(fs, root, "scenes/main.scene.json");
    await slots.write("a", "history");
    expect(handle.read(".myco/history/scenes/main.scene.json.history.a.json")).toBe("history");
  });

  it("watches a folder by polling for changes", async () => {
    vi.useFakeTimers();
    const { fs } = await mounted();
    const seen: string[][] = [];
    const stop = await fs.watch("/game/scripts", (paths) => seen.push(paths), 100);
    await fs.writeText("/game/scripts/New.ts", "export {};");
    await vi.advanceTimersByTimeAsync(150);
    expect(seen).toEqual([["/game/scripts/New.ts"]]);
    await fs.remove("/game/scripts/Player.ts");
    await vi.advanceTimersByTimeAsync(150);
    expect(seen.at(-1)).toEqual(["/game/scripts/Player.ts"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(2); // nothing changed since
    stop();
    await fs.writeText("/game/scripts/Later.ts", "export {};");
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).toHaveLength(2);
  });

  it("asks for write access to a remembered folder", async () => {
    const handle = folder();
    handle.permission = "prompt";
    handle.grant = "denied";
    expect(await ensureWritable(handle)).toBe(false);
    handle.grant = "granted";
    expect(await ensureWritable(handle)).toBe(true);
    expect(await ensureWritable(handle)).toBe(true); // already granted: no prompt
  });
});
