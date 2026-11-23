import { describe, expect, it } from "vitest";
import { BLEND, QUEUE, SEQUENCE, SWITCH } from "./__fixtures__/playlists";
import {
  defaultBlend, defaultQueue, emptyPlaylist, formatPlaylist, isPlaylistPath, parsePlaylist, parsePlaylistBody, PLAYLIST_LIMITS, playlistToJson,
} from "./format";
import type { EmbeddedEntry, PlaylistAsset, SampleEntry } from "./types";

const roundTrip = (p: PlaylistAsset) => parsePlaylist(playlistToJson(p));

describe("parsePlaylist: the fixtures", () => {
  for (const [name, raw] of Object.entries({ QUEUE, SWITCH, SEQUENCE, BLEND })) {
    it(`${name} parses without problems and round-trips`, () => {
      const { playlist, problems } = parsePlaylist(raw, `audio/${name}.playlist.json`);
      expect(problems).toEqual([]);
      expect(roundTrip(playlist)).toEqual({ playlist, problems: [] });
      // Writing is stable.
      expect(playlistToJson(roundTrip(playlist).playlist)).toEqual(playlistToJson(playlist));
    });
  }

  it("reads the Queue's fields", () => {
    const { playlist } = parsePlaylist(QUEUE);
    expect(playlist.playback).toEqual({ plays: "oneShot", maxInstances: 4, whenFull: "stealQuietest", cooldown: 0.05, chance: 0.9, delay: 0, priority: 100 });
    expect(playlist.effects[0].params).toEqual({ cutoff: 8000, resonance: 0.1, drive: 0 });
    expect(playlist.entries[0]).toEqual({ kind: "linked", playlist: "audio/footsteps/dirt_01.playlist.json", volume: 0, pitch: 0, weight: 2, atZeroWeight: "stop", curves: {} });
    const embedded = playlist.entries[1] as EmbeddedEntry;
    expect(embedded.embedded.type).toBe("clip");
    expect(embedded.embedded.entries[0]).toMatchObject({ kind: "sample", sample: "audio/dirt_02.wav", trim: [0.01, 0.4], loop: "off" });
    expect(embedded.curves.pitch).toEqual({ input: { parameter: "Speed" }, curve: [[0, 0], [10, 2]], bypass: false });
    expect(playlist.switch).toBeNull();
  });

  it("reads the Sequence's tracks, clips and loops", () => {
    const seq = parsePlaylist(SEQUENCE).playlist.sequence!;
    expect(seq.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);
    const c1 = seq.tracks[0].clips[0];
    expect(c1).toMatchObject({ id: "c1", sample: "audio/brake_skid.wav", sync: true, enabled: true, offset: 0, gain: 0 });
    expect(c1.loops.l1).toEqual({ active: "parameter", binding: { parameter: "brake", op: ">", value: 0.1 }, reentry: "reenter" });
    expect(seq.tracks[1].clips[1].playlist).toMatchObject({ type: "clip" });
    expect(seq.loops[0]).toEqual({ id: "h1", start: 1.6, end: 1.6, active: "held", exit: "jump", exitFadeMs: 40, reentry: "ignore" });
  });
});

