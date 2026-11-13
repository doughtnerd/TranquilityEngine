import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameManifest } from "../export/format";
import { desktopExportCommand, exportProjectBuild } from "./exportBuild";
import { openFolderProject, readOnlyProject } from "./projects";
import { demoFolder, ROOT, type MemoryFileSystem } from "./testing";

// Build / Export in the editor (ADR 0041): the open project's files, its scripts compiled, and the
// player fetched from beside the editor, written through the platform FileSystem.
const PLAYER: Record<string, string> = {
  "player/files.json": JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }),
  "player/assets/player-x.js": "// player",
  "player/myco.js": "export {};",
  "player/player.html": "<!DOCTYPE html><title>player</title>",
};

let blobs: Map<string, Uint8Array>;
beforeEach(() => {
  blobs = new Map();
  vi.stubGlobal("document", { baseURI: "http://editor.test/" });
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:test/${n++}`;
    void (blob as Blob).arrayBuffer().then((b) => blobs.set(url, new Uint8Array(b)));
    return url;
  });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("http://editor.test/", "");
    const body = PLAYER[path] ?? blobs.get(url);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function folderProject(fs: MemoryFileSystem) {
  fs.files.set(`${ROOT}\\scripts\\Hello.ts`, 'import { GameBehavior, behavior } from "myco";\n@behavior("t.Hello") export class Hello extends GameBehavior {}\n');
  const project = await openFolderProject(fs, ROOT);
  await new Promise((r) => setTimeout(r, 0)); // blob bytes land
  return project;
}

describe("the Export dialog's audio capture checkbox (its option reaches the build)", () => {
  it("checked: game.json carries audioCapture; unchecked, or no option: it doesn't", async () => {
    const run = async (options?: { audioCapture?: boolean }) => {
      const fs = demoFolder();
      const project = await folderProject(fs);
      await exportProjectBuild(project, fs, "C:\\Out\\flappy", undefined, options);
      return JSON.parse(fs.files.get("C:\\Out\\flappy\\game.json") as string) as GameManifest;
    };
    expect((await run({ audioCapture: true })).audioCapture).toBe(true);
    expect(await run({ audioCapture: false })).not.toHaveProperty("audioCapture");
    expect(await run()).not.toHaveProperty("audioCapture");
  });

  it("the desktop command the dialog shows adds --audio-capture only when it is checked", async () => {
    const project = await folderProject(demoFolder());
    expect(desktopExportCommand(project)).not.toContain("--audio-capture");
    expect(desktopExportCommand(project, false)).not.toContain("--audio-capture");
    expect(desktopExportCommand(project, true)).toMatch(/--target desktop --audio-capture$/);
  });
});

describe("exportProjectBuild", () => {
  it("writes the player, the project's files and its compiled scripts into the folder", async () => {
    const fs = demoFolder();
    const project = await folderProject(fs);
    const progress: number[] = [];
    const plan = await exportProjectBuild(project, fs, "C:\\Out\\flappy", (done) => progress.push(done));
    const file = (p: string) => fs.files.get(`C:\\Out\\flappy\\${p.replace(/\//g, "\\")}`);
    expect(file("index.html")).toEqual(new TextEncoder().encode(PLAYER["player/player.html"]));
    expect(file("myco.js")).toBeDefined();
    expect(file("player.html")).toBeUndefined();
    expect(file("project/project.json")).toBe(project.textOf("project.json"));
    expect(file("project/images/flappyBird.png")).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(file("code/scripts/Hello.js")).toContain('from "../../myco.js"');
    expect(file("project/scripts/Hello.ts")).toBeUndefined();
    const manifest = JSON.parse(file("game.json") as string) as GameManifest;
    expect(manifest).toEqual(plan.manifest);
    expect(manifest).toMatchObject({ name: "flappy", mainScene: "scenes/main.scene.json", scripts: [{ source: "scripts/Hello.ts", module: "code/scripts/Hello.js" }] });
    expect(progress.at(-1)).toBe(3 + plan.copies.length + plan.generated.size);

    // Again over the earlier build: replaced. Into a folder holding something else: refused.
    fs.files.set("C:\\Out\\flappy\\stale.txt", "old");
    await exportProjectBuild(project, fs, "C:\\Out\\flappy");
    expect(file("stale.txt")).toBeUndefined();
    fs.files.set("C:\\Mine\\notes.txt", "mine");
    await expect(exportProjectBuild(project, fs, "C:\\Mine")).rejects.toThrow(/isn't empty/);
    await expect(exportProjectBuild(project, fs, `${ROOT}\\build`)).rejects.toThrow(/inside the project/);
  });

  it("explains when there's no player beside the editor", async () => {
    delete PLAYER["player/files.json"];
    try {
      const project = readOnlyProject("p", { values: new Map([["project.json", {}]]), texts: new Map([["project.json", "{}"]]) });
      await expect(exportProjectBuild(project, demoFolder(), "C:\\Out")).rejects.toThrow(/no game player/);
    } finally {
      PLAYER["player/files.json"] = JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] });
    }
  });
});
