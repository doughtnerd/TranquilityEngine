// ADR 0166 task SM2, migrated to playlists (ADR 0343): the Sound Lab's music playlists
// (samples/sound-lab/audio/music/*.playlist.json, written by the audio event migration) read from disk. Each parses without
// a problem, its samples exist and are as long as the clips that play them (read from the WAV headers
// `tools/makeMusic.mjs` writes), and the lint finds only the stems' overlap (stems are sync clips on parallel tracks: the
// first drives the playhead). The rules the world playlist authors (a cut, crossfades, a transition, two stingers) and the
// loop playlist's parameter-bound loop are checked here as data; they play in
// `src/plugins/audio/runtime/playlists/soundLabPlaylists.test.ts` and the touch test's music page.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePlaylist } from "../audio/playlist/format";
import { lintPlaylist } from "../audio/playlist/lint";
import type { Entry, PlaylistBody } from "../audio/playlist/types";

const SAMPLE = fileURLToPath(new URL("../../../samples/sound-lab/", import.meta.url));

function load(name: string): { playlist: PlaylistBody; problems: string[] } {
  return parsePlaylist(JSON.parse(readFileSync(`${SAMPLE}audio/music/${name}.playlist.json`, "utf8")), name);
}

/** A mono 16-bit WAV's length in seconds, from its header. */
function seconds(path: string): number {
  const b = readFileSync(`${SAMPLE}${path}`);
  return b.readUInt32LE(40) / 2 / b.readUInt32LE(24);
}

const body = (e: Entry | undefined): PlaylistBody => {
  if (e?.kind !== "embedded") throw new Error("an embedded entry");
  return e.embedded;
};

/** Every sequence in `b` (itself, its entries, its clips' playlists). */
function sequences(b: PlaylistBody): PlaylistBody[] {
  const out: PlaylistBody[] = b.type === "sequence" ? [b] : [];
  for (const e of b.entries) if (e.kind === "embedded") out.push(...sequences(e.embedded));
  for (const t of b.sequence?.tracks ?? []) for (const c of t.clips) if (c.playlist && typeof c.playlist === "object") out.push(...sequences(c.playlist));
  return out;
}

/** The stem names of a sequence (its tracks). */
const stems = (b: PlaylistBody): string[] => (b.sequence?.tracks ?? []).map((t) => t.name);

describe("the Sound Lab's music playlists", () => {
  for (const name of ["music-world", "music-loop", "music-playlist", "music-stems8", "music-list3"]) {
    it(`${name}: parses without a problem, every sample clip is as long as its WAV, and the lint finds nothing (parallel stems are no problem)`, () => {
      const { playlist, problems } = load(name);
      expect(problems).toEqual([]);
      expect(playlist.output).toBe("Music");
      for (const s of sequences(playlist)) {
        expect(s.sequence!.tempo).toEqual({ bpm: 120, meter: "4/4" });
        for (const t of s.sequence!.tracks) for (const c of t.clips) if (c.sample) expect(seconds(c.sample)).toBeCloseTo(c.length, 2);
      }
      expect(lintPlaylist(playlist)).toEqual([]);
    });
  }

  it("the world playlist: a Switch on State, a rule for every pair (a cut, crossfades, a transition through the riser) and two stingers", () => {
    const { playlist } = load("music-world");
    expect(playlist.type).toBe("switch");
    expect(playlist.playback.plays).toBe("untilStopped");
    expect(playlist.parameters).toEqual([{ name: "State", labels: ["explore", "combat", "calm"], default: "explore" }]);
    const sw = playlist.switch!;
    expect(sw.parameter).toBe("State");
    expect(sw.map).toEqual({ explore: 0, combat: 1, calm: 2 });
    expect(playlist.entries.map((e) => stems(body(e)))).toEqual([["pad", "arp"], ["drums", "bass"], ["pad", "bells"]]);
    const rule = (from: string, to: string) => sw.rules.find((r) => r.from === from && r.to === to)!;
    expect([rule("explore", "combat").when, rule("explore", "combat").how]).toEqual(["bar", "cut"]);
    expect([rule("combat", "explore").how, rule("combat", "explore").length]).toEqual(["crossfade", { beats: 2 }]);
    expect([rule("explore", "calm").how, rule("explore", "calm").length]).toEqual(["crossfade", { beats: 4 }]);
    expect([rule("calm", "explore").how, rule("calm", "explore").length]).toEqual(["crossfade", { beats: 4 }]);
    const bridge = rule("calm", "combat");
    expect(bridge.how).toBe("transition");
    expect(stems(body(bridge.transition ?? undefined))).toEqual(["riser"]);
    expect(sw.onChange.when).toBe("bar");
    expect(playlist.stingers.map((s) => [s.trigger, s.at, s.ifLate])).toEqual([["hit", "beat", "nextGrid"], ["hitBar", "bar", "nextGrid"]]);
  });

  it("the loop playlist: a 2-bar loop held while Loop is hold, then its last bar", () => {
    const { playlist } = load("music-loop");
    const seq = playlist.sequence!;
    expect(seq.length).toBe(6);
    expect(seq.loops.map((l) => [l.start, l.end, l.active, l.binding, l.exit])).toEqual([[0, 4, "parameter", { parameter: "Loop", op: "<", value: 0.5 }, "finish"]]);
    expect(playlist.parameters).toEqual([{ name: "Loop", labels: ["hold", "release"], default: "hold" }]);
  });

  it("the playlist playlist: explore, calm and combat, two plays each, round robin until stopped", () => {
    const { playlist } = load("music-playlist");
    expect(playlist.type).toBe("queue");
    expect(playlist.queue).toEqual({ pick: "roundRobin", avoidRepeat: 0, continuous: { gapMs: 0 } });
    expect(playlist.entries.map((e) => body(e).sequence!.tracks[0]!.clips[0]!.sample)).toEqual([
      "audio/music/explore-pad.wav", "audio/music/explore-pad.wav", "audio/music/calm-pad.wav", "audio/music/calm-pad.wav",
      "audio/music/combat-drums.wav", "audio/music/combat-drums.wav",
    ]);
  });

  // L2: what the music page starts with 4 and 5, on the lab's 4 s stems.
  it("the eight-stem playlist: one looping sequence of pad, pulse, lead and melody twice; the melody streams", () => {
    const { playlist } = load("music-stems8");
    expect(stems(playlist)).toEqual(["pad-a", "pulse-a", "lead-a", "melody-a", "pad-b", "pulse-b", "lead-b", "melody-b"]);
    expect(playlist.sequence!.loops.map((l) => [l.start, l.end, l.active])).toEqual([[0, 4, "always"]]);
    const meta = JSON.parse(readFileSync(`${SAMPLE}audio/melody-loop.wav.meta.json`, "utf8")) as { stream?: boolean };
    expect(meta.stream).toBe(true);
  });

  it("the A, B, C playlist: three 4 s sections one after another, once through (a one-shot sequence)", () => {
    const { playlist } = load("music-list3");
    expect(playlist.type).toBe("sequence");
    expect(playlist.playback.plays).toBe("oneShot");
    const seq = playlist.sequence!;
    expect(seq.length).toBe(12);
    expect(seq.loops).toEqual([]);
    const clips = seq.tracks.flatMap((t) => t.clips);
    expect(clips.map((c) => [c.at, c.length, typeof c.playlist === "object" && c.playlist ? stems(c.playlist) : null])).toEqual([
      [0, 4, ["pad", "pulse"]],
      [4, 4, ["lead", "pulse"]],
      [8, 4, ["melody", "pad"]],
    ]);
  });
});
