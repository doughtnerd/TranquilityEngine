// ADR 0166 P6: music events in the event runtime (limits, steal, cooldown, `EventInstance.music`) and in `AudioSource`
// (pitch ignored with one warning). The planner (P2) is a stub in this tree, so the player stays in `starting`; stem voices
// are put on its runs by hand where a test needs them.
import { describe, expect, it, vi } from "vitest";
import { GameObject } from "../../../../myco";
import { AudioSource } from "../AudioSource";
import { Audio } from "../index";
import { musicPlayers, playerOf } from "../music/musicSystem";
import { segmentClipSource } from "../music/segmentRun";
import { events } from "./eventRuntime";
import { eventKit, ev } from "./eventTestKit";

const kit = eventKit();
const fake = kit.fake;

const seg = (id = "s", extra: Record<string, unknown> = {}) => ({ type: "segment", id, tracks: [{ name: "a", clip: "a.wav" }], ...extra });
const warnCount = (text: string): number => vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes(text)).length;

describe("a music event in the event runtime", () => {
  it("makes a player for a segment root, and `handle.music` finds it", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    const h = Audio.play("m.audioevent.json");
    expect(h.playing).toBe(true);
    expect(musicPlayers()).toHaveLength(1);
    const inst = [...(events() as unknown as { live: Set<{ music: unknown }> }).live][0]!;
    expect(inst.music).toBe(musicPlayers()[0]);
    expect(playerOf(inst)).toBe(inst.music);
    expect(h.music).toBeDefined();
    expect(fake.plays).toHaveLength(0); // the tree walk plays nothing: the player does
  });

  it("makes a player for a playlist root and a musicSwitch root", async () => {
    await kit.boot({
      "p.audioevent.json": ev({ type: "playlist", id: "p", mode: "sequence", children: [seg("a"), seg("b")] }),
      "w.audioevent.json": ev({ type: "musicSwitch", id: "w", parameter: "S", children: [seg("a", { value: "x" })] }, { parameters: [{ name: "S", labels: ["x"] }] }),
    });
    Audio.play("p.audioevent.json");
    Audio.play("w.audioevent.json");
    expect(musicPlayers().map((p) => p.root.type)).toEqual(["playlist", "musicSwitch"]);
  });

  it("passes the `at` option to the player", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    Audio.play("m.audioevent.json", { at: 12.5 });
    expect(musicPlayers()[0]!.requestedAt).toBe(12.5);
  });

  it("stop ends the instance, disposes the player and frees the group", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    const h = Audio.play("m.audioevent.json");
    h.stop();
    expect(h.playing).toBe(false);
    expect(musicPlayers()).toHaveLength(0);
    expect(h.music).toBeUndefined();
  });

  it("a refused player ends the instance on the next end scan", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    const h = Audio.play("m.audioevent.json");
    musicPlayers()[0]!.state = "refused";
    expect(h.playing).toBe(false);
  });

  describe("limits (the 0158 rows, for music)", () => {
    const limited = (steal: "oldest" | "quietest" | "none") => ({ "m.audioevent.json": ev(seg(), { limit: { maxInstances: 2, steal } }) });

    it("steal oldest stops the oldest instance", async () => {
      await kit.boot(limited("oldest"));
      const h1 = Audio.play("m.audioevent.json");
      const h2 = Audio.play("m.audioevent.json");
      const h3 = Audio.play("m.audioevent.json");
      expect(h1.playing).toBe(false);
      expect(h2.playing).toBe(true);
      expect(h3.playing).toBe(true);
      expect(musicPlayers()).toHaveLength(2);
    });

    it("steal none refuses the new instance", async () => {
      await kit.boot(limited("none"));
      Audio.play("m.audioevent.json");
      Audio.play("m.audioevent.json");
      const h3 = Audio.play("m.audioevent.json");
      expect(h3.playing).toBe(false);
      expect(musicPlayers()).toHaveLength(2);
    });

    it("steal quietest stops the quietest instance", async () => {
      await kit.boot(limited("quietest"));
      const loud = Audio.play("m.audioevent.json", { volume: 1 });
      const quiet = Audio.play("m.audioevent.json", { volume: 0.2 });
      const next = Audio.play("m.audioevent.json", { volume: 0.5 });
      expect(quiet.playing).toBe(false);
      expect(loud.playing).toBe(true);
      expect(next.playing).toBe(true);
    });

    it("a limit counts a music event apart from other events", async () => {
      await kit.boot({ ...limited("oldest"), "c.audioevent.json": ev({ type: "clip", clip: "a.wav" }, { limit: { maxInstances: 1, steal: "oldest" } }) });
      Audio.play("m.audioevent.json");
      Audio.play("c.audioevent.json");
      Audio.play("m.audioevent.json");
      expect(musicPlayers()).toHaveLength(2);
    });
  });

  it("cooldown refuses a second play of a music event", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg(), { cooldown: 5 }) });
    let t = 100;
    events().now = () => t;
    const a = Audio.play("m.audioevent.json");
    t = 101;
    const b = Audio.play("m.audioevent.json");
    expect(a.playing).toBe(true);
    expect(b.playing).toBe(false);
    expect(musicPlayers()).toHaveLength(1);
    t = 106;
    expect(Audio.play("m.audioevent.json").playing).toBe(true);
    expect(musicPlayers()).toHaveLength(2);
  });

  it("an instance is playing while a stem voice plays and over when none does", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    const h = Audio.play("m.audioevent.json");
    const p = musicPlayers()[0]!;
    // As P1/P2 leave it: a stamped run with a stem voice.
    const voice = fake.play({ path: "a.wav", url: "", loop: false, stream: false, bus: "", volume: 1, pitch: 1, priority: 128, world: 0, group: 0 })!;
    p.run = { node: p.root, player: p, state: "playing", group: 1, stems: [{ track: "a", alternative: 0, clip: "a.wav", streamed: false, voice, primed: true }], startAt: 0, startFrame: 0, loopsDone: 0, prime: null };
    p.state = "playing";
    expect(h.playing).toBe(true);
    expect(h.panner).toBe(voice.panner ?? null);
    voice.stop(0);
    expect(h.playing).toBe(false);
  });
});

