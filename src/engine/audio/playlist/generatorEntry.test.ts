/**
 * ADR 0346 in the playlist format: the generator entry (Clip playlists only, wrapped elsewhere), sequence clips' generator
 * source, `gen:<param>` targets, the generator lints and the references to `*.generator.json`.
 */
import { describe, expect, it } from "vitest";
import { emptyGeneratorBody } from "../generators/format";
import { parsePlaylist, playlistToJson } from "./format";
import { lintPlaylist, type LintContext } from "./lint";
import { playlistReferences, referencedPaths, rewritePlaylistReferences } from "./references";
import type { EmbeddedEntry, GeneratorEntry } from "./types";

const P = { format: "myco.playlist@1" };
const parsed = (raw: unknown) => parsePlaylist(raw).playlist;
const codes = (raw: unknown, ctx?: LintContext) => lintPlaylist(parsed(raw), ctx).map((l) => l.code);
const COIN = "audio/ui/coin.generator.json";
const step = (y0: number, y1: number) => [[0, y0, "step"], [1, y1]];

describe("generator entries", () => {
  it("parse in a Clip, linked or embedded, and round-trip", () => {
    const raw = {
      ...P, type: "clip",
      entries: [
        { generator: COIN, volume: -3, curves: { "gen:frequency": { input: "Charge", curve: [[0, 200], [1, 800]] }, gain: { input: "voiceTime", curve: [[0, 0], [1, -6]] } } },
        { generator: { kind: "blip", params: { waveform: "saw" }, seed: 7, preset: "laser" } },
      ],
    };
    const { playlist, problems } = parsePlaylist(raw);
    expect(problems).toEqual(["entries: a Clip plays one sample; the entries after the first are kept but not played."]);
    const [linked, embedded] = playlist.entries as GeneratorEntry[];
    expect(linked).toMatchObject({ kind: "generator", generator: COIN, volume: -3 });
    expect(Object.keys(linked.curves).sort()).toEqual(["gain", "gen:frequency"]);
    expect(embedded.generator).toMatchObject({ kind: "blip", seed: 7, preset: "laser", params: { waveform: 1 } });
    const json = playlistToJson(playlist);
    expect((json.entries as Record<string, unknown>[])[1].generator).toEqual({ kind: "blip", params: { waveform: "saw" }, seed: 7, preset: "laser" });
    expect(parsePlaylist(json).playlist).toEqual(playlist);
  });

  it("outside a Clip are wrapped in an embedded Clip, with a problem (the sample rule)", () => {
    const { playlist, problems } = parsePlaylist({ ...P, type: "queue", entries: [{ generator: COIN, weight: 3 }, { sample: "a.wav" }] });
    expect(problems).toContain("entries[0]: a generator plays only in a Clip; wrapped in an embedded Clip.");
    const wrapper = playlist.entries[0] as EmbeddedEntry;
    expect(wrapper).toMatchObject({ kind: "embedded", weight: 3, embedded: { type: "clip", entries: [{ kind: "generator", generator: COIN, weight: 1 }] } });
    expect(parsePlaylist(playlistToJson(playlist)).problems).toEqual([]);
  });

  it("report bad sources and mixed keys", () => {
    expect(parsePlaylist({ ...P, type: "clip", entries: [{ generator: 4 }] }).problems).toContain("entries[0].generator: must be a generator path or an embedded generator; dropped.");
    const both = parsePlaylist({ ...P, type: "clip", entries: [{ sample: "a.wav", generator: COIN }] });
    expect(both.problems).toContain('entries[0]: has sample and generator; using "sample".');
    const bad = parsePlaylist({ ...P, type: "clip", entries: [{ generator: { kind: "oscillator", params: { frequency: 1 } } }] });
    expect(bad.problems).toContain("entries[0].generator.params.frequency: 1 is outside 20..20000; using 20.");
    expect(parsePlaylist({ ...P, type: "clip", entries: [{ generator: COIN, curves: { "gen:": { curve: [[0, 1]] } } }] }).problems[0]).toMatch(/unknown target/);
  });
});

describe("sequence clips with a generator source", () => {
  const seq = (clip: Record<string, unknown>, kind = "audio") => ({
    ...P, type: "sequence", entries: [], sequence: { length: 4, tracks: [{ id: "t1", name: "Tones", kind, clips: [{ id: "c1", at: 0, length: 1, ...clip }] }] },
  });

  it("parse and round-trip, linked or embedded, with gen: automation", () => {
    const raw = seq({ generator: { kind: "synth", preset: "pad" }, automation: [{ id: "a1", target: "gen:cutoff", input: "clipTime", curve: [[0, 300], [1, 3000]] }] });
    const { playlist, problems } = parsePlaylist(raw);
    expect(problems).toEqual([]);
    const clip = playlist.sequence!.tracks[0].clips[0];
    expect(clip.generator).toMatchObject({ kind: "synth", preset: "pad" });
    expect(clip.sample).toBeUndefined();
    expect(clip.automation[0].target).toBe("gen:cutoff");
    expect(parsePlaylist(playlistToJson(playlist)).playlist).toEqual(playlist);
    expect(parsed(seq({ generator: COIN })).sequence!.tracks[0].clips[0].generator).toBe(COIN);
  });

  it("keep one source", () => {
    const { playlist, problems } = parsePlaylist(seq({ sample: "a.wav", generator: COIN }));
    expect(playlist.sequence!.tracks[0].clips[0]).toMatchObject({ sample: "a.wav" });
    expect(playlist.sequence!.tracks[0].clips[0].generator).toBeUndefined();
    expect(problems[0]).toMatch(/one source/);
  });

  it("lint a generator on a playlist track, and none on an audio track", () => {
    expect(codes(seq({ generator: COIN }))).toEqual([]);
    expect(codes(seq({ generator: COIN }, "playlist"))).toEqual(["trackKindMismatch"]);
  });
});