describe("parsePlaylist: defaults and the canonical form", () => {
  it("fills every field for a minimal file and writes it back minimal", () => {
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "queue", entries: [] });
    expect(problems).toEqual([]);
    expect(playlist).toEqual(emptyPlaylist("queue"));
    expect(playlist.queue).toEqual(defaultQueue());
    expect(playlistToJson(playlist)).toEqual({ format: "myco.playlist@1", type: "queue", entries: [] });
    expect(formatPlaylist(playlist)).toBe('{\n  "format": "myco.playlist@1",\n  "type": "queue",\n  "entries": []\n}\n');
  });

  it("gives each type its own block", () => {
    expect(parsePlaylist({ format: "myco.playlist@1", type: "blend", entries: [] }).playlist.blend).toEqual(defaultBlend());
    const layer = parsePlaylist({ format: "myco.playlist@1", type: "layer", entries: [] }).playlist;
    expect([layer.queue, layer.switch, layer.blend, layer.sequence]).toEqual([null, null, null, null]);
  });

  it("keeps another type's block, so changing type back loses nothing", () => {
    const raw = { ...BLEND, type: "queue" };
    const { playlist } = parsePlaylist(raw);
    expect(playlist.type).toBe("queue");
    expect(playlist.blend?.fade).toBe("layer");
    expect(playlist.queue).toEqual(defaultQueue());
    expect(playlistToJson(playlist).blend).toEqual(BLEND.blend);
    expect(roundTrip(playlist).playlist).toEqual(playlist);
  });

  it("is lenient about the format and the root", () => {
    expect(parsePlaylist({ type: "layer", entries: [] }, "a.playlist.json").problems).toEqual(['a.playlist.json: format: expected "myco.playlist@1"; reading it anyway.']);
    const bad = parsePlaylist([1, 2]);
    expect(bad.playlist).toEqual(emptyPlaylist("queue"));
    expect(bad.problems).toEqual(["a playlist must be a JSON object; using an empty Queue."]);
    const untyped = parsePlaylist({ format: "myco.playlist@1" });
    expect(untyped.playlist.type).toBe("queue");
    expect(untyped.problems).toEqual(['type: missing; using "queue".']);
  });

  it("clamps and defaults bad values with one problem each", () => {
    const { playlist, problems } = parsePlaylist({
      format: "myco.playlist@1", type: "queue", volume: 99, playback: { maxInstances: 40, chance: "always", whenFull: "kill" },
      volumeRandom: [3, -3], spatial: { attenuation: 5, doppler: 9, spread: 400 }, entries: [],
    });
    expect(playlist.volume).toBe(24);
    expect(playlist.playback).toMatchObject({ maxInstances: 32, chance: 1, whenFull: "stealOldest" });
    expect(playlist.volumeRandom).toEqual([-3, 3]);
    expect(playlist.spatial).toEqual({ attenuation: null, occlusion: true, doppler: 5, spread: 360 });
    expect(problems).toHaveLength(8);
  });

  it("reads inline attenuation", () => {
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "layer", entries: [], spatial: { attenuation: { minDistance: 2, maxDistance: 40, curves: { volume: [[2, 0], [40, -60]] } } } });
    expect(problems).toEqual([]);
    expect(playlist.spatial?.attenuation).toEqual({ minDistance: 2, maxDistance: 40, curves: { volume: [[2, 0], [40, -60]] } });
    expect(roundTrip(playlist).playlist).toEqual(playlist);
  });
});

