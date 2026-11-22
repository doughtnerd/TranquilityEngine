import { describe, expect, it } from "vitest";
import { QUEUE, SEQUENCE, SWITCH } from "./__fixtures__/playlists";
import { parsePlaylist } from "./format";
import { playlistReferences, referencedPaths, rewritePlaylistReferences, wouldContain } from "./references";
import type { PlaylistBody } from "./types";

const parsed = (raw: unknown) => parsePlaylist(raw).playlist;

describe("playlistReferences", () => {
  it("lists every path a Queue names, embedded ones too", () => {
    expect(playlistReferences(parsed(QUEUE))).toEqual([
      { kind: "attenuation", path: "audio/attenuation/feet.attenuation.json", where: ["spatial", "attenuation"] },
      { kind: "playlist", path: "audio/footsteps/dirt_01.playlist.json", where: ["entries", 0, "playlist"] },
      { kind: "sample", path: "audio/dirt_02.wav", where: ["entries", 1, "embedded", "entries", 0, "sample"] },
    ]);
  });

  it("lists stingers and Switch transitions", () => {
    expect(playlistReferences(parsed(SWITCH)).map((r) => [r.kind, r.path, r.where.join(".")])).toEqual([
      ["playlist", "audio/music/explore.playlist.json", "entries.0.playlist"],
      ["playlist", "audio/music/combat.playlist.json", "entries.1.playlist"],
      ["playlist", "audio/music/victory.playlist.json", "stingers.0.playlist.playlist"],
      ["playlist", "audio/music/bridge.playlist.json", "switch.rules.0.transition.playlist"],
    ]);
  });

  it("lists sequence clip sources, embedded clip playlists too", () => {
    expect(referencedPaths(parsed(SEQUENCE))).toEqual(["audio/brake_skid.wav", "audio/hover/whine.playlist.json", "audio/hiss.wav"]);
    expect(referencedPaths(parsed(SEQUENCE), "sample")).toEqual(["audio/brake_skid.wav", "audio/hiss.wav"]);
  });

  it("lists each path once in referencedPaths", () => {
    const p = parsed({ format: "myco.playlist@1", type: "layer", entries: [{ playlist: "a.playlist.json" }, { playlist: "a.playlist.json" }] });
    expect(playlistReferences(p)).toHaveLength(2);
    expect(referencedPaths(p)).toEqual(["a.playlist.json"]);
  });
});

describe("rewritePlaylistReferences", () => {
  it("moves the named paths and shares everything else", () => {
    const p = parsed(QUEUE);
    const out = rewritePlaylistReferences(p, { "audio/dirt_02.wav": "audio/dirt/dirt_02.wav" });
    expect(referencedPaths(out)).toEqual(["audio/attenuation/feet.attenuation.json", "audio/footsteps/dirt_01.playlist.json", "audio/dirt/dirt_02.wav"]);
    expect(out.entries[0]).toBe(p.entries[0]);
    expect(out.effects).toBe(p.effects);
    // The original is untouched.
    expect(referencedPaths(p)).toContain("audio/dirt_02.wav");
  });

  it("takes a function for folder moves and a Map", () => {
    const p = parsed(SEQUENCE);
    const folder = rewritePlaylistReferences(p, (path) => path.replace(/^audio\/hover\//, "audio/vehicles/hover/"));
    expect(referencedPaths(folder)).toContain("audio/vehicles/hover/whine.playlist.json");
    const map = rewritePlaylistReferences(parsed(SWITCH), new Map([["audio/music/bridge.playlist.json", "audio/music/bridges/a.playlist.json"]]));
    expect(map.switch!.rules[0].transition).toMatchObject({ kind: "linked", playlist: "audio/music/bridges/a.playlist.json" });
  });

  it("returns the same object when nothing moves", () => {
    const p = parsed(QUEUE);
    expect(rewritePlaylistReferences(p, { "other.wav": "x.wav" })).toBe(p);
    expect(rewritePlaylistReferences(p, (x) => x)).toBe(p);
  });
});

describe("wouldContain", () => {
  const files: Record<string, PlaylistBody> = {
    "a.playlist.json": parsed({ format: "myco.playlist@1", type: "layer", entries: [{ playlist: "b.playlist.json" }] }),
    "b.playlist.json": parsed({ format: "myco.playlist@1", type: "sequence", entries: [], sequence: { tracks: [{ id: "t", name: "T", kind: "playlist", clips: [{ id: "c", playlist: "c.playlist.json", at: 0, length: 1 }] }] } }),
    "c.playlist.json": parsed({ format: "myco.playlist@1", type: "queue", entries: [{ embedded: { type: "layer", entries: [{ playlist: "d.playlist.json" }] } }] }),
    "d.playlist.json": parsed({ format: "myco.playlist@1", type: "clip", entries: [{ sample: "d.wav" }] }),
    "loop1.playlist.json": parsed({ format: "myco.playlist@1", type: "layer", entries: [{ playlist: "loop2.playlist.json" }] }),
    "loop2.playlist.json": parsed({ format: "myco.playlist@1", type: "layer", entries: [{ playlist: "loop1.playlist.json" }] }),
  };
  const loads: string[] = [];
  const load = (path: string) => { loads.push(path); return files[path]; };

  it("refuses a playlist inside itself", () => {
    expect(wouldContain("a.playlist.json", "a.playlist.json", load)).toBe(true);
  });

  it("follows links through entries, sequence clips and embedded playlists", () => {
    expect(wouldContain("d.playlist.json", "a.playlist.json", load)).toBe(true);
    expect(wouldContain("a.playlist.json", "d.playlist.json", load)).toBe(false);
  });

  it("checks a body about to be embedded", () => {
    const body = parsed({ format: "myco.playlist@1", type: "layer", entries: [{ playlist: "c.playlist.json" }] });
    expect(wouldContain("d.playlist.json", body, load)).toBe(true);
    expect(wouldContain("a.playlist.json", body, load)).toBe(false);
  });

  it("ends on existing cycles and missing files, loading each file once", () => {
    loads.length = 0;
    expect(wouldContain("x.playlist.json", "loop1.playlist.json", load)).toBe(false);
    expect(loads.sort()).toEqual(["loop1.playlist.json", "loop2.playlist.json"]);
    expect(wouldContain("x.playlist.json", "missing.playlist.json", () => null)).toBe(false);
  });
});