describe("generator lints", () => {
  const endless = { kind: "oscillator" };
  const finite = { kind: "oscillator", params: { length: 0.5 } };

  it("generatorNeverEnds: a one-shot playlist playing an endless generator", () => {
    expect(codes({ ...P, type: "clip", entries: [{ generator: endless }] })).toEqual(["generatorNeverEnds"]);
    expect(codes({ ...P, type: "clip", entries: [{ generator: finite }] })).toEqual([]);
    expect(codes({ ...P, type: "clip", playback: { plays: "untilStopped" }, entries: [{ generator: endless }] })).toEqual([]);
    // Wrapped in a Queue: the root's playback decides.
    expect(codes({ ...P, type: "queue", entries: [{ generator: endless }] })).toEqual(["generatorNeverEnds"]);
    // Linked: known only through the context.
    expect(codes({ ...P, type: "clip", entries: [{ generator: COIN }] })).toEqual([]);
    expect(codes({ ...P, type: "clip", entries: [{ generator: COIN }] }, { generator: () => emptyGeneratorBody("synth") })).toEqual(["generatorNeverEnds"]);
  });

  it("generatorClipNoLength: an endless generator in a clip of length 0", () => {
    const seq = (generator: unknown, length: number) => ({ ...P, type: "sequence", entries: [], sequence: { tracks: [{ id: "t", name: "T", kind: "audio", clips: [{ id: "c", at: 0, length, generator }] }] } });
    expect(codes(seq(endless, 0))).toEqual(["generatorClipNoLength"]);
    expect(codes(seq(endless, 2))).toEqual([]);
    expect(codes(seq(finite, 0))).toEqual([]);
  });

  it("genTargetUnknown and genCurveNotStep against the generator's kind", () => {
    const entry = (curves: Record<string, unknown>, generator: unknown = finite) => ({ ...P, type: "clip", entries: [{ generator, curves }] });
    expect(codes(entry({ "gen:frequency": { curve: [[0, 100], [1, 200]] } }))).toEqual([]);
    expect(codes(entry({ "gen:cutoff": { curve: [[0, 100], [1, 200]] } }))).toEqual(["genTargetUnknown"]);
    expect(codes(entry({ "gen:waveform": { curve: [[0, 0], [1, 2]] } }))).toEqual(["genCurveNotStep"]);
    expect(codes(entry({ "gen:waveform": { curve: step(0, 2) } }))).toEqual([]);
    expect(codes(entry({ "gen:cutoff": { curve: [[0, 1]] } }, COIN))).toEqual([]);
    expect(codes(entry({ "gen:cutoff": { curve: [[0, 1]] } }, COIN), { generator: () => emptyGeneratorBody("synth") })).toEqual(["generatorNeverEnds"]);
    // On the wrapper of a wrapped generator, the target is checked against the generator inside.
    expect(codes({ ...P, type: "queue", entries: [{ generator: finite, curves: { "gen:detune": { curve: [[0, 1]] } } }] })).toEqual(["genTargetUnknown"]);
  });

  it("genTargetIgnored: instance and track lanes, and curves on what plays no generator", () => {
    const lane = { id: "a", target: "gen:frequency", curve: [[0, 100]] };
    expect(codes({ ...P, type: "clip", automation: [lane], entries: [{ generator: finite }] })).toEqual(["genTargetIgnored"]);
    expect(codes({ ...P, type: "clip", entries: [{ sample: "a.wav", curves: { "gen:frequency": { curve: [[0, 1]] } } }] })).toEqual(["genTargetIgnored"]);
    const seq = { ...P, type: "sequence", entries: [], sequence: { tracks: [{ id: "t", name: "T", kind: "audio", automation: [lane], clips: [{ id: "c", at: 0, length: 1, sample: "a.wav", automation: [lane] }] }] } };
    expect(lintPlaylist(parsed(seq)).map((l) => [l.code, l.where])).toEqual([
      ["genTargetIgnored", "sequence.tracks[0].automation[0]"],
      ["genTargetIgnored", "sequence.tracks[0].clips[0].automation[0]"],
    ]);
  });
});

describe("references to generators", () => {
  const raw = {
    ...P, type: "queue",
    entries: [{ generator: COIN }, { generator: { kind: "blip" } }],
    sequence: { tracks: [{ id: "t", name: "T", kind: "audio", clips: [{ id: "c", at: 0, length: 1, generator: "audio/hum.generator.json" }] }] },
  };

  it("list linked generators (entries, wrapped entries, sequence clips), never embedded ones", () => {
    const body = parsed(raw);
    expect(playlistReferences(body).filter((r) => r.kind === "generator").map((r) => [r.path, r.where.join(".")])).toEqual([
      [COIN, "entries.0.embedded.entries.0.generator"],
      ["audio/hum.generator.json", "sequence.tracks.0.clips.0.generator"],
    ]);
    expect(referencedPaths(body, "generator")).toEqual([COIN, "audio/hum.generator.json"]);
  });

  it("rewrite on a move, sharing what is untouched", () => {
    const body = parsed(raw);
    const moved = rewritePlaylistReferences(body, { [COIN]: "audio/sfx/coin.generator.json", "audio/hum.generator.json": "audio/drone.generator.json" });
    expect(referencedPaths(moved, "generator")).toEqual(["audio/sfx/coin.generator.json", "audio/drone.generator.json"]);
    expect(moved.entries[1]).toBe(body.entries[1]);
    expect(rewritePlaylistReferences(body, {})).toBe(body);
  });
});
