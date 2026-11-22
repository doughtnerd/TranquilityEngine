/**
 * `migrateProjectAudio` over the editor's in-memory file system (`src/editor/memoryFs.ts`, Windows-style paths like
 * Tauri's on Windows), which also shows the editor's `FileSystem` is a `MigrationFileSystem`.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { parsePlaylist } from "../playlist/format";
import { findAudioEvents, migrateProjectAudio, type MigrationFileSystem } from "./project";

const ROOT = "C:\\games\\demo";

function wav(seconds: number, rate = 8000): Uint8Array {
  const frames = Math.round(seconds * rate);
  const b = new Uint8Array(44 + frames * 2);
  const v = new DataView(b.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, 36 + frames * 2, true); tag(8, "WAVE");
  tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, frames * 2, true);
  return b;
}

const event = (root: unknown) => JSON.stringify({ format: "myco.audioevent@1", root }, null, 2);
const SCENE = `{
  "format": "myco.scene@1",
  "nodes": [
    { "id": "a", "components": [{ "type": "engine.AudioSource", "data": { "clip": "asset:audio/music.audioevent.json", "playOnAwake": true } }] },
    { "id": "b", "components": [{ "type": "engine.AudioSource", "data": { "clip": "audio/step.wav" } }] }
  ],
  "audio/music.audioevent.json": "a key, not a reference"
}
`;

function project(): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  const put = (path: string, v: string | Uint8Array) => fs.files.set(`${ROOT}\\${path.replace(/\//g, "\\")}`, v);
  put("project.json", JSON.stringify({ name: "Demo", startScene: "scenes/main.scene.json" }));
  put("scenes/main.scene.json", SCENE);
  put("prefabs/radio.prefab.json", JSON.stringify({ format: "myco.prefab@1", clip: "./audio/sfx/step.audioevent.json" }));
  put("audio/music.audioevent.json", event({ type: "clip", clip: "audio/loop.wav", sustain: true }));
  put("audio/sfx/step.audioevent.json", event({ type: "random", children: [{ type: "clip", clip: "audio/step.wav" }, { type: "clip", clip: "audio/missing.wav" }] }));
  put("audio/loop.wav", wav(2.5));
  put("audio/step.wav", wav(0.25));
  put("scripts/player.ts", `Audio.play("audio/sfx/step.audioevent.json");`);
  put(".myco/migrated/audio/music.audioevent.json", "an earlier run's copy");
  return fs;
}

const text = (fs: MemoryFileSystem, path: string) => fs.files.get(`${ROOT}\\${path.replace(/\//g, "\\")}`) as string | undefined;

describe("migrateProjectAudio", () => {
  it("is satisfied by the editor's FileSystem", () => {
    const fs: MigrationFileSystem = new MemoryFileSystem();
    expect(fs).toBeDefined();
  });

  it("finds the project's audio events, skipping dot folders", async () => {
    expect(await findAudioEvents(project(), ROOT)).toEqual(["audio/music.audioevent.json", "audio/sfx/step.audioevent.json"]);
  });

  it("writes playlists with the samples' lengths, rewrites references, moves the old files and reports it all", async () => {
    const fs = project();
    const report = await migrateProjectAudio(fs, ROOT);
    expect(report.written).toEqual(["audio/music.playlist.json", "audio/sfx/step.playlist.json"]);
    expect(report.rewritten).toEqual(["prefabs/radio.prefab.json", "scenes/main.scene.json"]);
    expect(report.moved).toEqual([
      { from: "audio/music.audioevent.json", to: ".myco/migrated/audio/music.2.audioevent.json" },
      { from: "audio/sfx/step.audioevent.json", to: ".myco/migrated/audio/sfx/step.audioevent.json" },
    ]);
    expect(report.notes).toContain('audio/sfx/step.audioevent.json: "audio/missing.wav" isn\'t in the project; its length is unknown.');
    expect(report.notes).toContain("scripts/player.ts: names audio/sfx/step.audioevent.json; change it to audio/sfx/step.playlist.json by hand.");

    // The sustain's held loop spans the whole sample, read from the WAV header.
    const music = parsePlaylist(JSON.parse(text(fs, "audio/music.playlist.json")!));
    expect(music.problems).toEqual([]);
    expect(music.playlist.sequence!.length).toBe(2.5);
    expect(music.playlist.sequence!.loops[0]).toMatchObject({ start: 0, end: 2.5, active: "held" });

    // References: the prefix and layout are kept, keys and other strings are not touched.
    expect(text(fs, "scenes/main.scene.json")).toBe(SCENE.replace('"asset:audio/music.audioevent.json"', '"asset:audio/music.playlist.json"'));
    expect(JSON.parse(text(fs, "prefabs/radio.prefab.json")!).clip).toBe("./audio/sfx/step.playlist.json");
    expect(text(fs, "scripts/player.ts")).toContain("step.audioevent.json");

    expect(text(fs, "audio/music.audioevent.json")).toBeUndefined();
    expect(text(fs, ".myco/migrated/audio/music.2.audioevent.json")).toBe(event({ type: "clip", clip: "audio/loop.wav", sustain: true }));
    expect(text(fs, ".myco/migrated/audio/music.audioevent.json")).toBe("an earlier run's copy");
    expect(await findAudioEvents(fs, ROOT)).toEqual([]);
  });

  it("changes nothing on a dry run but reports the same", async () => {
    const fs = project();
    const before = new Map(fs.files);
    const dry = await migrateProjectAudio(fs, ROOT, { dryRun: true });
    expect(fs.files).toEqual(before);
    expect(dry).toEqual(await migrateProjectAudio(project(), ROOT));
  });

  it("does nothing in a project without audio events, and a second run finds nothing to do", async () => {
    const fs = project();
    await migrateProjectAudio(fs, ROOT);
    const after = new Map(fs.files);
    expect(await migrateProjectAudio(fs, ROOT)).toEqual({ written: [], rewritten: [], moved: [], notes: [] });
    expect(fs.files).toEqual(after);
  });

  it("leaves an event whose playlist path is taken where it is, with a note", async () => {
    const fs = project();
    fs.files.set(`${ROOT}\\audio\\music.playlist.json`, "{}");
    const report = await migrateProjectAudio(fs, ROOT);
    expect(report.moved.map((m) => m.from)).toEqual(["audio/sfx/step.audioevent.json"]);
    expect(report.notes.some((n) => n.startsWith("audio/music.audioevent.json: audio/music.playlist.json already exists"))).toBe(true);
    expect(text(fs, "scenes/main.scene.json")).toBe(SCENE);
  });
});
