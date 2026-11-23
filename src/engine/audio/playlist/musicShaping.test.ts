// ADR 0350: the playlist format's additions (parse with defaults, write, round trip), the fade shapes, the blend regions
// and weight curves in the one weight model, and the new lints.
import { describe, expect, it } from "vitest";
import { parsePlaylist, playlistToJson } from "./format";
import { fadeInLevel, fadeOutLevel, fadePieces, SHAPE_SEGMENTS } from "./fadeShapes";
import { blendWeights1D, blendWeights2D, derivedRegion, regionWeight } from "./blendWeights";
import { lintPlaylist } from "./lint";
import { FADE_SHAPES, type EmbeddedEntry, type PlaylistAsset } from "./types";

const F = "myco.playlist@1";
const roundTrip = (p: PlaylistAsset) => parsePlaylist(playlistToJson(p));

const MUSIC = {
  format: F, type: "switch",
  parameters: [{ name: "State", labels: ["a", "b"], default: "a" }, { name: "I", min: 0, max: 1, default: 0 }],
  entries: [
    { embedded: { type: "blend", entries: [
      { embedded: { type: "clip", entries: [{ sample: "x.wav" }] }, x: 0, region: { start: -1, end: 4, fadeIn: 1, fadeOut: 2, shapeOut: "sCurve" } },
      { embedded: { type: "clip", entries: [{ sample: "y.wav" }] }, x: 5, weightCurve: [[0, 0], [0.4, 0], [1, 1]] },
    ], blend: { axes: [{ parameter: "I" }], fade: "layer", curve: "linear" } } },
    { embedded: { type: "sequence", entries: [], sequence: {
      length: 8, tempo: { bpm: 120, meter: "4/4" },
      tracks: [{ id: "t", kind: "audio", automation: [{ id: "a", target: "volume", input: { parameter: "I" }, curve: [[0, -20], [1, 0]], quantize: { beats: 2 } }], clips: [{ id: "c", sample: "z.wav", at: 0, length: 8, sync: true }] }],
      loops: [{ id: "l", start: 0, end: 4, tail: true, exit: "crossfade", exitFadeMs: 200, exitShape: "log2" }],
      markers: [{ id: "m", name: "in", at: 0.5, type: "entry" }, { id: "x", name: "out", at: 6, type: "exit" }],
    } } },
  ],
  queue: { pick: "roundRobin", avoidRepeat: 0, continuous: { gapMs: -200, shape: "sCurve" } },
  switch: {
    parameter: "State", map: { a: 0, b: 1 },
    onChange: { when: "bar", how: "crossfade", length: { beats: 2 }, shapeOut: "exp3", shapeIn: "log1", tail: false },
    rules: [{ from: "a", to: "b", when: "exit", how: "transition", length: { ms: 500 }, transition: { embedded: { type: "clip", entries: [{ sample: "r.wav" }] } },
      transitionIn: { length: { ms: 0 }, shape: "linear" }, transitionOut: { length: { beats: 1 }, shape: "invSCurve" } }],
  },
};

