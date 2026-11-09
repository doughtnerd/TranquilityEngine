import { beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { Audio, AudioSource } from "../../plugins/audio/runtime";
import { setAudioBackend, type AudioBackend, type AudioVoice, type PlayRequest } from "../../plugins/audio/runtime/backend";
import { mixer } from "../audio/mixer";

const plays: PlayRequest[] = [];
const events: string[] = [];
const voice = (): AudioVoice => ({
  playing: true,
  setVolume: (v) => events.push(`volume:${v}`), setPitch() {}, setAttenuation() {}, setPosition() {},
  setBus: (b) => events.push(`bus:${b}`), pause() {}, resume() {}, stop() { events.push("stop"); },
});
const fake: AudioBackend = {
  name: "fake",
  play: (r) => { plays.push(r); mixer.voiceStarted(r.bus); return voice(); },
  setListener() {}, applyMix() {}, configureBuses() {}, masterVolume: 1, muted: false,
};

let engine: Engine;
beforeEach(async () => {
  plays.length = 0; events.length = 0;
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
    expect(plays.at(-1)).toMatchObject({ path: "a.wav", bus: "Music" });
    src.output = "Gone";
    src.play();
    expect(plays.at(-1)!.bus).toBe("Master");
  });
  it("playOneShot takes a bus; the mixer API is exposed", () => {
    Audio.playOneShot("asset:a.wav", { bus: "Music", volume: 0.5 });
    expect(plays.at(-1)!.bus).toBe("Music");
    expect(events).toContain("volume:0.5");
    Audio.bus("Music").volume = 0.25;
    expect(Audio.bus("Music").effectiveGain).toBeCloseTo(0.25);
    expect(Audio.buses).toEqual(["Master", "Music"]);
  });
  it("changing output while playing moves the voice", () => {
    const src = GameObject.create("b").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false });
    src.play();
    events.length = 0;
    src.output = "Music";
    src._sync();
    expect(events).toContain("bus:Music");
  });
});
