// ADR 0158 E3.6: pins the event runtime's behaviour as of wave 0 that the rough-edges work (rough.test.ts) keeps:
// picks, step sequences, switches, release, cooldown and limits. Written before the changes; where E3.6 deliberately
// changes a result, the expectation here says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { _resetHandleWarningsForTests } from "../core/handle";
import { makeFakeBackend } from "../testing";
import { Audio } from "../index";
import { events } from "./eventRuntime";

const fake = makeFakeBackend();
const F = "myco.audioevent@1";
const clip = (c: string, extra: Record<string, unknown> = {}) => ({ type: "clip", clip: c, ...extra });

async function boot(assets: Record<string, unknown>, audio: Record<string, unknown> = {}): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:,", "b.wav": "data:,", "c.wav": "data:,", ...assets }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7, ...audio } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
}

beforeEach(() => {
  fake.clear();
  fake.ready = true;
  setAudioBackend(fake);
  events()._reset();
  _resetHandleWarningsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  events()._reset();
  setAudioBackend(null);
});

const RANDOM = { "r.audioevent.json": { format: F, root: { type: "random", children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] } } };

describe("pinned: random picks", () => {
  it("the same seed gives the same picks after a reset", async () => {
    await boot(RANDOM);
    for (let i = 0; i < 12; i++) Audio.play("r.audioevent.json");
    const first = fake.plays.map((p) => p.path);
    expect(new Set(first).size).toBeGreaterThan(1);
    fake.clear();
    events()._reset();
    await boot(structuredClone(RANDOM)); // a fresh asset object: today's avoid-repeat history is per node, so it must be a new node
    for (let i = 0; i < 12; i++) Audio.play("r.audioevent.json");
    expect(fake.plays.map((p) => p.path)).toEqual(first);
  });

  it("avoidRepeat 2 over three children cycles through all of them", async () => {
    await boot({ "r2.audioevent.json": { format: F, root: { type: "random", avoidRepeat: 2, children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] } } });
    for (let i = 0; i < 9; i++) Audio.play("r2.audioevent.json");
    const p = fake.plays.map((x) => x.path);
    for (let i = 2; i < p.length; i++) expect(new Set([p[i - 2], p[i - 1], p[i]]).size).toBe(3);
  });
});

describe("pinned: step sequences", () => {
  const Q = { "q.audioevent.json": { format: F, root: { type: "sequence", reset: 5, children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] } } };

  it("advances per play, wraps, and resets after `reset` seconds idle", async () => {
    await boot(Q);
    let t = 100;
    events().now = () => t;
    Audio.play("q.audioevent.json");
    Audio.play("q.audioevent.json");
    t += 4;
    Audio.play("q.audioevent.json");
    Audio.play("q.audioevent.json"); // wraps to a
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "c.wav", "a.wav"]);
    t += 6;
    Audio.play("q.audioevent.json"); // idle longer than reset: back to the first
    expect(fake.plays.at(-1)!.path).toBe("a.wav");
  });
});

describe("pinned: switch and release", () => {
  it("a switch picks its labelled child and keeps playing on onChange keep", async () => {
    await boot({
      "sw.audioevent.json": { format: F, parameters: [{ name: "S", labels: ["x", "y"] }],
        root: { type: "switch", parameter: "S", onChange: "keep", children: [clip("a.wav", { value: "x" }), clip("b.wav", { value: "y" })] } },
    });
    const h = Audio.play("sw.audioevent.json", { parameters: { S: "y" } });
    expect(fake.plays.map((p) => p.path)).toEqual(["b.wav"]);
    h.setParameter("S", "x");
    expect(fake.plays).toHaveLength(1);
    expect(fake.voices[0].stopped).toBe(false);
  });

  it("release plays a sustain container's end after its loop", async () => {
    await boot({ "su.audioevent.json": { format: F, root: { type: "sustain", loop: clip("a.wav"), end: clip("b.wav"), release: "now", fade: 0.1 } } });
    const h = Audio.play("su.audioevent.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav"]);
    h.release();
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(fake.voices[0].stopped).toBe(true);
  });
});

describe("pinned: cooldown, limits, instance lifetime", () => {
  it("cooldown refuses a replay inside its window", async () => {
    await boot({ "c.audioevent.json": { format: F, cooldown: 1, root: clip("a.wav") } });
    let t = 10;
    events().now = () => t;
    expect(Audio.play("c.audioevent.json").playing).toBe(true);
    t += 0.5;
    expect(Audio.play("c.audioevent.json").playing).toBe(false);
    t += 1;
    expect(Audio.play("c.audioevent.json").playing).toBe(true);
  });

  it("maxInstances with steal oldest stops the first", async () => {
    await boot({ "o.audioevent.json": { format: F, limit: { maxInstances: 2, steal: "oldest" }, root: clip("a.wav") } });
    const h = [1, 2, 3].map(() => Audio.play("o.audioevent.json"));
    expect(h.map((x) => x.playing)).toEqual([false, true, true]);
    expect(fake.voices[0].stopped).toBe(true);
  });

  it("maxInstances with steal quietest stops the quietest", async () => {
    await boot({ "o.audioevent.json": { format: F, limit: { maxInstances: 2, steal: "quietest" }, root: clip("a.wav") } });
    const loud = Audio.play("o.audioevent.json", { volume: 1 });
    const quiet = Audio.play("o.audioevent.json", { volume: 0.2 });
    Audio.play("o.audioevent.json", { volume: 1 });
    expect(quiet.playing).toBe(false);
    expect(loud.playing).toBe(true);
  });

  it("an ended instance frees its group without a frame, but the next play takes a different one", async () => {
    await boot({ "e.audioevent.json": { format: F, root: clip("a.wav") } });
    const h = Audio.play("e.audioevent.json");
    const group = fake.plays[0].group;
    fake.voices[0].end();
    expect(h.playing).toBe(false);
    Audio.play("e.audioevent.json");
    expect(fake.plays[1].group).not.toBe(group); // E3.10: the longest-free group goes first
    expect(events().debugRows()).toHaveLength(1);
  });

  it("volume option scales the request; pitch option applies at play", async () => {
    await boot({ "e.audioevent.json": { format: F, volume: 0.5, root: clip("a.wav") } });
    Audio.play("e.audioevent.json", { volume: 0.5, pitch: 2 });
    expect(fake.plays[0].volume).toBeCloseTo(0.25);
    expect(fake.plays[0].pitch).toBeCloseTo(2);
  });
});
