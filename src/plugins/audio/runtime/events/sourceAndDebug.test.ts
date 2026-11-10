// ADR 0158 E3.5c: AudioSource with an event asset, Audio.debug().events rows, voices[].event, lateStarts.
import { describe, expect, it } from "vitest";
import { GameObject } from "../../../../myco";
import { AudioSource } from "../AudioSource";
import { Audio } from "../index";
import { events } from "./eventRuntime";
import { clip, eventKit, ev, F } from "./eventTestKit";

const kit = eventKit();
const fake = kit.fake;

/** A source on a fresh node, set up to play `clip` when told to. */
const source = (path: string, extra: Record<string, unknown> = {}) =>
  GameObject.create("n").addBehavior(AudioSource, { clip: path, playOnAwake: false, ...extra });

describe("AudioSource with an event asset", () => {
  it("plays the event as an instance that follows the node", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav"), { spatial: { minDistance: 1, maxDistance: 30, rolloff: "inverse" } }) });
    const go = GameObject.create("n");
    const transform = go.transform!;
    transform.position = { x: 1, y: 2, z: 3 };
    const src = go.addBehavior(AudioSource, { clip: "e.audioevent.json", playOnAwake: false });
    src.play();
    expect(src.isPlaying).toBe(true);
    expect(Audio.debug().events).toHaveLength(1);
    expect(fake.plays).toHaveLength(1);
    expect(fake.voices[0].attenuation).toEqual({ minDistance: 1, maxDistance: 30, rolloff: "inverse" });
    expect(fake.voices[0].position).toEqual({ x: 1, y: 2, z: 3 });
    // Moving the node reaches the instance's voice on the next sync (the audio system calls _sync each frame).
    transform.position = { x: 4, y: 5, z: 6 };
    src._sync();
    expect(fake.voices[0].position).toEqual({ x: 4, y: 5, z: 6 });
    expect(fake.voices[0].events.filter((e) => e.kind === "position").at(-1)).toEqual({ kind: "position", value: { x: 4, y: 5, z: 6 } });
  });

  it("setParameter, getParameter and release reach the instance", async () => {
    await kit.boot({
      "e.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }], root: { type: "clip", clip: "a.wav", sustain: true } },
    });
    const src = source("e.audioevent.json");
    src.play();
    const voice = fake.voices[0];
    expect(src.getParameter("Speed")).toBe(0);
    src.setParameter("Speed", 4);
    expect(src.getParameter("Speed")).toBe(4);
    expect(Audio.debug().events[0].parameters).toEqual({ Speed: 4 });
    // A sustain clip loops until release.
    expect(voice.events.filter((e) => e.kind === "loop").at(-1)).toEqual({ kind: "loop", start: 0, end: 0, looping: true });
    src.release();
    expect(voice.events.filter((e) => e.kind === "loop").at(-1)).toEqual({ kind: "loop", start: 0, end: 0, looping: false });
    // Once stopped there is no instance: the parameter reads undefined and release does nothing.
    src.stop();
    expect(src.getParameter("Speed")).toBeUndefined();
    expect(() => src.release()).not.toThrow();
    expect(Audio.debug().events).toEqual([]);
  });

  it("volume is applied as the instance's fade", async () => {
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) });
    const src = source("e.audioevent.json");
    src.play();
    const voice = fake.voices[0];
    const volumeEvents = voice.events.filter((e) => e.kind === "volume").length;
    src.volume = 0.5;
    src._sync();
    expect(voice.events.at(-1)).toEqual({ kind: "fade", to: 0.5, seconds: 0 });
    // The voice's own gain is not set: the fade carries it.
    expect(voice.events.filter((e) => e.kind === "volume")).toHaveLength(volumeEvents);
    // A sync with no change adds nothing.
    const count = voice.events.length;
    src._sync();
    expect(voice.events).toHaveLength(count);
  });

  it("pitch changes reach every voice of a playing layer live", async () => {
    // rough.test.ts covers one voice; a layer of two clips checks that the change goes to all of them.
    await kit.boot({ "l.audioevent.json": ev({ type: "layer", children: [clip("a.wav"), clip("b.wav")] }) });
    const src = source("l.audioevent.json", { pitch: 1 });
    src.play();
    expect(fake.voices).toHaveLength(2);
    src.pitch = 0.5;
    src._sync();
    for (const v of fake.voices) expect(v.pitch).toBeCloseTo(0.5);
    // A later play starts at the new pitch.
    src.stop();
    src.play();
    expect(fake.voices.at(-1)!.pitch).toBeCloseTo(0.5);
  });
});

describe("Audio.debug()", () => {
  it("events rows carry id, asset, world, voices, parameters", async () => {
    await kit.boot({
      "p.audioevent.json": { format: F, parameters: [{ name: "Speed", min: 0, max: 10, default: 0 }], root: { type: "layer", children: [clip("a.wav"), clip("b.wav")] } },
    });
    const h = Audio.play("p.audioevent.json", { parameters: { Speed: 3 } });
    expect(h.playing).toBe(true);
    const rows = Audio.debug().events;
    expect(rows).toEqual([{ id: expect.any(Number), asset: "p.audioevent.json", world: expect.any(Number), voices: 2, parameters: { Speed: 3 }, lateStarts: 0 }]);
    expect(rows[0].id).toBeGreaterThan(0);
    // Voices that end leave the count; a row goes once its instance has no playing voice.
    fake.voices[0].end();
    expect(Audio.debug().events[0].voices).toBe(1);
    fake.voices[1].end();
    expect(Audio.debug().events).toEqual([]);
  });

  it("voices[].event names the instance id (null for plain clips)", async () => {
    // Not verifiable on the fake: `fake.debug().voices` is always [], so `voices[].event` can't be read here (testing.ts is read only).
    // This checks the link the runtime sets it from: the voice request carries the instance's group, which is the row id.
    await kit.boot({ "e.audioevent.json": ev(clip("a.wav")) });
    Audio.play("e.audioevent.json");
    const id = Audio.debug().events[0].id;
    Audio.playOneShot("a.wav");
    expect(fake.plays[0].group).toBe(id);
    expect(fake.plays[1].group ?? null).toBeNull();
  });

  it("lateStarts counts per instance", async () => {
    await kit.boot({ "c.audioevent.json": { format: F, root: { type: "random", mode: "continuous", avoidRepeat: 0, children: [clip("a.wav"), clip("b.wav")] } } });
    Audio.play("c.audioevent.json");
    Audio.play("c.audioevent.json");
    const [first, second] = Audio.debug().events.map((r) => r.id);
    const rowOf = (id: number) => Audio.debug().events.find((r) => r.id === id)!;
    const voiceOf = (id: number) => fake.voices.find((v) => v.request.group === id && v.playing)!;
    expect(rowOf(first).lateStarts).toBe(0);
    expect(rowOf(second).lateStarts).toBe(0);

    // The first instance's clip ends: its next clip starts a frame late, and only that instance counts it.
    voiceOf(first).end();
    kit.setTime(1);
    events().update(1 / 60);
    expect(rowOf(first).lateStarts).toBe(1);
    expect(rowOf(second).lateStarts).toBe(0);
    expect(events().lateStartTotal).toBe(1);

    // Then the second instance's clip ends: the count is per instance, the total adds up.
    voiceOf(second).end();
    kit.setTime(2);
    events().update(1 / 60);
    expect(rowOf(first).lateStarts).toBe(1);
    expect(rowOf(second).lateStarts).toBe(1);
    expect(events().lateStartTotal).toBe(2);
  });
});
