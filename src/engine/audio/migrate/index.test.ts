/** `migrateProjectAudioEvents` (ADR 0329 §"Migration"): every event file becomes a playlist beside it. */
import { describe, expect, it } from "vitest";
import { emptyPlaylist, parsePlaylist } from "../playlist/format";
import { migrateProjectAudioEvents, playlistPathFor, writePlaylistText } from "./index";

const event = (root: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ format: "myco.audioevent@1", root, ...extra });

describe("migrateProjectAudioEvents", () => {
  it("writes a playlist beside each event, deletes the event and reports the move; other files are untouched", () => {
    const files = new Map([
      ["audio/step.audioevent.json", event({ type: "clip", clip: "audio/step.wav" })],
      ["audio/Loud.AudioEvent.json", event({ type: "clip", clip: "audio/loud.wav" })],
      ["scenes/main.scene.json", "{}"],
    ]);
    const r = migrateProjectAudioEvents(files);
    expect([...r.writes.keys()].sort()).toEqual(["audio/Loud.playlist.json", "audio/step.playlist.json"]);
    expect(r.deletes).toEqual(["audio/Loud.AudioEvent.json", "audio/step.audioevent.json"]);
    expect(r.references).toEqual([
      { from: "audio/Loud.AudioEvent.json", to: "audio/Loud.playlist.json" },
      { from: "audio/step.audioevent.json", to: "audio/step.playlist.json" },
    ]);
    const text = r.writes.get("audio/step.playlist.json")!;
    expect(text.endsWith("\n")).toBe(true);
    expect(parsePlaylist(JSON.parse(text)).playlist).toMatchObject({ format: "myco.playlist@1", type: "clip", entries: [{ kind: "sample", sample: "audio/step.wav" }] });
    expect(r.notes).toEqual([]);
  });

  it("skips an event whose playlist path is taken, and one that isn't JSON, with notes", () => {
    const r = migrateProjectAudioEvents(new Map([
      ["a.audioevent.json", event({ type: "clip", clip: "a.wav" })],
      ["a.playlist.json", "{}"],
      ["b.audioevent.json", "{ nope"],
    ]));
    expect(r.writes.size).toBe(0);
    expect(r.deletes).toEqual([]);
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/^a\.audioevent\.json: a\.playlist\.json already exists/);
    expect(r.notes[1]).toMatch(/^b\.audioevent\.json: not valid JSON/);
  });

  it("passes the old file's parse problems and the migration's notes through, each with its path", () => {
    const r = migrateProjectAudioEvents(new Map([["x.audioevent.json", event({ type: "clip", clip: "x.wav", loop: true }, { volume: 9 })]]));
    expect(r.notes.some((n) => n.startsWith("x.audioevent.json: volume: 9 is outside"))).toBe(true);
    expect(r.notes.some((n) => n.startsWith("x.audioevent.json root:") && n.includes(`"inherit"`))).toBe(true);
  });

  it("passes sample lengths through", () => {
    const r = migrateProjectAudioEvents(new Map([["x.audioevent.json", event({ type: "clip", clip: "x.wav", sustain: true })]]), { sampleSeconds: () => 3 });
    expect(JSON.parse(r.writes.get("x.playlist.json")!).sequence.length).toBe(3);
  });

  it("names the playlist after the event and writes two-space JSON", () => {
    expect(playlistPathFor("a/b/c.audioevent.json")).toBe("a/b/c.playlist.json");
    const text = writePlaylistText(emptyPlaylist("clip"));
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")[1]).toBe('  "format": "myco.playlist@1",');
  });
});
