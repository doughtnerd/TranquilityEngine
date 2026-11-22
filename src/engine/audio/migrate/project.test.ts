/**
 * `migrateProjectAudio` over the editor's in-memory file system (`src/editor/memoryFs.ts`, Windows-style paths like
 * Tauri's on Windows), which also shows the editor's `FileSystem` is a `MigrationFileSystem`.
 */
import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { parsePlaylist } from "../playlist/format";
import type { SampleEntry } from "../playlist/types";
import { parseDerivedSample } from "../sample/format";
import { writeWavMetadata } from "../sample/wavChunks";
import { parseImportSettings } from "../../scene/importSettings";
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
const put = (fs: MemoryFileSystem, path: string, v: string | Uint8Array) => fs.files.set(`${ROOT}\\${path.replace(/\//g, "\\")}`, v);
/** A sidecar's loops as the engine reads them. */
const loopsOf = (fs: MemoryFileSystem, path: string) => {
  const { settings, problems } = parseImportSettings(JSON.parse(text(fs, path)!));
  expect(problems).toEqual([]);
  return settings.sample?.loops;
};
/** A project with only `events` (path → root node) and `files`. */
function small(events: Record<string, unknown>, files: Record<string, string | Uint8Array>): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  for (const [p, root] of Object.entries(events)) put(fs, p, event(root));
  for (const [p, v] of Object.entries(files)) put(fs, p, v);
  return fs;
}
const loopClip = (clip: string, extra: Record<string, unknown> = {}) => ({ type: "clip", clip, loop: true, ...extra });
const firstSample = (fs: MemoryFileSystem, path: string) => {
  const { playlist } = parsePlaylist(JSON.parse(text(fs, path)!));
  return (playlist.entries[0] as SampleEntry).sample;
};

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
    expect(report.written).toEqual(["audio/music.playlist.json", "audio/sfx/step.playlist.json", "audio/loop.wav.meta.json"]);
    expect(report.rewritten).toEqual(["prefabs/radio.prefab.json", "scenes/main.scene.json"]);
    expect(report.moved).toEqual([
      { from: "audio/music.audioevent.json", to: ".myco/migrated/audio/music.2.audioevent.json" },
      { from: "audio/sfx/step.audioevent.json", to: ".myco/migrated/audio/sfx/step.audioevent.json" },
    ]);
    expect(report.notes).toContain('audio/sfx/step.audioevent.json: "audio/missing.wav" isn\'t in the project; its length is unknown.');
    expect(report.notes).toContain("scripts/player.ts: names audio/sfx/step.audioevent.json; change it to audio/sfx/step.playlist.json by hand.");

    // The sustain clip's held loop spans the whole sample (its length read from the WAV header), in the sample's sidecar.
    const music = parsePlaylist(JSON.parse(text(fs, "audio/music.playlist.json")!));
    expect(music.problems).toEqual([]);
    expect(music.playlist.sequence!.length).toBe(2.5);
    expect(music.playlist.sequence!.loops).toEqual([]);
    expect(music.playlist.sequence!.tracks[0].clips[0].sample).toBe("audio/loop.wav");
    expect(loopsOf(fs, "audio/loop.wav.meta.json")).toMatchObject([{ id: "l1", start: 0, end: 2.5, active: "held", exit: "finish", file: null }]);
    expect(report.notes).toContain("audio/loop.wav.meta.json: written with the sample loop l1 at 0–2.5 s, held until release (exit finish) for audio/music.audioevent.json.");

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

