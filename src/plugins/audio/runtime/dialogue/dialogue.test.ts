// ADR 0341 §2–§5: dynamic dialogue through the public `Audio.say`, `Audio.dialogue` and `AudioSpeaker` on the fake
// backend: best match, speaker channels and `maxVoices`, priority and interruption (with its fade and `onInterrupted`),
// the queue (decided at start, `maxWait`, the cap), event cooldown and chance, line `once`, and the memory round trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Audio, AudioSpeaker, Engine, GameObject, SceneManager, type AudioLineEvent, type DialogueMemory } from "../../../../myco";
import type { ProjectSettingsInput } from "../../../../engine";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend, type FakeVoice } from "../testing";

const fake = makeFakeBackend();
let engine: Engine | null = null;
const WAV = "data:,";

const KEYS = ["guard_near", "guard_any", "generic", "chat_01", "alarm_01", "cool_01", "once_01", "ouch_01", "bark_01", "bark_02"];
const SPEAKER: Record<string, string> = { guard_near: "Guard", guard_any: "Guard", generic: "Guard", chat_01: "Ava", alarm_01: "Ava", ouch_01: "Ava", cool_01: "Bob", once_01: "Bob", bark_01: "Dog", bark_02: "Dog" };

const EVENTS = [
  {
    name: "spotted",
    arguments: [{ name: "speaker", labels: ["Guard", "Captain"] }, { name: "distance", labels: ["Near", "Far"], default: "Near" }],
    paths: [
      { path: ["Guard", "Near"], lines: [{ key: "guard_near" }] },
      { path: ["Guard", "*"], lines: [{ key: "guard_any" }] },
      { path: ["Captain", "Far"], lines: [] },
      { path: ["*", "*"], lines: [{ key: "generic" }] },
    ],
    whenBusy: "drop", interrupt: "never", avoidRepeat: 0,
  },
  { name: "chat", arguments: [], paths: [{ path: [], lines: [{ key: "chat_01" }] }], priority: 20, whenBusy: "queue", interrupt: "never", maxWait: 2, onInterrupted: "ouch" },
  { name: "alarm", arguments: [], paths: [{ path: [], lines: [{ key: "alarm_01" }] }], priority: 80, whenBusy: "queue", interrupt: "lower" },
  { name: "ouch", arguments: [], paths: [{ path: [], lines: [{ key: "ouch_01" }] }], priority: 50, whenBusy: "queue", interrupt: "never", maxWait: 5 },
  { name: "cool", arguments: [], paths: [{ path: [], lines: [{ key: "cool_01" }] }], cooldown: 4 },
  { name: "onceonly", arguments: [], paths: [{ path: [], lines: [{ key: "once_01" }] }] },
  { name: "never", arguments: [], paths: [{ path: [], lines: [{ key: "bark_01" }] }], chance: 0 },
  { name: "bark", arguments: [], paths: [{ path: [], lines: [{ key: "bark_01" }, { key: "bark_02" }] }], whenBusy: "queue", interrupt: "never", maxWait: 10, priority: 10 },
];

function files(audioSettings: Record<string, unknown> = {}, scene: unknown[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "s.json": { format: "myco.scene@1", nodes: scene },
    "audio.json": { format: "myco.audio@1", localisation: { roots: ["vo"] }, settings: audioSettings },
    "audio/lines/index.json": { format: "myco.lineindex@1", tables: ["vo/all.lines.json"], dialogue: ["vo/events.dialogue.json"] },
    "vo/all.lines.json": { format: "myco.lines@1", lines: KEYS.map((key) => ({ key, speaker: SPEAKER[key], ...(key === "once_01" ? { once: true } : {}) })) },
    "vo/events.dialogue.json": { format: "myco.dialogue@1", events: EVENTS },
  };
  for (const k of KEYS) out[`vo/en/${k}.wav`] = WAV;
  return out;
}

async function boot(assets: Record<string, unknown> = files()): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(assets));
  // `project.json` as written (the languages section in its file form; the Engine parses it).
  const project = { audio: { buses: [{ name: "Master" }, { name: "Voice", parent: "Master" }], seed: 7 }, languages: { list: [{ code: "en", name: "English" }], useSystemLanguage: false } };
  engine = await Engine.create({ headless: true, project: project as ProjectSettingsInput });
  engine.world.render = {} as never;
  await SceneManager.load("s.json");
}