describe("ADR 0350 format", () => {
  it("reads every new field and round-trips (writing is stable)", () => {
    const { playlist, problems } = parsePlaylist(MUSIC);
    expect(problems).toEqual([]);
    expect(roundTrip(playlist)).toEqual({ playlist, problems: [] });
    expect(playlistToJson(roundTrip(playlist).playlist)).toEqual(playlistToJson(playlist));
    const blend = (playlist.entries[0] as EmbeddedEntry).embedded;
    expect(blend.entries[0]!.region).toEqual({ start: -1, end: 4, fadeIn: 1, fadeOut: 2, shapeOut: "sCurve" });
    expect(blend.entries[1]!.weightCurve).toEqual([[0, 0], [0.4, 0], [1, 1]]);
    const seq = (playlist.entries[1] as EmbeddedEntry).embedded.sequence!;
    expect(seq.tracks[0]!.automation[0]!.quantize).toEqual({ beats: 2 });
    expect(seq.loops[0]).toMatchObject({ tail: true, exitShape: "log2" });
    expect(seq.markers[0]!.type).toBe("entry");
    expect(playlist.queue!.continuous).toEqual({ gapMs: -200, shape: "sCurve" });
    expect(playlist.switch!.onChange).toEqual({ when: "bar", how: "crossfade", length: { beats: 2 }, shapeOut: "exp3", shapeIn: "log1", tail: false });
    expect(playlist.switch!.rules[0]).toMatchObject({ transitionIn: { length: { ms: 0 }, shape: "linear" }, transitionOut: { length: { beats: 1 }, shape: "invSCurve" } });
  });

  it("absent fields stay absent (old files mean what they meant) and defaults aren't written", () => {
    const { playlist } = parsePlaylist({
      format: F, type: "switch", entries: [{ sample: "a.wav" }],
      queue: { continuous: { gapMs: -100, shape: "equalPower" } },
      switch: { parameter: "S", map: {}, onChange: { when: "now", how: "cut", length: { ms: 0 }, shapeOut: "equalPower", tail: true } },
      sequence: { length: 1, tracks: [], loops: [{ id: "l", start: 0, end: 1, tail: false }] },
    });
    expect(playlist.switch!.onChange).toEqual({ when: "now", how: "cut", length: { ms: 0 } });
    expect(playlist.queue!.continuous).toEqual({ gapMs: -100 });
    expect(playlist.sequence!.loops[0]!.tail).toBeUndefined();
    expect(playlist.entries[0]!.region).toBeUndefined();
    const json = playlistToJson(playlist) as { switch: { onChange: Record<string, unknown> } };
    expect(Object.keys(json.switch.onChange)).toEqual(["when", "how", "length"]);
  });

  it("bad values fall back with one problem each", () => {
    const { playlist, problems } = parsePlaylist({
      format: F, type: "blend", parameters: [{ name: "I", min: 0, max: 1 }],
      entries: [{ sample: "a.wav", region: { start: 3, end: 1, fadeIn: 9 }, weightCurve: [] }, { sample: "b.wav", region: "wide" }],
      switch: { parameter: "I", map: {}, onChange: { when: "bar", shapeOut: "wobbly", transitionIn: 4 } },
      sequence: { length: 1, tracks: [{ id: "t", automation: [{ id: "a", target: "volume", input: "I", curve: [[0, 0]], quantize: "triplet" }], clips: [] }] },
    });
    const e0 = (playlist.entries[0] as EmbeddedEntry).embedded.entries.length ? playlist.entries[0]! : playlist.entries[0]!;
    expect(e0.region).toEqual({ start: 1, end: 3, fadeIn: 2, fadeOut: 0 });
    expect(e0.weightCurve).toBeUndefined();
    expect(playlist.entries[1]!.region).toBeUndefined();
    expect(playlist.switch!.onChange.shapeOut).toBeUndefined();
    expect(playlist.switch!.onChange.transitionIn).toBeUndefined();
    expect(playlist.sequence!.tracks[0]!.automation[0]!.quantize).toBeUndefined();
    for (const k of ["region: end was before start", "region.fadeIn", "weightCurve", "entries[1].region", "shapeOut", "transitionIn", "quantize"]) {
      expect(problems.some((p) => p.includes(k)), k).toBe(true);
    }
  });
});

