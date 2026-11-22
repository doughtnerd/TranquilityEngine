// ADR 0329: the playlist runtime's trigger gate and Queue picks, through `Audio.play` on the fake backend.
import { describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { endAudioSession } from "../testing";
import { eventKit, pla, sample } from "../events/eventTestKit";

const kit = eventKit();
const fake = kit.fake;

/** The sample paths `n` triggers of `path` played. */
function picks(path: string, n: number): string[] {
  const from = fake.plays.length;
  for (let i = 0; i < n; i++) Audio.play(path);
  return fake.plays.slice(from).map((p) => p.path);
}

/** Wall clock (the gate's cooldown clock) at `seconds`. */
function wallAt(seconds: number): void {
  vi.spyOn(performance, "now").mockReturnValue(seconds * 1000);
}

const FOUR = [sample("a.wav"), sample("b.wav"), sample("c.wav"), sample("d.wav")];

describe("trigger gate", () => {
  it("cooldown refuses triggers within the window since the last accepted one", async () => {
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")], { playback: { cooldown: 1 } }) });
    wallAt(10);
    expect(Audio.play("c.playlist.json").playing).toBe(true);
    wallAt(10.5);
    expect(Audio.play("c.playlist.json").playing).toBe(false);
    // Measured from the last accepted trigger, not the refused one.
    wallAt(11.01);
    expect(Audio.play("c.playlist.json").playing).toBe(true);
    expect(fake.plays).toHaveLength(2);
    expect(Audio.debug().playlistTotals!.refused.cooldown).toBe(1);
    expect(Audio.debug().playlistTotals!.recentRefusals.at(-1)).toMatchObject({ playlist: "c.playlist.json", reason: "cooldown" });
  });

  it("chance refuses about 1 - chance of the triggers, deterministically per seed", async () => {
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")], { playback: { chance: 0.25 } }) });
    const played = picks("c.playlist.json", 400).length;
    expect(played).toBeGreaterThan(60);
    expect(played).toBeLessThan(140);
    expect(Audio.debug().playlistTotals!.refused.chance).toBe(400 - played);
    endAudioSession();
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")], { playback: { chance: 0.25 } }) });
    expect(picks("c.playlist.json", 400).length).toBe(played);
  });

  it("chance 0 never plays", async () => {
    await kit.boot({ "c.playlist.json": pla("clip", [sample("a.wav")], { playback: { chance: 0 } }) });
    expect(picks("c.playlist.json", 5)).toEqual([]);
  });

  it("maxInstances with refuse refuses while full", async () => {
    await kit.boot({ "m.playlist.json": pla("clip", [sample("a.wav")], { playback: { maxInstances: 2, whenFull: "refuse" } }) });
    expect(picks("m.playlist.json", 3)).toEqual(["a.wav", "a.wav"]);
    expect(Audio.debug().playlistTotals!.refused.maxInstances).toBe(1);
    // One ends: room again.
    fake.voices[0]!.end();
    kit.frame();
    expect(picks("m.playlist.json", 1)).toEqual(["a.wav"]);
  });

  it("stealOldest fades the oldest out over 40 ms", async () => {
    await kit.boot({ "m.playlist.json": pla("clip", [sample("a.wav")], { playback: { maxInstances: 2, whenFull: "stealOldest" } }) });
    const h1 = Audio.play("m.playlist.json");
    const h2 = Audio.play("m.playlist.json");
    const h3 = Audio.play("m.playlist.json");
    expect([h1.playing, h2.playing, h3.playing]).toEqual([false, true, true]);
    expect(fake.voices[0]!.events.at(-1)).toEqual({ kind: "stop", fadeSeconds: 0.04 });
    expect(Audio.debug().playlistTotals!.recentSteals.at(-1)).toMatchObject({ playlist: "m.playlist.json", rule: "stealOldest" });
  });

  it("stealQuietest takes the quietest instance", async () => {
    await kit.boot({ "m.playlist.json": pla("clip", [sample("a.wav")], { playback: { maxInstances: 2, whenFull: "stealQuietest" } }) });
    const loud = Audio.play("m.playlist.json", { volume: 1 });
    const quiet = Audio.play("m.playlist.json", { volume: 0.2 });
    Audio.play("m.playlist.json", { volume: 0.5 });
    expect(loud.playing).toBe(true);
    expect(quiet.playing).toBe(false);
  });

  it("stealFarthest takes the instance farthest from the listener", async () => {
    await kit.boot({
      // A listener at the origin.
      "s.json": { format: "myco.scene@1", nodes: [{ id: "ear", components: [{ type: "engine.Transform", data: {} }, { type: "engine.AudioListener", data: {} }] }] },
      "m.playlist.json": pla("clip", [sample("a.wav")], { playback: { maxInstances: 2, whenFull: "stealFarthest" }, spatial: { attenuation: null } }),
    });
    const near = Audio.play("m.playlist.json", { position: { x: 1, y: 0, z: 0 } });
    const far = Audio.play("m.playlist.json", { position: { x: 50, y: 0, z: 0 } });
    Audio.play("m.playlist.json", { position: { x: 5, y: 0, z: 0 } });
    expect(near.playing).toBe(true);
    expect(far.playing).toBe(false);
  });

  it("refuses a missing playlist and a sequence (M5) with their reasons", async () => {
    await kit.boot({ "s.playlist.json": pla("sequence", []) });
    expect(Audio.play("nope.playlist.json").playing).toBe(false);
    expect(Audio.play("s.playlist.json").playing).toBe(false);
    const t = Audio.debug().playlistTotals!;
    expect(t.refused.missing).toBe(1);
    expect(t.refused.unsupported).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("M5"));
  });
});

