import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileSystem, isTauri, type DirEntry } from "../platform/FileSystem";
import { TauriFileSystem } from "../platform/TauriFileSystem";

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

describe("platform detection and the browser file system", () => {
  it("is not Tauri in Node", () => {
    expect(isTauri()).toBe(false);
  });

  it("rejects writes, listing and the folder dialog in the browser", async () => {
    const fs = await getFileSystem(); // not Tauri: the read-only browser file system
    expect(fs.canWrite).toBe(false);
    const unsupported = { name: "UnsupportedError", message: expect.stringMatching(/not available in the browser; run the editor under Tauri/) };
    await expect(fs.writeText("a.txt", "")).rejects.toMatchObject(unsupported);
    await expect(fs.list("")).rejects.toMatchObject(unsupported);
    await expect(fs.pickFolder()).rejects.toMatchObject(unsupported);
  });
});
