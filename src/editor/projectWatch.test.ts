import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "./memoryFs";
import { joinPath } from "./projectPaths";
import { changedStamps, classifyChanges, projectRelative, watchProject, type ProjectChanges } from "./projectWatch";

const ROOT = "C:\\Games\\demo";
const at = (path: string) => joinPath(ROOT, path);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("sorting what a watch reports", () => {
  it("makes paths project-relative, without case on Windows", () => {
    expect(projectRelative(ROOT, "C:\\Games\\demo\\music\\a.wav")).toBe("music/a.wav");
    expect(projectRelative(ROOT, "c:/games/DEMO/music/a.wav")).toBe("music/a.wav");
    expect(projectRelative(ROOT, "C:\\Games\\demo")).toBe("");
    expect(projectRelative(ROOT, "C:\\Games\\demo2\\x.json")).toBeNull();
    expect(projectRelative("/home/me/game", "/home/me/Game/x.json")).toBeNull(); // case counts elsewhere
    expect(projectRelative("/home/me/game/", "/home/me/game/x.json")).toBe("x.json");
  });

  it("tells project files, scripts, locks and pending moves apart, and skips the rest", () => {
    const changes = classifyChanges(ROOT, [
      at("audio.json"),
      at("music/a.wav"),
      at("music/a.wav"), // twice
      at("music/a.wav.meta.json"),
      at("music"), // a folder that came or went
      at("scripts/Bird.ts"),
      at("plugins/tool/index.ts"),
      at(".myco/locks/studio.json"),
      at(".myco/locks/pending-moves.json"),
      at(".myco/locks/other.json"),
      at(".myco/asset-history/x.json"),
      at(".git/index"),
      at("node_modules/pkg/index.js"),
      at("scenes/main.scene.json.tmp-k2x9ab"),
      at("scenes/main.scene.json.crswap"),
      at("scripts/types.d.ts"),
      "D:\\elsewhere\\a.json",
      ROOT,
    ]);
    expect(changes).toEqual<ProjectChanges>({
      files: ["audio.json", "music/a.wav", "music/a.wav.meta.json", "music"],
      scripts: ["scripts/Bird.ts", "plugins/tool/index.ts"],
      pendingMoves: true,
      locks: ["studio"],
    });
  });

  it("finds what changed between two looks", () => {
    const before = new Map([["a", "1:1"], ["b", "2:2"], ["c", "3:3"]]);
    const after = new Map([["a", "1:1"], ["b", "2:9"], ["d", "4:4"]]);
    expect(changedStamps(before, after).sort()).toEqual(["b", "c", "d"]);
  });
});

/** A desktop-like file system: `fire` reports changed paths, as Tauri's `watch` does. */
class WatchedFs extends MemoryFileSystem {
  listeners = new Set<(paths: string[]) => void>();
  async watch(_path: string, onChange: (paths: string[]) => void) {
    this.listeners.add(onChange);
    return () => void this.listeners.delete(onChange);
  }
  fire(...paths: string[]) {
    for (const l of this.listeners) l(paths);
  }
}

/** A browser-like file system: no events, but stamps of every file to compare (as `FsaFileSystem.stamps`). */
class StampedFs extends MemoryFileSystem {
  async stamps(path: string, skipFolder?: (name: string) => boolean) {
    const out = new Map<string, string>();
    const prefix = path.replace(/\//g, "\\") + "\\";
    for (const [key, v] of this.files) {
      if (!key.startsWith(prefix)) continue;
      if (key.slice(prefix.length).split("\\").slice(0, -1).some((n) => skipFolder?.(n))) continue;
      out.set(key, typeof v === "string" ? `${v.length}:${v}` : `${v.length}:${[...v].join(",")}`);
    }
    return out;
  }
}

describe("watching a project folder", () => {
  it("live: hands each batch on in order, one at a time, and stops", async () => {
    const fs = new WatchedFs();
    const seen: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const watch = await watchProject(fs, ROOT, async (c) => {
      seen.push([...c.files]);
      if (seen.length === 1) await gate; // the first batch is slow
    });
    expect(watch.mode).toBe("live");
    fs.fire(at("a.json"));
    fs.fire(at(".myco/asset-history/x.json")); // nothing to hand on
    fs.fire(at("b.json"));
    await flush();
    expect(seen).toEqual([["a.json"]]);
    release();
    await watch.rescan();
    expect(seen).toEqual([["a.json"], ["b.json"]]);
    watch.stop();
    fs.fire(at("c.json"));
    await flush();
    expect(seen).toHaveLength(2);
    expect(fs.listeners.size).toBe(0);
  });

  it("an error in one batch doesn't stop the next", async () => {
    const fs = new WatchedFs();
    const errors: unknown[] = [];
    const seen: string[] = [];
    const watch = await watchProject(
      fs,
      ROOT,
      (c) => {
        if (c.files[0] === "bad.json") throw new Error("boom");
        seen.push(...c.files);
      },
      (err) => errors.push(err),
    );
    fs.fire(at("bad.json"));
    fs.fire(at("good.json"));
    await watch.rescan();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual(["good.json"]);
  });

  it("on demand (browser): looks when asked, against the last look, skipping hidden and dependency folders", async () => {
    const fs = new StampedFs();
    fs.files.set(at("a.json"), "{}");
    fs.files.set(at("old.json"), "{}");
    const seen: ProjectChanges[] = [];
    const watch = await watchProject(fs, ROOT, (c) => void seen.push(c));
    expect(watch.mode).toBe("on-demand");
    await watch.rescan();
    expect(seen).toEqual([]); // nothing changed since it started
    fs.files.set(at("a.json"), '{"n":1}');
    fs.files.delete(at("old.json"));
    fs.files.set(at("new.wav"), new Uint8Array([1]));
    fs.files.set(at("node_modules/x/package.json"), "{}");
    fs.files.set(at(".myco/locks/pending-moves.json"), "[]");
    await Promise.all([watch.rescan(), watch.rescan()]); // one look shared
    expect(seen).toHaveLength(1);
    expect([...seen[0].files].sort()).toEqual(["a.json", "new.wav", "old.json"]);
    expect(seen[0].pendingMoves).toBe(false); // .myco is skipped while looking: the editor checks pending moves on every batch
  });

  it("can't watch a project in memory, and says so", async () => {
    const watch = await watchProject(new MemoryFileSystem(), ROOT, () => {});
    expect(watch.mode).toBe("none");
    await watch.rescan();
  });
});
