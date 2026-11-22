// ADR 0329 (M5): the musical clock of the playing entry: Switch rules at beat, bar and exit (a Clip's sample tempo and
// tempo map, a Sequence's tempo, Exit markers, loop ends), transitions as bridges, stingers and `handle.music` on a
// Clip — through the public API on the fake backend's single clock (ADR 0286).
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "../events/eventTestKit";
import type { FakeVoice } from "../testing";

const kit = eventKit();
const fake = kit.fake;

const SURFACE = [{ name: "Surface", labels: ["Grass", "Stone"], default: "Grass" }];
const meta = (sampleBlock: Record<string, unknown>) => ({ format: "myco.import@1", sample: sampleBlock });
const voiceOf = (path: string, nth = 0): FakeVoice => fake.voices.filter((v) => v.request.path === path)[nth]!;
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const playsOf = (path: string) => fake.plays.filter((p) => p.path === path).map((p) => (p.at === undefined ? undefined : Math.round(p.at * 1e6) / 1e6));

/** A Switch on Surface: Grass → entry 0, Stone → entry 1. */
const SWITCH = (entries: unknown[], sw: Record<string, unknown>) => pla("switch", entries, {
  parameters: SURFACE,
  switch: { parameter: "Surface", map: { Grass: 0, Stone: 1 }, ...sw },
});

describe("Switch timing on a Clip's sample tempo", () => {
  it.each([["beat", 1], ["bar", 4]] as const)("%s waits for the playing sample's grid; length in beats uses its tempo", async (when, boundary) => {
    {
      await kit.boot({
        "a.wav.meta.json": meta({ tempo: { bpm: 60, meter: "4/4" } }),
        "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { onChange: { when, how: "crossfade", length: { beats: 1 } } }),
      });
      fake.durations.set("a.wav", 16);
      const h = Audio.play("s.playlist.json");
      at(0.3);
      h.setParameter("Surface", "Stone");
      at(boundary - 0.3);
      expect(playsOf("b.wav")).toEqual([]);
      at(boundary - 0.2); // planned a quarter second ahead
      expect(playsOf("b.wav")).toEqual([boundary]);
      expect(voiceOf("b.wav").events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 1, law: "equalPowerIn", at: boundary });
      expect(voiceOf("a.wav").events).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 1, law: "equalPowerOut", stopAtEnd: true, at: boundary });
    }
  });

  it("follows the sample's tempo map (bars of 4 s at 60 bpm, then 2 s at 120 bpm); handle.music reads it", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ tempo: { bpm: 60, meter: "4/4", map: [{ at: 4, bpm: 120, meter: "4/4" }] } }),
      "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { onChange: { when: "bar", how: "cut", length: { ms: 0 } } }),
    });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    at(5);
    const m = h.music!;
    expect([m.segment, m.bar, m.beat, m.tempo, m.beatsPerBar]).toEqual(["a.wav", 2, 3, 120, 4]);
    expect(m.nextGrid("bar")).toEqual({ time: 6, bar: 3, beat: 1, segment: "a.wav" });
    expect(m.seek("1:1:0")).toMatchObject({ ok: false });
    h.setParameter("Surface", "Stone");
    at(5.8);
    expect(playsOf("b.wav")).toEqual([6]);
  });

  it("without a tempo handle.music is undefined", async () => {
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")]) });
    expect(Audio.play("c.playlist.json").music).toBeUndefined();
  });
});

describe("Switch at exit", () => {
  it("waits for the next Exit marker of the playing sample", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ markers: [{ id: "x", type: "exit", name: "Out", at: 0.75 }] }),
      "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { onChange: { when: "exit", how: "cut", length: { ms: 0 } } }),
    });
    fake.durations.set("a.wav", 2);
    const h = Audio.play("s.playlist.json");
    at(0.1);
    h.setParameter("Surface", "Stone");
    at(0.5);
    expect(playsOf("b.wav")).toEqual([0.75]);
  });

  it("without an Exit marker waits for the playing sample's loop end (its next wrap)", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ loops: [{ id: "l", start: 0.5, end: 1.5, active: "always" }] }),
      "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { onChange: { when: "exit", how: "cut", length: { ms: 0 } } }),
    });
    fake.durations.set("a.wav", 2);
    const h = Audio.play("s.playlist.json");
    at(1.6); // in the second pass (it wrapped at 1.5): the next wrap is at 2.5
    h.setParameter("Surface", "Stone");
    at(2.3);
    expect(playsOf("b.wav")).toEqual([2.5]);
  });

  it("a transition plays as a bridge: the old entry leaves at the boundary, the new one enters at the transition's Exit marker", async () => {
    await kit.boot({
      "a.wav.meta.json": meta({ markers: [{ id: "x", type: "exit", name: "Out", at: 0.75 }] }),
      "c.wav.meta.json": meta({ markers: [{ id: "x", type: "exit", name: "In", at: 0.4 }] }),
      "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], {
        rules: [{ from: "*", to: "Stone", when: "exit", how: "transition", length: { ms: 100 }, transition: { sample: "c.wav" } }],
      }),
    });
    fake.durations.set("a.wav", 2);
    fake.durations.set("c.wav", 1);
    const h = Audio.play("s.playlist.json");
    at(0.1);
    h.setParameter("Surface", "Stone");
    at(0.5);
    expect(playsOf("c.wav")).toEqual([0.75]);
    expect(voiceOf("a.wav").events).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.1, law: "equalPowerOut", stopAtEnd: true, at: 0.75 });
    expect(playsOf("b.wav")).toEqual([]);
    at(0.9);
    expect(playsOf("b.wav")).toEqual([1.15]);
    expect(voiceOf("c.wav").events).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.1, law: "equalPowerOut", stopAtEnd: true, at: 1.15 });
    expect(voiceOf("b.wav").events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.1, law: "equalPowerIn", at: 1.15 });
  });
});

