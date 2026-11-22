// ADR 0329: Switch change rules and Blend weights, envelopes and follow, through `Audio.play` on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio } from "../Audio";
import { eventKit, pla, sample } from "./testKit";
import type { FakeVoice } from "../testing";

const kit = eventKit();
const fake = kit.fake;

const SURFACE = [{ name: "Surface", labels: ["Grass", "Stone", "Mud"], default: "Grass" }];
const SPEED = [{ name: "Speed", min: 0, max: 10, default: 0 }];

const voiceOf = (path: string, nth = 0): FakeVoice => fake.voices.filter((v) => v.request.path === path)[nth]!;

/** A Switch on Surface: Grass → a.wav, Stone → b.wav, Mud → c.wav. */
const SWITCH = (sw: Record<string, unknown>) => pla("switch", [sample("a.wav"), sample("b.wav"), sample("c.wav")], {
  parameters: SURFACE,
  switch: { parameter: "Surface", map: { Grass: 0, Stone: 1, Mud: 2 }, ...sw },
});

describe("Switch", () => {
  it("plays the entry the label maps to, with the label's gain", async () => {
    await kit.boot({ "s.playlist.json": SWITCH({ labelGain: { Stone: -6 } }) });
    Audio.play("s.playlist.json", { parameters: { Surface: "Stone" } });
    expect(fake.plays.map((p) => p.path)).toEqual(["b.wav"]);
    expect(fake.plays[0]!.volume).toBeCloseTo(Math.pow(10, -6 / 20), 6);
  });

  it("a label mapped to null plays nothing", async () => {
    await kit.boot({ "s.playlist.json": SWITCH({ map: { Grass: 0, Stone: null, Mud: 2 } }) });
    Audio.play("s.playlist.json", { parameters: { Surface: "Stone" } });
    expect(fake.plays).toHaveLength(0);
  });

  it("onChange now + crossfade: the old entry fades out and the new one in (equal power)", async () => {
    await kit.boot({ "s.playlist.json": SWITCH({ onChange: { when: "now", how: "crossfade", length: { ms: 300 } } }) });
    const h = Audio.play("s.playlist.json");
    h.setParameter("Surface", "Stone");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(voiceOf("a.wav").events).toContainEqual({ kind: "fadeShaped", to: 0, seconds: 0.3, law: "equalPowerOut", stopAtEnd: true });
    expect(voiceOf("b.wav").events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.3, law: "equalPowerIn" });
    expect(fake.plays[1]!.fadeZero).toBe(true);
  });

  it("onChange cut stops the old entry at once", async () => {
    await kit.boot({ "s.playlist.json": SWITCH({ onChange: { when: "now", how: "cut", length: { ms: 0 } } }) });
    const h = Audio.play("s.playlist.json");
    h.setParameter("Surface", "Stone");
    expect(voiceOf("a.wav").stopped).toBe(true);
    expect(voiceOf("b.wav").playing).toBe(true);
    expect(voiceOf("b.wav").events.some((e) => e.kind === "fadeShaped")).toBe(false);
  });

  it("onChange nextTrigger keeps the playing entry; the next trigger reads the new label", async () => {
    await kit.boot({ "s.playlist.json": SWITCH({ onChange: { when: "nextTrigger", how: "crossfade", length: { ms: 200 } } }) });
    const h = Audio.play("s.playlist.json");
    h.setParameter("Surface", "Stone");
    expect(fake.plays).toHaveLength(1);
    expect(voiceOf("a.wav").stopped).toBe(false);
    Audio.play("s.playlist.json", { parameters: { Surface: "Stone" } });
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
  });

  it("rules: exact beats any, the first listed breaks ties, no match uses onChange", async () => {
    await kit.boot({
      "s.playlist.json": SWITCH({
        onChange: { when: "nextTrigger", how: "crossfade", length: { ms: 200 } },
        rules: [
          { from: "*", to: "Stone", when: "now", how: "crossfade", length: { ms: 100 } },
          { from: "Grass", to: "Stone", when: "now", how: "cut", length: { ms: 0 } }, // exact on both: 4 beats 2
          { from: "Stone", to: "*", when: "now", how: "crossfade", length: { ms: 700 } },
          { from: "*", to: "Mud", when: "now", how: "crossfade", length: { ms: 900 } }, // ties with the rule above for Stone → Mud
        ],
      }),
    });
    const h = Audio.play("s.playlist.json");
    h.setParameter("Surface", "Stone"); // Grass → Stone: the exact rule (cut)
    expect(voiceOf("a.wav").stopped).toBe(true);
    expect(voiceOf("b.wav").events.some((e) => e.kind === "fadeShaped")).toBe(false);
    h.setParameter("Surface", "Mud"); // Stone → Mud: two rules score 2; the first listed (700 ms) wins
    expect(voiceOf("c.wav").events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.7, law: "equalPowerIn" });
    h.setParameter("Surface", "Grass"); // Mud → Grass: no rule matches → onChange (next trigger)
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "c.wav"]);
  });

  it("a rule timed to a bar changes now when the playing entry has no tempo, with one warning", async () => {
    await kit.boot({ "s.playlist.json": SWITCH({ onChange: { when: "bar", how: "crossfade", length: { beats: 1 } } }) });
    const h = Audio.play("s.playlist.json");
    h.setParameter("Surface", "Stone");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    // A beat with no tempo is the prototype's 500 ms.
    expect(voiceOf("b.wav").events).toContainEqual({ kind: "fadeShaped", to: 1, seconds: 0.5, law: "equalPowerIn" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no boundary to wait for"));
  });

  it("follows a global parameter (Audio.setParameter)", async () => {
    await kit.boot(
      { "s.playlist.json": pla("switch", [sample("a.wav"), sample("b.wav")], { switch: { parameter: "Ground", map: { Dirt: 0, Rock: 1 }, onChange: { when: "now", how: "cut", length: { ms: 0 } } } }) },
      { parameters: [{ name: "Ground", labels: ["Dirt", "Rock"], default: "Dirt" }] },
    );
    Audio.play("s.playlist.json");
    Audio.setParameter("Ground", "Rock");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
  });
});

