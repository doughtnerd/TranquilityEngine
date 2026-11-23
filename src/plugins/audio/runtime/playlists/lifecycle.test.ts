// ADR 0343: instance lifecycle (oneShot, untilStopped, release vs stop), continuous Queues, voice curves, the handle,
// debug rows and profile taps, and AudioSource with a playlist — through the public API on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio, AudioSource, type AudioEventHandle } from "../index";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { taps } from "../mix/profileTaps";
import { recordingSink } from "../mix/recordingSink";
import { embed, eventKit, pl, pla, sample } from "./testKit";
import { GameObject } from "../../../../myco";

const kit = eventKit();
const fake = kit.fake;

describe("oneShot, untilStopped, release and stop", () => {
  it("a oneShot instance ends when its voices end", async () => {
    await kit.boot({ "o.playlist.json": pla("clip", [sample("a.wav")]) });
    const h = Audio.play("o.playlist.json");
    expect(h.playing).toBe(true);
    fake.voices[0]!.end();
    kit.frame();
    expect(h.playing).toBe(false);
  });

  it("stop fades every voice over 120 ms unless told otherwise", async () => {
    await kit.boot({ "o.playlist.json": pla("layer", [sample("a.wav"), sample("b.wav")]) });
    const h = Audio.play("o.playlist.json");
    h.stop();
    expect(fake.voices.map((v) => v.events.at(-1))).toEqual([{ kind: "stop", fadeSeconds: 0.12 }, { kind: "stop", fadeSeconds: 0.12 }]);
    expect(h.playing).toBe(false);
    const h2 = Audio.play("o.playlist.json");
    h2.stop(0);
    expect(fake.voices[2]!.events.at(-1)).toEqual({ kind: "stop" });
  });

  it("untilStopped stays alive after its voices end, loops samples without a loop of their own, and release lets it end", async () => {
    await kit.boot({ "u.playlist.json": pla("clip", [sample("a.wav")], { playback: { plays: "untilStopped" } }) });
    const h = Audio.play("u.playlist.json");
    expect(fake.plays[0]!.loop).toBe(true);
    h.release();
    expect(fake.voices[0]!.events).toContainEqual({ kind: "loop", start: 0, end: 0, looping: false });
    expect(h.playing).toBe(true); // the voice plays its last pass out
    fake.voices[0]!.end();
    kit.frame();
    expect(h.playing).toBe(false);
  });

  it("untilStopped with a sample that never loops stays playing until stopped", async () => {
    await kit.boot({ "u.playlist.json": pla("clip", [sample("a.wav", { loop: "off" })], { playback: { plays: "untilStopped" } }) });
    const h = Audio.play("u.playlist.json");
    fake.voices[0]!.end();
    kit.frame();
    expect(h.playing).toBe(true);
    h.stop();
    expect(h.playing).toBe(false);
  });

  it("release ends a held loop by its exit; an always loop keeps looping; stop ends both", async () => {
    await kit.boot({
      "a.wav.meta.json": { format: "myco.import@1", sample: { loops: [{ id: "l1", start: 0.5, end: 1.5, active: "held", exit: "jump" }] } },
      "b.wav.meta.json": { format: "myco.import@1", sample: { loops: [{ id: "l1", start: 0.2, end: 0.8, active: "always" }] } },
      "r.playlist.json": pla("layer", [sample("a.wav"), sample("b.wav")]),
    });
    const h = Audio.play("r.playlist.json");
    const [a, b] = fake.voices;
    expect(a!.events).toContainEqual({ kind: "loop", start: 0.5, end: 1.5, looping: true });
    expect(b!.events).toContainEqual({ kind: "loop", start: 0.2, end: 0.8, looping: true });
    h.release();
    expect(a!.events).toContainEqual({ kind: "loop", start: 0.5, end: 1.5, looping: false });
    expect(a!.events.at(-1)).toEqual({ kind: "seek", seconds: 1.5 }); // exit: jump
    expect(b!.events.filter((e) => e.kind === "loop")).toHaveLength(1);
    expect(h.playing).toBe(true);
    h.stop();
    expect(b!.stopped).toBe(true);
  });

  it("a loop bound to a parameter loops only while its condition holds", async () => {
    await kit.boot({
      "a.wav.meta.json": { format: "myco.import@1", sample: { loops: [{ id: "l1", start: 0.5, end: 1, active: "parameter", binding: { parameter: "Rpm", op: ">", value: 5 }, reentry: "reenter" }] } },
      "p.playlist.json": pla("clip", [sample("a.wav")], { parameters: [{ name: "Rpm", min: 0, max: 10, default: 8 }] }),
    });
    const h = Audio.play("p.playlist.json");
    const v = fake.voices[0]!;
    expect(v.events).toContainEqual({ kind: "loop", start: 0.5, end: 1, looping: true });
    h.setParameter("Rpm", 2);
    expect(v.events.at(-1)).toEqual({ kind: "loop", start: 0.5, end: 1, looping: false });
    h.setParameter("Rpm", 9);
    expect(v.events.at(-1)).toEqual({ kind: "loop", start: 0.5, end: 1, looping: true });
  });
});