describe("parsePlaylist: the rules the runtime needs", () => {
  it("wraps a sample outside a Clip in an embedded Clip, moving the per-use fields out", () => {
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "queue", entries: [{ sample: "audio/a.wav", trim: [0, 1], loop: "on", weight: 3, volume: -6 }] });
    expect(problems).toEqual(["entries[0]: a sample plays only in a Clip; wrapped in an embedded Clip."]);
    const e = playlist.entries[0] as EmbeddedEntry;
    expect(e).toMatchObject({ kind: "embedded", weight: 3, volume: -6 });
    expect(e.embedded.type).toBe("clip");
    expect(e.embedded.entries[0]).toEqual({ kind: "sample", sample: "audio/a.wav", trim: [0, 1], loop: "on", volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} });
    // Written back it reads without problems.
    expect(roundTrip(playlist).problems).toEqual([]);
  });

  it("keeps a Clip to samples and says when it has none or several", () => {
    const one = parsePlaylist({ format: "myco.playlist@1", type: "clip", entries: [{ playlist: "a.playlist.json" }, { sample: "a.wav" }, { sample: "b.wav" }] });
    expect(one.playlist.entries.map((e) => (e as SampleEntry).sample)).toEqual(["a.wav", "b.wav"]);
    expect(one.problems).toEqual(["entries: a Clip plays a sample; its other entries are dropped.", "entries: a Clip plays one sample; the entries after the first are kept but not played."]);
    expect(parsePlaylist({ format: "myco.playlist@1", type: "clip", entries: [] }).problems).toEqual(["entries: a Clip needs one sample; it plays nothing."]);
  });

  it("drops entries that name nothing and reports entries that name two things", () => {
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "layer", entries: [{}, 4, { playlist: "" }, { playlist: "a.playlist.json", embedded: { type: "layer" } }] });
    expect(playlist.entries).toHaveLength(1);
    expect(playlist.entries[0].kind).toBe("linked");
    expect(problems).toHaveLength(4);
  });

  it("points Switch map labels at entries that exist", () => {
    const { playlist, problems } = parsePlaylist({ ...SWITCH, switch: { ...SWITCH.switch, map: { explore: 0, combat: 5, boss: -1, calm: 1.5 } } });
    expect(playlist.switch!.map).toEqual({ explore: 0, combat: null, boss: null, calm: null });
    expect(problems).toHaveLength(3);
  });

  it("turns a transition rule without a transition into a crossfade", () => {
    const { playlist, problems } = parsePlaylist({ ...SWITCH, switch: { ...SWITCH.switch, rules: [{ from: "a", to: "b", when: "beat", how: "transition" }] } });
    expect(playlist.switch!.rules[0]).toEqual({ from: "a", to: "b", when: "beat", how: "crossfade", length: { beats: 1 } });
    expect(problems).toHaveLength(1);
  });

  it("gives a sequence clip exactly one source and unique ids", () => {
    const { playlist, problems } = parsePlaylist({
      format: "myco.playlist@1", type: "sequence", entries: [],
      sequence: { length: 8, tracks: [
        { id: "t", name: "A", kind: "audio", clips: [{ id: "c", sample: "a.wav", playlist: "p.playlist.json", at: 0, length: 1 }, { id: "c", at: 1, length: 1 }, { id: "c", sample: "b.wav", at: 2, length: 1 }] },
        { id: "t", name: "B", kind: "playlist", clips: [{ id: "c", sample: "a.wav", playlist: "p.playlist.json", at: 0, length: 1 }] },
      ] },
    });
    const [a, b] = playlist.sequence!.tracks;
    expect([a.id, b.id]).toEqual(["t", "t1"]);
    expect(a.clips.map((c) => [c.id, c.sample, c.playlist])).toEqual([["c", "a.wav", undefined], ["c1", "b.wav", undefined]]);
    expect(b.clips.map((c) => [c.id, c.sample, c.playlist])).toEqual([["c2", undefined, "p.playlist.json"]]);
    expect(problems).toHaveLength(6);
  });

  it("drops automation with a bad target or no keys", () => {
    const { playlist, problems } = parsePlaylist({
      format: "myco.playlist@1", type: "sequence", entries: [],
      sequence: { tracks: [{ id: "t", name: "A", kind: "audio", clips: [], automation: [
        { target: "loudness", curve: [[0, 0]] }, { target: "pan", curve: [] }, { target: "fx:e1:cutoff", input: "speed", curve: [[0, 1]] },
      ] }] },
    });
    expect(playlist.sequence!.tracks[0].automation).toEqual([{ id: "a1", target: "fx:e1:cutoff", input: { parameter: "speed" }, curve: [[0, 1]], bypass: false }]);
    expect(problems).toHaveLength(3);
  });

  it("reads a playlist's own automation, defaulting to voice time and turning clip or sequence time into it", () => {
    const { playlist, problems } = parsePlaylist({
      format: "myco.playlist@1", type: "queue", entries: [],
      automation: [
        { id: "a1", target: "pitch", curve: [[0, 0], [2, 3]] },
        { id: "x", target: "enabled", input: "clipTime", curve: [[0, 1]] },
        { id: "a2", target: "pan", input: { parameter: "side" }, curve: [[0, -1], [1, 1]], bypass: true },
        { target: "loud", curve: [[0, 0]] },
      ],
    });
    expect(playlist.automation).toEqual([
      { id: "a1", target: "pitch", input: "voiceTime", curve: [[0, 0], [2, 3]], bypass: false },
      { id: "x", target: "enabled", input: "voiceTime", curve: [[0, 1]], bypass: false },
      { id: "a2", target: "pan", input: { parameter: "side" }, curve: [[0, -1], [1, 1]], bypass: true },
    ]);
    expect(problems).toEqual([
      "automation[1].input: clipTime belongs to sequence clips and tracks; a playlist's own automation reads voiceTime.",
      "automation[3].target: must be volume, pitch, pan, enabled, fx:<effect id>:<parameter> or gen:<parameter>; dropped.",
    ]);
    expect(parsePlaylist(playlistToJson(playlist)).playlist).toEqual(playlist);
    expect(playlistToJson(emptyPlaylist())).not.toHaveProperty("automation");
  });
});

