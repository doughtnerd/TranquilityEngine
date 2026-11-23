import { describe, expect, it } from "vitest";
import { QUEUE, SEQUENCE, SWITCH } from "./__fixtures__/playlists";
import { parsePlaylist } from "./format";
import {
  playlistLocalParameterNames, playlistParameterReferences, playlistReferences, referencedPaths, renamePlaylistParameter, rewritePlaylistReferences, wouldContain,
} from "./references";
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

describe("playlist parameter references", () => {
  const json = {
    format: "myco.playlist@1",
    type: "switch",
    parameters: [{ name: "gear", min: 0, max: 5, default: 0 }],
    automation: [{ id: "i", target: "volume", input: { parameter: "speed" }, curve: [[0, 0]] }, { id: "t", target: "pan", input: "voiceTime", curve: [[0, 0]] }],
    switch: { parameter: "surface", map: {}, onChange: { transition: { embedded: { type: "blend", entries: [], blend: { axes: ["speed", { voiceTime: 2 }] } } } }, rules: [{ from: "*", to: "a", transition: { playlist: "x.playlist.json" } }] },
    entries: [
      { sample: "a.wav", curves: { gain: { input: "gear" }, pitch: { input: "clipTime" } } },
      {
        embedded: {
          type: "sequence",
          entries: [],
          sequence: {
            tracks: [{ automation: [{ input: { parameter: "speed" } }], clips: [{ automation: [{ input: "sequenceTime" }], loops: { l: { binding: { parameter: "gear" } } }, playlist: { type: "clip", automation: [{ input: { parameter: "speed" } }], entries: [] } }] }],
            loops: [{ binding: { parameter: "surface" } }],
          },
        },
      },
    ],
    stingers: [{ playlist: { embedded: { type: "clip", entries: [{ sample: "s.wav", curves: { lowpass: { input: { parameter: "surface" } } } }] } } }],
  };

  it("lists every name a playlist reads, in file order, with where it sits (times aren't parameters)", () => {
    expect(playlistParameterReferences(json).map((r) => [r.use, r.name, r.where.join(".")])).toEqual([
      ["definition", "gear", "parameters.0.name"],
      ["automation", "speed", "automation.0.input.parameter"],
      ["curve", "gear", "entries.0.curves.gain.input"],
      ["automation", "speed", "entries.1.embedded.sequence.tracks.0.automation.0.input.parameter"],
      ["binding", "gear", "entries.1.embedded.sequence.tracks.0.clips.0.loops.l.binding.parameter"],
      ["automation", "speed", "entries.1.embedded.sequence.tracks.0.clips.0.playlist.automation.0.input.parameter"],
      ["binding", "surface", "entries.1.embedded.sequence.loops.0.binding.parameter"],
      ["curve", "surface", "stingers.0.playlist.embedded.entries.0.curves.lowpass.input.parameter"],
      ["switch", "surface", "switch.parameter"],
      ["axis", "speed", "switch.onChange.transition.embedded.blend.axes.0"],
    ]);
  });

  it("lists the same on a parsed playlist", () => {
    const names = playlistParameterReferences(parsed(json)).map((r) => `${r.use}:${r.name}`);
    expect(names).toContain("automation:speed");
    expect(names).toContain("switch:surface");
    expect(names).toContain("axis:speed");
  });

  it("collects an instance's local parameters as the runtime does: the root's and embedded entries'", () => {
    const b = { parameters: [{ name: "a" }], entries: [{ embedded: { parameters: [{ name: "b" }], entries: [] } }], stingers: [{ playlist: { embedded: { parameters: [{ name: "c" }] } } }] };
    expect([...playlistLocalParameterNames(b)]).toEqual(["a", "b"]);
  });

  it("renames a global parameter everywhere, copying only what changes", () => {
    const next = renamePlaylistParameter(json, "speed", "pace", "global");
    expect(playlistParameterReferences(next).filter((r) => r.name === "pace")).toHaveLength(4);
    expect(playlistParameterReferences(next).some((r) => r.name === "speed")).toBe(false);
    expect(next.stingers).toBe(json.stingers);
    expect(renamePlaylistParameter(json, "rpm", "revs", "global")).toBe(json);
  });

  it("leaves a playlist alone for a global rename when its instance has a local of either name", () => {
    expect(renamePlaylistParameter(json, "gear", "cog", "global")).toBe(json);
    expect(renamePlaylistParameter(json, "speed", "gear", "global")).toBe(json);
  });

  it("renames a local parameter's definition and every reference to it", () => {
    const next = renamePlaylistParameter(json, "gear", "cog", "local");
    expect(playlistParameterReferences(next).filter((r) => r.name === "cog").map((r) => r.use)).toEqual(["definition", "curve", "binding"]);
    expect(renamePlaylistParameter(json, "speed", "pace", "local")).toBe(json);
  });

  it("renames in a parsed playlist, sharing what it doesn't touch", () => {
    const p = parsed(json);
    const next = renamePlaylistParameter(p, "surface", "ground", "global");
    expect(next.switch!.parameter).toBe("ground");
    expect(next.entries[0]).toBe(p.entries[0]);
  });
});

describe("second inputs (ADR 0362 §5)", () => {
  it("lists and renames a lane's second input like its own input", () => {
    const json = {
      format: "myco.playlist@1", type: "clip",
      entries: [{ sample: "a.wav", curves: { gain: { input: "speed", curve: [[0, 0]], by: { input: "load", mode: "scale" } } } }],
      automation: [{ id: "a", target: "volume", input: "voiceTime", curve: [[0, 0]], by: { input: "load", mode: "morph" } }],
    };
    expect(playlistParameterReferences(json).filter((r) => r.name === "load").map((r) => [r.use, r.where.join(".")])).toEqual([
      ["automation", "automation.0.by.input"],
      ["curve", "entries.0.curves.gain.by.input"],
    ]);
    const next = renamePlaylistParameter(json, "load", "weight", "global");
    expect(next.entries[0]!.curves.gain.by.input).toBe("weight");
    expect(next.automation[0]!.by.input).toBe("weight");
  });
});
