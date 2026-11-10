// ADR 0158 E3 smoke tests: the event runtime on the fake backend (no `automation` sink, so `TsAutomation` runs).
// Not yet complete coverage: see docs/plans/2026-11-audio-events-m2.md (E3 "remaining").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { setAudioBackend } from "../backend";
import { _resetHandleWarningsForTests } from "../core/handle";
import { makeFakeBackend } from "../testing";
import { Audio } from "../index";
import { events } from "./eventRuntime";

const fake = makeFakeBackend();
const F = "myco.audioevent@1";

async function boot(assets: Record<string, unknown>, audio: Record<string, unknown> = {}): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:,", "b.wav": "data:,", "c.wav": "data:,", ...assets }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7, ...audio } } });
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

describe("Audio.play (ADR 0158)", () => {
  it("plays a clip as a one-clip event and returns a live handle", async () => {
    await boot({});
    const h = Audio.play("asset:a.wav", { volume: 0.5 });
    expect(fake.plays).toHaveLength(1);
    expect(fake.plays[0].path).toBe("a.wav");
    expect(fake.plays[0].volume).toBeCloseTo(0.5);
    expect(fake.plays[0].group).toBeGreaterThan(0);
    expect(h.playing).toBe(true);
    fake.voices[0].end();
    expect(h.playing).toBe(false);
  });

  it("returns an inert handle for a missing event", async () => {
    await boot({});
    const h = Audio.play("nope.audioevent.json");
    expect(h.playing).toBe(false);
    expect(fake.plays).toHaveLength(0);
  });

  it("layers play every child; random with avoidRepeat never repeats the last pick", async () => {
    await boot({
      "l.audioevent.json": { format: F, bus: "SFX", root: { type: "layer", children: [{ type: "clip", clip: "a.wav" }, { type: "clip", clip: "b.wav" }] } },
      "r.audioevent.json": { format: F, root: { type: "random", avoidRepeat: 1, children: [{ type: "clip", clip: "a.wav" }, { type: "clip", clip: "b.wav" }, { type: "clip", clip: "c.wav" }] } },
    });
    Audio.play("l.audioevent.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(fake.plays.every((p) => p.bus === "SFX")).toBe(true);
    fake.clear();
    for (let i = 0; i < 20; i++) Audio.play("r.audioevent.json");
    const picks = fake.plays.map((p) => p.path);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
  });

  it("a step sequence advances one child per play", async () => {
    await boot({ "q.audioevent.json": { format: F, root: { type: "sequence", children: [{ type: "clip", clip: "a.wav" }, { type: "clip", clip: "b.wav" }] } } });
    for (let i = 0; i < 3; i++) Audio.play("q.audioevent.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "a.wav"]);
  });

  it("a switch follows its labelled parameter and restarts on change", async () => {
    await boot({
      "sw.audioevent.json": { format: F, parameters: [{ name: "Surface", labels: ["Grass", "Gravel"] }],
        root: { type: "switch", parameter: "Surface", onChange: "restart", children: [{ type: "clip", clip: "a.wav", value: "Grass" }, { type: "clip", clip: "b.wav", value: "Gravel" }] } },
    });
    const h = Audio.play("sw.audioevent.json", { parameters: { Surface: "Gravel" } });
    expect(fake.plays.map((p) => p.path)).toEqual(["b.wav"]);
    h.setParameter("Surface", "Grass");
    expect(fake.voices[0].stopped).toBe(true);
    expect(fake.plays.map((p) => p.path)).toEqual(["b.wav", "a.wav"]);
    expect(h.getParameter("Surface")).toBe("Grass");
  });

  it("automation on the fallback evaluator drives voice volume from a parameter", async () => {
    await boot({
      "v.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 10 }],
        automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [10, 1]] }], root: { type: "clip", clip: "a.wav" } },
    });
    const h = Audio.play("v.audioevent.json", { parameters: { Speed: 5 } });
    expect(fake.voices[0].volume).toBeCloseTo(0.5);
    h.setParameter("Speed", 10);
    events().update(1 / 60);
    expect(fake.voices[0].volume).toBeCloseTo(1);
  });

  it("global parameters and limits", async () => {
    await boot(
      { "g.audioevent.json": { format: F, limit: { maxInstances: 1, steal: "none" }, automation: [{ parameter: "Intensity", target: "volume", curve: [[0, 0.2], [1, 1]] }], root: { type: "clip", clip: "a.wav" } } },
      { parameters: [{ name: "Intensity", min: 0, max: 1 }] },
    );
    Audio.setParameter("Intensity", 1);
    expect(Audio.getParameter("Intensity")).toBe(1);
    const h1 = Audio.play("g.audioevent.json");
    const h2 = Audio.play("g.audioevent.json");
    expect(h1.playing).toBe(true);
    expect(h2.playing).toBe(false);
    expect(fake.voices[0].volume).toBeCloseTo(1);
  });

  it("release ends a sustain clip's loop", async () => {
    await boot({ "s.audioevent.json": { format: F, root: { type: "clip", clip: "a.wav", sustain: true, loopRegion: [0.5, 1.5] } } });
    const h = Audio.play("s.audioevent.json");
    expect(fake.plays[0].loop).toBe(true);
    h.release();
    const loops = fake.voices[0].events.filter((e) => e.kind === "loop");
    expect(loops).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: true }, { kind: "loop", start: 0.5, end: 1.5, looping: false }]);
  });
});