/** A 1D Blend on Speed (0..10) of a.wav at 0, b.wav at 5 and c.wav at 10. */
const BLEND = (blend: Record<string, unknown>, extra: Record<string, unknown> = {}) => pla("blend", [sample("a.wav", { x: 0 }), sample("b.wav", { x: 5 }), sample("c.wav", { x: 10 })], {
  parameters: SPEED,
  blend: { axes: [{ parameter: "Speed" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 }, ...blend },
  ...extra,
});

describe("Blend", () => {
  it("1D crossfade: piecewise linear between neighbours (and atZeroWeight stop doesn't start silent entries)", async () => {
    await kit.boot({ "b.playlist.json": BLEND({}) });
    const h = Audio.play("b.playlist.json", { parameters: { Speed: 2.5 } });
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(fake.plays[0]!.volume).toBeCloseTo(0.5, 6);
    expect(fake.plays[1]!.volume).toBeCloseTo(0.5, 6);
    h.setParameter("Speed", 4);
    kit.frame();
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.2, 6);
    expect(voiceOf("b.wav").volume).toBeCloseTo(0.8, 6);
  });

  it("1D equal power uses √weight", async () => {
    await kit.boot({ "b.playlist.json": BLEND({ curve: "equalPower" }) });
    Audio.play("b.playlist.json", { parameters: { Speed: 1 } });
    expect(fake.plays[0]!.volume).toBeCloseTo(Math.sqrt(0.8), 6);
    expect(fake.plays[1]!.volume).toBeCloseTo(Math.sqrt(0.2), 6);
  });

  it("1D layer: the first entry is always 1 and each next one ramps in between its neighbour and itself", async () => {
    await kit.boot({ "b.playlist.json": BLEND({ fade: "layer", curve: "equalPower" }) });
    Audio.play("b.playlist.json", { parameters: { Speed: 7.5 } });
    expect(fake.plays.map((p) => [p.path, p.volume])).toEqual([["a.wav", 1], ["b.wav", 1], ["c.wav", 0.5]]); // layer ignores equal power
  });

  it("atZeroWeight stop stops an entry at weight 0 and restarts it from the top when it returns", async () => {
    await kit.boot({ "b.playlist.json": BLEND({}) });
    const h = Audio.play("b.playlist.json", { parameters: { Speed: 2.5 } });
    h.setParameter("Speed", 7.5);
    kit.frame();
    expect(voiceOf("a.wav").stopped).toBe(true);
    expect(voiceOf("c.wav").playing).toBe(true);
    h.setParameter("Speed", 2.5);
    kit.frame();
    expect(fake.plays.filter((p) => p.path === "a.wav")).toHaveLength(2);
    expect(voiceOf("a.wav", 1).playing).toBe(true);
  });

  it("atZeroWeight continue starts the entry silent and keeps it running at weight 0", async () => {
    await kit.boot({
      "b.playlist.json": pla("blend", [sample("a.wav", { x: 0, atZeroWeight: "continue" }), sample("b.wav", { x: 10, atZeroWeight: "continue" })], {
        parameters: SPEED, blend: { axes: [{ parameter: "Speed" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 } },
      }),
    });
    const h = Audio.play("b.playlist.json", { parameters: { Speed: 0 } });
    expect(fake.plays.map((p) => [p.path, p.volume])).toEqual([["a.wav", 1], ["b.wav", 0]]);
    h.setParameter("Speed", 10);
    kit.frame();
    expect(voiceOf("a.wav").playing).toBe(true);
    expect(voiceOf("a.wav").volume).toBe(0);
    expect(voiceOf("b.wav").volume).toBe(1);
    expect(fake.plays).toHaveLength(2);
  });

  it("follow with glide smooths the input; hold keeps the trigger's value", async () => {
    await kit.boot({ "g.playlist.json": BLEND({ follow: { glideMs: 300 } }), "h.playlist.json": BLEND({ follow: "hold" }) });
    const g = Audio.play("g.playlist.json", { parameters: { Speed: 0 } });
    g.setParameter("Speed", 5);
    kit.frame(0.05);
    const mid = voiceOf("a.wav").volume;
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0.3); // still on its way
    for (let i = 0; i < 30; i++) kit.frame(0.05);
    expect(voiceOf("b.wav").volume).toBeCloseTo(1, 3);
    const hold = Audio.play("h.playlist.json", { parameters: { Speed: 2.5 } });
    hold.setParameter("Speed", 10);
    kit.frame();
    const voices = fake.voices.slice(-2);
    expect(voices.map((v) => v.volume)).toEqual([0.5, 0.5]);
  });

  it("a voice-time axis moves through the entries as the voice plays", async () => {
    await kit.boot({
      "t.playlist.json": pla("blend", [sample("a.wav", { x: 0 }), sample("b.wav", { x: 2, atZeroWeight: "continue" })], {
        blend: { axes: [{ voiceTime: 2 }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 } },
      }),
    });
    Audio.play("t.playlist.json");
    kit.setTime(1);
    kit.frame();
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.5, 6);
    expect(voiceOf("b.wav").volume).toBeCloseTo(0.5, 6);
  });

  it("2D: barycentric inside the triangle", async () => {
    await kit.boot({
      "d.playlist.json": pla("blend", [sample("a.wav", { x: 0, y: 0 }), sample("b.wav", { x: 10, y: 0 }), sample("c.wav", { x: 0, y: 10 })], {
        parameters: [...SPEED, { name: "Load", min: 0, max: 10, default: 0 }],
        blend: { axes: [{ parameter: "Speed" }, { parameter: "Load" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 } },
      }),
    });
    Audio.play("d.playlist.json", { parameters: { Speed: 2, Load: 3 } });
    expect(fake.plays.map((p) => p.volume)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(0.2, 6), expect.closeTo(0.3, 6)]);
  });

  it("the zone envelope gives each entry the low/high lerp by its rank, and one-shots release on their own", async () => {
    const low = { attackMs: 200, decayMs: 0, sustain: 1, releaseMs: 100 };
    const high = { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 100 };
    await kit.boot({
      "z.playlist.json": pla("blend", [sample("a.wav", { x: 0, atZeroWeight: "continue" }), sample("b.wav", { x: 10, atZeroWeight: "continue" })], {
        parameters: SPEED,
        blend: { axes: [{ parameter: "Speed" }], fade: "layer", curve: "linear", follow: { glideMs: 0 }, envelope: { mode: "zone", low, high } },
      }),
    });
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1);
    Audio.play("z.playlist.json", { parameters: { Speed: 10 } });
    kit.setTime(0.1); kit.frame();
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.5, 6); // rank 0: low (200 ms attack)
    expect(voiceOf("b.wav").volume).toBeCloseTo(1, 6); // rank 1: high (no attack)
    kit.setTime(1.05); kit.frame(); // past the longest one-shot (1 s): releasing over 100 ms
    expect(voiceOf("b.wav").volume).toBeCloseTo(0.5, 6);
    kit.setTime(1.2); kit.frame();
    expect(voiceOf("a.wav").stopped).toBe(true);
  });

  it("the envelope (morph) attacks, holds a looping entry until released, then releases linearly", async () => {
    const adsr = { attackMs: 100, decayMs: 100, sustain: 0.5, releaseMs: 200 };
    await kit.boot({
      "e.playlist.json": pla("blend", [sample("a.wav", { x: 0, loop: "on" })], {
        blend: { axes: [{ voiceTime: 2 }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 }, envelope: { mode: "morph", low: adsr, high: adsr } },
      }),
    });
    const h = Audio.play("e.playlist.json");
    expect(fake.plays[0]!.volume).toBe(0); // attack starts at 0
    kit.setTime(0.05); kit.frame();
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.5, 6);
    kit.setTime(1); kit.frame();
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.5, 6); // sustain, held (looping)
    h.release();
    kit.setTime(1.1); kit.frame();
    expect(voiceOf("a.wav").volume).toBeCloseTo(0.25, 6);
    kit.setTime(1.25); kit.frame();
    expect(voiceOf("a.wav").stopped).toBe(true);
  });
});