describe("continuous Queue", () => {
  it("plays entries back to back with gapMs, picking each next ahead of its start", async () => {
    await kit.boot({ "c.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", continuous: { gapMs: 100 } } }) });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 2);
    fake.lookahead = 0;
    const h = Audio.play("c.playlist.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav"]);
    kit.setTime(0.8); kit.frame(); // the next is due at 1.1, picked 0.25 s ahead (0.85)
    expect(fake.plays).toHaveLength(1);
    kit.setTime(0.9); kit.frame();
    expect(fake.plays.map((p) => [p.path, p.at])).toEqual([["a.wav", undefined], ["b.wav", expect.closeTo(1.1, 9)]]);
    kit.setTime(3); kit.frame(); // 1.1 + 2 + 0.1 = 3.2
    expect(fake.plays.map((p) => p.at)).toEqual([undefined, 1.1, expect.closeTo(3.2, 9)]);
    expect(h.playing).toBe(true);
  });

  it("a negative gap overlaps entries with an equal-power crossfade", async () => {
    await kit.boot({ "c.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", continuous: { gapMs: -200 } } }) });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1);
    fake.lookahead = 0;
    Audio.play("c.playlist.json");
    kit.setTime(0.6); kit.frame(); // due at 0.8, picked at 0.55
    expect(fake.plays[1]!.at).toBeCloseTo(0.8, 9);
    expect(fake.plays[1]!.fadeZero).toBe(true);
    expect(fake.voices[1]!.events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.2, law: "equalPowerIn", at: expect.closeTo(0.8, 9) });
    expect(fake.voices[0]!.events).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.2, law: "equalPowerOut", stopAtEnd: true, at: expect.closeTo(0.8, 9) });
  });

  it("ends rather than spins when an entry plays nothing, or is zero length", async () => {
    await kit.boot({ "c.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", continuous: { gapMs: 0 } } }) });
    fake.ready = false;
    const h = Audio.play("c.playlist.json");
    kit.frame();
    expect(h.playing).toBe(false);
    fake.ready = true;
    fake.durations.set("a.wav", 0);
    fake.durations.set("b.wav", 0);
    fake.lookahead = 0;
    Audio.play("c.playlist.json");
    kit.setTime(0.1);
    kit.frame();
    // At least 20 ms apart: 0, then each pick up to 0.1 + 0.25 ahead.
    expect(fake.plays.filter((p) => p.at !== undefined).length).toBeLessThan(20);
  });

  it("with unknown lengths the next entry starts when the current one ends (a late start); release stops picking", async () => {
    await kit.boot({ "c.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin", continuous: { gapMs: 0 } } }) });
    const h = Audio.play("c.playlist.json");
    fake.voices[0]!.end();
    kit.frame();
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(Audio.debug().playlistTotals!.lateStarts).toBe(1);
    h.release();
    fake.voices[1]!.end();
    kit.frame();
    expect(fake.plays).toHaveLength(2);
    expect(h.playing).toBe(false);
  });
});

