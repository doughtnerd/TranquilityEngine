import { beforeEach, describe, expect, it, vi } from "vitest";

// Howler is mocked: these tests check what the engine tells it, not what it plays.
const calls = vi.hoisted(() => ({ list: [] as { target: string; method: string; args: unknown[] }[], nextId: 1 }));
vi.mock("howler", () => {
  class Howl {
    constructor(public opts: Record<string, unknown>) {}
    play(id?: number) {
      if (id !== undefined) return id;
      const n = calls.nextId++;
      calls.list.push({ target: "howl", method: "play", args: [n] });
      return n;
    }
    playing() { return true; }
    pause() {}
    stop(id: number) { calls.list.push({ target: "howl", method: "stop", args: [id] }); }
    volume(...a: unknown[]) { calls.list.push({ target: "howl", method: "volume", args: a }); }
    rate(...a: unknown[]) { calls.list.push({ target: "howl", method: "rate", args: a }); }
    pos(...a: unknown[]) { calls.list.push({ target: "howl", method: "pos", args: a }); }
    pannerAttr(...a: unknown[]) { calls.list.push({ target: "howl", method: "pannerAttr", args: a }); }
  }
  const Howler = {
    pos: (...a: unknown[]) => calls.list.push({ target: "howler", method: "pos", args: a }),
    orientation: (...a: unknown[]) => calls.list.push({ target: "howler", method: "orientation", args: a }),
    volume: () => 1,
    mute: () => {},
  };
  return { Howl, Howler };
});

import { Assets, Audio, AudioListener, AudioSource, Camera, Engine, GameObject, SceneManager, Vector3 } from "../index";

const of = (method: string, target = "howl") => calls.list.filter((c) => c.target === target && c.method === method);

let engine: Engine;
beforeEach(async () => {
  calls.list.length = 0;
  calls.nextId = 1;
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
    expect(of("play")).toHaveLength(0);
    expect(of("pos", "howler")).toHaveLength(0);
  });

  it("plays a flat source without positioning it", () => {
    giveView();
    const n = GameObject.create("n");
    n.addBehavior(AudioSource, { clip: "boom.wav", volume: 0.5, pitch: 1.5 });
    engine.step(1 / 60);
    expect(of("play")).toHaveLength(1);
    expect(of("rate")[0].args).toEqual([1.5, 1]);
    expect(of("pos")).toHaveLength(0);
    expect(of("pannerAttr")).toHaveLength(0);
  });

  it("places a spatial source at its node, with the rolloff settings, and follows the node", () => {
    giveView();
    const n = GameObject.create("n");
    n.transform!.position.set(4, 5, 6);
    n.addBehavior(AudioSource, { clip: "boom.wav", spatial: true, minDistance: 2, maxDistance: 50, rolloff: "linear", loop: true });
    engine.step(1 / 60);
    expect(of("pos").at(-1)!.args).toEqual([4, 5, 6, 1]);
    expect(of("pannerAttr")).toHaveLength(1);
    expect(of("pannerAttr")[0].args).toEqual([expect.objectContaining({ distanceModel: "linear", refDistance: 2, maxDistance: 50, rolloffFactor: 1 }), 1]);
    n.transform!.position.set(-1, 0, 9);
    engine.step(1 / 60);
    expect(of("pos").at(-1)!.args).toEqual([-1, 0, 9, 1]);
    expect(of("pannerAttr")).toHaveLength(1); // unchanged settings aren't re-sent
  });

  it("sets the listener from an AudioListener: position, forward is -Z, up is +Y", () => {
    giveView();
    const n = GameObject.create("ears");
    n.transform!.position.set(1, 2, 3);
    n.transform!.eulerAngles = [0, 90, 0]; // turned left: -Z becomes -X
    n.addBehavior(AudioListener);
    engine.step(1 / 60);
    expect(of("pos", "howler").at(-1)!.args).toEqual([1, 2, 3]);
    const o = of("orientation", "howler").at(-1)!.args as number[];
    expect(o[0]).toBeCloseTo(-1);
    expect(o[1]).toBeCloseTo(0);
    expect(o[2]).toBeCloseTo(0);
    expect(o[3]).toBeCloseTo(0);
    expect(o[4]).toBeCloseTo(1);
    expect(o[5]).toBeCloseTo(0);
  });

  it("falls back to the main camera, and prefers an AudioListener over it", () => {
    giveView();
    const cam = GameObject.create("cam");
    cam.transform!.position.set(0, 0, 10);
    cam.addBehavior(Camera);
    engine.step(1 / 60);
    expect(of("pos", "howler").at(-1)!.args).toEqual([0, 0, 10]);
    const ears = GameObject.create("ears");
    ears.transform!.position.set(7, 0, 0);
    ears.addBehavior(AudioListener);
    engine.step(1 / 60);
    expect(of("pos", "howler").at(-1)!.args).toEqual([7, 0, 0]);
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
    expect(of("pos", "howler").at(-1)!.args).toEqual([1, 0, 0]);
    first.enabled = false;
    engine.step(1 / 60);
    expect(of("pos", "howler").at(-1)!.args).toEqual([2, 0, 0]);
  });

  it("plays one-shots flat, with a volume number, or spatially at a position", () => {
    giveView();
    Audio.playOneShot("boom.wav", 0.4);
    expect(of("volume").at(-1)!.args).toEqual([0.4, 1]);
    expect(of("pos")).toHaveLength(0);
    Audio.playOneShot("boom.wav", { volume: 0.8, pitch: 0.5, position: new Vector3(3, 2, 1), minDistance: 4, maxDistance: 40 });
    expect(of("volume").at(-1)!.args).toEqual([0.8, 2]);
    expect(of("rate").at(-1)!.args).toEqual([0.5, 2]);
    expect(of("pos").at(-1)!.args).toEqual([3, 2, 1, 2]);
    expect(of("pannerAttr").at(-1)!.args).toEqual([expect.objectContaining({ refDistance: 4, maxDistance: 40 }), 2]);
  });
});
