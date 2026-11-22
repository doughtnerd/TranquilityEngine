import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry, FileSystem } from "../platform/FileSystem";
import { MemoryStorage, type StorageBackend } from "../platform/Storage";
import { EncodedStorage, openStorage } from "../platform/storageScope";
import { moveLegacyEditorData, TauriRecords } from "../platform/tauriRecords";

// Player storage (ADR 0024, 0317): one contract for every built-in backend, and where each scope keeps its data.
// IndexedDB isn't available under Node (no fake is installed), so its adapter is covered by the e2e specs.

/** A file system in memory, holding text and bytes. */
function memoryFiles(): FileSystem & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const fs = {
    canWrite: true,
    files,
    readText: async (p: string) => {
      const v = files.get(p);
      if (typeof v !== "string") throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeText: async (p: string, t: string) => void files.set(p, t),
    readBinary: async (p: string) => {
      const v = files.get(p);
      if (!(v instanceof Uint8Array)) throw new Error(`ENOENT ${p}`);
      return v.slice();
    },
    writeBinary: async (p: string, d: Uint8Array) => void files.set(p, d.slice()),
    exists: async (p: string) => files.has(p) || dirs.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    mkdir: async (p: string) => void dirs.add(p),
    remove: async (p: string) => void files.delete(p),
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    list: async (p: string): Promise<DirEntry[]> => {
      const names = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/")) names.add(k.slice(p.length + 1));
      return [...names].map((name) => ({ name, isDirectory: false }));
    },
    pickFolder: async () => null,
  };
  return fs;
}

const backends: [string, () => StorageBackend][] = [
  ["memory", () => new MemoryStorage()],
  ["files (Tauri)", () => new EncodedStorage(new TauriRecords(memoryFiles(), "/data"))],
];

describe.each(backends)("the storage contract: %s", (_name, make) => {
  let storage: StorageBackend;
  beforeEach(() => (storage = make()));

  it("round-trips JSON data, per namespace", async () => {
    const save = { level: 3, name: "Ada", flags: [true, false, null], nested: { score: -1.5, items: [] as unknown[] } };
    await storage.save("saves", "slot1", save);
    await storage.save("settings", "slot1", "en");
    expect(await storage.load("saves", "slot1")).toEqual(save);
    expect(await storage.load("settings", "slot1")).toBe("en");
    expect(await storage.load("cache", "slot1")).toBeUndefined();
  });

  it("gives a copy: changing a loaded or saved value changes nothing stored", async () => {
    const value = { hp: 10 };
    await storage.save("saves", "a", value);
    value.hp = 0;
    const loaded = (await storage.load("saves", "a")) as { hp: number };
    loaded.hp = 5;
    expect(await storage.load("saves", "a")).toEqual({ hp: 10 });
  });

  it("stores bytes from an ArrayBuffer or a typed array, and loads them as an ArrayBuffer", async () => {
    await storage.save("cache", "buf", new Uint8Array([9, 8, 7]).buffer);
    const view = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4);
    await storage.save("cache", "view", view);
    await storage.save("cache", "floats", new Float32Array([1.5]));
    const buf = await storage.load("cache", "buf");
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buf as ArrayBuffer)]).toEqual([9, 8, 7]);
    expect([...new Uint8Array((await storage.load("cache", "view")) as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(new Float32Array((await storage.load("cache", "floats")) as ArrayBuffer)[0]).toBe(1.5);
  });

  it("replaces bytes with JSON and back under one key", async () => {
    await storage.save("cache", "k", new Uint8Array([1]));
    await storage.save("cache", "k", "now json");
    expect(await storage.load("cache", "k")).toBe("now json");
    await storage.save("cache", "k", new Uint8Array([2]));
    expect([...new Uint8Array((await storage.load("cache", "k")) as ArrayBuffer)]).toEqual([2]);
    expect(await storage.list("cache")).toEqual(["k"]);
  });

  it("lists, overwrites and deletes any key string", async () => {
    await storage.save("settings", "audio/volume", { music: 0.5 });
    await storage.save("settings", "audio/volume", { music: 0.8 });
    await storage.save("settings", "lang", "en");
    expect((await storage.list("settings")).sort()).toEqual(["audio/volume", "lang"]);
    expect(await storage.load("settings", "audio/volume")).toEqual({ music: 0.8 });
    await storage.delete("settings", "lang");
    await storage.delete("settings", "never-saved");
    expect(await storage.list("settings")).toEqual(["audio/volume"]);
    expect(await storage.list("cache")).toEqual([]);
  });

  it("leaves out undefined object properties", async () => {
    await storage.save("saves", "a", { kept: 1, gone: undefined });
    expect(await storage.load("saves", "a")).toEqual({ kept: 1 });
  });

  it("refuses values outside the contract, naming the part, instead of changing them", async () => {
    const refused: [unknown, RegExp][] = [
      [new Date(0), /Date at the value/],
      [{ seen: new Map() }, /Map at the value\.seen/],
      [{ list: [1, new Set()] }, /Set at the value\.list\[1\]/],
      [{ deep: { bytes: new Uint8Array(1) } }, /Uint8Array at the value\.deep\.bytes/],
      [[1, undefined], /undefined at the value\[1\]/],
      [NaN, /NaN/],
      [{ f: () => 1 }, /function at the value\.f/],
      [undefined, /Delete the key/],
      [10n, /bigint/],
    ];
    for (const [value, message] of refused) await expect(storage.save("saves", "bad", value)).rejects.toThrow(message);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(storage.save("saves", "bad", cyclic)).rejects.toThrow(/contains itself/);
    expect(await storage.list("saves")).toEqual([]);
  });
});