describe("parsePlaylist: limits", () => {
  it("declares the ADR 0343 limits", () => {
    expect(PLAYLIST_LIMITS).toMatchObject({ entries: 256, nesting: 16, tracks: 32, clips: 512, curveKeys: 64 });
  });

  it("caps entries", () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ playlist: `p${i}.playlist.json` }));
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "layer", entries });
    expect(playlist.entries).toHaveLength(256);
    expect(problems).toHaveLength(44);
  });

  it("caps nesting", () => {
    let body: Record<string, unknown> = { type: "layer", entries: [] };
    for (let i = 0; i < 20; i++) body = { type: "layer", entries: [{ embedded: body }] };
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", ...body });
    let depth = 0;
    let at = playlist as PlaylistAsset | EmbeddedEntry["embedded"];
    while (at.entries.length) { at = (at.entries[0] as EmbeddedEntry).embedded; depth++; }
    expect(depth).toBe(16);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nest at most 16 deep");
  });

  it("caps tracks, clips and curve keys", () => {
    const tracks = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: "T", kind: "audio", clips: Array.from({ length: 20 }, (_, j) => ({ id: `c${i}_${j}`, sample: "a.wav", at: j, length: 1 })) }));
    const seq = parsePlaylist({ format: "myco.playlist@1", type: "sequence", entries: [], sequence: { tracks } }).playlist.sequence!;
    expect(seq.tracks).toHaveLength(32);
    expect(seq.tracks.reduce((n, t) => n + t.clips.length, 0)).toBe(512);
    const keys = Array.from({ length: 80 }, (_, i) => [i, i]);
    const p = parsePlaylist({ format: "myco.playlist@1", type: "layer", entries: [{ playlist: "a.playlist.json", curves: { gain: { curve: keys } } }] }).playlist;
    expect(p.entries[0].curves.gain?.curve).toHaveLength(64);
  });
});

describe("parsePlaylistBody", () => {
  it("parses an embedded body and falls back for a non-object", () => {
    const problems: string[] = [];
    expect(parsePlaylistBody({ type: "clip", entries: [{ sample: "a.wav" }] }, "x", problems).entries).toHaveLength(1);
    expect(problems).toEqual([]);
    expect(parsePlaylistBody(null, "x", problems).type).toBe("queue");
    expect(problems).toHaveLength(1);
  });
});

describe("isPlaylistPath", () => {
  it("knows the suffix", () => {
    expect(isPlaylistPath("audio/A.Playlist.json")).toBe(true);
    expect(isPlaylistPath("audio/a.audioevent.json")).toBe(false);
  });
});

