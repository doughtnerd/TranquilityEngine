// `Audio.debug().music` from playlist instances with a musical clock (decision log D32 left it empty when the music
// players went): tempo, position, segment, the pending Switch change and when it lands, queued stingers, and the
// session's stinger outcomes in `musicTotals` — through the public API on the fake backend's single clock.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const meta = (sampleBlock: Record<string, unknown>) => ({ format: "myco.import@1", sample: sampleBlock });
const SURFACE = [{ name: "Surface", labels: ["Grass", "Stone"], default: "Grass" }];

describe("Audio.debug().music from playlists", () => {
  it("lists a Switch playing a sample with a tempo: its position, then its pending change until it lands", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ tempo: { bpm: 60, meter: "4/4" } }),
      "s.playlist.json": pla("switch", [sample("a.wav"), sample("b.wav")], {
        parameters: SURFACE,
        switch: {
          parameter: "Surface", map: { Grass: 0, Stone: 1 },
          onChange: { when: "bar", how: "cut", length: { ms: 0 } },
          rules: [{ from: "Grass", to: "Stone", when: "bar", how: "crossfade", length: { beats: 1 } }],
        },
      }),
      "plain.playlist.json": pla("clip", [sample("c.wav")]),
    });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    Audio.play("plain.playlist.json"); // no tempo: no music row
    at(1.5);
    let rows = Audio.debug().music!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: expect.any(Number), asset: "s.playlist.json", state: "playing", segment: "a.wav", bar: 1, beat: 2, tick: 480, tempo: 60, beatsPerBar: 4, pending: null, groups: [] });
    expect(rows[0]!.time).toBeCloseTo(1.5, 6);
    expect(h.music!.transition).toBeNull();

    h.setParameter("Surface", "Stone");
    at(2);
    rows = Audio.debug().music!;
    expect(rows[0]!.state).toBe("transitioning");
    expect(rows[0]!.pending).toEqual({ to: "Stone", time: "2:1", rule: 0, ruleKey: "Grass>Stone", tier: 1, parent: "s.playlist.json", exit: "bar", enter: "start" });
    expect(h.music!.transition).toEqual({ to: "Stone", time: 4 });

    at(4.1); // landed: b.wav has no tempo, so the instance has no musical clock any more
    expect(Audio.debug().music).toEqual([]);
  });

  it("shows stingers waiting for their bar as stamped groups; musicTotals counts stinger outcomes over the session", async () => {
    await kit.boot({
      "s.playlist.json": pla("sequence", [], {
        stingers: [
          { trigger: "bar", playlist: { sample: "b.wav" }, at: "bar" },
          { trigger: "once", playlist: { sample: "b.wav" }, at: "now", dontRepeat: 10 },
          { trigger: "skip", playlist: { sample: "c.wav" }, at: "bar", ifLate: "skip" },
          { trigger: "next", playlist: { sample: "c.wav" }, at: "bar", ifLate: "nextGrid" },
        ],
        sequence: { length: 16, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 16, sync: true }] }] },
      }),
    });
    fake.durations.set("a.wav", 16);
    fake.durations.set("b.wav", 1);
    const h = Audio.play("s.playlist.json"); // bars at 0, 2, 4...
    fake.lookahead = 0.2;
    at(0.3);
    expect(h.trigger("bar")).toBe(true);
    expect([h.trigger("once"), h.trigger("once")]).toEqual([true, false]);
    at(0.6); // "once" started at 0.5; "bar" waits for 2
    let row = Audio.debug().music![0]!;
    expect(row.segment).toBe("s.playlist.json");
    expect(row.groups.map((g) => g.state)).toEqual(["stamped", "playing"]);
    expect(row.stingers).toEqual({ played: 2, late: 0, skipped: 0, dropped: 1 });
    at(1.9);
    expect(h.trigger("skip")).toBe(false);
    expect(h.trigger("next")).toBe(true);
    row = Audio.debug().music![0]!;
    expect(row.stingers).toEqual({ played: 2, late: 1, skipped: 1, dropped: 1 });
    expect(Audio.debug().musicTotals!.stingers).toEqual({ played: 2, late: 1, skipped: 1, dropped: 1 });

    h.stop(0);
    at(2.5);
    expect(Audio.debug().music).toEqual([]);
    expect(Audio.debug().musicTotals!.stingers).toEqual({ played: 2, late: 1, skipped: 1, dropped: 1 }); // ended instances count
  });
});