describe("quantised stem automation on a stamped run (G-1)", () => {
  it("a stamped run with a quantised binding gets its level at once and a stamped ramp at the next beat", async () => {
    const track = { name: "a", clip: "a.wav", automation: [{ parameter: "I", target: "volume", curve: [[0, 0], [1, 1]], quantize: "beat" }] };
    await kit.boot({ "m.audioevent.json": ev(seg("s", { tracks: [track] }), { parameters: [{ name: "I", min: 0, max: 1, default: 0 }] }) });
    Audio.play("m.audioevent.json");
    const p = musicPlayers()[0]!;
    const voice = fake.play({ path: "a.wav", url: "", loop: false, stream: false, bus: "", volume: 1, pitch: 1, priority: 128, world: 0, group: 0 })!;
    const calls: { gain: number; seconds: number; at?: number }[] = [];
    (voice as { paramsShaped?: unknown }).paramsShaped = (r: { gain: number; seconds: number; at?: number }) => void calls.push(r);
    // The run as P1 leaves it before the core reports the group started: "stamped", default 120 bpm grid from 1.0 s.
    p.run = { node: p.root, player: p, state: "stamped", group: 1, stems: [{ track: "a", alternative: 0, clip: "a.wav", streamed: false, voice, primed: true }], startAt: 1, startFrame: 0, loopsDone: 0, prime: null };
    p.state = "playing";
    (fake as { time: number }).time = 1.2;
    const inst = [...(events() as unknown as { live: Set<{ tickMusicAutomation(): void }> }).live][0]!;
    inst.tickMusicAutomation();
    // The level at bind, before the first beat, stamped at the run's start (F-9: the members' PLAYs are stamped there).
    expect(calls[0]).toEqual({ gain: 0, seconds: 0, law: "linear", at: 1 });
    const ramp = calls.slice(1).find((c) => c.at !== undefined)!; // the stamped ramp (absent without the "stamped" guard)
    expect(ramp).toBeDefined();
    expect(ramp.gain).toBe(0);
    expect(ramp.at).toBeGreaterThanOrEqual(1.2);
  });
});

describe("pitch on music", () => {
  it("an EventOptions pitch is ignored with one warning", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    Audio.play("m.audioevent.json", { pitch: 2 });
    Audio.play("m.audioevent.json", { pitch: 2 });
    expect(warnCount("pitch is ignored for music")).toBe(1);
  });

  it("a pitched AudioSource plays a music event at rate 1 with one warning", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    const src = GameObject.create("n").addBehavior(AudioSource, { clip: "m.audioevent.json", playOnAwake: false, pitch: 1.5 });
    src.play();
    expect(src.isPlaying).toBe(true);
    const inst = [...(events() as unknown as { live: Set<{ pitchOption: number }> }).live][0]!;
    expect(inst.pitchOption).toBe(1);
    src.pitch = 2;
    src._sync();
    src._sync();
    expect(inst.pitchOption).toBe(1);
    expect(warnCount("pitch is ignored for music")).toBe(1);
  });

  it("a source at pitch 1 plays a music event without a warning", async () => {
    await kit.boot({ "m.audioevent.json": ev(seg()) });
    const src = GameObject.create("n").addBehavior(AudioSource, { clip: "m.audioevent.json", playOnAwake: false });
    src.play();
    src._sync();
    expect(src.isPlaying).toBe(true);
    expect(warnCount("pitch is ignored")).toBe(0);
  });

  it("an ordinary event keeps its pitch", async () => {
    await kit.boot({ "c.audioevent.json": ev({ type: "clip", clip: "a.wav" }) });
    Audio.play("c.audioevent.json", { pitch: 2 });
    expect(fake.plays[0]!.pitch).toBe(2);
  });
});

describe("the segment clip source", () => {
  it("is wired by AudioSource.ts to the project's URLs, import settings and buses", async () => {
    await kit.boot({});
    const src = segmentClipSource();
    expect(src.url("a.wav")).toBe("data:,");
    expect(src.settings("a.wav").volume).toBe(1);
    expect(src.bus("SFX")).toBe("SFX");
    expect(src.bus(undefined)).toBe("Master");
  });
});
