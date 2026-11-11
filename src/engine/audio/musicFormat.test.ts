import { describe, expect, it } from "vitest";
import { eventClips, formatAudioEvent, parseAudioEvent } from "./eventFormat";
import {
  formatMusicNode, isMusicError, musicClips, musicNodeToJson, newMusicContext, parseMusicSegment, parseSegmentNode,
  segmentEntryPosition, segmentExitPosition,
} from "./musicFormat";

const full = {
  type: "segment", id: "explore", value: "explore", gridOffset: 0.5, plays: 2, volume: 0.8, weight: 2,
  tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "9:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 4 }],
  cues: [{ name: "entry", at: "1:1:0" }, { name: "hit", at: "3:3:0" }, { name: "exit", at: "end" }],
  entry: "entry", exit: "exit",
  regions: [{ id: "loop", from: "1:1:0", to: "9:1:0", count: 0, tailBeats: 4, while: { parameter: "Boss", is: "alive" } }],
  tracks: [
    { name: "drums", clip: "music/e-drums.ogg", alternatives: ["music/e-drums-b.ogg"], pick: "random", volume: 0.5, bus: "Drums",
      automation: [{ parameter: "Intensity", target: "volume", curve: [[0, 0], [1, 1]], quantize: "bar" }] },
    { name: "bass", clip: "music/e-bass.ogg" },
  ],
};

describe("musicFormat writer", () => {
  it("round-trips a full segment: parse(write(x)) equals x and the text is idempotent", () => {
    const a = parseMusicSegment(full);
    expect(a.problems).toEqual([]);
    const text = formatMusicNode(a.value!);
    const b = parseMusicSegment(JSON.parse(text));
    expect(b.problems).toEqual([]);
    expect(b.value).toEqual(a.value);
    expect(formatMusicNode(b.value!)).toBe(text);
  });

  it("writes type and id first and omits defaults and the ignored NodeBase keys", () => {
    const { value } = parseMusicSegment({ type: "segment", id: "s", tracks: [{ name: "a", clip: "a.ogg" }] });
    const json = musicNodeToJson(value!);
    expect(Object.keys(json)).toEqual(["type", "id", "tracks"]);
    expect(json.tracks).toEqual([{ name: "a", clip: "a.ogg" }]);
  });

  it("a written segment re-parses with no problems (no pitch/delay/fade keys leak)", () => {
    const { value } = parseMusicSegment({ ...full, pitch: 2, delay: 1, fade: 1, range: [0, 1] });
    expect(parseMusicSegment(JSON.parse(formatMusicNode(value!))).problems).toEqual([]);
  });

  it("round-trips a segment with no tracks and with problems fixed by the parse (idempotent after one pass)", () => {
    const first = parseMusicSegment({ type: "segment", id: "x", tempo: [{ at: "2:2:5", bpm: 90 }], cues: [{ name: "c", at: "01:1:000" }] });
    expect(first.problems.length).toBeGreaterThan(0);
    const second = parseMusicSegment(JSON.parse(formatMusicNode(first.value!)));
    expect(second.value).toEqual(first.value);
    expect(second.problems).toEqual(["segment.tracks: has no tracks; it plays nothing."]);
  });

  it("entry, exit and clip helpers", () => {
    const { value } = parseMusicSegment(full);
    expect(segmentEntryPosition(value!)).toBe("1:1:0");
    expect(segmentExitPosition(value!)).toBe("end");
    expect(musicClips(value!)).toEqual(["music/e-drums.ogg", "music/e-drums-b.ogg", "music/e-bass.ogg"]);
    const bare = parseMusicSegment({ type: "segment", id: "b", tracks: [] }).value!;
    expect(segmentEntryPosition(bare)).toBe("1:1:0");
    expect(segmentExitPosition(bare)).toBe("end");
  });

  it("a pitch binding is an error-level problem", () => {
    const { problems } = parseMusicSegment({ type: "segment", id: "s", tracks: [{ name: "a", clip: "a", automation: [{ parameter: "p", target: "pitch", curve: [[0, 1], [1, 2]] }] }] });
    expect(problems.some(isMusicError)).toBe(true);
  });

  it("a metre change at the last bar is dropped rather than snapping past the position range", () => {
    const { value, problems } = parseMusicSegment({ type: "segment", id: "s", tracks: [], tempo: [{ at: "1:1:0", bpm: 100 }, { at: "99999:2:0", beatsPerBar: 3 }] });
    expect(value!.tempo).toHaveLength(1);
    expect(problems.some((p) => p.includes("no bar after"))).toBe(true);
  });

  it("shares ids across nodes through one context", () => {
    const ctx = newMusicContext();
    expect(parseSegmentNode({ type: "segment", id: "a", tracks: [] }, "root", ctx)).not.toBeNull();
    expect(parseSegmentNode({ type: "segment", id: "a", tracks: [] }, "library[0]", ctx)).toBeNull();
  });
});

