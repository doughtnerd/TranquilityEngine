import { effect } from "@preact/signals";
import { describe, expect, it, vi } from "vitest";
import { FsaFileSystem, type FsaDirectoryHandle } from "./fsaFileSystem";
import { MemoryDirectoryHandle } from "./fsaMemory";
import { joinPath } from "./projects";
import { locationOf, RecentProjects, type HandleStore, type ListStore } from "./recentProjectList";
import { rememberProject } from "./recentProjects";
import { MemoryFileSystem } from "./testing";

describe("rememberProject (the editor's and the Studio's)", () => {
  it("adds a desktop folder by its path, a browser folder by its handle, and skips a project in memory", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles);
    await rememberProject({ name: "Desk", fileSystem: new MemoryFileSystem(), root: "/games/desk" }, "studio", recent);
    const fsa = new FsaFileSystem(null);
    const handle = new MemoryDirectoryHandle("Web Game");
    const root = await fsa.mount(handle);
    await rememberProject({ name: "Web", fileSystem: fsa, root }, "studio", recent);
    await rememberProject({ name: "Sample", fileSystem: null, root: null }, "studio", recent);
    expect(recent.list().map((e) => [e.name, e.kind, e.path])).toEqual([
      ["Web", "handle", "Web Game"],
      ["Desk", "path", "/games/desk"],
    ]);
    expect(await recent.handle(recent.list()[0]!.id)).toBe(handle);
  });

  it("warns, never throws, when the folder can't be remembered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recent = new RecentProjects(stores().list, null);
    await expect(rememberProject({ name: "A", fileSystem: new FsaFileSystem(null), root: "/gone" }, "studio", recent)).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[studio\] couldn't add \/gone to the recent projects: /);
    expect(recent.list()).toEqual([]);
    warn.mockRestore();
  });
});

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

  it("puts a removed entry back where its last opening places it, with a browser folder's handle", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles);
    const handle = new MemoryDirectoryHandle("web").put("project.json", "{}");
    await recent.add({ name: "A", path: "/a" }, 1);
    const web = await recent.add({ name: "Web", path: "web", handle }, 2);
    await recent.add({ name: "C", path: "/c" }, 3);
    const removed = await recent.remove(web.id);
    expect(removed).toEqual({ entry: web, handle });
    expect(s.map.size).toBe(0);
    await recent.restore(removed!);
    expect(recent.list().map((e) => e.name)).toEqual(["C", "Web", "A"]);
    expect(await recent.handle(web.id)).toBe(handle);
    expect(await recent.check(web, null)).toBe("ok");
    expect(await recent.remove("not-there")).toBeNull();
  });

  it("doesn't restore a project that is on the list again, and keeps the limit when restoring", async () => {
    const s = stores();
    const recent = new RecentProjects(s.list, s.handles, 2);
    const a = await recent.add({ name: "A", path: "/a" }, 1);
    await recent.add({ name: "B", path: "/b" }, 2);
    const removed = (await recent.remove(a.id))!;
    await recent.add({ name: "A reopened", path: "/a/" }, 3); // reopened before Undo: a new entry for the same folder
    await recent.restore(removed);
    expect(recent.list().map((e) => e.name)).toEqual(["A reopened", "B"]);
    const b = recent.list()[1]!;
    const removedB = (await recent.remove(b.id))!;
    await recent.add({ name: "D", path: "/d" }, 4);
    await recent.restore(removedB); // the oldest of three falls off
    expect(recent.list().map((e) => e.name)).toEqual(["D", "A reopened"]);
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
  });

  it("carries its own change signal: its writes and another window's bump it (ADR 0318)", async () => {
    let text: string | null = null;
    let otherWindowWrote = () => {};
    const r = new RecentProjects({ read: () => text, write: (t) => void (text = t), subscribe: (changed) => void (otherWindowWrote = changed) }, null);
    const seen: number[] = [];
    const stop = effect(() => void seen.push(r.version.value));
    const entry = await r.add({ name: "A", path: "/a" });
    await r.remove(entry.id);
    text = JSON.stringify([{ ...entry, name: "From the editor window" }]);
    otherWindowWrote();
    stop();
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(r.list().map((e) => e.name)).toEqual(["From the editor window"]);
  });
});
