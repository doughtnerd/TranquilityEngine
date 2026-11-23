import { describe, expect, it } from "vitest";
import { BLEND, QUEUE, SEQUENCE, SWITCH } from "./__fixtures__/playlists";
import { parsePlaylist } from "./format";
import { lintPlaylist, type LintContext } from "./lint";

const parsed = (raw: unknown) => parsePlaylist(raw).playlist;
const codes = (raw: unknown, ctx?: LintContext) => lintPlaylist(parsed(raw), ctx).map((l) => l.code);
const P = { format: "myco.playlist@1" };

describe("lintPlaylist", () => {
  it("is quiet for the well-formed fixtures", () => {
    const ctx: LintContext = {
      sampleTempo: (p) => (p === "audio/brake_skid.wav" ? { bpm: 120 } : null),
      playlist: (p) => parsed({ ...P, type: "sequence", entries: [], sequence: { tempo: p.includes("music") ? { bpm: 120 } : null } }),
    };
    for (const raw of [QUEUE, SWITCH, SEQUENCE, BLEND]) expect(lintPlaylist(parsed(raw), ctx)).toEqual([]);
  });

  describe("noTempoSource", () => {
    const sw = (when: string, entry: unknown) => ({ ...P, type: "switch", entries: [entry], switch: { parameter: "S", map: {}, onChange: { when } } });

    it("warns when a beat or bar change has an entry with no tempo", () => {
      const noTempo = { embedded: { type: "sequence", entries: [], sequence: { tracks: [] } } };
      const lints = lintPlaylist(parsed(sw("bar", noTempo)));
      expect(lints).toEqual([{ code: "noTempoSource", where: "switch.onChange", message: 'The change waits for the next bar, but "entry 1" has no tempo, so it changes at once there.' }]);
      expect(codes(sw("now", noTempo))).toEqual([]);
    });

    it("finds tempo in a sequence, a sync sample or a linked playlist, and stays quiet when it can't know", () => {
      const tempo = { embedded: { type: "sequence", entries: [], sequence: { tempo: { bpm: 100 } } } };
      expect(codes(sw("beat", tempo))).toEqual([]);
      const syncSample = { embedded: { type: "sequence", entries: [], sequence: { tracks: [{ id: "t", name: "T", kind: "audio", clips: [{ id: "c", sample: "loop.wav", sync: true, at: 0, length: 4 }] }] } } };
      expect(codes(sw("beat", syncSample), { sampleTempo: () => ({ bpm: 90 }) })).toEqual([]);
      expect(codes(sw("beat", syncSample), { sampleTempo: () => null })).toEqual(["noTempoSource"]);
      expect(codes(sw("beat", syncSample))).toEqual([]);
      const linked = { playlist: "m.playlist.json" };
      expect(codes(sw("bar", linked))).toEqual([]);
      expect(codes(sw("bar", linked), { playlist: () => parsed({ ...P, type: "clip", entries: [{ sample: "x.wav" }] }), sampleTempo: () => null })).toEqual(["noTempoSource"]);
    });

    it("checks only the entries the map plays", () => {
      const raw = { ...P, type: "switch", entries: [{ embedded: { type: "sequence", entries: [], sequence: { tempo: { bpm: 1 } } } }, { embedded: { type: "layer", entries: [] } }],
        switch: { parameter: "S", map: { a: 0 }, rules: [{ when: "bar" }] } };
      expect(codes(raw)).toEqual([]);
      expect(codes({ ...raw, switch: { ...raw.switch, map: { a: 0, b: 1 } } })).toEqual(["noTempoSource"]);
    });

    it("warns for a stinger on the bar in a playlist with no tempo", () => {
      const raw = { ...P, type: "layer", entries: [], stingers: [{ trigger: "hit", playlist: { playlist: "s.playlist.json" }, at: "bar" }] };
      expect(codes(raw)).toEqual(["noTempoSource"]);
      expect(codes({ ...raw, stingers: [{ ...raw.stingers[0], at: "now" }] })).toEqual([]);
    });
  });

  it("warns about a sync clip whose sample tempo differs from the sequence's", () => {
    expect(codes(SEQUENCE, { sampleTempo: () => ({ bpm: 96 }) })).toEqual(["tempoClash"]);
  });

  it("warns about a sync clip chained over another on its own track, never about stems on parallel tracks (decision 4)", () => {
    const clip = (id: string, at: number) => ({ id, sample: `${id}.wav`, sync: true, at, length: 2 });
    const raw = { ...P, type: "sequence", entries: [], sequence: { length: 8, tracks: [
      { id: "a", name: "Drums", kind: "audio", clips: [clip("c1", 0)] },
      { id: "b", name: "Bass", kind: "audio", clips: [clip("c2", 1), clip("c3", 4), clip("c5", 5)] },
      { id: "c", name: "Muted", kind: "audio", enabled: false, clips: [clip("c4", 0), clip("c6", 1)] },
    ] } };
    const lints = lintPlaylist(parsed(raw));
    expect(lints).toEqual([{ code: "overlappingSyncLoops", where: "sequence.tracks[1]", message: 'Sync clip "c5" starts before sync clip "c3" ends on track "Bass"; "c3" drives the playhead and "c5" follows.' }]);
  });

  it("warns when every weight of a random Queue is zero", () => {
    const raw = { ...P, type: "queue", entries: [{ playlist: "a.playlist.json", weight: 0 }, { playlist: "b.playlist.json", weight: 0 }] };
    expect(codes(raw)).toEqual(["allWeightsZero"]);
    expect(codes({ ...raw, queue: { pick: "roundRobin" } })).toEqual([]);
    expect(codes({ ...raw, entries: [...raw.entries, { playlist: "c.playlist.json" }] })).toEqual([]);
  });

  it("warns about parameter loops with no binding, on the sequence and on clip overrides", () => {
    const raw = { ...P, type: "sequence", entries: [], sequence: {
      tracks: [{ id: "t", name: "T", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 1, loops: { l1: { active: "parameter" }, l2: { active: "parameter", binding: { parameter: "p", op: ">", value: 0 } } } }] }],
      loops: [{ id: "s1", start: 0, end: 1, active: "parameter" }],
    } };
    expect(lintPlaylist(parsed(raw)).map((l) => [l.code, l.where])).toEqual([["unboundLoop", "sequence.loops[0]"], ["unboundLoop", "sequence.tracks[0].clips[0].loops.l1"]]);
  });

  it("warns about a Switch or Blend axis with no parameter and unknown labels", () => {
    expect(codes({ ...P, type: "switch", entries: [] })).toEqual(["unboundParameter"]);
    expect(codes({ ...P, type: "blend", entries: [], blend: { axes: [{ parameter: "" }] } })).toEqual(["unboundParameter"]);
    expect(codes({ ...SWITCH, switch: { ...SWITCH.switch, map: { ...SWITCH.switch.map, stealth: 0 } } }, { playlist: () => parsed({ ...P, type: "sequence", entries: [], sequence: { tempo: { bpm: 1 } } }) })).toEqual(["unknownLabel"]);
  });

  it("warns about clips on the wrong kind of track", () => {
    const raw = { ...P, type: "sequence", entries: [], sequence: { tracks: [
      { id: "a", name: "A", kind: "audio", clips: [{ id: "c1", playlist: "p.playlist.json", at: 0, length: 1 }] },
      { id: "b", name: "B", kind: "playlist", clips: [{ id: "c2", sample: "s.wav", at: 0, length: 1 }] },
    ] } };
    expect(codes(raw)).toEqual(["trackKindMismatch", "trackKindMismatch"]);
  });

  it("warns about automation of a missing effect or parameter", () => {
    const raw = { ...P, type: "sequence", entries: [], sequence: { tracks: [{
      id: "a", name: "A", kind: "audio", effects: [{ id: "e1", type: "lowpass" }],
      automation: [{ target: "fx:e1:cutoff", curve: [[0, 1]] }, { target: "fx:e1:on", curve: [[0, 1]] }, { target: "fx:e1:mix", curve: [[0, 1]] }, { target: "fx:e9:cutoff", curve: [[0, 1]] }],
      clips: [],
    }] } };
    expect(lintPlaylist(parsed(raw)).map((l) => l.where)).toEqual(["sequence.tracks[0].automation[2]", "sequence.tracks[0].automation[3]"]);
  });

  it("checks a playlist's own automation against its effects, in embedded playlists too", () => {
    const raw = { ...P, type: "layer", effects: [{ id: "g", type: "gain" }],
      automation: [{ target: "fx:g:gain", curve: [[0, 0]] }, { target: "fx:lp:cutoff", curve: [[0, 1]] }],
      entries: [{ embedded: { type: "queue", entries: [], automation: [{ target: "fx:g:gain", curve: [[0, 0]] }] } }] };
    expect(lintPlaylist(parsed(raw)).map((l) => [l.code, l.where])).toEqual([
      ["danglingEffectTarget", "automation[1]"],
      ["danglingEffectTarget", "entries[0].embedded.automation[0]"],
    ]);
  });

  it("lints embedded playlists with their place", () => {
    const raw = { ...P, type: "layer", entries: [{ embedded: { type: "queue", entries: [{ playlist: "a.playlist.json", weight: 0 }] } }] };
    expect(lintPlaylist(parsed(raw))).toEqual([{ code: "allWeightsZero", where: "entries[0].embedded.entries", message: "Every entry has weight 0, so this Queue never plays anything." }]);
  });
});