describe("round trip over generated playlists", () => {
  /** A small seeded generator. */
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  it("parse(write(parse(x))) equals parse(x) for many random files, valid or not", () => {
    for (let s = 1; s <= 200; s++) {
      const rand = rng(s);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
      const maybe = <T,>(v: T): T | undefined => (rand() < 0.5 ? v : undefined);
      const curve = () => Array.from({ length: Math.floor(rand() * 4) }, (_, i) => [i, Math.round(rand() * 20 - 10), ...(rand() < 0.3 ? ["smooth"] : [])]);
      const entry = (depth: number): unknown => {
        const kind = pick(["sample", "playlist", "embedded", "junk"]);
        const use = { volume: maybe(Math.round(rand() * 20 - 10)), weight: maybe(Math.round(rand() * 5)), x: maybe(rand() * 100), atZeroWeight: maybe(pick(["stop", "continue", "?"])), curves: maybe({ gain: { input: pick(["voiceTime", "rpm", 3]), curve: curve() } }) };
        if (kind === "sample") return { sample: "a.wav", trim: maybe([0, rand() * 2]), loop: maybe(pick(["on", "off", "inherit", "x"])), ...use };
        if (kind === "playlist") return { playlist: `p${s}.playlist.json`, ...use };
        if (kind === "embedded" && depth < 3) return { embedded: body(depth + 1), ...use };
        return pick([{}, 7, null]);
      };
      const body = (depth: number): Record<string, unknown> => ({
        type: pick(["clip", "queue", "switch", "blend", "layer", "sequence", "nope"]),
        output: maybe(pick(["SFX", "", null])),
        volume: maybe(rand() * 200 - 100),
        playback: maybe({ maxInstances: Math.round(rand() * 40), whenFull: pick(["refuse", "x"]) }),
        effects: maybe([{ type: pick(["eq", "delay", "flanger"]), params: { low: rand() * 40 - 20 } }]),
        entries: Array.from({ length: Math.floor(rand() * 4) }, () => entry(depth)),
        queue: maybe({ pick: pick(["random", "roundRobin"]), continuous: maybe({ gapMs: 50 }) }),
        switch: maybe({ parameter: "State", map: { a: 0, b: 3, c: null }, onChange: { when: pick(["bar", "now"]), how: pick(["transition", "cut"]), transition: maybe(entry(depth)) }, rules: [{ from: "a", when: "beat" }] }),
        blend: maybe({ axes: pick([[{ parameter: "speed" }], [{ voiceTime: 50 }, "rpm"], []]), follow: pick(["hold", { glideMs: 10 }, 3]) }),
        sequence: maybe({
          length: rand() * 10, tempo: maybe({ bpm: rand() * 500, meter: pick(["3/4", "x"]) }),
          tracks: [{ name: "T", kind: pick(["audio", "playlist"]), clips: [{ sample: maybe("a.wav"), playlist: maybe(pick(["p.playlist.json", { type: "clip", entries: [] }])), at: rand() * 4, length: rand() * 2, loops: maybe({ l1: { active: "held", start: 1, end: 0.5 } }), automation: maybe([{ target: pick(["volume", "fx:a:b", "nope"]), curve: curve() }]) }] }],
          loops: maybe([{ start: 2, end: 1, active: "parameter" }]), markers: maybe([{ name: "M", at: 1 }]),
        }),
        stingers: maybe([{ trigger: "t", playlist: entry(depth), at: pick(["hit", "x"]) }]),
        spatial: maybe(pick([null, { attenuation: "a.attenuation.json" }, { attenuation: { minDistance: 3, maxDistance: 1, curves: { volume: curve() } }, spread: 90 }])),
      });
      const first = parsePlaylist({ format: "myco.playlist@1", ...body(0) }).playlist;
      const again = roundTrip(first);
      // Nothing needs repairing the second time; only the advisory notes about a Clip's sample count remain.
      expect(again.problems.filter((p) => !/a Clip (needs|plays) one sample/.test(p)), `seed ${s}`).toEqual([]);
      expect(again.playlist, `seed ${s}`).toEqual(first);
    }
  });
});

describe("sequence markers", () => {
  it("keep their type (note, cue, exit) through write and parse; an unknown type reads as a note with a problem", () => {
    const raw = { format: "myco.playlist@1", type: "sequence", sequence: { length: 4, markers: [
      { id: "a", name: "Hit", at: 1, type: "cue" }, { id: "b", name: "Out", at: 2, type: "exit" },
      { id: "c", name: "Plain", at: 3 }, { id: "d", name: "Odd", at: 3.5, type: "bogus" },
    ] } };
    const { playlist, problems } = parsePlaylist(raw);
    expect(playlist.sequence!.markers.map((m) => m.type)).toEqual(["cue", "exit", undefined, undefined]);
    expect(problems.some((p) => p.includes("bogus"))).toBe(true);
    const again = parsePlaylist(playlistToJson(playlist));
    expect(again.problems).toEqual([]);
    expect(again.playlist.sequence!.markers).toEqual(playlist.sequence!.markers);
  });

  it("keep a colour (theme token or #rrggbb) and a note through write and parse; bad ones are dropped (ADR 0362 item 4)", () => {
    const raw = { format: "myco.playlist@1", type: "sequence", sequence: { length: 4, markers: [
      { id: "a", name: "Drop", at: 1, colour: "warning", note: "Hit lands here" }, { id: "b", name: "Out", at: 2, colour: "#6AA8FF" },
      { id: "c", name: "Bad", at: 3, colour: "rgb(1,2,3)", note: 5 }, { id: "d", name: "Plain", at: 3.5, note: "  " },
    ] } };
    const { playlist, problems } = parsePlaylist(raw);
    expect(playlist.sequence!.markers.map((m) => [m.colour, m.note])).toEqual([["warning", "Hit lands here"], ["#6aa8ff", undefined], [undefined, undefined], [undefined, undefined]]);
    expect(problems.filter((p) => p.includes("markers[2]"))).toHaveLength(2);
    const json = playlistToJson(playlist) as { sequence: { markers: Record<string, unknown>[] } };
    expect(json.sequence.markers[0]).toEqual({ id: "a", name: "Drop", at: 1, colour: "warning", note: "Hit lands here" });
    expect(json.sequence.markers[3]).toEqual({ id: "d", name: "Plain", at: 3.5 });
    expect(parsePlaylist(json).playlist.sequence!.markers).toEqual(playlist.sequence!.markers);
  });
});

