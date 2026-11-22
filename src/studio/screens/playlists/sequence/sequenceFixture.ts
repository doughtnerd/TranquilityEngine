// Fixture sequences for the Sequence view's tests and stories: the prototype's Brake sequence (a skid whose loop is
// overridden to run while `brake > 0.1` and re-enter, a volume envelope, a hold point at 1.6 s that jumps on release),
// two overlapping sync music clips (the "follows" lint), a playlist track, markers of each type; and what each sample
// tells the timeline (length, loops, markers, tempo). Data only.
import { emptyPlaylistBody } from "../../../../engine/audio/playlist/format";
import type { Clip, PlaylistBody, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import type { SourceFacts, SourceOf } from "./sequenceModel";

export const FIXTURE_SELF = "audio/vehicles/brake.playlist.json";

const clip = (id: string, patch: Partial<Clip>): Clip => ({
  id, at: 0, length: 0, offset: 0, gain: 0, pitch: 0, pan: 0, reverse: false, sync: false, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [], ...patch,
});

const track = (id: string, name: string, color: number, clips: Clip[], patch: Partial<Track> = {}): Track => ({
  id, name, kind: "audio", color, volume: 0, pan: 0, output: null, mute: false, solo: false, enabled: true, effects: [], automation: [], clips, ...patch,
});

export function fixtureSequence(): SequenceSettings {
  return {
    length: 6,
    tempo: { bpm: 120, meter: "4/4" },
    tracks: [
      track("t1", "Skid", 1, [
        clip("c1", {
          sample: "audio/brake_skid.wav", at: 0, length: 3,
          loops: { L1: { active: "parameter", binding: { parameter: "brake", op: ">", value: 0.1 }, reentry: "reenter" } },
          automation: [{ id: "a1", target: "volume", input: "clipTime", curve: [[0, -12], [0.5, 0], [2.5, 0], [3, -24]], bypass: false }],
          effects: [{ id: "fx1", type: "lowpass", on: true, params: { cutoff: 4000 } }],
        }),
      ], { automation: [{ id: "a1", target: "pan", input: "sequenceTime", curve: [[0, -0.5], [4, 0.5]], bypass: false }] }),
      track("t2", "Music", 4, [clip("c2", { sample: "audio/music_loop.wav", at: 0.5, length: 4, sync: true })]),
      track("t3", "Music B", 5, [clip("c3", { sample: "audio/music_loop.wav", at: 2, length: 2, sync: true })]),
      track("t4", "Stingers", 3, [clip("c4", { playlist: "audio/stingers.playlist.json", at: 2.5, length: 2 })], { kind: "playlist" }),
    ],
    loops: [{ id: "l1", start: 1.6, end: 1.6, active: "held", exit: "jump", exitFadeMs: 40, reentry: "ignore" }],
    markers: [
      { id: "m1", name: "Intro", at: 0.5 },
      { id: "m2", name: "Drop", at: 2, type: "exit" },
      { id: "m3", name: "Hit", at: 3.5, type: "cue" },
    ],
  };
}

export function fixtureBody(seq: SequenceSettings = fixtureSequence()): PlaylistBody {
  return { ...emptyPlaylistBody("sequence"), sequence: seq };
}

export const FIXTURE_SOURCES: Readonly<Record<string, SourceFacts>> = {
  "audio/brake_skid.wav": {
    length: 2,
    loops: [{ id: "L1", start: 0.4, end: 0.9, active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore" }],
    markers: [{ id: "k1", name: "Grip", at: 1.2, type: "exit" }, { id: "k2", name: "Squeal", at: 0.2, type: "note" }],
    kind: "sustain",
  },
  "audio/music_loop.wav": {
    length: 4,
    loops: [{ id: "L1", start: 1, end: 3, active: "always", exit: "finish", exitFadeMs: 40, reentry: "ignore" }],
    markers: [{ id: "e1", name: "Out", at: 2, type: "exit" }],
    kind: "music",
    bpm: 120,
  },
  "audio/stingers.playlist.json": { length: 1.5, loops: [], markers: [] },
  "audio/hit.wav": { length: 0.8, loops: [], markers: [], kind: "oneshot" },
};

export const fixtureSource: SourceOf = (c) => {
  const key = c.sample ?? (typeof c.playlist === "string" ? c.playlist : null);
  return key ? (FIXTURE_SOURCES[key] ?? null) : null;
};

/** Playlist files the fixture project has (for the tree drop's cycle check): stingers links back to the sequence's file in `loop.playlist.json`. */
export const FIXTURE_PLAYLISTS: Readonly<Record<string, PlaylistBody>> = {
  "audio/stingers.playlist.json": emptyPlaylistBody("queue"),
  "audio/loop.playlist.json": { ...emptyPlaylistBody("queue"), entries: [{ kind: "linked", playlist: FIXTURE_SELF, volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} }] },
};
export const loadFixturePlaylist = (path: string): PlaylistBody | null => FIXTURE_PLAYLISTS[path] ?? null;