const frame = () => engine!.step(1 / 60);
const voiceOf = (key: string) => fake.voices.find((v) => v.request.path === `vo/en/${key}.wav` && !v.stopped) as FakeVoice | undefined;

beforeEach(() => {
  fake.clear();
  fake.ready = true;
  fake.advanceTo(0);
  setAudioBackend(fake);
  endAudioSession();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
  endAudioSession();
  setAudioBackend(null);
});

describe("Audio.say decides by best match", () => {
  it("prefers the path exact at the earliest arguments; defaults fill missing arguments; silence and unknown events refuse", async () => {
    await boot();
    const near = Audio.say("spotted", { args: { speaker: "Guard" } }); // distance: its default, Near
    expect(near.key).toBe("guard_near");
    expect(near.event).toBe("spotted");
    expect(near.path).toEqual(["Guard", "Near"]);
    expect(near.speaker).toBe("Guard");
    near.stop(0);
    expect(Audio.say("spotted", { args: { speaker: "Guard", distance: "Far" } }).key).toBe("guard_any");
    Audio.dialogue.stop();
    expect(Audio.say("spotted", { args: { speaker: "Captain" } }).key).toBe("generic");
    Audio.dialogue.stop();
    const silent = Audio.say("spotted", { args: { speaker: "Captain", distance: "Far" } });
    expect(silent.reason).toBe("silence");
    await expect(silent.finished).resolves.toBe("refused");
    const unknown = Audio.say("nobody");
    expect(unknown.reason).toBe("unknownEvent");
    expect(unknown.playing).toBe(false);
  });
});

describe("speaker channels", () => {
  it("a channel speaks one line at a time (drop refuses busy); other channels speak at once", async () => {
    await boot();
    const a = Audio.say("spotted", { args: { speaker: "Guard" } });
    expect(Audio.dialogue.speaking("Guard")).toBe(true);
    const b = Audio.say("spotted", { args: { speaker: "Guard" } });
    expect(b.reason).toBe("busy");
    const c = Audio.say("chat"); // channel Ava
    expect(c.state).toBe("playing");
    expect(a.state).toBe("playing");
    expect(Audio.debug().dialogue.refusals.busy).toBe(1);
    expect(Audio.debug().dialogue.channels.map((ch) => [ch.channel, ch.speaking])).toEqual([["Guard", "guard_near"], ["Ava", "chat_01"]]);
  });

  it("options.channel overrides the speaker; maxVoices caps lines across channels", async () => {
    await boot(files({ dialogue: { maxVoices: 2 } }));
    Audio.say("chat", { channel: "one" });
    Audio.say("chat", { channel: "two" });
    const third = Audio.say("spotted", { args: { speaker: "Guard" } }); // drop, and the speaking lines aren't lower than it may cut
    expect(third.reason).toBe("busy");
    expect(Audio.dialogue.speaking("one")).toBe(true);
    expect(Audio.dialogue.speaking("Ava")).toBe(false);
  });
});