describe("files (Tauri) on disk", () => {
  it("keeps one JSON file per key, URI-encoded, and bytes as .bin", async () => {
    const fs = memoryFiles();
    const storage = new EncodedStorage(new TauriRecords(fs, "/data/"));
    await storage.save("saves", "best", 12);
    await storage.save("settings", "audio/volume", { music: 0.5 });
    await storage.save("cache", "blob", new Uint8Array([1, 2]));
    expect(fs.files.get("/data/saves/best.json")).toBe("12");
    expect(fs.files.get("/data/settings/audio%2Fvolume.json")).toBe('{"music":0.5}');
    expect([...(fs.files.get("/data/cache/blob.bin") as Uint8Array)]).toEqual([1, 2]);
  });
});

// --- scopes: where each one's data lives (Tauri) ---------------------------------------------------------------

const disk = memoryFiles();

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: (p: string) => disk.readText(p),
  writeTextFile: (p: string, t: string) => disk.writeText(p, t),
  readFile: (p: string) => disk.readBinary(p),
  writeFile: (p: string, d: Uint8Array) => disk.writeBinary(p, d),
  rename: (a: string, b: string) => disk.rename(a, b),
  readDir: async (p: string) => (await disk.list(p)).map((e) => ({ name: e.name, isDirectory: false, isFile: true, isSymlink: false })),
  exists: (p: string) => disk.exists(p),
  mkdir: (p: string) => disk.mkdir(p),
  remove: (p: string) => disk.remove(p),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "C:/AppData/com.foxfirestudios.myco.editor/" }));

describe("storage scopes under Tauri (ADR 0317)", () => {
  const APP = "C:/AppData/com.foxfirestudios.myco.editor";
  beforeAll(() => vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }));
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => disk.files.clear());

  it("keeps an exported game's saves in the app data folder itself, where they always were", async () => {
    disk.files.set(`${APP}/saves/best.json`, "41"); // saved by an earlier build
    const game = await openStorage({ kind: "game", name: "Flappy" });
    expect(await game.load("saves", "best")).toBe(41);
    await game.save("settings", "lang", "en");
    expect(disk.files.get(`${APP}/settings/lang.json`)).toBe('"en"');
  });

  it("gives each played project its own folder, even two with one name, apart from the editor's data", async () => {
    const a = await openStorage({ kind: "project", id: "C:/Games/Flappy", name: "Flappy Bird" });
    const b = await openStorage({ kind: "project", id: "D:/Copy/Flappy", name: "Flappy Bird" });
    const editor = await openStorage({ kind: "editor" });
    await a.save("saves", "slot", 1);
    await b.save("saves", "slot", 2);
    await editor.save("cache", "history-x.a", "{}");
    expect(await a.load("saves", "slot")).toBe(1);
    expect(await b.load("saves", "slot")).toBe(2);
    expect(await a.list("cache")).toEqual([]); // game code in Play can't see the editor's history
    const files = [...disk.files.keys()];
    expect(files.filter((f) => f.startsWith(`${APP}/play/flappy-bird-`) && f.endsWith("/saves/slot.json"))).toHaveLength(2);
    expect(files).toContain(`${APP}/editor/cache/history-x.a.json`);
    expect(files.some((f) => f.startsWith(`${APP}/saves/`))).toBe(false);
  });

  it("moves the editor's history and user layouts out of the shared root once, leaving Play's old saves", async () => {
    // Before ADR 0317 the editor's data lived beside every project's Play saves.
    disk.files.set(`${APP}/cache/history-abc-main.a.json`, '"slot a"');
    disk.files.set(`${APP}/cache/asset-history-def-x.b.json`, '"slot b"');
    disk.files.set(`${APP}/cache/capture.bin`, new Uint8Array([1]));
    disk.files.set(`${APP}/settings/layouts%2FWide.layout.json.json`, '"layout"');
    disk.files.set(`${APP}/settings/graphics.quality.json`, '"high"');
    await moveLegacyEditorData(disk, APP, `${APP}/editor`);
    const editor = new EncodedStorage(new TauriRecords(disk, `${APP}/editor`));
    expect((await editor.list("cache")).sort()).toEqual(["asset-history-def-x.b", "history-abc-main.a"]);
    expect(await editor.load("settings", "layouts/Wide.layout.json")).toBe("layout");
    expect(disk.files.has(`${APP}/cache/capture.bin`)).toBe(true);
    expect(disk.files.has(`${APP}/settings/graphics.quality.json`)).toBe(true);
    expect(disk.files.has(`${APP}/cache/history-abc-main.a.json`)).toBe(false);
  });
});
