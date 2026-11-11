import { beforeEach, describe, expect, it } from "vitest";
import { Assets, Camera, Engine, GameObject, SceneManager, Vector3 } from "../index";
import { Audio, AudioListener, AudioSource } from "../../plugins/audio/runtime";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { makeFakeBackend, type FakeBackend } from "../../plugins/audio/runtime/testing";

// The fake backend records what the engine tells it, not what it plays: positions, attenuation, pitch and listener poses.
let backend: FakeBackend;
let engine: Engine;
beforeEach(async () => {
  backend = makeFakeBackend();
  setAudioBackend(backend);
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "boom.wav": "data:audio/wav;base64,AAAA" }));
  engine = await Engine.create({ headless: true, project: {} });
  await SceneManager.load("s.json");
});

/** Give the World the view, the way a backend would: only that World plays sound. */
const giveView = () => {
  engine.world.render = {} as never;
};

describe("spatial audio (ADR 0074)", () => {
  it("has the documented defaults", () => {
    const s = new AudioSource();
    expect([s.spatial, s.minDistance, s.maxDistance, s.rolloff, s.pitch]).toEqual([false, 1, 100, "inverse", 1]);
  });

  it("is silent in a World without the view", () => {
    const n = GameObject.create("n");
    n.addBehavior(AudioSource, { clip: "boom.wav" });
    Audio.playOneShot("boom.wav");
    engine.step(1 / 60);
    expect(backend.plays).toHaveLength(0);
    expect(backend.listeners).toHaveLength(0);
  });

  it("plays a flat source without positioning it", () => {
    giveView();
    const n = GameObject.create("n");
    n.addBehavior(AudioSource, { clip: "boom.wav", volume: 0.5, pitch: 1.5 });
    engine.step(1 / 60);
    expect(backend.voices).toHaveLength(1);
    expect(backend.voices[0].pitch).toBe(1.5);
    expect(backend.voices[0].position).toBeNull();
    expect(backend.voices[0].attenuation).toBeNull();
  });

  it("places a spatial source at its node, with the rolloff settings, and follows the node", () => {
    giveView();
    const n = GameObject.create("n");
    n.transform!.position.set(4, 5, 6);
    n.addBehavior(AudioSource, { clip: "boom.wav", spatial: true, minDistance: 2, maxDistance: 50, rolloff: "linear", loop: true });
    engine.step(1 / 60);
    const voice = backend.voices[0];
    expect(voice.position).toEqual({ x: 4, y: 5, z: 6 });
    expect(voice.attenuation).toEqual({ minDistance: 2, maxDistance: 50, rolloff: "linear" });
    n.transform!.position.set(-1, 0, 9);
    engine.step(1 / 60);
    expect(voice.position).toEqual({ x: -1, y: 0, z: 9 });
    // unchanged settings aren't re-sent
    expect(voice.events.filter((e) => e.kind === "attenuation")).toHaveLength(1);
  });

  it("sets the listener from an AudioListener: position, forward is +Z, up is +Y", () => {
    giveView();
    const n = GameObject.create("ears");
    n.transform!.position.set(1, 2, 3);
    n.transform!.eulerAngles = [0, Math.PI / 2, 0]; // turned right (ADR 0164): +Z becomes +X
    n.addBehavior(AudioListener);
    engine.step(1 / 60);
    const pose = backend.listener!;
    expect(pose.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(pose.forward.x).toBeCloseTo(1);
    expect(pose.forward.y).toBeCloseTo(0);
    expect(pose.forward.z).toBeCloseTo(0);
    expect(pose.up.x).toBeCloseTo(0);
    expect(pose.up.y).toBeCloseTo(1);
    expect(pose.up.z).toBeCloseTo(0);
  });

  it("falls back to the main camera, and prefers an AudioListener over it", () => {
    giveView();
    const cam = GameObject.create("cam");
    cam.transform!.position.set(0, 0, 10);
    cam.addBehavior(Camera);
    engine.step(1 / 60);
    expect(backend.listener!.position).toEqual({ x: 0, y: 0, z: 10 });
    const ears = GameObject.create("ears");
    ears.transform!.position.set(7, 0, 0);
    ears.addBehavior(AudioListener);
    engine.step(1 / 60);
    expect(backend.listener!.position).toEqual({ x: 7, y: 0, z: 0 });
  });

  it("uses the first enabled AudioListener", () => {
    giveView();
    const a = GameObject.create("a");
    a.transform!.position.set(1, 0, 0);
    const first = a.addBehavior(AudioListener);
    const b = GameObject.create("b");
    b.transform!.position.set(2, 0, 0);
    b.addBehavior(AudioListener);
    engine.step(1 / 60);
    expect(backend.listener!.position).toEqual({ x: 1, y: 0, z: 0 });
    first.enabled = false;
    engine.step(1 / 60);
    expect(backend.listener!.position).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("plays one-shots flat, with a volume number, or spatially at a position", () => {
    giveView();
    Audio.playOneShot("boom.wav", 0.4);
    expect(backend.voices[0].volume).toBe(0.4);
    expect(backend.voices[0].position).toBeNull();
    expect(backend.voices[0].attenuation).toBeNull();
    Audio.playOneShot("boom.wav", { volume: 0.8, pitch: 0.5, position: new Vector3(3, 2, 1), minDistance: 4, maxDistance: 40 });
    const spatial = backend.voices[1];
    expect(spatial.volume).toBe(0.8);
    expect(spatial.pitch).toBe(0.5);
    expect(spatial.position).toEqual({ x: 3, y: 2, z: 1 });
    expect(spatial.attenuation).toEqual({ minDistance: 4, maxDistance: 40, rolloff: "inverse" });
  });
});
