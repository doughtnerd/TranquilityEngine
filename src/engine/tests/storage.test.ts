import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry, FileSystem } from "../platform/FileSystem";
import { MemoryStorage, Storage, type StorageBackend } from "../platform/Storage";
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

describe("files (Tauri): keys as file names (ADR 0384)", () => {
  /** `memoryFiles` as a case-insensitive disk (Windows, macOS): one file per name whatever its case, keeping the first spelling. */
  function caseInsensitiveFiles() {
    const fs = memoryFiles();
    const real = (p: string) => [...fs.files.keys()].find((k) => k.toLowerCase() === p.toLowerCase()) ?? p;
    return {
      ...fs,
      readText: (p: string) => fs.readText(real(p)),
      writeText: (p: string, t: string) => fs.writeText(real(p), t),
      exists: async (p: string) => fs.files.has(real(p)) || (await fs.exists(p)),
      remove: (p: string) => fs.remove(real(p)),
      rename: (a: string, b: string) => fs.rename(real(a), b),
    };
  }

  it("gives keys that differ only in case their own files on a case-insensitive disk", async () => {
    const fs = caseInsensitiveFiles();
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    await storage.save("saves", "Slot", 1);
    await storage.save("saves", "slot", 2);
    expect(await storage.load("saves", "Slot")).toBe(1);
    expect(await storage.load("saves", "slot")).toBe(2);
    expect((await storage.list("saves")).sort()).toEqual(["Slot", "slot"]);
  });

  it("names no file with a character or device name Windows refuses", async () => {
    const fs = memoryFiles();
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    const keys = ["a*b", "what?", "CON", "nul.cfg", "com1", "x'(y)!~", "plain-key_1.v2"];
    for (const key of keys) await storage.save("saves", key, key);
    for (const name of [...fs.files.keys()].map((f) => f.slice("/data/saves/".length))) {
      expect(name).toMatch(/^([a-z0-9._-]|%[0-9A-F]{2})+\.json$/);
      expect(name).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/);
    }
    expect(fs.files.has("/data/saves/plain-key_1.v2.json")).toBe(true);
    expect((await storage.list("saves")).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(await storage.load("saves", key)).toBe(key);
  });

  it("reads, rewrites and deletes files an earlier build named, under their keys", async () => {
    const fs = memoryFiles();
    fs.files.set("/data/saves/Slot1.json", "1");
    fs.files.set("/data/saves/a*b.json", "2");
    fs.files.set("/data/saves/best.json", "3");
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    expect((await storage.list("saves")).sort()).toEqual(["Slot1", "a*b", "best"]);
    expect(await storage.load("saves", "Slot1")).toBe(1);
    expect(await storage.load("saves", "a*b")).toBe(2);
    await storage.save("saves", "Slot1", 10);
    expect(await storage.load("saves", "Slot1")).toBe(10);
    await storage.delete("saves", "a*b");
    expect((await storage.list("saves")).sort()).toEqual(["Slot1", "best"]);
    expect([...fs.files.keys()].some((f) => f.includes("*") || f.includes("Slot1"))).toBe(false);
  });

  it("lists only the files whose names it can read, skipping a stray one", async () => {
    const fs = memoryFiles();
    fs.files.set("/data/saves/100%.json", "1");
    fs.files.set("/data/saves/notes.txt", "x");
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    await storage.save("saves", "ok", 2);
    expect(await storage.list("saves")).toEqual(["ok"]);
  });
});

describe("files (Tauri): long keys (ADR 0387)", () => {
  const names = (fs: { files: Map<string, unknown> }) => [...fs.files.keys()].map((f) => f.slice("/data/saves/".length));
  const long = (tail: string) => `${"level-".repeat(60)}${tail}`; // 360 characters

  it("names a long key's file within the limits, readable and listed under its full key", async () => {
    const fs = memoryFiles();
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    const keys = [long("a"), long("b"), `${"Ä".repeat(200)}`, "short"];
    for (const key of keys) await storage.save("saves", key, key.length);
    await storage.save("saves", long("bytes"), new Uint8Array([1, 2, 10, 3]));
    for (const name of names(fs)) {
      expect(name.length).toBeLessThanOrEqual(110);
      expect(name).toMatch(/^([a-z0-9._-]|%[0-9A-F]{2})+(~[0-9a-f]{32})?\.(json|bin)$/);
    }
    expect(names(fs).filter((n) => n.startsWith("level-")).length).toBe(3); // a readable prefix, one file per key
    expect(fs.files.has("/data/saves/short.json")).toBe(true);
    for (const key of keys) expect(await storage.load("saves", key)).toBe(key.length);
    expect([...new Uint8Array((await storage.load("saves", long("bytes"))) as ArrayBuffer)]).toEqual([1, 2, 10, 3]);
    expect((await storage.list("saves")).sort()).toEqual([...keys, long("bytes")].sort());
    await storage.delete("saves", long("a"));
    expect(await storage.load("saves", long("a"))).toBeUndefined();
    expect((await storage.list("saves")).sort()).toEqual([long("b"), "short", "Ä".repeat(200), long("bytes")].sort());
  });

  it("gives long keys that differ only in case their own files on a case-insensitive disk", async () => {
    const fs = memoryFiles();
    const real = (p: string) => [...fs.files.keys()].find((k) => k.toLowerCase() === p.toLowerCase()) ?? p;
    const ci = { ...fs, readText: (p: string) => fs.readText(real(p)), writeText: (p: string, t: string) => fs.writeText(real(p), t), exists: async (p: string) => fs.files.has(real(p)) };
    const storage = new EncodedStorage(new TauriRecords(ci, "/data"));
    await storage.save("saves", long("Slot"), 1);
    await storage.save("saves", long("slot"), 2);
    expect(await storage.load("saves", long("Slot"))).toBe(1);
    expect(await storage.load("saves", long("slot"))).toBe(2);
    expect(fs.files.size).toBe(2);
  });

  it("still reads a long key's file an earlier build named in full, moving it to the short name", async () => {
    const fs = memoryFiles();
    const key = long("old");
    fs.files.set(`/data/saves/${key}.json`, "7"); // ADR 0384's name: 365 bytes, where the disk allowed it
    fs.files.set(`/data/saves/${"x".repeat(150)}.bin`, new Uint8Array([4, 5]));
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    expect((await storage.list("saves")).sort()).toEqual([key, "x".repeat(150)].sort());
    expect(await storage.load("saves", key)).toBe(7);
    expect([...new Uint8Array((await storage.load("saves", "x".repeat(150))) as ArrayBuffer)]).toEqual([4, 5]);
    for (const name of names(fs)) expect(name.length).toBeLessThanOrEqual(110);
  });

  it("reads a file under a short name only for the key it holds", async () => {
    const fs = memoryFiles();
    const storage = new EncodedStorage(new TauriRecords(fs, "/data"));
    await storage.save("saves", long("a"), 1);
    const [file] = [...fs.files.keys()];
    fs.files.set(file, `${JSON.stringify(long("z"))}\n2`); // another key's record under this name
    expect(await storage.load("saves", long("a"))).toBeUndefined();
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

  it("says which folder a played project's files go under, for a host that reports where it saved", async () => {
    const played = await openStorage({ kind: "project", id: "C:/Games/Flappy", name: "Flappy Bird" });
    const previous = Storage.use(played);
    try {
      expect(Storage.root()).toMatch(new RegExp(`^${APP}/play/flappy-bird-[0-9a-f]{8}$`));
    } finally {
      Storage.use(previous);
    }
    expect(new MemoryStorage().root).toBeUndefined();
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