describe("music containers in the event format (F1b)", () => {
  const seg = (id: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, tracks: [{ name: "a", clip: `${id}.ogg` }], ...extra });
  const event = (root: unknown) => parseAudioEvent({ format: "myco.audioevent@1", root });

  it("reads a playlist root into musicRoot and keeps root the empty layer", () => {
    const r = event({ type: "playlist", id: "p", mode: "shuffle", rounds: 0, children: [seg("a"), seg("b", { plays: 3 })] });
    expect(r.problems).toEqual([]);
    expect(r.value.root.type).toBe("layer");
    const m = r.value.musicRoot!;
    expect(m.type === "playlist" && [m.mode, m.rounds, m.children.length]).toEqual(["shuffle", 0, 2]);
    expect(eventClips(r.value)).toEqual(["a.ogg", "b.ogg"]);
  });

  it("drops a music node under a 0158 container and a 0158 node under a music container, each with a problem", () => {
    const a = event({ type: "random", children: [seg("s"), { type: "clip", clip: "c.ogg" }] });
    expect(a.problems).toContainEqual(expect.stringMatching(/^root\.children\[0\]: a segment is a music node/));
    expect(a.value.root.type === "random" && a.value.root.children).toHaveLength(1);
    const b = event({ type: "musicSwitch", id: "m", parameter: "S", children: [{ type: "clip", clip: "c.ogg" }, seg("s", { value: "x" })] });
    expect(b.problems).toContainEqual(expect.stringMatching(/^root\.children\[0\]: a clip is not a music node/));
    expect(b.value.musicRoot!.type === "musicSwitch" && b.value.musicRoot!.children).toHaveLength(1);
    const c = event({ type: "sustain", loop: seg("s") });
    expect(c.problems).toContainEqual(expect.stringMatching(/^root\.loop: a segment is a music node/));
  });

  it("requires unique ids across music nodes, library segments and 0158 ids", () => {
    const r = event({ type: "playlist", id: "p", children: [seg("a"), seg("a")], library: [seg("p"), seg("lib")] });
    expect(r.problems).toContainEqual(expect.stringMatching(/^root\.children\[1\]\.id: another node is already named "a"/));
    expect(r.problems).toContainEqual(expect.stringMatching(/^root\.library\[0\]\.id: another node is already named "p"/));
    const n = event({ type: "random", id: "x", children: [{ type: "clip", id: "x", clip: "c.ogg" }, { type: "clip", id: "bad id", clip: "d.ogg" }] });
    expect(n.problems).toHaveLength(2);
    const root = n.value.root;
    expect(root.type === "random" && root.children.map((c) => c.id)).toEqual([undefined, undefined]);
  });

  it("applies the container limits: 256 children, 64 library segments, node budget, depth", () => {
    const kids = Array.from({ length: 300 }, (_, i) => seg(`c${i}`));
    const r = event({ type: "playlist", id: "p", children: kids });
    expect(r.problems).toContainEqual(expect.stringMatching(/^root\.children: at most 256 entries/));
    expect(r.value.musicRoot!.type === "playlist" && r.value.musicRoot!.children).toHaveLength(256);
    const lib = event({ type: "playlist", id: "p", children: [seg("a")], library: Array.from({ length: 70 }, (_, i) => seg(`l${i}`)) });
    expect(lib.problems).toContainEqual(expect.stringMatching(/^root\.library: at most 64 entries/));
    let deep: unknown = seg("leaf");
    for (let i = 0; i < 20; i++) deep = { type: "playlist", id: `p${i}`, children: [deep] };
    expect(event(deep).problems).toContainEqual(expect.stringMatching(/nested deeper than 16/));
  });

  it("checks musicSwitch children (value) and caps avoidRepeat; reads an empty container with a problem", () => {
    const r = event({ type: "musicSwitch", id: "m", parameter: "S", children: [seg("a", { value: "x" }), seg("b", { value: "x" }), seg("c")] });
    expect(r.problems).toContainEqual(expect.stringMatching(/^root\.children\[1\]\.value: another child already has/));
    expect(r.problems).toContainEqual(expect.stringMatching(/^root\.children\[2\]: a musicSwitch child needs a value/));
    const p = event({ type: "playlist", id: "p", mode: "random", avoidRepeat: 5, children: [seg("a"), seg("b")] });
    expect(p.problems).toContainEqual(expect.stringMatching(/^root\.avoidRepeat: 5 is outside 0\.\.1/));
    expect(event({ type: "playlist", id: "e" }).problems).toContainEqual(expect.stringMatching(/^root: has no children/));
  });

  it("writes a music root through musicNodeToJson (no pitch or fade keys) and round-trips", () => {
    const r = event({ type: "playlist", id: "p", pitch: 2, fade: 1, children: [seg("a", { pitch: 2 })], library: [seg("lib")] });
    expect(r.problems.filter((p) => p.includes("not used on music"))).toHaveLength(3);
    const text = formatAudioEvent(r.value);
    expect(JSON.stringify(JSON.parse(text).root)).not.toMatch(/"pitch"|"fade"/);
    const again = parseAudioEvent(JSON.parse(text));
    expect(again.problems).toEqual([]);
    expect(again.value).toEqual(r.value);
    expect(formatAudioEvent(again.value)).toBe(text);
  });
});
