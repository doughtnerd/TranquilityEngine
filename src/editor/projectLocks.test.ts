import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "./memoryFs";
import { joinPath } from "./projectPaths";
import {
  acquireLock,
  chainMoves,
  otherAppHolds,
  parseLock,
  parsePendingMoves,
  readLock,
  recordPendingMoves,
  takePendingMoves,
  PENDING_MOVES_FILE,
} from "./projectLocks";

const ROOT = "C:\\Games\\demo";
const at = (path: string) => joinPath(ROOT, path);
const NOW = new Date("2026-11-22T10:00:00.000Z");

describe("project locks", () => {
  it("an app holds its lock while it has the project open, and the other app sees it", async () => {
    const fs = new MemoryFileSystem();
    expect(await otherAppHolds(fs, ROOT, "studio")).toBeNull();
    const held = await acquireLock(fs, ROOT, "editor", 4242, NOW);
    expect(JSON.parse(fs.files.get(at(".myco/locks/editor.json")) as string)).toEqual({ app: "editor", pid: 4242, started: NOW.toISOString() });
    expect(await otherAppHolds(fs, ROOT, "studio")).toEqual({ app: "editor", pid: 4242, started: NOW.toISOString() });
    expect(await otherAppHolds(fs, ROOT, "editor")).toBeNull(); // the Studio holds nothing
    await held.release();
    expect(fs.files.has(at(".myco/locks/editor.json"))).toBe(false);
    expect(await otherAppHolds(fs, ROOT, "studio")).toBeNull();
    await held.release(); // twice is fine
  });

  it("releasing leaves a newer lock of the same app alone", async () => {
    const fs = new MemoryFileSystem();
    const first = await acquireLock(fs, ROOT, "studio", null, NOW);
    await acquireLock(fs, ROOT, "studio", null, new Date("2026-11-22T11:00:00.000Z")); // opened again in another window
    await first.release();
    expect((await readLock(fs, ROOT, "studio")).lock?.started).toBe("2026-11-22T11:00:00.000Z");
  });

  it("reads a bad lock file as no lock, saying why", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(at(".myco/locks/editor.json"), "{oops");
    const read = await readLock(fs, ROOT, "editor");
    expect(read.lock).toBeNull();
    expect(read.problem?.message).toMatch(/not valid JSON/);
    expect(parseLock(`{"app":"game"}`).problem?.message).toMatch(/names no app/);
    expect(parseLock(`{"app":"studio","pid":-3}`).lock).toEqual({ app: "studio", pid: null, started: "" });
  });
});

describe("pending moves", () => {
  it("the Studio records moves, chained after those already waiting; the editor takes them once", async () => {
    const fs = new MemoryFileSystem();
    await recordPendingMoves(fs, ROOT, [{ from: "sfx/a.wav", to: "sfx/b.wav" }]);
    await recordPendingMoves(fs, ROOT, [{ from: "sfx/b.wav", to: "audio/b.wav" }, { from: "music", to: "audio/music" }]);
    expect(await takePendingMoves(fs, ROOT)).toEqual({
      moves: [
        { from: "sfx/a.wav", to: "audio/b.wav" },
        { from: "music", to: "audio/music" },
      ],
      problems: [],
    });
    expect(fs.files.has(at(PENDING_MOVES_FILE))).toBe(false);
    expect(await takePendingMoves(fs, ROOT)).toEqual({ moves: [], problems: [] });
  });

  it("chains moves of a file and of the folder holding it, and drops moves that come back", () => {
    expect(chainMoves([{ from: "a/x.wav", to: "b/x.wav" }], [{ from: "b", to: "c" }])).toEqual([
      { from: "a/x.wav", to: "c/x.wav" },
      { from: "b", to: "c" },
    ]);
    expect(chainMoves([{ from: "a.wav", to: "b.wav" }], [{ from: "b.wav", to: "a.wav" }])).toEqual([]);
  });

  it("skips bad entries with a problem, reads a bare list, and deletes a file it can't parse", async () => {
    const read = parsePendingMoves(JSON.stringify({ moves: [{ from: "a", to: "b" }, { from: "../x", to: "y" }, { from: "C:/x", to: "y" }, { to: "z" }, { from: "same", to: "same" }] }));
    expect(read.moves).toEqual([{ from: "a", to: "b" }]);
    expect(read.problems).toHaveLength(3);
    expect(parsePendingMoves(`[{"from":"a","to":"b"}]`).moves).toEqual([{ from: "a", to: "b" }]);
    const fs = new MemoryFileSystem();
    fs.files.set(at(PENDING_MOVES_FILE), "not json");
    const taken = await takePendingMoves(fs, ROOT);
    expect(taken.moves).toEqual([]);
    expect(taken.problems[0]).toMatch(/isn't valid JSON/);
    expect(fs.files.has(at(PENDING_MOVES_FILE))).toBe(false);
  });
});