describe("ADR 0357 §4: captions; ADR 0354 §5: line entries", () => {
  it("reads, writes and round-trips a caption", () => {
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "queue", caption: { key: "cc.door_slams", minGap: 2 }, entries: [] });
    expect(problems).toEqual([]);
    expect(playlist.caption).toEqual({ key: "cc.door_slams", minGap: 2 });
    expect(playlistToJson(playlist).caption).toEqual({ key: "cc.door_slams", minGap: 2 });
    expect(roundTrip(playlist)).toEqual({ playlist, problems: [] });
    const short = parsePlaylist({ format: "myco.playlist@1", type: "queue", caption: { key: "cc.step" }, entries: [] }).playlist;
    expect(playlistToJson(short).caption).toEqual({ key: "cc.step" });
    expect("caption" in playlistToJson(emptyPlaylist())).toBe(false);
  });

  it("drops a bad caption and clamps its gap, one problem each", () => {
    const bad = parsePlaylist({ format: "myco.playlist@1", type: "queue", caption: { key: "not a key" }, entries: [] }, "p");
    expect(bad.playlist.caption).toBeUndefined();
    expect(bad.problems).toEqual(["p: caption: must be { key, minGap } with a string key; dropped."]);
    const far = parsePlaylist({ format: "myco.playlist@1", type: "queue", caption: { key: "cc.x", minGap: 999 }, entries: [] }, "p");
    expect(far.playlist.caption).toEqual({ key: "cc.x", minGap: PLAYLIST_LIMITS.captionGap });
  });

  it("reads, writes and round-trips line entries in a Clip: fixed, programmer and event forms", () => {
    const raw = { format: "myco.playlist@1", type: "clip", entries: [{ line: "intro_01" }, { line: null, volume: -3 }, { line: { event: "enemy_spotted" } }] };
    const { playlist, problems } = parsePlaylist(raw, "p");
    expect(problems.filter((p) => !p.includes("plays one sample"))).toEqual([]);
    expect(playlist.entries.map((e) => (e.kind === "line" ? e.line : e.kind))).toEqual(["intro_01", null, { event: "enemy_spotted" }]);
    expect(playlistToJson(playlist).entries).toEqual(raw.entries);
    expect(parsePlaylist(playlistToJson(playlist)).playlist).toEqual(playlist);
  });

  it("wraps a line outside a Clip and drops a bad one", () => {
    const { playlist, problems } = parsePlaylist({ format: "myco.playlist@1", type: "queue", entries: [{ line: "intro_01" }, { line: "bad key" }, { line: { event: 3 } }] }, "p");
    expect(playlist.entries).toHaveLength(1);
    expect((playlist.entries[0] as EmbeddedEntry).embedded.entries[0]).toMatchObject({ kind: "line", line: "intro_01" });
    expect(problems).toEqual([
      "p: entries[0]: a line plays only in a Clip; wrapped in an embedded Clip.",
      "p: entries[1].line: must be a line key, null or { event }; dropped.",
      "p: entries[2].line: must be a line key, null or { event }; dropped.",
    ]);
  });
});