describe("priority and interruption", () => {
  it("a higher-priority event with interrupt 'lower' cuts the speaking line with a 150 ms fade; its onInterrupted is said after", async () => {
    await boot();
    const events: AudioLineEvent[] = [];
    Audio.onLine((e) => events.push(e));
    const chat = Audio.say("chat");
    const chatVoice = voiceOf("chat_01")!;
    const alarm = Audio.say("alarm");
    expect(chatVoice.events.at(-1)).toEqual({ kind: "stop", fadeSeconds: 0.15 });
    await expect(chat.finished).resolves.toBe("interrupted");
    expect(alarm.state).toBe("playing");
    expect(events.filter((e) => e.phase === "end").map((e) => [e.key, e.reason])).toEqual([["chat_01", "interrupted"]]);
    // After the fade, "ouch" is said on the same channel: it waits for the alarm, then speaks.
    fake.advanceTo(0.2);
    frame();
    expect(Audio.debug().dialogue.channels[0]!.queue.map((q) => q.event)).toEqual(["ouch"]);
    voiceOf("alarm_01")!.end();
    frame();
    expect(events.filter((e) => e.phase === "start").map((e) => e.key)).toEqual(["chat_01", "alarm_01", "ouch_01"]);
  });

  it("interrupt 'never' queues instead; the queued say decides and starts when the channel frees", async () => {
    await boot();
    const alarm = Audio.say("alarm");
    const chat = Audio.say("chat");
    expect(chat.state).toBe("queued");
    expect(chat.playing).toBe(true);
    expect(alarm.state).toBe("playing");
    voiceOf("alarm_01")!.end();
    frame();
    expect(chat.state).toBe("playing");
    expect(chat.key).toBe("chat_01");
  });

  it("a queued say is dropped (busy) once it waited maxWait; the queue holds 4, the lowest priority dropped when full", async () => {
    await boot();
    Audio.say("alarm");
    const chat = Audio.say("chat"); // maxWait 2
    fake.advanceTo(2.5);
    frame();
    await expect(chat.finished).resolves.toBe("refused");
    expect(chat.reason).toBe("busy");
    Audio.dialogue.stop();
    Audio.say("bark", { channel: "Dog", priority: 90 });
    const queued = [10, 40, 30, 20].map((priority) => Audio.say("bark", { channel: "Dog", priority }));
    expect(queued.every((h) => h.state === "queued")).toBe(true);
    const fifth = Audio.say("bark", { channel: "Dog", priority: 50 });
    expect(fifth.state).toBe("queued");
    expect(queued[0]!.reason).toBe("busy"); // priority 10, the lowest, dropped
    expect(Audio.debug().dialogue.channels.find((c) => c.channel === "Dog")!.queue).toHaveLength(4);
  });

  it("Audio.dialogue.stop clears a channel's line and queue", async () => {
    await boot();
    const alarm = Audio.say("alarm");
    const chat = Audio.say("chat");
    Audio.dialogue.stop("Ava", 0);
    await expect(alarm.finished).resolves.toBe("stopped");
    await expect(chat.finished).resolves.toBe("stopped");
    expect(Audio.dialogue.speaking("Ava")).toBe(false);
  });
});

describe("cooldown, chance, once and memory", () => {
  it("an event's cooldown refuses within it; chance 0 always refuses; a once line is said once", async () => {
    await boot();
    expect(Audio.say("cool").state).toBe("playing");
    Audio.dialogue.stop();
    fake.advanceTo(1);
    expect(Audio.say("cool").reason).toBe("cooldown");
    fake.advanceTo(4.5);
    expect(Audio.say("cool").state).toBe("playing");
    expect(Audio.say("never").reason).toBe("chance");
    Audio.dialogue.stop();
    expect(Audio.say("onceonly").key).toBe("once_01");
    Audio.dialogue.stop();
    expect(Audio.say("onceonly").reason).toBe("unavailable");
  });

  it("memory() is plain JSON relative to now, and restore() brings cooldowns, histories and once-lines into a new session", async () => {
    await boot();
    Audio.say("cool");
    Audio.say("onceonly", { channel: "x" });
    fake.advanceTo(1);
    const saved: DialogueMemory = JSON.parse(JSON.stringify(Audio.dialogue.memory()));
    expect(saved.events.cool).toEqual({ since: 1, history: ["cool_01"] });
    expect(saved.once).toEqual(["once_01"]);
    expect(saved.lines.cool_01).toBe(1);
    engine!.dispose();
    endAudioSession();
    fake.clear();
    fake.advanceTo(10);
    await boot();
    expect(Audio.say("cool", { channel: "y" }).state).toBe("playing"); // a new session forgot it
    Audio.dialogue.stop();
    Audio.dialogue.restore(saved);
    expect(Audio.say("cool").reason).toBe("cooldown"); // 1 s since, in a 4 s cooldown
    expect(Audio.say("onceonly").reason).toBe("unavailable");
    expect(Audio.dialogue.memory().events.cool!.since).toBe(1);
  });
});

describe("AudioSpeaker", () => {
  it("places a said line at the speaker of its line, and says from its node with its speaker argument", async () => {
    await boot(files({}, [
      { id: "g", name: "Guard", components: [{ type: "engine.Transform", data: { position: [5, 0, 0] } }, { type: "engine.AudioSpeaker", data: { speaker: "Guard" } }] },
    ]));
    Audio.say("spotted", { args: { speaker: "Guard" } });
    expect(fake.plays.at(-1)!.position).toMatchObject({ x: 5, y: 0, z: 0 });
    Audio.dialogue.stop();
    const h = GameObject.findObjectOfType(AudioSpeaker)!.say("spotted");
    expect(h.key).toBe("guard_near"); // its speaker "Guard" filled the event's speaker argument
    expect(fake.plays.at(-1)!.position).toMatchObject({ x: 5, y: 0, z: 0 });
  });
});
