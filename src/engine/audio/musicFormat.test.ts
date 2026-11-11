import { describe, expect, it } from "vitest";
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
