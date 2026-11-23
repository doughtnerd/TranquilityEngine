// ADR 0362 §1: pausing a playback through the public handle on the fake backend's single clock (ADR 0286). A paused
// playback holds its voices (one stamped pause each, at one heard time), its timers and pending picks, its sequence
// clock and its voice time; `resume()` continues from the same position, everything planned that much later. Pausing
// twice or resuming a playing playback does nothing; `stop()` stops a paused one.
import { describe, expect, it } from "vitest";
import { Audio } from "../index";
import { embed, eventKit, pl, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;

/** Moves the heard clock to `t` and runs one frame. */
const at = (t: number): void => { kit.setTime(t); kit.frame(); };
const plays = () => fake.plays.map((p) => [p.path, p.at === undefined ? undefined : Math.round(p.at * 1e6) / 1e6]);
const holds = (i: number) => fake.voices[i]!.events.filter((e) => e.kind === "pause" || e.kind === "resume");

const seq = (sequence: Record<string, unknown>, extra: Record<string, unknown> = {}) => pla("sequence", [], { sequence, ...extra });
const track = (clips: unknown[]) => ({ id: "t1", kind: "audio", clips });

describe("pause and resume a playback (ADR 0362 §1)", () => {
  it("holds a sequence's clock and its next clip; resume continues from the same position, the next clip that much later", async () => {
    await kit.boot({ "s.playlist.json": seq({ length: 8, tempo: { bpm: 60, meter: "4/4" }, tracks: [track([{ id: "c1", sample: "a.wav", at: 0, length: 1 }, { id: "c2", sample: "b.wav", at: 1.5, length: 1 }])] }) });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1);
    const h = Audio.play("s.playlist.json");
    at(0.5);
    const m = h.music!;
    const before = [m.bar, m.beat, m.beatFraction];
    expect(before).toEqual([1, 1, 0.5]);

    h.pause();
    expect(h.paused).toBe(true);
    expect(holds(0)).toEqual([{ kind: "pause", at: 0.5 }]);
    at(3); // b.wav was due at 1.5
    expect(plays()).toEqual([["a.wav", 0]]);
    expect([m.bar, m.beat, m.beatFraction]).toEqual(before);
    expect(h.playing).toBe(true);

    h.resume();
    expect(h.paused).toBe(false);
    expect(holds(0)).toEqual([{ kind: "pause", at: 0.5 }, { kind: "resume", at: 3 }]);
    // The same position when it continues, on the heard clock it continues at.
    expect([m.bar, m.beat, m.beatFraction]).toEqual(before);
    expect(m.time).toBe(3);
    expect(m.nextGrid("beat")).toEqual({ time: 3.5, bar: 1, beat: 2, segment: "s.playlist.json" });
    at(3.95);
    // 1.5 s into the sequence, 2.5 s later than planned.
    expect(plays()).toEqual([["a.wav", 0], ["b.wav", 4]]);
  });

  it("holds a continuous Queue's pending pick: nothing is picked while paused, the next pick comes as late as the pause lasted", async () => {
    await kit.boot({ "c.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", continuous: { gapMs: 100 } } }) });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 2);
    fake.lookahead = 0;
    const h = Audio.play("c.playlist.json");
    at(0.5);
    h.pause(); // the next pick was due at 0.85, for 1.1
    at(2);
    expect(plays()).toEqual([["a.wav", undefined]]);
    h.resume(); // held 1.5 s
    at(2.3);
    expect(plays()).toHaveLength(1);
    at(2.4);
    expect(plays()).toEqual([["a.wav", undefined], ["b.wav", 2.6]]);
  });

  it("holds after a start already stamped: the voice waits with the rest and starts when the playback continues", async () => {
    await kit.boot({ "c.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", continuous: { gapMs: 100 } } }) });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 2);
    fake.lookahead = 0;
    const h = Audio.play("c.playlist.json");
    at(0.9); // b.wav stamped at 1.1
    expect(plays()).toEqual([["a.wav", undefined], ["b.wav", 1.1]]);
    h.pause();
    // No stamp lies past the hold: both voices hold at 1.1 (a.wav plays on to it, b.wav hasn't started).
    expect(holds(0)).toEqual([{ kind: "pause", at: 1.1 }]);
    expect(holds(1)).toEqual([{ kind: "pause", at: 1.1 }]);
    at(2);
    h.resume();
    expect(holds(0).at(-1)).toEqual({ kind: "resume", at: 2 });
    expect(holds(1).at(-1)).toEqual({ kind: "resume", at: 2 });
    // b.wav (2 s) then ends at 4 and the next pick lands 0.1 s later.
    at(3.9);
    expect(plays().at(-1)).toEqual(["a.wav", 4.1]);
  });

  it("holds voice time: a voice-time curve reads the same value after the pause as before it", async () => {
    await kit.boot({ "v.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), { curves: { gain: { input: "voiceTime", curve: [[0, 0], [1, -20]] } } })]) });
    const h = Audio.play("v.playlist.json");
    at(0.5);
    const held = fake.voices[0]!.volume;
    expect(held).toBeCloseTo(Math.pow(10, -10 / 20), 3);
    h.pause();
    at(2);
    h.resume();
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(held, 3);
    at(2.5); // voice time 1
    expect(fake.voices[0]!.volume).toBeCloseTo(0.1, 6);
  });

  it("pausing twice or resuming a playing playback does nothing; stop ends a paused one", async () => {
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")]) });
    const h = Audio.play("c.playlist.json");
    h.resume();
    expect(holds(0)).toEqual([]);
    at(0.2);
    h.pause();
    h.pause();
    expect(holds(0)).toEqual([{ kind: "pause", at: 0.2 }]);
    h.resume();
    h.resume();
    expect(holds(0)).toEqual([{ kind: "pause", at: 0.2 }, { kind: "resume", at: 0.2 }]);
    h.pause();
    at(1);
    h.stop();
    expect(fake.voices[0]!.events.at(-1)).toEqual({ kind: "stop" });
    expect(h.paused).toBe(false);
    expect(h.playing).toBe(false);
    h.resume();
    expect(fake.voices[0]!.events.at(-1)).toEqual({ kind: "stop" });
  });

  it("parameter changes while paused reach the playlist when it resumes", async () => {
    await kit.boot({
      "s.playlist.json": pla("switch", [sample("a.wav"), sample("b.wav")], {
        parameters: [{ name: "Surface", labels: ["Grass", "Metal"], default: "Grass" }],
        switch: { parameter: "Surface", map: { Grass: 0, Metal: 1 } },
        playback: { plays: "untilStopped" },
      }),
    });
    const h = Audio.play("s.playlist.json");
    at(0.2);
    h.pause();
    h.setParameter("Surface", "Metal");
    at(1);
    expect(plays().map((p) => p[0])).toEqual(["a.wav"]);
    expect(h.getParameter("Surface")).toBe("Metal");
    h.resume();
    at(1.1);
    expect(plays().map((p) => p[0])).toEqual(["a.wav", "b.wav"]);
  });

  it("an inert handle (nothing played) has the members and never pauses", () => {
    const h = Audio.play("missing.playlist.json");
    h.pause();
    expect(h.paused).toBe(false);
    h.resume();
  });
});
