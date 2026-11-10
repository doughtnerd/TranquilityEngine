// ADR 0158 E3.6: the event runtime's rough edges. Per-World seeding and sequence state, `playing` without side
// effects, pitch reaching a playing instance, no double-applied gain at a backend hand-over, the late-start count.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import { setAudioBackend, type AudioBackend } from "../backend";
import { _resetHandleWarningsForTests } from "../core/handle";
import { AudioSource } from "../AudioSource";
import { makeFakeBackend } from "../testing";
import { Audio } from "../index";
import { events, worldSeed, type EventInstance } from "./eventRuntime";
import type { AutomationSink } from "./automation";

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

const RANDOM = () => ({ "r.audioevent.json": { format: F, root: { type: "random", children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] } } });
const SEQ = () => ({
  "q.audioevent.json": { format: F, root: { type: "sequence", reset: 5, children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] } },
  "q2.audioevent.json": { format: F, root: { type: "sequence", reset: 5, children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] } },
});

function picks(path: string, world: number, n = 16): string[] {
  const from = fake.plays.length;
  for (let i = 0; i < n; i++) events().play(path, {}, world);
  return fake.plays.slice(from).map((p) => p.path);
}

describe("seeding per World (0158 §6)", () => {
  it("the same seed and the same World give the same picks", async () => {
    await boot(RANDOM());
    const first = picks("r.audioevent.json", 3);
    events()._reset();
    await boot(RANDOM());
    expect(picks("r.audioevent.json", 3)).toEqual(first);
  });

  it("Worlds have their own generators: another World's picks differ, and neither disturbs the other", async () => {
    await boot(RANDOM());
    const a = picks("r.audioevent.json", 1);
    const b = picks("r.audioevent.json", 2);
    expect(b).not.toEqual(a);
    // World 1 alone, fresh: the same picks as when World 2 played in between.
    events()._reset();
    await boot(RANDOM());
    const alone = [...picks("r.audioevent.json", 1, 8), ...picks("r.audioevent.json", 1, 8)];
    events()._reset();
    await boot(RANDOM());
    const mixed: string[] = [];
    for (let i = 0; i < 8; i++) { mixed.push(...picks("r.audioevent.json", 1, 1)); picks("r.audioevent.json", 2, 1); }
    expect(alone.slice(0, 8)).toEqual(mixed.slice(0, 8));
  });

  it("key 0 keeps mulberry32(seed) and other keys combine the key into the seed", () => {
    expect(worldSeed(7, 0)).toBe(7);
    expect(worldSeed(7, 1)).not.toBe(worldSeed(7, 2));
  });

  it("forgetting a World starts its generator and positions over", async () => {
    await boot({ ...RANDOM(), ...SEQ() });
    const first = picks("r.audioevent.json", 4, 8);
    events().forgetWorld(4);
    expect(picks("r.audioevent.json", 4, 8)).toEqual(first);
  });

  it("keepWorlds forgets the Worlds the host no longer lists but not key 0", async () => {
    await boot(SEQ());
    picks("q.audioevent.json", 0, 1);
    picks("q.audioevent.json", 5, 1);
    events().keepWorlds(new Set());
    expect(picks("q.audioevent.json", 0, 1)).toEqual(["b.wav"]); // key 0 kept its position
    expect(picks("q.audioevent.json", 5, 1)).toEqual(["a.wav"]); // key 5 started over
  });

  it("a key held by another World drops the old World's state", async () => {
    await boot(SEQ());
    events().noteWorld(6, {});
    picks("q.audioevent.json", 6, 2);
    events().noteWorld(6, {});
    expect(picks("q.audioevent.json", 6, 1)).toEqual(["a.wav"]);
  });
});

describe("step sequences per asset per World (0158 §1)", () => {
  it("two Worlds don't share positions", async () => {
    await boot(SEQ());
    expect(picks("q.audioevent.json", 1, 2)).toEqual(["a.wav", "b.wav"]);
    expect(picks("q.audioevent.json", 2, 1)).toEqual(["a.wav"]);
    expect(picks("q.audioevent.json", 1, 1)).toEqual(["c.wav"]);
  });

  it("two assets don't share positions", async () => {
    await boot(SEQ());
    expect(picks("q.audioevent.json", 1, 2)).toEqual(["a.wav", "b.wav"]);
    expect(picks("q2.audioevent.json", 1, 1)).toEqual(["a.wav"]);
  });

  it("the position resets after `reset` seconds idle", async () => {
    await boot(SEQ());
    let t = 50;
    events().now = () => t;
    picks("q.audioevent.json", 1, 2);
    t += 4;
    expect(picks("q.audioevent.json", 1, 1)).toEqual(["c.wav"]);
    t += 5.5;
    expect(picks("q.audioevent.json", 1, 1)).toEqual(["a.wav"]);
  });

  it("avoidRepeat 0 allows repeats and a weight biases picks (it used to ban every earlier pick)", async () => {
    await boot({ "w.audioevent.json": { format: F, root: { type: "random", avoidRepeat: 0, children: [clip("a.wav", { weight: 0.001 }), clip("b.wav", { weight: 1000 })] } } });
    expect(picks("w.audioevent.json", 0, 20).filter((p) => p === "b.wav").length).toBeGreaterThanOrEqual(19);
  });
});