describe("voice curves", () => {
  it("a parameter curve on gain (dB) binds to the parameter: the voice follows it", async () => {
    await kit.boot({
      "v.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), { curves: { gain: { input: { parameter: "Speed" }, curve: [[0, -20], [10, 0]] } } })], {
        parameters: [{ name: "Speed", min: 0, max: 10, default: 10 }],
      }),
    });
    const h = Audio.play("v.playlist.json");
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(1, 3);
    h.setParameter("Speed", 0);
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(0.1, 3);
  });

  it("a voice-time curve on gain is evaluated as the voice plays", async () => {
    await kit.boot({
      "v.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), { curves: { gain: { input: "voiceTime", curve: [[0, 0], [1, -20]] } } })]),
    });
    Audio.play("v.playlist.json");
    expect(fake.plays[0]!.volume).toBeCloseTo(1, 6);
    kit.setTime(1);
    kit.frame();
    expect(fake.voices[0]!.volume).toBeCloseTo(0.1, 6);
  });

  it("pan and high-pass curves become bindings, which a backend without the core ignores with one warning", async () => {
    await kit.boot({
      "v.playlist.json": pla("layer", [embed(pl("clip", [sample("a.wav")]), { curves: { pan: { input: "voiceTime", curve: [[0, -1], [1, 1]] }, highpass: { input: "voiceTime", curve: [[0, 200]] } } })]),
    });
    Audio.play("v.playlist.json");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("pan and high-pass automation need the audio core"));
  });
});

describe("the handle, debug rows and taps", () => {
  it("parameters: set and get locals (by label), globals through getParameter", async () => {
    await kit.boot(
      { "p.playlist.json": pla("clip", [sample("a.wav")], { parameters: [{ name: "Mood", labels: ["Calm", "Tense"], default: "Calm" }] }) },
      { parameters: [{ name: "Wind", min: 0, max: 1, default: 0.25 }] },
    );
    const h = Audio.play("p.playlist.json");
    expect(h.getParameter("Mood")).toBe("Calm");
    h.setParameter("Mood", "Tense");
    expect(h.getParameter("Mood")).toBe("Tense");
    expect(h.getParameter("Wind")).toBe(0.25);
  });

  it("onMarker returns an unsubscribe function; music is undefined without a tempo and an unknown stinger is refused", async () => {
    await kit.boot({ "p.playlist.json": pla("clip", [sample("a.wav")]) });
    const h = Audio.play("p.playlist.json");
    const off = h.onMarker("cue", () => {});
    expect(typeof off).toBe("function");
    off();
    expect(h.music).toBeUndefined();
    expect(h.trigger("hit")).toBe(false);
  });

  it("instances appear in Audio.debug().events with their playlist path", async () => {
    await kit.boot({ "d.playlist.json": pla("layer", [sample("a.wav"), sample("b.wav")], { parameters: [{ name: "Speed", min: 0, max: 1, default: 0.5 }] }) });
    Audio.play("d.playlist.json");
    const rows = Audio.debug().events;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ asset: "d.playlist.json", voices: 2, parameters: { Speed: 0.5 } });
    expect(rows[0]!.id).toBeGreaterThan(0);
  });

  it("profile taps: eventStart carries the instance id and playlist path; eventStop once however it ended", async () => {
    await kit.boot({ "d.playlist.json": pla("clip", [sample("a.wav")]) });
    const stub = recordingSink();
    taps.sink = stub.sink;
    try {
      const h = Audio.play("d.playlist.json");
      h.stop();
      h.stop();
      const starts = stub.of("eventStart");
      expect(starts).toHaveLength(1);
      expect(starts[0]![1]).toBe("d.playlist.json");
      expect(stub.of("eventStop")).toEqual([[starts[0]![0]]]);
    } finally {
      taps.sink = NULL_PROFILE_SINK;
    }
  });

  it("an AudioEventHandle (the deprecated alias, ADR 0343) still names the handle a playlist plays with", async () => {
    await kit.boot({ "e.playlist.json": pla("clip", [sample("a.wav")]) });
    const h: AudioEventHandle = Audio.play("e.playlist.json");
    expect(h.playing).toBe(true);
    expect(typeof h.onMarker).toBe("function");
  });
});

describe("AudioSource", () => {
  it("plays a playlist path as an instance, follows volume and stops with the node", async () => {
    await kit.boot({ "src.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin" } }) });
    const source = GameObject.create("n").addBehavior(AudioSource, { clip: "src.playlist.json", playOnAwake: false, volume: 0.5 });
    source.play();
    kit.frame();
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav"]);
    expect(source.isPlaying).toBe(true);
    expect(fake.voices[0]!.volume).toBeCloseTo(0.5, 6);
    source.stop();
    expect(fake.voices[0]!.stopped).toBe(true);
    expect(source.isPlaying).toBe(false);
  });
});
