import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../editor/memoryFs";
import { fileSystemFolder, writeWebBuild, type BuildFolder, type FileSource, type WriteBuildOptions } from "./buildWriter";
import { MANIFEST_FORMAT } from "./format";
import type { ImageTranscoder } from "./images";
import { ExportError, type WebBuildPlan } from "./webBuild";

// The build writer (ADR 0296), the one suite for what the Node exporter and the editor's Build /
// Export write: on an in-memory folder through the platform FileSystem adapter.

const OUT = "C:\\Out\\game";
const PLAYER_LIST = JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] });

/** A file source over a record, counting reads by path. */
function source(files: Record<string, string | Uint8Array>): FileSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: async (path) => {
      reads.push(path);
      const v = files[path];
      if (v === undefined) throw new Error(`no ${path}`);
      return v;
    },
  };
}

const sidecar = (o: object) => JSON.stringify({ format: "myco.import@1", ...o });
const PNG = new Uint8Array(400).fill(7);

function plan(copies: string[] = ["project.json", "images/big.png", "images/big.png.meta.json", "images/small.png", "music/a.mp3"]): WebBuildPlan {
  return {
    manifest: { format: MANIFEST_FORMAT, name: "Game", mainScene: null, files: copies, scripts: [] },
    copies,
    generated: new Map([["game.json", "{}\n"], ["code/scripts/a.js", "export {};\n"]]),
  };
}

/** Halves an image that has a maxSize, at a quarter of the bytes. */
const halve: ImageTranscoder = async (bytes, r) => ({ bytes: new Uint8Array(bytes.length / 4), width: r.maxSize || 100, height: r.maxSize || 100, sourceWidth: 100, sourceHeight: 100 });

/** `folder`, noting each path written. */
const recording = (folder: BuildFolder, writes: string[]): BuildFolder => ({
  ...folder,
  writeText: (path, text) => (writes.push(path), folder.writeText(path, text)),
  writeBytes: (path, bytes) => (writes.push(path), folder.writeBytes(path, bytes)),
});

function setup(extra: Partial<WriteBuildOptions> & { playerFiles?: Record<string, string | Uint8Array> } = {}) {
  const fs = new MemoryFileSystem();
  const project = source({
    "project.json": '{ "name": "Game" }',
    "images/big.png": PNG,
    "images/big.png.meta.json": sidecar({ maxSize: 50 }),
    "images/small.png": new Uint8Array([1, 2, 3]),
    "music/a.mp3": new Uint8Array([9, 9]),
  });
  const player = source(extra.playerFiles ?? { "files.json": PLAYER_LIST, "assets/player-x.js": "// player", "myco.js": "export {};", "player.html": "<title>player</title>" });
  const progress: [number, number][] = [];
  const writes: string[] = [];
  const options: WriteBuildOptions = {
    project,
    player,
    playerWhere: "the test player",
    folder: recording(fileSystemFolder(fs, OUT), writes),
    platform: "web",
    transcode: halve,
    bake: async () => ({ bytes: new Uint8Array([77]), dropped: [] }),
    progress: (done, total) => progress.push([done, total]),
    ...extra,
  };
  const file = (p: string) => fs.files.get(`${OUT}\\${p.replace(/\//g, "\\")}`);
  return { fs, project, player, progress, options, file, writes };
}