describe("A transition Sequence", () => {
  it("whose Exit marker is at its end hands over there (the migrated bridges' shape)", async () => {
    const riser = { type: "sequence", entries: [], sequence: { length: 2, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "c.wav", at: 0, length: 2, sync: true }] }], markers: [{ id: "m", name: "exit", at: 2, type: "exit" }] } };
    await kit.boot({ "s.playlist.json": SWITCH([sample("a.wav"), sample("b.wav")], { rules: [{ from: "*", to: "Stone", when: "now", how: "transition", length: { ms: 0 }, transition: { embedded: riser } }] }) });
    fake.durations.set("a.wav", 8);
    fake.durations.set("c.wav", 2);
    const h = Audio.play("s.playlist.json");
    at(0.5);
    h.setParameter("Surface", "Stone");
    at(0.6);
    const bridge = playsOf("c.wav")[0]!;
    expect(bridge).toBeGreaterThan(0.4);
    expect(playsOf("b.wav")).toEqual([]);
    at(bridge + 2);
    expect(playsOf("b.wav")).toEqual([Math.round((bridge + 2) * 1e6) / 1e6]);
  });
});

describe("Switch timing on a Sequence's tempo", () => {
  it("bar waits for the sequence's next bar on its playhead", async () => {
    const sequence = { type: "sequence", entries: [], sequence: { length: 8, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 8, sync: true }] }] } };
    await kit.boot({ "s.playlist.json": SWITCH([{ embedded: sequence }, sample("b.wav")], { onChange: { when: "bar", how: "crossfade", length: { beats: 1 } } }) });
    fake.durations.set("a.wav", 8);
    const h = Audio.play("s.playlist.json");
    at(0.3);
    h.setParameter("Surface", "Stone");
    at(1.8);
    expect(playsOf("b.wav")).toEqual([2]);
    expect(voiceOf("b.wav").events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.5, law: "equalPowerIn", at: 2 });
    expect(voiceOf("a.wav").events).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.5, law: "equalPowerOut", stopAtEnd: true, at: 2 });
  });
});

describe("Stingers", () => {
  const stingerSeq = (stingers: unknown[]) => pla("sequence", [], {
    stingers,
    sequence: { length: 16, tempo: { bpm: 120, meter: "4/4" }, tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 16, sync: true }] }] },
  });

  it("play at now, the next beat or bar, or with their Hit marker landing on the bar", async () => {
    await kit.boot({
      "c.wav.meta.json": meta({ markers: [{ id: "h", type: "hit", name: "Hit", at: 0.25 }] }),
      "s.playlist.json": stingerSeq([
        { trigger: "now", playlist: { sample: "b.wav" }, at: "now" },
        { trigger: "beat", playlist: { sample: "b.wav" }, at: "beat" },
        { trigger: "bar", playlist: { sample: "b.wav" }, at: "bar" },
        { trigger: "hit", playlist: { sample: "c.wav" }, at: "hit" },
      ]),
    });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json");
    at(0.3);
    expect(["now", "beat", "bar"].map((n) => h.trigger(n))).toEqual([true, true, true]);
    expect(playsOf("b.wav")).toEqual([0.3, 0.5, 2]);
    expect(h.trigger("hit")).toBe(true);
    expect(playsOf("c.wav")).toEqual([1.75]);
    expect(h.trigger("nope")).toBe(false);
  });

  it("dontRepeat drops a repeat within its seconds; ifLate decides a boundary too close to reach", async () => {
    await kit.boot({
      "s.playlist.json": stingerSeq([
        { trigger: "once", playlist: { sample: "b.wav" }, at: "now", dontRepeat: 10 },
        { trigger: "skip", playlist: { sample: "c.wav" }, at: "bar", ifLate: "skip" },
        { trigger: "next", playlist: { sample: "c.wav" }, at: "bar", ifLate: "nextGrid" },
        { trigger: "now!", playlist: { sample: "d.wav" }, at: "bar", ifLate: "playNow" },
      ]),
    });
    fake.durations.set("a.wav", 16);
    const h = Audio.play("s.playlist.json"); // bars at 0, 2, 4...
    fake.lookahead = 0.2;
    at(0.2);
    expect([h.trigger("once"), h.trigger("once")]).toEqual([true, false]);
    at(1.9); // the bar at 2 can't be stamped any more (the earliest start is 2.1)
    expect(h.trigger("skip")).toBe(false);
    expect(h.trigger("next")).toBe(true);
    expect(playsOf("c.wav")).toEqual([4]);
    expect(h.trigger("now!")).toBe(true);
    expect(playsOf("d.wav")).toEqual([2.1]);
  });

  it("with no musical clock a timed stinger plays at once, with one warning", async () => {
    await kit.boot({ "s.playlist.json": pla("clip", [sample("a.wav")], { stingers: [{ trigger: "x", playlist: { sample: "b.wav" }, at: "bar" }] }) });
    const h = Audio.play("s.playlist.json");
    at(0.5);
    expect(h.trigger("x")).toBe(true);
    expect(playsOf("b.wav")).toEqual([0.5]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no boundary to wait for"));
  });
});