describe("fade shapes", () => {
  it("every shape runs 0 → 1 in and 1 → 0 out; equal power keeps its power across a crossfade", () => {
    for (const s of FADE_SHAPES) {
      expect([fadeInLevel(s, 0), fadeInLevel(s, 1), fadeOutLevel(s, 0), fadeOutLevel(s, 1)]).toEqual([0, 1, 1, expect.closeTo(0, 12)]);
      for (let u = 0; u <= 1; u += 0.125) expect(fadeInLevel(s, u + 0.125)).toBeGreaterThanOrEqual(fadeInLevel(s, u) - 1e-12);
    }
    for (let u = 0; u <= 1; u += 0.1) expect(fadeInLevel("equalPower", u) ** 2 + fadeOutLevel("equalPower", u) ** 2).toBeCloseTo(1, 12);
    expect([fadeInLevel("log2", 0.5), fadeInLevel("exp2", 0.5), fadeOutLevel("log2", 0.5), fadeOutLevel("exp2", 0.5)]).toEqual([0.75, 0.25, 0.25, 0.75]);
  });

  it("the core's laws are one piece; other shapes are linear pieces on the exact knots", () => {
    expect(fadePieces("equalPower", 1, 1, 0)).toEqual([{ at: 0, seconds: 1, to: 0, law: "equalPowerOut" }]);
    expect(fadePieces("sCurve", 1, 0, 1)).toEqual([{ at: 0, seconds: 1, to: 1, law: "sCurve" }]);
    const p = fadePieces("exp2", 1.2, 0, 1);
    expect(p).toHaveLength(SHAPE_SEGMENTS);
    expect(p[SHAPE_SEGMENTS / 2 - 1]!.to).toBeCloseTo(0.25, 12);
    expect(p.at(-1)).toEqual({ at: expect.closeTo(1.1, 12), seconds: expect.closeTo(0.1, 12), to: 1, law: "linear" });
    expect(fadePieces("log3", 1, 1, 0)[SHAPE_SEGMENTS / 2 - 1]!.to).toBeCloseTo(0.125, 12);
  });
});

