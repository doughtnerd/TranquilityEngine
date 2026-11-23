// ADR 0343 "Migration" (D11): opening a project with old audio events asks once and, on yes, migrates them through the
// app's file system before anything reads the files; declined, nothing changes. Over the in-memory file system.
import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem } from "./memoryFs";
import { migrationQuestion, migrationSummary, offerAudioEventMigration, runAudioEventMigration } from "./audioEventMigration";

const ROOT = "C:\\games\\demo";
const event = (clip: string) => JSON.stringify({ format: "myco.audioevent@1", root: { type: "clip", clip } });

function project(events = 2): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  const put = (path: string, v: string | Uint8Array) => fs.files.set(`${ROOT}\\${path.replace(/\//g, "\\")}`, v);
  put("project.json", JSON.stringify({ name: "Demo" }));
  put("scenes/main.scene.json", JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "a", components: [{ type: "engine.AudioSource", data: { clip: "audio/e1.audioevent.json" } }] }] }));
  for (let i = 1; i <= events; i++) put(`audio/e${i}.audioevent.json`, event(`audio/c${i}.ogg`));
  return fs;
}
const has = (fs: MemoryFileSystem, path: string) => fs.files.has(`${ROOT}\\${path.replace(/\//g, "\\")}`);
const text = (fs: MemoryFileSystem, path: string) => fs.files.get(`${ROOT}\\${path.replace(/\//g, "\\")}`) as string;

describe("offering the migration when a project opens", () => {
  it("asks once, naming the count and where the copies go, and on yes migrates every event to a playlist", async () => {
    const fs = project();
    const confirm = vi.fn(async (_question: unknown) => true);
    const log = vi.fn();
    const outcome = await offerAudioEventMigration(fs, ROOT, confirm, log);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({
      message: "This project uses the old audio event format; migrate 2 files to playlists? A copy of each goes to .myco/migrated/.",
      items: ["audio/e1.audioevent.json", "audio/e2.audioevent.json"],
      confirmLabel: "Migrate",
    });
    expect(outcome.kind).toBe("migrated");
    expect(has(fs, "audio/e1.playlist.json") && has(fs, "audio/e2.playlist.json")).toBe(true);
    expect(has(fs, "audio/e1.audioevent.json")).toBe(false);
    expect(has(fs, ".myco/migrated/audio/e1.audioevent.json")).toBe(true);
    expect(JSON.parse(text(fs, "scenes/main.scene.json")).nodes[0].components[0].data.clip).toBe("audio/e1.playlist.json");
    expect(log.mock.calls[0]![0]).toMatch(/Migrated 2 audio events to playlists/);
  });

  it("declined, changes nothing and says which files are left", async () => {
    const fs = project();
    const before = new Map(fs.files);
    const outcome = await offerAudioEventMigration(fs, ROOT, async () => false);
    expect(outcome).toEqual({ kind: "declined", files: ["audio/e1.audioevent.json", "audio/e2.audioevent.json"] });
    expect(fs.files).toEqual(before);
  });

  it("doesn't ask about a project without old events, or a folder it can't write", async () => {
    const confirm = vi.fn(async () => true);
    expect(await offerAudioEventMigration(project(0), ROOT, confirm)).toEqual({ kind: "none" });
    const readOnly = Object.assign(project(), { canWrite: false });
    expect(await offerAudioEventMigration(readOnly, ROOT, confirm)).toEqual({ kind: "none" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("reports a file system failure instead of throwing", async () => {
    const fs = project();
    fs.rename = async () => {
      throw new Error("disk full");
    };
    expect(await runAudioEventMigration(fs, ROOT, () => {})).toEqual({ kind: "failed", files: ["audio/e1.audioevent.json", "audio/e2.audioevent.json"], error: "disk full" });
  });
});

describe("the words", () => {
  it("lists at most eight files and counts the rest; one file is singular", () => {
    const many = Array.from({ length: 11 }, (_, i) => `e${i}.audioevent.json`);
    expect(migrationQuestion(many).items).toHaveLength(9);
    expect(migrationQuestion(many).items.at(-1)).toBe("and 3 more");
    expect(migrationQuestion(["a.audioevent.json"]).message).toMatch(/migrate 1 file to playlists/);
  });

  it("summarises a report", () => {
    expect(migrationSummary({ written: ["a.playlist.json"], rewritten: [], moved: [], notes: ["x", "y"] })).toBe(
      "Migrated 1 audio event to playlists; the old files are in .myco/migrated/. 2 notes in the console.",
    );
  });
});
