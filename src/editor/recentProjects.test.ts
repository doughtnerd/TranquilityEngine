import { describe, expect, it } from "vitest";
import type { FsaDirectoryHandle } from "./fsaFileSystem";
import { MemoryDirectoryHandle } from "./fsaMemory";
import { joinPath } from "./projects";
import { cleanLabel, locationOf, RecentProjects, type HandleStore, type ListStore } from "./recentProjects";
import { MemoryFileSystem } from "./testing";

function stores() {
  let text: string | null = null;
  const list: ListStore = { read: () => text, write: (t) => void (text = t) };
  const map = new Map<string, FsaDirectoryHandle>();
  const handles: HandleStore = { get: async (id) => map.get(id), set: async (id, h) => void map.set(id, h), delete: async (id) => void map.delete(id) };
  return { list, handles, map, raw: () => text, setRaw: (t: string) => (text = t) };
}

describe("recent projects", () => {
  it("lists the newest first, moves a reopened project to the top, and keeps at most N", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles, 3);
    await recent.add({ name: "A", path: "C:\\Games\\a" }, 1);
    await recent.add({ name: "B", path: "C:\\Games\\b" }, 2);
    await recent.add({ name: "A again", path: "c:/games/A/" }, 3); // the same folder, written differently
    expect(recent.list().map((e) => [e.name, e.lastOpened])).toEqual([
      ["A again", 3],
      ["B", 2],
    ]);
    await recent.add({ name: "C", path: "/c" }, 4);
    await recent.add({ name: "D", path: "/d" }, 5);
    expect(recent.list().map((e) => e.name)).toEqual(["D", "C", "A again"]);
  });

  it("removes an entry, and reads unreadable storage as empty", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles);
    const a = await recent.add({ name: "A", path: "/a" });
    await recent.remove(a.id);
    expect(recent.list()).toEqual([]);
    s.setRaw("not json");
    expect(recent.list()).toEqual([]);
    s.setRaw('[{"id": 3}, {"id": "x", "name": "Ok", "path": "/ok", "lastOpened": 1, "kind": "path"}]');
    expect(recent.list().map((e) => e.name)).toEqual(["Ok"]);
  });

  it("says whether a desktop project's folder is still there", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles);
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath("C:\\Games\\a", "project.json"), "{}");
    const a = await recent.add({ name: "A", path: "C:\\Games\\a" });
    const gone = await recent.add({ name: "Gone", path: "C:\\Games\\gone" });
    expect(await recent.check(a, fs)).toBe("ok");
    expect(await recent.check(gone, fs)).toBe("missing");
    expect(await recent.check(a, null)).toBe("unknown");
    const failing = Object.assign(new MemoryFileSystem(), { exists: async () => Promise.reject(new Error("forbidden path")) });
    expect(await recent.check(a, failing)).toBe("unknown");
  });

  it("keeps browser folders as handles: matched by folder, checked for access and for being gone", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles);
    const handle = new MemoryDirectoryHandle("game").put("project.json", "{}");
    const first = await recent.add({ name: "Game", path: "game", handle }, 1);
    const again = await recent.add({ name: "Game", path: "game", handle }, 2);
    expect(again.id).toBe(first.id);
    expect(recent.list()).toHaveLength(1);
    expect(s.raw()).not.toContain("entries"); // the handle isn't in the JSON list
    expect(await recent.handle(first.id)).toBe(handle);

    expect(await recent.check(again, null)).toBe("ok");
    handle.permission = "prompt";
    expect(await recent.check(again, null)).toBe("needs-access");
    handle.permission = "granted";
    handle.entries.delete("project.json");
    expect(await recent.check(again, null)).toBe("missing");

    await recent.remove(first.id);
    expect(s.map.size).toBe(0);
    expect(await recent.check(again, null)).toBe("missing");
  });

  it("drops the handles of entries that fall off the list", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles, 1);
    await recent.add({ name: "A", path: "a", handle: new MemoryDirectoryHandle("a") }, 1);
    await recent.add({ name: "B", path: "b", handle: new MemoryDirectoryHandle("b") }, 2);
    expect(recent.list().map((e) => e.name)).toEqual(["B"]);
    expect(s.map.size).toBe(1);
  });
});

describe("browser folder location notes (ADR 0116)", () => {
  it("keeps a note on a handle entry, cleans it, and shows it in place of the folder name", async () => {
    let text: string | null = null;
    const r = new RecentProjects({ read: () => text, write: (t) => (text = t) }, null);
    const entry = await r.add({ name: "Flappy", path: "flappy" });
    const handleEntry = { ...entry, kind: "handle" as const };
    text = JSON.stringify([handleEntry]);
    r.setLabel(entry.id, "  ~/games\n/flappy  ");
    expect(r.list()[0].label).toBe("~/games /flappy");
    expect(locationOf(r.list()[0])).toBe("~/games /flappy");
    r.setLabel(entry.id, "   ");
    expect(r.list()[0].label).toBeUndefined();
    expect(locationOf(r.list()[0])).toBe("flappy");
  });

  it("ignores notes on path entries and rejects non-string labels", () => {
    let text: string | null = JSON.stringify([{ id: "a", name: "A", path: "/a", lastOpened: 1, kind: "path" }, { id: "b", name: "B", path: "b", lastOpened: 2, kind: "handle", label: 5 }]);
    const r = new RecentProjects({ read: () => text, write: (t) => (text = t) }, null);
    r.setLabel("a", "x");
    expect(r.list().map((e) => e.id)).toEqual(["a"]); // the malformed entry is dropped
    expect(r.list()[0].label).toBeUndefined();
    expect(cleanLabel(3)).toBe("");
  });
});