describe("writeWebBuild", () => {
  it("writes the player (its page as index.html), the project's files, the generated and baked files, with progress", async () => {
    const { options, file, progress } = setup();
    const written = await writeWebBuild(plan([...plan().copies, "models/crate.obj"]), { ...options, project: source({ "project.json": "{}", "images/big.png": PNG, "images/big.png.meta.json": sidecar({}), "images/small.png": new Uint8Array([1]), "music/a.mp3": new Uint8Array([2]), "models/crate.obj": "o crate\n" }) });
    expect(file("index.html")).toEqual(new TextEncoder().encode("<title>player</title>"));
    expect(file("player.html")).toBeUndefined();
    expect(file("myco.js")).toBeInstanceOf(Uint8Array);
    expect(file("assets/player-x.js")).toBeDefined();
    expect(file("project/project.json")).toBe("{}"); // text the source holds as text stays text
    expect(file("project/music/a.mp3")).toEqual(new Uint8Array([2]));
    expect(file("project/models/crate.obj")).toBe("o crate\n");
    expect(file("code/scripts/a.js")).toBe("export {};\n");
    expect(file("project/models/crate.obj.mycomesh")).toEqual(new Uint8Array([77]));
    expect(written.manifest.files).toContain("models/crate.obj.mycomesh");
    expect(JSON.parse(file("game.json") as string)).toEqual(written.manifest);
    const total = 3 + written.copies.length + written.generated.size + written.binaries!.size;
    expect(progress.map(([d]) => d)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(progress.every(([, t]) => t === total)).toBe(true);
  });

  it("writes a processed image once, in place of its copy, without reading the original for the copy", async () => {
    const { options, file, project, progress, writes } = setup();
    await writeWebBuild(plan(), options);
    expect(file("project/images/big.png")).toEqual(new Uint8Array(100)); // processed
    expect(JSON.parse(file("project/images/big.png.meta.json") as string)).toMatchObject({ maxSize: 50, sourceSize: [100, 100] });
    expect(file("project/images/small.png")).toEqual(new Uint8Array([1, 2, 3])); // no sidecar: as it is
    expect(project.reads.filter((p) => p === "images/big.png")).toEqual(["images/big.png"]); // read once, to process it
    expect(writes.filter((w) => w.includes("big.png")).sort()).toEqual(["project/images/big.png", "project/images/big.png.meta.json"]);
    expect(new Set(writes).size).toBe(writes.length); // each file once
    expect(progress.at(-1)).toEqual([writes.length, writes.length]);
  });

  it("checks the player before anything in the folder is touched: an earlier build survives a broken player", async () => {
    const { options, fs, file } = setup();
    await writeWebBuild(plan(), options);
    fs.files.set(`${OUT}\\stale.txt`, "old");
    const before = new Map(fs.files);
    for (const playerFiles of [{} as Record<string, string>, { "files.json": "not json" }, { "files.json": JSON.stringify({ files: ["myco.js"] }) }]) {
      const broken = setup({ playerFiles }).options;
      const err = await writeWebBuild(plan(), { ...broken, folder: fileSystemFolder(fs, OUT) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExportError);
      expect((err as Error).message).toMatch(/game player in the test player/);
      expect(fs.files).toEqual(before);
    }
    expect(file("stale.txt")).toBe("old");
  });

  it("replaces an earlier build, and refuses a folder holding something else before baking or reading anything", async () => {
    const { options, fs, file, project } = setup();
    await writeWebBuild(plan(), options);
    fs.files.set(`${OUT}\\stale.txt`, "old");
    fs.files.set(`${OUT}\\project\\gone.png`, new Uint8Array([1]));
    await writeWebBuild(plan(), options);
    expect(file("stale.txt")).toBeUndefined();
    expect(file("project/gone.png")).toBeUndefined();
    expect(file("game.json")).toBeDefined();

    fs.files.set("C:\\Mine\\notes.txt", "mine");
    project.reads.length = 0;
    let baked = 0;
    const refused = writeWebBuild(plan(["project.json", "models/a.obj"]), { ...options, folder: fileSystemFolder(fs, "C:\\Mine"), bake: async () => (baked++, { bytes: new Uint8Array(), dropped: [] }) });
    await expect(refused).rejects.toThrow(/"C:\\Mine" isn't empty and doesn't hold an earlier build/);
    expect(fs.files.get("C:\\Mine\\notes.txt")).toBe("mine");
    expect([baked, project.reads.length]).toEqual([0, 0]);
  });

  it("writes into an empty or missing folder", async () => {
    const { options, fs, file } = setup();
    await fs.mkdir(OUT);
    await writeWebBuild(plan(), options);
    expect(file("index.html")).toBeDefined();
    const { options: fresh, file: freshFile } = setup();
    await writeWebBuild(plan(), fresh);
    expect(freshFile("game.json")).toBeDefined();
  });

  it("a desktop package: the web build in web/, an earlier package cleared but for its Rust cache", async () => {
    const { options, fs, file } = setup();
    const desktop = { ...options, web: "web", keep: ["src-tauri/target"], kind: "desktop", platform: "desktop" as const };
    fs.files.set(`${OUT}\\notes.txt`, "mine");
    await expect(writeWebBuild(plan(), desktop)).rejects.toThrow(/doesn't hold an earlier desktop build/);
    fs.files.delete(`${OUT}\\notes.txt`);

    await writeWebBuild(plan(), desktop);
    expect(file("web/index.html")).toBeDefined();
    expect(file("web/project/project.json")).toBeDefined();
    expect(file("index.html")).toBeUndefined();
    fs.files.set(`${OUT}\\README.txt`, "readme");
    fs.files.set(`${OUT}\\src-tauri\\tauri.conf.json`, "{}");
    fs.files.set(`${OUT}\\src-tauri\\target\\release\\game.exe`, new Uint8Array([1]));
    await writeWebBuild(plan(), desktop);
    expect(file("README.txt")).toBeUndefined();
    expect(file("src-tauri/tauri.conf.json")).toBeUndefined();
    expect(file("src-tauri/target/release/game.exe")).toEqual(new Uint8Array([1]));
    expect(file("web/game.json")).toBeDefined();
  });

  it("names a project file it can't read", async () => {
    const { options } = setup();
    await expect(writeWebBuild(plan(["project.json", "missing.png"]), options)).rejects.toThrow(/Couldn't read missing\.png from the project/);
  });
});