describe("migrateProjectAudio: looping clips' loops go into the samples' sidecars (ADR 0328)", () => {
  it("writes a new sidecar holding the loop region as an endless loop; the clip plays the sample's loop", async () => {
    const fs = small({ "a.audioevent.json": loopClip("hum.wav", { loopRegion: [0.25, 1.25] }) }, { "hum.wav": wav(2) });
    const report = await migrateProjectAudio(fs, ROOT);
    expect(report.written).toEqual(["a.playlist.json", "hum.wav.meta.json"]);
    expect(firstSample(fs, "a.playlist.json")).toBe("hum.wav");
    expect(JSON.parse(text(fs, "hum.wav.meta.json")!)).toEqual({
      format: "myco.import@1",
      sample: {
        kind: "loop",
        loops: [{ id: "l1", start: 0.25, end: 1.25, direction: "forward", crossfadeMs: 20, count: 0, active: "always", exit: "finish", exitFadeMs: 0, reentry: "ignore", file: null }],
      },
    });
    expect(report.notes).toContain("hum.wav.meta.json: written with the sample loop l1 at 0.25–1.25 s, endless for a.audioevent.json.");
  });

  it("reuses an equal loop in the sidecar and writes nothing to it", async () => {
    const sidecar = JSON.stringify({ format: "myco.import@1", sample: { kind: "loop", loops: [{ id: "run", start: 0.25, end: 1.25, active: "always", exit: "finish", exitFadeMs: 0 }] } });
    const fs = small({ "a.audioevent.json": loopClip("hum.wav", { loopRegion: [0.25, 1.25] }) }, { "hum.wav": wav(2), "hum.wav.meta.json": sidecar });
    const report = await migrateProjectAudio(fs, ROOT);
    expect(report.written).toEqual(["a.playlist.json"]);
    expect(report.rewritten).toEqual([]);
    expect(text(fs, "hum.wav.meta.json")).toBe(sidecar);
    expect(firstSample(fs, "a.playlist.json")).toBe("hum.wav");
  });

  it("a loop clip with no region uses the sample's own loop when its sidecar has one", async () => {
    const sidecar = JSON.stringify({ format: "myco.import@1", sample: { loops: [{ id: "run", start: 0.5, end: 1, active: "always", exit: "finish", exitFadeMs: 0 }] } });
    const fs = small({ "a.audioevent.json": loopClip("hum.wav") }, { "hum.wav": wav(2), "hum.wav.meta.json": sidecar });
    await migrateProjectAudio(fs, ROOT);
    expect(text(fs, "hum.wav.meta.json")).toBe(sidecar);
    expect(firstSample(fs, "a.playlist.json")).toBe("hum.wav");
  });

  it("a sidecar with a different loop keeps it: the clip names a derived sample carrying its loop", async () => {
    const sidecar = JSON.stringify({ format: "myco.import@1", volume: 0.5, sample: { trim: [0, 1.9], loops: [{ id: "run", start: 0, end: 1 }] } });
    const fs = small({ "a.audioevent.json": loopClip("hum.wav", { loopRegion: [0.25, 1.25] }) }, { "hum.wav": wav(2), "hum.wav.meta.json": sidecar });
    const report = await migrateProjectAudio(fs, ROOT);
    expect(text(fs, "hum.wav.meta.json")).toBe(sidecar);
    expect(report.written).toEqual(["a.playlist.json", "hum.loop1.sample.json"]);
    expect(firstSample(fs, "a.playlist.json")).toBe("hum.loop1.sample.json");
    const { sample, problems } = parseDerivedSample(JSON.parse(text(fs, "hum.loop1.sample.json")!), "hum.loop1.sample.json");
    expect(problems).toEqual([]);
    expect(sample).toMatchObject({ format: "myco.sample@1", source: "hum.wav", range: null, lineage: { kind: "duplicate", parent: "hum.wav", mode: "follow" } });
    // The sample's own edits come along (its trim), with only the migrated loop.
    expect(sample.sample.trim).toEqual([0, 1.9]);
    expect(sample.sample.loops).toMatchObject([{ id: "l1", start: 0.25, end: 1.25, active: "always", file: null }]);
    expect(report.notes.some((n) => n.startsWith("hum.loop1.sample.json: a derived sample of hum.wav") && n.includes("already has a different loop"))).toBe(true);
  });

  it("two events wanting different loops on one file: the first goes in the sidecar, the second in a derived sample; equal requests share", async () => {
    const fs = small({
      "a.audioevent.json": loopClip("hum.wav", { loopRegion: [0.25, 1.25] }),
      "b.audioevent.json": { type: "clip", clip: "hum.wav", sustain: true, loopRegion: [0.5, 1.5] },
      "c.audioevent.json": { type: "clip", clip: "hum.wav", sustain: true, loopRegion: [0.5, 1.5] },
      "d.audioevent.json": loopClip("hum.wav", { loopRegion: [0.25, 1.25] }),
    }, { "hum.wav": wav(2) });
    const report = await migrateProjectAudio(fs, ROOT);
    expect(loopsOf(fs, "hum.wav.meta.json")).toMatchObject([{ start: 0.25, end: 1.25, active: "always" }]);
    expect(firstSample(fs, "a.playlist.json")).toBe("hum.wav");
    expect(firstSample(fs, "d.playlist.json")).toBe("hum.wav");
    const clipOf = (p: string) => parsePlaylist(JSON.parse(text(fs, p)!)).playlist.sequence!.tracks[0].clips[0].sample;
    expect(clipOf("b.playlist.json")).toBe("hum.loop1.sample.json");
    expect(clipOf("c.playlist.json")).toBe("hum.loop1.sample.json");
    expect(report.written.filter((p) => !p.endsWith(".playlist.json"))).toEqual(["hum.wav.meta.json", "hum.loop1.sample.json"]);
    expect(report.notes).toContain("hum.wav.meta.json: written with the sample loop l1 at 0.25–1.25 s, endless for a.audioevent.json, d.audioevent.json.");
    expect(report.notes.find((n) => n.startsWith("hum.loop1.sample.json"))).toContain("held until release (exit finish) for b.audioevent.json, c.audioevent.json");
  });

  it("a sidecar's other fields are untouched: only its sample block gains the loop (and is reported as rewritten)", async () => {
    const sidecar = { format: "myco.import@1", volume: 0.5, stream: true, custom: { kept: [1, 2] }, sample: { markers: [{ id: "m1", type: "cue", name: "spark", at: 0.3 }], root: { note: "C3", cents: 0, source: "set" } } };
    const fs = small({ "a.audioevent.json": { type: "clip", clip: "hum.wav", sustain: true, loopRegion: [0.5, 1.5] } }, { "hum.wav": wav(2), "hum.wav.meta.json": JSON.stringify(sidecar) });
    const report = await migrateProjectAudio(fs, ROOT);
    expect(report.rewritten).toEqual(["hum.wav.meta.json"]);
    const after = JSON.parse(text(fs, "hum.wav.meta.json")!);
    expect({ ...after, sample: undefined }).toEqual({ ...sidecar, sample: undefined });
    expect(after.sample.markers).toEqual([{ ...sidecar.sample.markers[0], file: null }]);
    expect(after.sample.root).toEqual(sidecar.sample.root);
    expect(after.sample.loops).toMatchObject([{ id: "l1", start: 0.5, end: 1.5, active: "held", exit: "finish", exitFadeMs: 0 }]);
    expect(report.notes).toContain("hum.wav.meta.json: now holds the sample loop l1 at 0.5–1.5 s, held until release (exit finish) for a.audioevent.json.");
  });

  it("a legacy loopStart/loopEnd loop becomes the sample block's loop for a clip with no region", async () => {
    const fs = small({ "a.audioevent.json": loopClip("hum.wav") }, { "hum.wav": wav(2), "hum.wav.meta.json": JSON.stringify({ format: "myco.import@1", loopStart: 0.5, loopEnd: 1.5 }) });
    await migrateProjectAudio(fs, ROOT);
    const after = JSON.parse(text(fs, "hum.wav.meta.json")!);
    expect(after).toMatchObject({ loopStart: 0.5, loopEnd: 1.5 });
    expect(loopsOf(fs, "hum.wav.meta.json")).toMatchObject([{ id: "l1", start: 0.5, end: 1.5, active: "always", exit: "finish", exitFadeMs: 0 }]);
    expect(firstSample(fs, "a.playlist.json")).toBe("hum.wav");
  });

  it("a WAV's own smpl loop is kept for a clip with no region (the old runtime looped it)", async () => {
    const bytes = writeWavMetadata(wav(2), { loops: [{ cueId: 0, type: 0, start: 4000, end: 12000, fraction: 0, playCount: 0 }] });
    const fs = small({ "a.audioevent.json": loopClip("hum.wav") }, { "hum.wav": bytes });
    await migrateProjectAudio(fs, ROOT);
    expect(loopsOf(fs, "hum.wav.meta.json")).toMatchObject([{ start: 0.5, end: 1.5, active: "always", exit: "finish", file: { chunk: "smpl", start: 0.5, end: 1.5 } }]);
  });

  it("a dry run reports the sidecars and derived samples it would write, and writes none", async () => {
    const make = () => small({
      "a.audioevent.json": loopClip("hum.wav", { loopRegion: [0.25, 1.25] }),
      "b.audioevent.json": loopClip("hum.wav", { loopRegion: [0.5, 1.5] }),
    }, { "hum.wav": wav(2) });
    const fs = make();
    const before = new Map(fs.files);
    const dry = await migrateProjectAudio(fs, ROOT, { dryRun: true });
    expect(fs.files).toEqual(before);
    expect(dry.written).toEqual(["a.playlist.json", "b.playlist.json", "hum.wav.meta.json", "hum.loop1.sample.json"]);
    expect(dry).toEqual(await migrateProjectAudio(make(), ROOT));
  });
});