describe("blend regions and weight curves (one weight model)", () => {
  const xs = [0, 0.5, 1];
  it("without regions or curves the weights are ADR 0343's, and the derived regions give them", () => {
    for (const fade of ["crossfade", "layer"] as const) {
      for (let x = -0.2; x <= 1.2; x += 0.05) {
        const w = blendWeights1D(xs, x, fade, "linear");
        const derived = xs.map((_, i) => regionWeight(derivedRegion(xs, i, fade), x, "linear"));
        derived.forEach((d, i) => expect(d).toBeCloseTo(w[i]!, 9));
      }
    }
  });

  it("an explicit region replaces the derived one; its shapes default to the blend's curve", () => {
    const r = { start: 0.2, end: 0.8, fadeIn: 0.2, fadeOut: 0.2 };
    expect(blendWeights1D(xs, 0.1, "crossfade", "linear", [undefined, r, undefined])[1]).toBe(0);
    expect(blendWeights1D(xs, 0.3, "crossfade", "linear", [undefined, r, undefined])[1]).toBeCloseTo(0.5, 12);
    expect(blendWeights1D(xs, 0.3, "crossfade", "equalPower", [undefined, r, undefined])[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(blendWeights1D(xs, 0.75, "crossfade", "linear", [undefined, { ...r, shapeOut: "exp2" }, undefined])[1]).toBeCloseTo(1 - 0.75 * 0.75, 12);
  });

  it("a weight curve shapes an entry's raw weight; 2D equal power normalises to constant power", () => {
    const narrow = [[0, 0], [0.4, 0], [1, 1]] as [number, number][];
    expect(blendWeights1D([0, 1], 0.3, "crossfade", "linear", undefined, [undefined, narrow])).toEqual([0.7, 0]);
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    const plain = blendWeights2D(pts, { x: 0.3, y: 0.3 }, "equalPower");
    expect(blendWeights2D(pts, { x: 0.3, y: 0.3 }, "equalPower", [undefined, undefined, undefined])).toEqual(plain);
    const shaped = blendWeights2D(pts, { x: 0.3, y: 0.3 }, "equalPower", [undefined, narrow, undefined]);
    expect(shaped[1]).toBe(0);
    expect(shaped.reduce((s, w) => s + w * w, 0)).toBeCloseTo(1, 12);
    expect(blendWeights2D(pts, { x: 0.3, y: 0.3 }, "linear", [undefined, narrow, undefined])).toEqual([expect.closeTo(0.4, 12), 0, expect.closeTo(0.3, 12)]);
  });
});

describe("ADR 0350 lints", () => {
  it("quantise on time or an effect parameter the voice doesn't carry, quantise without a tempo, a 2D region, a tail with no Exit after", () => {
    const { playlist } = parsePlaylist({
      format: F, type: "sequence", entries: [],
      sequence: {
        length: 4, tempo: null,
        tracks: [{ id: "t", kind: "audio", effects: [{ id: "d", type: "delay" }, { id: "h", type: "highpass" }], automation: [
          { id: "a", target: "volume", input: "sequenceTime", curve: [[0, 0]], quantize: "beat" },
          { id: "b", target: "fx:d:time", input: { parameter: "I" }, curve: [[0, 0]], quantize: "beat" },
          { id: "c", target: "volume", input: { parameter: "I" }, curve: [[0, 0]], quantize: "bar" },
          { id: "p", target: "pitch", input: { parameter: "I" }, curve: [[0, 0]], quantize: "beat" },
          { id: "f", target: "fx:h:cutoff", input: { parameter: "I" }, curve: [[0, 20]], quantize: "beat" },
        ], clips: [{ id: "k", playlist: { type: "blend", entries: [{ sample: "a.wav", x: 0, y: 0, region: { start: 0, end: 1 } }], blend: { axes: [{ parameter: "I" }, { parameter: "J" }] } }, at: 0, length: 1 }] }],
        loops: [{ id: "l", start: 0, end: 2, tail: true }],
      },
    });
    const lints = lintPlaylist(playlist).map((l) => [l.code, l.where]);
    expect(lints).toEqual(expect.arrayContaining([
      ["quantizeIgnored", "sequence.tracks[0].automation[0].quantize"],
      ["quantizeIgnored", "sequence.tracks[0].automation[1].quantize"],
      ["quantizeNoTempo", "sequence.tracks[0].automation[2].quantize"],
      ["quantizeNoTempo", "sequence.tracks[0].automation[3].quantize"], // pitch and high-pass quantise now
      ["quantizeNoTempo", "sequence.tracks[0].automation[4].quantize"],
      ["regionIgnored", "sequence.tracks[0].clips[0].playlist.entries[0].region"],
      ["tailWithoutExit", "sequence.loops[0].tail"],
    ]));
  });

  it("entry voice curves take quantize: parsed, written back, and linted on time or without a tempo", () => {
    const raw = {
      format: F, type: "layer",
      entries: [
        { sample: "a.wav", curves: { pitch: { input: "I", curve: [[0, 0], [1, 12]], quantize: "beat" }, gain: { input: "voiceTime", curve: [[0, 0]], quantize: "bar" } } },
        { sample: "b.wav", curves: { pan: { input: "I", curve: [[0, -1], [1, 1]], quantize: { beats: 2 } }, lowpass: { input: "I", curve: [[0, 500]], quantize: "sometimes" } } },
      ],
    };
    const { playlist, problems } = parsePlaylist(raw);
    expect(playlist.entries[0]!.curves.pitch!.quantize).toBe("beat");
    expect(playlist.entries[1]!.curves.pan!.quantize).toEqual({ beats: 2 });
    expect(playlist.entries[1]!.curves.lowpass!.quantize).toBeUndefined();
    expect(problems.some((p) => p.includes("entries[1].curves.lowpass.quantize"))).toBe(true);
    const json = playlistToJson(playlist) as { entries: { curves: Record<string, { quantize?: unknown }> }[] };
    expect(json.entries[0]!.curves.pitch!.quantize).toBe("beat");
    expect(json.entries[1]!.curves.pan!.quantize).toEqual({ beats: 2 });
    expect(json.entries[1]!.curves.lowpass!.quantize).toBeUndefined();
    expect(lintPlaylist(playlist, { sampleTempo: () => null }).map((l) => [l.code, l.where])).toEqual(expect.arrayContaining([
      ["quantizeNoTempo", "entries[0].curves.pitch.quantize"],
      ["quantizeIgnored", "entries[0].curves.gain.quantize"],
      ["quantizeNoTempo", "entries[1].curves.pan.quantize"],
    ]));
  });
});
