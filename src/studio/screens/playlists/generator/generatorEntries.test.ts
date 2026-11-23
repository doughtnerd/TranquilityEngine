// Generators in playlists, sequences and the Library (ADR 0360 §1, §9) through the edits: a Clip plays the generator,
// other playlists wrap it in an embedded Clip, a sequence gets a generator clip on an audio track, an embedded
// generator is replaced in place, and the Library lists generators with their kind.
import { describe, expect, it } from "vitest";
import { applyBlipPreset } from "../../../../engine/audio/generators/blipPresets";
import { emptyGeneratorBody, formatGenerator } from "../../../../engine/audio/generators/format";
import { emptyPlaylistBody } from "../../../../engine/audio/playlist/format";
import type { PlaylistBody, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { addItems, entriesFor, filterCounts, filterItems } from "../addDialogModel";
import { addGenerator,addGeneratorClip, clipGenerator, generatorClipLength, generatorFromDrag, generatorDragText, libraryGenerators, setClipGenerator } from "./generatorEntries";

const ctx = { parameters: [] };
const ok = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

describe("adding generators to playlists", () => {
  it("makes a Clip play the generator", () => {
    const clip: PlaylistBody = { ...emptyPlaylistBody("clip"), entries: [{ kind: "sample", sample: "a.wav", trim: null, loop: "inherit", volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} }] };
    const next = ok(addGenerator(clip, "audio/ui/coin.generator.json", ctx));
    expect(next.entries).toHaveLength(1);
    expect(clipGenerator(next)).toEqual({ index: 0, generator: "audio/ui/coin.generator.json" });
  });

  it("wraps it in an embedded Clip elsewhere, and refuses a Sequence", () => {
    const queue = emptyPlaylistBody("queue");
    const body = emptyGeneratorBody("synth");
    const next = ok(addGenerator(queue, body, ctx));
    const e = next.entries[0]!;
    expect(e.kind).toBe("embedded");
    expect(e.kind === "embedded" && clipGenerator(e.embedded)).toEqual({ index: 0, generator: body });
    expect("refused" in addGenerator(emptyPlaylistBody("sequence"), "x.generator.json", ctx)).toBe(true);
  });

  it("replaces an embedded generator in place, and refuses a linked one", () => {
    const embedded = ok(addGenerator(emptyPlaylistBody("clip"), emptyGeneratorBody("oscillator"), ctx));
    const blip = emptyGeneratorBody("blip");
    expect(clipGenerator(ok(setClipGenerator(embedded, blip)))!.generator).toBe(blip);
    const linked = ok(addGenerator(emptyPlaylistBody("clip"), "a.generator.json", ctx));
    expect("refused" in setClipGenerator(linked, blip)).toBe(true);
    expect(clipGenerator(emptyPlaylistBody("queue"))).toBeNull();
  });
});

describe("generator clips in sequences", () => {
  const seq = (tracks: SequenceSettings["tracks"]): SequenceSettings => ({ ...emptyPlaylistBody("sequence").sequence!, tracks });

  it("adds to the first audio track, or a new one named after the generator", () => {
    const fresh = ok(addGeneratorClip(seq([]), "audio/ui/coin.generator.json", 1.5, 0.4));
    expect(fresh.tracks.map((t) => [t.kind, t.name])).toEqual([["audio", "coin"]]);
    expect(fresh.tracks[0]!.clips[0]).toMatchObject({ generator: "audio/ui/coin.generator.json", at: 1.5, length: 0.4 });
    const again = ok(addGeneratorClip(fresh, emptyGeneratorBody("silence"), 3, 1));
    expect(again.tracks).toHaveLength(1);
    expect(again.tracks[0]!.clips.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("gives a clip its sound's length, 2 s for an endless one", () => {
    expect(generatorClipLength(emptyGeneratorBody("oscillator"))).toBe(2);
    expect(generatorClipLength({ ...emptyGeneratorBody("silence"), params: { length: 0.75, lengthRandom: 0 } })).toBe(0.75);
    const coin = applyBlipPreset(emptyGeneratorBody("blip"), "coin", 3);
    expect(generatorClipLength(coin)).toBeGreaterThan(0.05);
  });
});

describe("the Add dialog's generators", () => {
  it("lists generators as sources a Clip can take, and adds them wrapped in a Clip elsewhere", () => {
    const files = ["audio/a.wav", "audio/ui/coin.generator.json", "audio/q.playlist.json"];
    const gens = (p: string) => (p === "audio/ui/coin.generator.json" ? emptyGeneratorBody("blip") : null);
    const forClip = addItems(files, "audio/c.playlist.json", "clip", () => emptyPlaylistBody("queue"), gens);
    expect(forClip.map((i) => [i.kind, i.disabled, i.generatorKind])).toEqual([["sample", null, undefined], ["playlist", "A Clip plays a sample", undefined], ["generator", null, "blip"]]);
    expect(filterCounts(forClip, "").generators).toBe(1);
    expect(filterItems(forClip, "", "generators").map((i) => i.name)).toEqual(["coin"]);
    const [e] = entriesFor(["audio/ui/coin.generator.json"], forClip, "link", () => null);
    expect(e!.kind === "embedded" && clipGenerator(e!.embedded)).toEqual({ index: 0, generator: "audio/ui/coin.generator.json" });
    // Callers that don't read generators list none.
    expect(addItems(files, "audio/c.playlist.json", "queue", () => emptyPlaylistBody("queue")).some((i) => i.kind === "generator")).toBe(false);
  });
});

describe("the Library's generators", () => {
  it("lists generators A–Z with their kind, searched by path", () => {
    const files = ["audio/ui/zap.generator.json", "audio/ui/coin.generator.json", "audio/a.wav", ".myco/x.generator.json", "audio/bad.generator.json"];
    const raw: Record<string, unknown> = {
      "audio/ui/zap.generator.json": JSON.parse(formatGenerator(emptyGeneratorBody("synth"))),
      "audio/ui/coin.generator.json": JSON.parse(formatGenerator(applyBlipPreset(emptyGeneratorBody("blip"), "coin", 1))),
    };
    const rows = libraryGenerators(files, "", (p) => raw[p]);
    expect(rows.map((r) => [r.name, r.kind, r.preset])).toEqual([["bad", null, null], ["coin", "blip", "coin"], ["zap", "synth", null]]);
    expect(libraryGenerators(files, "ui z", (p) => raw[p]).map((r) => r.name)).toEqual(["zap"]);
    expect(generatorFromDrag(generatorDragText("a.generator.json"))).toBe("a.generator.json");
    expect(generatorFromDrag("sample:a.wav")).toBeNull();
  });
});