describe("Queue picks", () => {
  it("random: weights bias the picks, weight 0 never plays, and a seed reproduces them", async () => {
    const asset = () => pla("queue", [sample("a.wav", { weight: 1 }), sample("b.wav", { weight: 9 }), sample("c.wav", { weight: 0 })], { queue: { pick: "random", avoidRepeat: 0 } });
    await kit.boot({ "w.playlist.json": asset() });
    const first = picks("w.playlist.json", 200);
    expect(first.filter((p) => p === "b.wav").length).toBeGreaterThan(150);
    expect(first).toContain("a.wav");
    expect(first).not.toContain("c.wav");
    endAudioSession();
    await kit.boot({ "w.playlist.json": asset() });
    expect(picks("w.playlist.json", 200)).toEqual(first);
  });

  it("random: avoidRepeat n skips the last n picks", async () => {
    await kit.boot({ "v.playlist.json": pla("queue", FOUR, { queue: { pick: "random", avoidRepeat: 2 } }) });
    const p = picks("v.playlist.json", 60);
    for (let i = 2; i < p.length; i++) expect([p[i - 1], p[i - 2]]).not.toContain(p[i]);
    expect(new Set(p).size).toBe(4);
  });

  it("random: avoidRepeat is capped at n - 1", async () => {
    await kit.boot({ "v.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "random", avoidRepeat: 5 } }) });
    expect(picks("v.playlist.json", 6)).toEqual(expect.arrayContaining(["a.wav", "b.wav"]));
    const p = picks("v.playlist.json", 10);
    for (let i = 1; i < p.length; i++) expect(p[i]).not.toBe(p[i - 1]);
  });

  it("shuffle: every entry once per deck, never the same twice across decks", async () => {
    await kit.boot({ "s.playlist.json": pla("queue", FOUR, { queue: { pick: "shuffle" } }) });
    const p = picks("s.playlist.json", 12);
    for (let d = 0; d < 3; d++) expect(new Set(p.slice(d * 4, d * 4 + 4)).size).toBe(4);
    for (let i = 1; i < p.length; i++) expect(p[i]).not.toBe(p[i - 1]);
  });

  it("round robin: in order, wrapping, persistent per playlist across triggers", async () => {
    await kit.boot({ "r.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav"), sample("c.wav")], { queue: { pick: "roundRobin" } }) });
    expect(picks("r.playlist.json", 7)).toEqual(["a.wav", "b.wav", "c.wav", "a.wav", "b.wav", "c.wav", "a.wav"]);
  });

  it("picks once per trigger: a parameter change afterwards doesn't re-pick", async () => {
    await kit.boot({
      "r.playlist.json": pla("queue", [sample("a.wav"), sample("b.wav")], { queue: { pick: "roundRobin" }, parameters: [{ name: "Speed", min: 0, max: 1, default: 0 }] }),
    });
    const h = Audio.play("r.playlist.json");
    h.setParameter("Speed", 1);
    kit.frame();
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav"]);
  });
});
