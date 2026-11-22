// ADR 0327: an audio-only Engine (the Audio Studio's runtime) draws nothing, yet its World plays sound as the World with
// the view does. Driven through the public API (`Engine.create`, `Audio.playOneShot`, `Audio.play`) on the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine } from "../../../myco";
import { setAudioBackend } from "./backend";
import { endAudioSession, makeFakeBackend } from "./testing";
import { Audio } from "./index";

const fake = makeFakeBackend();
let engine: Engine | null = null;

beforeEach(() => {
  fake.clear();
  fake.ready = true;
  setAudioBackend(fake);
  endAudioSession();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "a.wav": "data:audio/wav;base64,AAAA" }));
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  vi.restoreAllMocks();
  setAudioBackend(null);
});

describe("an audio-only World (ADR 0327)", () => {
  it("plays a one-shot with no view", async () => {
    engine = await Engine.create({ audioOnly: true, project: { audio: { buses: [{ name: "Master" }] } } });
    const h = Audio.playOneShot("asset:a.wav", 0.5);
    expect(h.playing).toBe(true);
    expect(fake.plays.at(-1)).toMatchObject({ path: "a.wav", volume: 0.5 });
  });

  it("still steps its audio system every frame", async () => {
    engine = await Engine.create({ audioOnly: true });
    Audio.playOneShot("asset:a.wav");
    expect(() => engine!.step(1 / 60)).not.toThrow();
    expect(fake.plays.length).toBe(1);
  });

  it("a headless Engine without the option stays silent (only the World with the view plays)", async () => {
    engine = await Engine.create({ headless: true });
    expect(Audio.playOneShot("asset:a.wav").playing).toBe(false);
    expect(fake.plays.length).toBe(0);
  });
});
