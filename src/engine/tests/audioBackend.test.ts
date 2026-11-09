import { beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { Audio, AudioSource } from "../../plugins/audio/runtime";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { makeFakeBackend } from "../../plugins/audio/runtime/testing";

const fake = makeFakeBackend();

let engine: Engine;
beforeEach(async () => {
  fake.clear();
  fake.ready = true;
  setAudioBackend(fake);
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:audio/wav;base64,AAAA" }));
  engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
});

describe("audio backend interface (ADR 0098)", () => {
  it("AudioSource plays on its output bus, falling back to Master", () => {
    const src = GameObject.create("a").addBehavior(AudioSource, { clip: "asset:a.wav", output: "Music", playOnAwake: false });
    src.play();
    expect(fake.plays.at(-1)).toMatchObject({ path: "a.wav", bus: "Music" });
    src.output = "Gone";
    src.play();
    expect(fake.plays.at(-1)!.bus).toBe("Master");
  });
  it("playOneShot takes a bus; the mixer API is exposed", () => {
    Audio.playOneShot("asset:a.wav", { bus: "Music", volume: 0.5 });
    expect(fake.plays.at(-1)!.bus).toBe("Music");
    expect(fake.voices.at(-1)!.events).toContainEqual({ kind: "volume", value: 0.5 });
    Audio.bus("Music").volume = 0.25;
    expect(Audio.bus("Music").effectiveGain).toBeCloseTo(0.25);
    expect(Audio.buses).toEqual(["Master", "Music"]);
  });
  it("changing output while playing moves the voice", () => {
    const src = GameObject.create("b").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false });
    src.play();
    const voice = fake.voices.at(-1)!;
    src.output = "Music";
    src._sync();
    expect(voice.events).toContainEqual({ kind: "bus", value: "Music" });
    expect(voice.bus).toBe("Music");
  });
  it("a voice's end() lowers its bus's voice count", () => {
    const music = Audio.bus("Music");
    const before = music.activeVoices;
    Audio.playOneShot("asset:a.wav", { bus: "Music" });
    Audio.playOneShot("asset:a.wav", { bus: "Music" });
    expect(music.activeVoices).toBe(before + 2);
    fake.voices[0].end();
    expect(music.activeVoices).toBe(before + 1);
  });
  it("when the backend is not ready, AudioSource.play starts nothing and does not throw", () => {
    fake.ready = false;
    const src = GameObject.create("c").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false });
    expect(() => src.play()).not.toThrow();
    expect(fake.plays).toHaveLength(1);
    expect(fake.voices).toHaveLength(0);
  });
});