describe("EventInstance.playing has no side effects", () => {
  it("an ended instance is retired by the system (play, update), not by reading `playing`", async () => {
    await boot({ "e.audioevent.json": { format: F, root: clip("a.wav") } });
    const h = Audio.play("e.audioevent.json");
    const live = (): number => (events() as unknown as { live: Set<EventInstance> }).live.size;
    expect(live()).toBe(1);
    fake.voices[0].end();
    expect(h.playing).toBe(false);
    expect(h.playing).toBe(false);
    expect(live()).toBe(1); // reading did not retire it
    events().update(1 / 60);
    expect(live()).toBe(0);
    expect(events().debugRows()).toEqual([]);
  });

  it("a play also retires ended instances, so their groups are reused", async () => {
    await boot({ "e.audioevent.json": { format: F, root: clip("a.wav") } });
    Audio.play("e.audioevent.json");
    const group = fake.plays[0].group;
    fake.voices[0].end();
    Audio.play("e.audioevent.json");
    expect(fake.plays[1].group).toBe(group);
  });
});

describe("pitch reaches a playing event", () => {
  it("AudioSource.pitch changes the playing instance's voices", async () => {
    await boot({ "e.audioevent.json": { format: F, pitch: 1.5, root: clip("a.wav") } });
    const src = GameObject.create("m").addBehavior(AudioSource, { clip: "e.audioevent.json", playOnAwake: false, pitch: 1 });
    src.play();
    expect(fake.voices[0].pitch).toBeCloseTo(1.5);
    src.pitch = 2;
    src._sync();
    expect(fake.voices[0].pitch).toBeCloseTo(3);
    src._sync();
    expect(fake.voices[0].events.filter((e) => e.kind === "pitch")).toHaveLength(2); // the request's and the change
  });

  it("automation on pitch keeps multiplying onto the new pitch", async () => {
    await boot({
      "p.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 10 }],
        automation: [{ parameter: "Speed", target: "pitch", curve: [[0, 1], [10, 2]] }], root: clip("a.wav") },
    });
    const i = events().play("p.audioevent.json", { parameters: { Speed: 10 } })!;
    expect(fake.voices[0].pitch).toBeCloseTo(2);
    i.setPitch(1.5);
    expect(fake.voices[0].pitch).toBeCloseTo(3);
    expect(fake.voices[0].request.pitch).toBeCloseTo(1); // the request kept the unautomated base
  });
});

describe("automated gain is never the request's volume", () => {
  const volumeEvent = () => ({
    "v.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 10 }],
      automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [10, 1]] }], root: clip("a.wav", { volume: 0.8 }) },
  });

  it("the request carries the base volume while the voice setter carries the automated gain", async () => {
    await boot(volumeEvent());
    events().play("v.audioevent.json", { parameters: { Speed: 5 } });
    expect(fake.plays[0].volume).toBeCloseTo(0.8);
    expect(fake.voices[0].volume).toBeCloseTo(0.4);
  });

  it("at a hand-over to a backend with its own automation, voices go back to the base before it binds", async () => {
    await boot(volumeEvent());
    events().play("v.audioevent.json", { parameters: { Speed: 5 } });
    const voice = fake.voices[0];
    expect(voice.volume).toBeCloseTo(0.4);
    const log: string[] = [];
    const sink: AutomationSink = {
      defineCurve() {}, setParam() {}, bindBus() {}, setLoop() {},
      bindVoice(v, _g, _b, base) { log.push(`bind:${base.volume.toFixed(2)}:${voice === v ? voice.volume.toFixed(2) : "?"}`); },
    };
    const core: AudioBackend = Object.assign(Object.create(fake) as AudioBackend, { automation: sink });
    setAudioBackend(core);
    events().update(1 / 60);
    // At the bind, the voice already sits at the base volume (0.8), not the automated 0.4.
    expect(log).toEqual(["bind:0.80:0.80"]);
  });
});

describe("late starts of continuous containers (0158 §6)", () => {
  it("counts a clip started on the previous one's end when its length is unknown", async () => {
    await boot({ "c.audioevent.json": { format: F, root: { type: "random", mode: "continuous", avoidRepeat: 0, children: [clip("a.wav"), clip("b.wav")] } } });
    Audio.play("c.audioevent.json");
    expect(Audio.debug().events[0].lateStarts).toBe(0);
    fake.voices[0].end();
    (fake as { time: number }).time = 1;
    events().update(1 / 60);
    expect(fake.plays).toHaveLength(2);
    expect(Audio.debug().events[0].lateStarts).toBe(1);
    expect(events().lateStartTotal).toBe(1);
  });

  it("a known length chains on time and counts nothing", async () => {
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1);
    fake.horizonTime = 0;
    await boot({ "c.audioevent.json": { format: F, root: { type: "random", mode: "continuous", avoidRepeat: 0, children: [clip("a.wav"), clip("b.wav")] } } });
    Audio.play("c.audioevent.json");
    (fake as { time: number }).time = 0.9;
    events().update(1 / 60);
    expect(fake.plays).toHaveLength(2);
    expect(events().lateStartTotal).toBe(0);
  });
});
