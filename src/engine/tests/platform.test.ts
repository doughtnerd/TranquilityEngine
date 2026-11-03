import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserFileSystem, UnsupportedError, isTauri, type DirEntry, type FileSystem } from "../platform/FileSystem";
import { TauriFileSystem } from "../platform/TauriFileSystem";
import { TauriStorage } from "../platform/TauriStorage";

// --- Tauri plugin mocks (an in-memory disk) ------------------------------------------------

const disk = new Map<string, string | Uint8Array>();
const dirs = new Set<string>();
const calls: string[] = [];

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: async (p: string) => {
    const v = disk.get(p);
    if (typeof v !== "string") throw new Error(`ENOENT ${p}`);
    return v;
  },
  writeTextFile: async (p: string, text: string) => {
    calls.push(`write ${p}`);
    disk.set(p, text);
  },
  readFile: async (p: string) => {
    const v = disk.get(p);
    if (!(v instanceof Uint8Array)) throw new Error(`ENOENT ${p}`);
    return v;
  },
  writeFile: async (p: string, data: Uint8Array) => {
    calls.push(`write ${p}`);
    disk.set(p, data);
  },
  rename: async (from: string, to: string) => {
    calls.push(`rename ${from} -> ${to}`);
    disk.set(to, disk.get(from)!);
    disk.delete(from);
  },
  readDir: async (p: string) => {
    const prefix = `${p}/`;
    const names = new Map<string, boolean>();
    for (const k of disk.keys()) if (k.startsWith(prefix)) names.set(k.slice(prefix.length).split("/")[0], k.slice(prefix.length).includes("/"));
    for (const d of dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) names.set(d.slice(prefix.length), true);
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
  },
  exists: async (p: string) => disk.has(p) || dirs.has(p),
  mkdir: async (p: string, opts: { recursive?: boolean }) => {
    calls.push(`mkdir ${p} ${JSON.stringify(opts)}`);
    dirs.add(p);
  },
  remove: async (p: string) => {
    disk.delete(p);
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async (opts: Record<string, unknown>) => {
    calls.push(`open ${JSON.stringify(opts)}`);
    return "C:/Projects/MyGame";
  }),
}));

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "C:/AppData/com.foxfirestudios.myco.flappy/" }));

beforeEach(() => {
  disk.clear();
  dirs.clear();
  calls.length = 0;
});

describe("TauriFileSystem (ADR 0026)", () => {
  const fs = new TauriFileSystem();

  it("writes text atomically: temp file in the same folder, then rename", async () => {
    await fs.writeText("C:/p/scene.json", "{}");
    expect(calls[0]).toMatch(/^write C:\/p\/scene\.json\.tmp-/);
    expect(calls[1]).toMatch(/^rename C:\/p\/scene\.json\.tmp-\S+ -> C:\/p\/scene\.json$/);
    expect(await fs.readText("C:/p/scene.json")).toBe("{}");
    expect([...disk.keys()]).toEqual(["C:/p/scene.json"]);
  });

  it("round-trips binary data and lists folders", async () => {
    await fs.writeBinary("C:/p/a.bin", new Uint8Array([1, 2, 3]));
    await fs.mkdir("C:/p/scenes");
    expect([...(await fs.readBinary("C:/p/a.bin"))]).toEqual([1, 2, 3]);
    const entries: DirEntry[] = await fs.list("C:/p");
    expect(entries).toEqual(expect.arrayContaining([{ name: "a.bin", isDirectory: false }, { name: "scenes", isDirectory: true }]));
    expect(calls).toContain('mkdir C:/p/scenes {"recursive":true}');
  });

  it("opens a recursive folder dialog so the whole project is in the fs scope", async () => {
    expect(await fs.pickFolder("Open project")).toBe("C:/Projects/MyGame");
    expect(calls).toContain('open {"directory":true,"multiple":false,"recursive":true,"title":"Open project"}');
  });
});

describe("TauriStorage (ADR 0024)", () => {
  it("stores one JSON file per key under <appDataDir>/<namespace>/", async () => {
    const storage = await TauriStorage.create(new TauriFileSystem());
    await storage.save("saves", "best", 12);
    expect(disk.get("C:/AppData/com.foxfirestudios.myco.flappy/saves/best.json")).toBe("12");
    expect(await storage.load("saves", "best")).toBe(12);
    expect(await storage.load("saves", "missing")).toBeUndefined();
  });

  it("encodes keys, lists, overwrites and deletes", async () => {
    const storage = await TauriStorage.create(new TauriFileSystem());
    await storage.save("settings", "audio/volume", { music: 0.5 });
    await storage.save("settings", "audio/volume", { music: 0.8 });
    await storage.save("settings", "lang", "en");
    expect(disk.has("C:/AppData/com.foxfirestudios.myco.flappy/settings/audio%2Fvolume.json")).toBe(true);
    expect((await storage.list("settings")).sort()).toEqual(["audio/volume", "lang"]);
    expect(await storage.load("settings", "audio/volume")).toEqual({ music: 0.8 });
    await storage.delete("settings", "lang");
    expect(await storage.list("settings")).toEqual(["audio/volume"]);
    expect(await storage.list("cache")).toEqual([]);
  });

  it("stores ArrayBuffers as .bin files and returns an ArrayBuffer", async () => {
    const storage = await TauriStorage.create(new TauriFileSystem());
    await storage.save("cache", "blob", new Uint8Array([9, 8, 7]).buffer);
    const v = await storage.load("cache", "blob");
    expect(v).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(v as ArrayBuffer)]).toEqual([9, 8, 7]);
    await storage.save("cache", "blob", "now json");
    expect(await storage.load("cache", "blob")).toBe("now json");
    expect(await storage.list("cache")).toEqual(["blob"]);
  });

  it("works over any FileSystem implementation", async () => {
    const files = new Map<string, string>();
    const fake = {
      canWrite: true,
      readText: async (p: string) => files.get(p)!,
      writeText: async (p: string, t: string) => void files.set(p, t),
      exists: async (p: string) => files.has(p),
      mkdir: async () => {},
      remove: async (p: string) => void files.delete(p),
    } as unknown as FileSystem;
    const storage = new TauriStorage(fake, "/data");
    await storage.save("saves", "slot1", { level: 3 });
    expect(files.get("/data/saves/slot1.json")).toBe('{"level":3}');
  });
});

describe("platform detection and the browser file system", () => {
  it("is not Tauri in Node", () => {
    expect(isTauri()).toBe(false);
  });

  it("rejects writes, listing and the folder dialog in the browser", async () => {
    const fs = new BrowserFileSystem();
    expect(fs.canWrite).toBe(false);
    await expect(fs.writeText()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(fs.list()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(fs.pickFolder()).rejects.toBeInstanceOf(UnsupportedError);
  });
});
