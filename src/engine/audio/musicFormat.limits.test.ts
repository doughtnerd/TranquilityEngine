/**
 * Every limit and message of `api-and-models.md` §2.3 for the `segment` node (L-F1aa fills these; the cases are named
 * and skipped in the skeleton). Each case parses a small raw segment with `parseMusicSegment` (or `parseSegmentNode`
 * with a shared `newMusicContext()` for ids) and asserts the value (clamped, dropped or kept) AND that `problems`
 * has one message naming the path (e.g. `segment.tempo[1].at`). Placement under non-music containers is F1b's, and
 * `transitions`, `stingers` and `library` limits are F2's: not here.
 */
import { describe, expect, it, vi } from "vitest";
import {
  isMusicError, newMusicContext, parseMusicSegment, parseSegmentNode, segmentEntryPosition, segmentExitPosition,
  type MusicParseContext, type SegmentNode,
} from "./musicFormat";

const track = { name: "a", clip: "a.ogg" };

/** A valid segment with one stem, `extra` on top. */
const raw = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "segment", id: "s", tracks: [track], ...extra });

/** Parse a segment that must be kept (the value is not null). */
function kept(extra: Record<string, unknown> = {}): { node: SegmentNode; problems: string[] } {
  const r = parseMusicSegment(raw(extra));
  if (!r.value) throw new Error(`segment dropped: ${r.problems.join(" | ")}`);
  return { node: r.value, problems: r.problems };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A problem message that names `path` (then `:`, `.` or `[`) and contains `phrase`; an error-level one counts too. */
const problem = (path: string, phrase: string) => expect.stringMatching(new RegExp(`^(error: )?${esc(path)}[:.\\[].*${esc(phrase)}`));
/** The problems that name `path`. */
const pathed = (problems: string[], path: string): string[] => problems.filter((p) => new RegExp(`^(error: )?${esc(path)}[:.\\[]`).test(p));

describe("musicFormat limits (L-F1aa)", () => {
  describe("ids", () => {
    it("L-F1aa: a missing id drops the node with a problem naming `segment.id`", () => {
      const r = parseMusicSegment({ type: "segment", tracks: [track] });
      expect(r.value).toBeNull();
      expect(r.problems).toContainEqual(problem("segment.id", "required"));
    });

    it("L-F1aa: an id that fails ^[A-Za-z0-9_-]{1,48}$ drops the node (empty, 49 chars, space, dot, non-string)", () => {
      for (const bad of ["", "a".repeat(49), "a b", "a.b", 5]) {
        const r = parseMusicSegment(raw({ id: bad }));
        expect(r.value, JSON.stringify(bad)).toBeNull();
        expect(r.problems, JSON.stringify(bad)).toContainEqual(problem("segment.id", "not a valid id"));
      }
    });

    it("L-F1aa: a 48-character id and every allowed character are accepted", () => {
      const id48 = "AZaz09_-".repeat(6);
      expect(id48).toHaveLength(48);
      expect(kept({ id: id48 }).node.id).toBe(id48);
      const every = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcdefghijklmnopqrstuvwxyz".slice(0, 38);
      expect(kept({ id: every }).node.id).toBe(every);
      expect(pathed(kept({ id: id48 }).problems, "segment.id")).toEqual([]);
    });

    it("L-F1aa: a repeated id in one shared context drops the later node; a fresh context accepts it", () => {
      const ctx = newMusicContext();
      expect(parseSegmentNode(raw({ id: "x" }), "segment", ctx)).not.toBeNull();
      expect(parseSegmentNode(raw({ id: "x" }), "segment", ctx)).toBeNull();
      expect(ctx.problems).toContainEqual(problem("segment.id", "already named"));
      expect(parseSegmentNode(raw({ id: "x" }), "segment", newMusicContext())).not.toBeNull();
    });

    it("L-F1aa: ctx.admit returning false drops the node with a problem and does not take the id", () => {
      const admit = vi.fn(() => false);
      const ctx: MusicParseContext = { problems: [], ids: new Set(), admit };
      expect(parseSegmentNode(raw({ id: "y" }), "segment", ctx)).toBeNull();
      expect(admit).toHaveBeenCalledWith("segment");
      expect(ctx.problems).toContainEqual(problem("segment", "node limit"));
      expect(ctx.ids.has("y")).toBe(false);
    });
  });

  describe("ignored fields", () => {
    it("L-F1aa: pitch, pitchRandom, delay, range and fade each give exactly one problem and the value is neutral", () => {
      const values: Record<string, unknown> = { pitch: 2, pitchRandom: [1, 2], delay: 0.5, range: 3, fade: 1 };
      for (const [key, value] of Object.entries(values)) {
        const { problems } = kept({ [key]: value });
        expect(pathed(problems, `segment.${key}`), key).toHaveLength(1);
        expect(problems, key).toHaveLength(1);
      }
      const { node } = kept(values);
      expect([node.pitch, node.pitchRandom, node.delay, node.fade]).toEqual([1, [0, 0], 0, 0]);
    });

    it("L-F1aa: automation on the segment itself gives one problem and is ignored", () => {
      const { node, problems } = kept({ automation: [{ parameter: "P", target: "volume", curve: [[0, 0], [1, 1]] }] });
      expect(node.automation).toEqual([]);
      expect(pathed(problems, "segment.automation")).toHaveLength(1);
      expect(problems).toContainEqual(problem("segment.automation", "ignored"));
    });

    it("L-F1aa: volume clamps to 0..4 with a problem; volumeRandom clamps to -96..24 and swaps when reversed", () => {
      const loud = kept({ volume: 9 });
      expect(loud.node.volume).toBe(4);
      expect(loud.problems).toContainEqual(problem("segment.volume", "using 4"));

      const wide = kept({ volumeRandom: [-200, 30] });
      expect(wide.node.volumeRandom).toEqual([-96, 24]);
      expect(wide.problems).toContainEqual(problem("segment.volumeRandom", "clamped to -96..24"));

      const reversed = kept({ volumeRandom: [6, -6] });
      expect(reversed.node.volumeRandom).toEqual([-6, 6]);
      expect(reversed.problems).toContainEqual(problem("segment.volumeRandom", "swapped"));
    });
  });

  describe("gridOffset and plays", () => {
    it("L-F1aa: gridOffset defaults to 0, clamps below 0 with a problem, and a non-number gives 0 with a problem", () => {
      const def = kept();
      expect(def.node.gridOffset).toBe(0);
      expect(pathed(def.problems, "segment.gridOffset")).toEqual([]);

      const neg = kept({ gridOffset: -1 });
      expect(neg.node.gridOffset).toBe(0);
      expect(neg.problems).toContainEqual(problem("segment.gridOffset", "using 0"));

      const word = kept({ gridOffset: "soon" });
      expect(word.node.gridOffset).toBe(0);
      expect(word.problems).toContainEqual(problem("segment.gridOffset", "must be a number"));
    });

    it("L-F1aa: plays defaults to 1, clamps to 1..64, and rounds a fraction", () => {
      expect(kept().node.plays).toBe(1);

      const low = kept({ plays: 0 });
      expect(low.node.plays).toBe(1);
      expect(low.problems).toContainEqual(problem("segment.plays", "using 1"));

      const high = kept({ plays: 65 });
      expect(high.node.plays).toBe(64);
      expect(high.problems).toContainEqual(problem("segment.plays", "using 64"));

      const fraction = kept({ plays: 2.4 });
      expect(fraction.node.plays).toBe(2);
      expect(pathed(fraction.problems, "segment.plays")).toEqual([]);
    });
  });

  describe("tempo", () => {
    it("L-F1aa: absent or empty tempo gives one 120 bpm 4/4 marker at 1:1:0", () => {
      for (const tempo of [undefined, []]) {
        const { node, problems } = kept({ tempo });
        expect(node.tempo).toEqual([{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }]);
        expect(pathed(problems, "segment.tempo")).toEqual([]);
      }
    });

    it("L-F1aa: 64 markers are kept; the 65th is dropped with 'at most 64'", () => {
      const sixtyFour = Array.from({ length: 64 }, (_, i) => ({ at: `${i + 1}:1:0`, bpm: 120 }));
      const ok = kept({ tempo: sixtyFour });
      expect(ok.node.tempo).toHaveLength(64);
      expect(ok.problems).toEqual([]);

      const sixtyFive = Array.from({ length: 65 }, (_, i) => ({ at: `${i + 1}:1:0`, bpm: 120 }));
      const over = kept({ tempo: sixtyFive });
      expect(over.node.tempo).toHaveLength(64);
      expect(over.problems).toContainEqual(problem("segment.tempo", "at most 64"));
    });

    it("L-F1aa: bpm clamps to 1..1000; beatsPerBar clamps to 1..32 and rounds; beatUnit outside 1,2,4,8,16 keeps the previous", () => {
      const low = kept({ tempo: [{ at: "1:1:0", bpm: 0 }] });
      expect(low.node.tempo[0].bpm).toBe(1);
      expect(low.problems).toContainEqual(problem("segment.tempo[0].bpm", "using 1"));

      const high = kept({ tempo: [{ at: "1:1:0", bpm: 5000 }] });
      expect(high.node.tempo[0].bpm).toBe(1000);
      expect(high.problems).toContainEqual(problem("segment.tempo[0].bpm", "using 1000"));

      const zeroBeats = kept({ tempo: [{ at: "1:1:0", beatsPerBar: 0 }] });
      expect(zeroBeats.node.tempo[0].beatsPerBar).toBe(1);
      expect(zeroBeats.problems).toContainEqual(problem("segment.tempo[0].beatsPerBar", "using 1"));

      const manyBeats = kept({ tempo: [{ at: "1:1:0", beatsPerBar: 40 }] });
      expect(manyBeats.node.tempo[0].beatsPerBar).toBe(32);
      expect(manyBeats.problems).toContainEqual(problem("segment.tempo[0].beatsPerBar", "using 32"));

      const rounded = kept({ tempo: [{ at: "1:1:0", beatsPerBar: 3.6 }] });
      expect(rounded.node.tempo[0].beatsPerBar).toBe(4);
      expect(pathed(rounded.problems, "segment.tempo")).toEqual([]);

      const badUnit = kept({ tempo: [{ at: "1:1:0", beatUnit: 8 }, { at: "2:1:0", beatUnit: 3 }] });
      expect(badUnit.node.tempo[1].beatUnit).toBe(8);
      expect(badUnit.problems).toContainEqual(problem("segment.tempo[1].beatUnit", "using 8"));

      const legalUnits = kept({ tempo: [{ at: "1:1:0", beatUnit: 16 }, { at: "2:1:0", beatUnit: 1 }] });
      expect(legalUnits.node.tempo.map((t) => t.beatUnit)).toEqual([16, 1]);
      expect(pathed(legalUnits.problems, "segment.tempo")).toEqual([]);
    });

    it("L-F1aa: a marker omitting a field inherits the previous marker's value", () => {
      const { node, problems } = kept({ tempo: [{ at: "1:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 8 }, { at: "5:1:0" }] });
      expect(node.tempo[1]).toEqual({ at: "5:1:0", bpm: 90, beatsPerBar: 3, beatUnit: 8 });
      expect(pathed(problems, "segment.tempo")).toEqual([]);
    });

    it("L-F1aa: a first marker not at 1:1:0 moves to 1:1:0 with a problem", () => {
      const { node, problems } = kept({ tempo: [{ at: "2:1:0", bpm: 100 }] });
      expect(node.tempo[0].at).toBe("1:1:0");
      expect(problems).toContainEqual(problem("segment.tempo[0].at", "the first tempo marker is at 1:1:0"));
    });

    it("L-F1aa: a marker with a tick moves to its beat with a problem", () => {
      const { node, problems } = kept({ tempo: [{ at: "1:1:0" }, { at: "3:2:480", bpm: 100 }] });
      expect(node.tempo[1].at).toBe("3:2:0");
      expect(problems).toContainEqual(problem("segment.tempo[1].at", "sits on a beat"));
    });

    it("L-F1aa: a metre change off beat 1 snaps to the next bar with a problem; on beat 1 it stays", () => {
      const off = kept({ tempo: [{ at: "1:1:0", beatsPerBar: 4 }, { at: "3:2:0", beatsPerBar: 3 }] });
      expect(off.node.tempo[1]).toEqual({ at: "4:1:0", bpm: 120, beatsPerBar: 3, beatUnit: 4 });
      expect(off.problems).toContainEqual(problem("segment.tempo[1].at", "to the next bar"));

      const on = kept({ tempo: [{ at: "1:1:0", beatsPerBar: 4 }, { at: "3:1:0", beatsPerBar: 3 }] });
      expect(on.node.tempo[1].at).toBe("3:1:0");
      expect(pathed(on.problems, "segment.tempo")).toEqual([]);
    });

    it("L-F1aa: out-of-order markers are sorted with a problem; a marker at the same position as its predecessor is dropped", () => {
      const unsorted = kept({ tempo: [{ at: "1:1:0" }, { at: "9:1:0", bpm: 90 }, { at: "5:1:0", bpm: 80 }] });
      expect(unsorted.node.tempo.map((t) => t.at)).toEqual(["1:1:0", "5:1:0", "9:1:0"]);
      expect(unsorted.problems).toContainEqual(problem("segment.tempo", "sorted"));

      const same = kept({ tempo: [{ at: "1:1:0" }, { at: "3:1:0", bpm: 100 }, { at: "3:1:0", bpm: 90 }] });
      expect(same.node.tempo).toHaveLength(2);
      expect(same.node.tempo[1].bpm).toBe(100);
      expect(same.problems).toContainEqual(problem("segment.tempo[2].at", "dropped"));
    });

    it("L-F1aa: a marker with a bad at is dropped with a problem naming its index", () => {
      const { node, problems } = kept({ tempo: [{ at: "1:1:0" }, { at: "two:1:0" }] });
      expect(node.tempo).toHaveLength(1);
      expect(problems).toContainEqual(problem("segment.tempo[1].at", "dropped"));
    });
  });

  describe("cues", () => {
    it("L-F1aa: 64 cues are kept; the 65th is dropped with 'at most 64'", () => {
      const cues = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, at: `${i + 1}:1:0` }));
      const ok = kept({ cues: cues(64) });
      expect(ok.node.cues).toHaveLength(64);
      expect(ok.problems).toEqual([]);

      const over = kept({ cues: cues(65) });
      expect(over.node.cues).toHaveLength(64);
      expect(over.problems).toContainEqual(problem("segment.cues", "at most 64"));
    });

    it("L-F1aa: a repeated cue name is dropped with a problem; an empty or missing name is dropped", () => {
      const repeated = kept({ cues: [{ name: "a", at: "1:1:0" }, { name: "a", at: "2:1:0" }] });
      expect(repeated.node.cues).toEqual([{ name: "a", at: "1:1:0" }]);
      expect(repeated.problems).toContainEqual(problem("segment.cues[1]", "already named"));

      const blank = kept({ cues: [{ name: "", at: "1:1:0" }, { at: "2:1:0" }] });
      expect(blank.node.cues).toEqual([]);
      expect(blank.problems).toContainEqual(problem("segment.cues[0]", "non-empty"));
      expect(blank.problems).toContainEqual(problem("segment.cues[1]", "non-empty"));
    });

    it("L-F1aa: cue at accepts bar:beat:tick, start and end, stored canonically ('01:1:000' becomes '1:1:0'); a bad at drops the cue", () => {
      const canon = kept({ cues: [{ name: "a", at: "01:1:000" }] });
      expect(canon.node.cues).toEqual([{ name: "a", at: "1:1:0" }]);
      expect(pathed(canon.problems, "segment.cues")).toEqual([]);

      const words = kept({ cues: [{ name: "s", at: "start" }, { name: "e", at: "end" }] });
      expect(words.node.cues).toEqual([{ name: "s", at: "start" }, { name: "e", at: "end" }]);

      const bad = kept({ cues: [{ name: "b", at: "1:0:0" }] });
      expect(bad.node.cues).toEqual([]);
      expect(bad.problems).toContainEqual(problem("segment.cues[0].at", "the cue is dropped"));
    });

    it("L-F1aa: entry and exit name existing cues; a dangling name gives a problem and is cleared; segmentEntryPosition and segmentExitPosition defaults", () => {
      const named = kept({ cues: [{ name: "entry", at: "2:1:0" }, { name: "exit", at: "8:1:0" }] });
      expect(segmentEntryPosition(named.node)).toBe("2:1:0");
      expect(segmentExitPosition(named.node)).toBe("8:1:0");

      const none = kept();
      expect(segmentEntryPosition(none.node)).toBe("1:1:0");
      expect(segmentExitPosition(none.node)).toBe("end");

      const chosen = kept({ cues: [{ name: "intro", at: "3:1:0" }], entry: "intro" });
      expect(chosen.node.entry).toBe("intro");
      expect(segmentEntryPosition(chosen.node)).toBe("3:1:0");

      const dangling = kept({ entry: "nope", exit: "nope" });
      expect(dangling.node.entry).toBeUndefined();
      expect(dangling.node.exit).toBeUndefined();
      expect(dangling.problems).toContainEqual(problem("segment.entry", "no cue named"));
      expect(dangling.problems).toContainEqual(problem("segment.exit", "no cue named"));
      expect(segmentEntryPosition(dangling.node)).toBe("1:1:0");
      expect(segmentExitPosition(dangling.node)).toBe("end");
    });
  });

  describe("regions", () => {
    it("L-F1aa: 16 regions are kept; the 17th is dropped with 'at most 16'", () => {
      const regions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, from: "1:1:0", to: `${i + 2}:1:0` }));
      const ok = kept({ regions: regions(16) });
      expect(ok.node.regions).toHaveLength(16);
      expect(ok.problems).toEqual([]);

      const over = kept({ regions: regions(17) });
      expect(over.node.regions).toHaveLength(16);
      expect(over.problems).toContainEqual(problem("segment.regions", "at most 16"));
    });

    it("L-F1aa: a repeated or empty region id is dropped", () => {
      const { node, problems } = kept({
        regions: [{ id: "r", from: "1:1:0", to: "2:1:0" }, { id: "r", from: "1:1:0", to: "3:1:0" }, { id: "", from: "1:1:0", to: "4:1:0" }],
      });
      expect(node.regions.map((r) => r.id)).toEqual(["r"]);
      expect(problems).toContainEqual(problem("segment.regions[1]", "already named"));
      expect(problems).toContainEqual(problem("segment.regions[2]", "non-empty"));
    });

    it("L-F1aa: from accepts start but not end; to accepts end but not start; a bad position drops the region", () => {
      const fromStart = kept({ regions: [{ id: "a", from: "start", to: "3:1:0" }] });
      expect(fromStart.node.regions[0].from).toBe("start");

      const fromEnd = kept({ regions: [{ id: "a", from: "end", to: "3:1:0" }] });
      expect(fromEnd.node.regions).toEqual([]);
      expect(fromEnd.problems).toContainEqual(problem("segment.regions[0].from", "the region is dropped"));

      const toEnd = kept({ regions: [{ id: "a", from: "1:1:0", to: "end" }] });
      expect(toEnd.node.regions[0].to).toBe("end");

      const toStart = kept({ regions: [{ id: "a", from: "1:1:0", to: "start" }] });
      expect(toStart.node.regions).toEqual([]);
      expect(toStart.problems).toContainEqual(problem("segment.regions[0].to", "the region is dropped"));

      const bad = kept({ regions: [{ id: "a", from: "1:0:0", to: "3:1:0" }] });
      expect(bad.node.regions).toEqual([]);
      expect(bad.problems).toContainEqual(problem("segment.regions[0].from", "the region is dropped"));
    });

    it("L-F1aa: from at or after to drops the region with a problem (start and end are never compared)", () => {
      const same = kept({ regions: [{ id: "a", from: "3:1:0", to: "3:1:0" }] });
      expect(same.node.regions).toEqual([]);
      expect(same.problems).toContainEqual(problem("segment.regions[0]", "is not before"));

      const reversed = kept({ regions: [{ id: "a", from: "4:1:0", to: "2:1:0" }] });
      expect(reversed.node.regions).toEqual([]);
      expect(reversed.problems).toContainEqual(problem("segment.regions[0]", "is not before"));

      const startFirst = kept({ regions: [{ id: "a", from: "start", to: "1:1:0" }] });
      expect(startFirst.node.regions).toHaveLength(1);
      expect(pathed(startFirst.problems, "segment.regions")).toEqual([]);

      const endLast = kept({ regions: [{ id: "b", from: "9:1:0", to: "end" }] });
      expect(endLast.node.regions).toHaveLength(1);
      expect(pathed(endLast.problems, "segment.regions")).toEqual([]);
    });

    it("L-F1aa: count defaults to 0, accepts 0 and 1..64, clamps 65 with a problem", () => {
      const def = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0" }] });
      expect(def.node.regions[0].count).toBe(0);
      expect(pathed(def.problems, "segment.regions")).toEqual([]);

      for (const count of [0, 1, 64]) {
        const ok = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0", count }] });
        expect(ok.node.regions[0].count).toBe(count);
        expect(pathed(ok.problems, "segment.regions")).toEqual([]);
      }

      const over = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0", count: 65 }] });
      expect(over.node.regions[0].count).toBe(64);
      expect(over.problems).toContainEqual(problem("segment.regions[0].count", "using 64"));
    });

    it("L-F1aa: tailBeats absent stays absent; clamps to 0..16 with a problem", () => {
      const absent = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0" }] });
      expect(absent.node.regions[0]).not.toHaveProperty("tailBeats");

      const ok = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0", tailBeats: 4 }] });
      expect(ok.node.regions[0].tailBeats).toBe(4);

      const high = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0", tailBeats: 20 }] });
      expect(high.node.regions[0].tailBeats).toBe(16);
      expect(high.problems).toContainEqual(problem("segment.regions[0].tailBeats", "using 16"));

      const low = kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0", tailBeats: -1 }] });
      expect(low.node.regions[0].tailBeats).toBe(0);
      expect(low.problems).toContainEqual(problem("segment.regions[0].tailBeats", "using 0"));
    });

    it("L-F1aa: while accepts is, atLeast and below; two forms use the first with a problem; none, a bad parameter or a bad value drops the condition and keeps the region", () => {
      const region = (while_: unknown) => kept({ regions: [{ id: "a", from: "1:1:0", to: "2:1:0", while: while_ }] });

      expect(region({ parameter: "Boss", is: "alive" }).node.regions[0].while).toEqual({ parameter: "Boss", is: "alive" });
      expect(region({ parameter: "Boss", atLeast: 3 }).node.regions[0].while).toEqual({ parameter: "Boss", atLeast: 3 });
      expect(region({ parameter: "Boss", below: 2 }).node.regions[0].while).toEqual({ parameter: "Boss", below: 2 });

      const two = region({ parameter: "Boss", is: "alive", atLeast: 3 });
      expect(two.node.regions[0].while).toEqual({ parameter: "Boss", is: "alive" });
      expect(two.problems).toContainEqual(problem("segment.regions[0].while", "using is"));

      const none = region({ parameter: "Boss" });
      expect(none.node.regions).toHaveLength(1);
      expect(none.node.regions[0]).not.toHaveProperty("while");
      expect(none.problems).toContainEqual(problem("segment.regions[0].while", "the condition is dropped"));

      const noParam = region({ is: "alive" });
      expect(noParam.node.regions).toHaveLength(1);
      expect(noParam.node.regions[0]).not.toHaveProperty("while");
      expect(noParam.problems).toContainEqual(problem("segment.regions[0].while.parameter", "the condition is dropped"));

      const badNumber = region({ parameter: "Boss", atLeast: "3" });
      expect(badNumber.node.regions).toHaveLength(1);
      expect(badNumber.node.regions[0]).not.toHaveProperty("while");
      expect(badNumber.problems).toContainEqual(problem("segment.regions[0].while.atLeast", "the condition is dropped"));

      const badLabel = region({ parameter: "Boss", is: 5 });
      expect(badLabel.node.regions).toHaveLength(1);
      expect(badLabel.node.regions[0]).not.toHaveProperty("while");
      expect(badLabel.problems).toContainEqual(problem("segment.regions[0].while.is", "the condition is dropped"));
    });
  });

  describe("tracks", () => {
    it("L-F1aa: no tracks keeps the segment with 'has no tracks'; 16 tracks are kept and the 17th dropped with 'at most 16'", () => {
      const none = parseMusicSegment({ type: "segment", id: "s" });
      expect(none.value).not.toBeNull();
      expect(none.value?.tracks).toEqual([]);
      expect(none.problems).toContainEqual(problem("segment.tracks", "has no tracks"));

      const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, clip: "a.ogg" }));
      const ok = kept({ tracks: tracks(16) });
      expect(ok.node.tracks).toHaveLength(16);
      expect(ok.problems).toEqual([]);

      const over = kept({ tracks: tracks(17) });
      expect(over.node.tracks).toHaveLength(16);
      expect(over.problems).toContainEqual(problem("segment.tracks", "at most 16"));
    });

    it("L-F1aa: a missing track name becomes trackN with a problem; a repeated name is dropped", () => {
      const missing = kept({ tracks: [{ clip: "a.ogg" }] });
      expect(missing.node.tracks[0].name).toBe("track1");
      expect(missing.problems).toContainEqual(problem("segment.tracks[0].name", 'using "track1"'));

      const repeated = kept({ tracks: [{ name: "a", clip: "x.ogg" }, { name: "a", clip: "y.ogg" }] });
      expect(repeated.node.tracks.map((t) => t.clip)).toEqual(["x.ogg"]);
      expect(repeated.problems).toContainEqual(problem("segment.tracks[1]", "already named"));
    });

    it("L-F1aa: an empty clip is kept with 'clip is empty'; an asset: prefix is stripped", () => {
      const empty = kept({ tracks: [{ name: "a", clip: "" }] });
      expect(empty.node.tracks).toHaveLength(1);
      expect(empty.node.tracks[0].clip).toBe("");
      expect(empty.problems).toContainEqual(problem("segment.tracks[0]", "clip is empty"));

      const prefixed = kept({ tracks: [{ name: "a", clip: "asset:music/x.ogg", alternatives: ["asset:music/y.ogg"] }] });
      expect(prefixed.node.tracks[0].clip).toBe("music/x.ogg");
      expect(prefixed.node.tracks[0].alternatives).toEqual(["music/y.ogg"]);
    });

    it("L-F1aa: 8 alternatives are kept; the 9th is dropped with 'at most 8'; a non-string or empty alternative is dropped", () => {
      const alts = (n: number) => Array.from({ length: n }, (_, i) => `alt${i}.ogg`);
      const ok = kept({ tracks: [{ name: "a", clip: "a.ogg", alternatives: alts(8) }] });
      expect(ok.node.tracks[0].alternatives).toHaveLength(8);
      expect(pathed(ok.problems, "segment.tracks[0].alternatives")).toEqual([]);

      const over = kept({ tracks: [{ name: "a", clip: "a.ogg", alternatives: alts(9) }] });
      expect(over.node.tracks[0].alternatives).toHaveLength(8);
      expect(over.problems).toContainEqual(problem("segment.tracks[0].alternatives", "at most 8"));

      const bad = kept({ tracks: [{ name: "a", clip: "a.ogg", alternatives: ["ok.ogg", 3, "", "b.ogg"] }] });
      expect(bad.node.tracks[0].alternatives).toEqual(["ok.ogg", "b.ogg"]);
      expect(bad.problems).toContainEqual(problem("segment.tracks[0].alternatives[1]", "dropped"));
      expect(bad.problems).toContainEqual(problem("segment.tracks[0].alternatives[2]", "dropped"));
    });

    it("L-F1aa: pick defaults to sequence, accepts random and sequence, a bad value gives sequence with a problem", () => {
      expect(kept().node.tracks[0].pick).toBe("sequence");
      expect(kept({ tracks: [{ ...track, pick: "random" }] }).node.tracks[0].pick).toBe("random");
      expect(kept({ tracks: [{ ...track, pick: "sequence" }] }).node.tracks[0].pick).toBe("sequence");

      const bad = kept({ tracks: [{ ...track, pick: "shuffle" }] });
      expect(bad.node.tracks[0].pick).toBe("sequence");
      expect(bad.problems).toContainEqual(problem("segment.tracks[0].pick", 'using "sequence"'));
    });

    it("L-F1aa: volume clamps to 0..4; bus defaults to empty (the event's)", () => {
      expect(kept().node.tracks[0].volume).toBe(1);
      expect(kept().node.tracks[0].bus).toBe("");

      const loud = kept({ tracks: [{ ...track, volume: 9 }] });
      expect(loud.node.tracks[0].volume).toBe(4);
      expect(loud.problems).toContainEqual(problem("segment.tracks[0].volume", "using 4"));

      const quiet = kept({ tracks: [{ ...track, volume: -1 }] });
      expect(quiet.node.tracks[0].volume).toBe(0);
      expect(quiet.problems).toContainEqual(problem("segment.tracks[0].volume", "using 0"));

      expect(kept({ tracks: [{ ...track, bus: "Drums" }] }).node.tracks[0].bus).toBe("Drums");
    });
  });

  describe("track automation", () => {
    it("L-F1aa: volume and lowpass bindings are kept; quantize beat and bar are kept; a bad quantize is dropped with a problem", () => {
      const { node, problems } = kept({
        tracks: [{
          ...track,
          automation: [
            { parameter: "Intensity", target: "volume", curve: [[0, 0], [1, 1]] },
            { parameter: "Muffle", target: "lowpass", curve: [[0, 0], [1, 1]], quantize: "beat" },
            { parameter: "Loud", target: "volume", curve: [[0, 1]], quantize: "bar" },
          ],
        }],
      });
      const [a, b, c] = node.tracks[0].automation;
      expect(a).toEqual({ parameter: "Intensity", target: "volume", curve: [[0, 0], [1, 1]] });
      expect(a).not.toHaveProperty("quantize");
      expect(b).toEqual({ parameter: "Muffle", target: "lowpass", curve: [[0, 0], [1, 1]], quantize: "beat" });
      expect(c.quantize).toBe("bar");
      expect(pathed(problems, "segment.tracks[0].automation")).toEqual([]);

      const bad = kept({ tracks: [{ ...track, automation: [{ parameter: "P", target: "volume", curve: [[0, 0]], quantize: "tick" }] }] });
      expect(bad.node.tracks[0].automation).toHaveLength(1);
      expect(bad.node.tracks[0].automation[0]).not.toHaveProperty("quantize");
      expect(bad.problems).toContainEqual(problem("segment.tracks[0].automation[0].quantize", "follows the parameter"));
    });

    it("L-F1aa: a pitch binding is dropped with an error-level problem (isMusicError) naming the path", () => {
      const { node, problems } = kept({ tracks: [{ ...track, automation: [{ parameter: "P", target: "pitch", curve: [[0, 1]] }] }] });
      expect(node.tracks[0].automation).toEqual([]);
      const errors = problems.filter(isMusicError);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^error: segment\.tracks\[0\]\.automation\[0\]\.target: /);
      expect(errors[0]).toContain("pitch");
    });

    it("L-F1aa: an unknown target, a missing parameter or a curve with no keys drops the binding; a curve over 32 keys is cut with a problem", () => {
      const unknown = kept({ tracks: [{ ...track, automation: [{ parameter: "P", target: "pan", curve: [[0, 0]] }] }] });
      expect(unknown.node.tracks[0].automation).toEqual([]);
      expect(unknown.problems).toContainEqual(problem("segment.tracks[0].automation[0]", "dropped"));

      const noParam = kept({ tracks: [{ ...track, automation: [{ target: "volume", curve: [[0, 0]] }] }] });
      expect(noParam.node.tracks[0].automation).toEqual([]);
      expect(noParam.problems).toContainEqual(problem("segment.tracks[0].automation[0]", "dropped"));

      const noKeys = kept({ tracks: [{ ...track, automation: [{ parameter: "P", target: "volume", curve: [] }] }] });
      expect(noKeys.node.tracks[0].automation).toEqual([]);
      expect(noKeys.problems).toContainEqual(problem("segment.tracks[0].automation[0]", "the curve has no keys; dropped"));

      const keys = Array.from({ length: 33 }, (_, i) => [i / 32, i / 32]);
      const long = kept({ tracks: [{ ...track, automation: [{ parameter: "P", target: "volume", curve: keys }] }] });
      expect(long.node.tracks[0].automation).toHaveLength(1);
      expect(long.node.tracks[0].automation[0].curve).toHaveLength(32);
      expect(long.problems).toContainEqual(problem("segment.tracks[0].automation[0].curve", "at most 32 keys"));
    });
  });
});
