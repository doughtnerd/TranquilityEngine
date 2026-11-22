// ADR 0333: a playlist's attenuation curves at runtime — volume, low-pass and reverb send per voice by listener distance,
// AudioSource distance overrides that stretch the curves, and the inverse law kept without a volume curve. Through the
// public API on the fake backend.
import { describe, expect, it } from "vitest";
import { Audio, AudioSource } from "../index";
import { eventKit, pla, sample } from "./testKit";
import { GameObject } from "../../../../myco";

const kit = eventKit();
const fake = kit.fake;

/** A scene with an AudioListener at the origin. */
const withListener = { "s.json": { format: "myco.scene@1", nodes: [{ id: "ear", components: [{ type: "engine.Transform", data: {} }, { type: "engine.AudioListener", data: {} }] }] } };

const curves = {
  minDistance: 2,
  maxDistance: 40,
  curves: { volume: [[0, 0], [2, 0], [40, -40]], lowpass: [[0, 20000], [40, 2000]], reverbSend: [[0, 0], [40, -6]] },
};
const dbGain = (db: number) => Math.pow(10, db / 20);

describe("attenuation curves", () => {
  it("volume and low-pass follow the curves at the listener's distance, at play and as the instance moves", async () => {
    await kit.boot({ ...withListener, "v.playlist.json": pla("clip", [sample("a.wav")], { playback: { plays: "untilStopped" }, spatial: { attenuation: curves } }) });
    kit.frame();
    const h = Audio.play("v.playlist.json", { position: { x: 21, y: 0, z: 0 } });
    const req = fake.plays[0]!;
    // The voice's own distance law adds nothing; the curve's -20 dB at 21 m is its volume.
    expect(req.attenuation).toEqual({ minDistance: 100000, maxDistance: 100000, rolloff: "inverse" });
    expect(req.volume).toBeCloseTo(dbGain(-20), 6);
    expect(req.filter?.lowpass).toBeCloseTo(20000 - 18000 * (21 / 40), 3);
    h.position = { x: 0, y: 0, z: 40 };
    kit.frame();
    const v = fake.voices[0]!;
    expect(v.volume).toBeCloseTo(dbGain(-40), 6);
    expect(v.events).toContainEqual(expect.objectContaining({ kind: "paramsShaped", lowpassHz: 2000 }));
    h.position = { x: 0, y: 1, z: 0 }; // inside Min: full level
    kit.frame();
    expect(v.volume).toBeCloseTo(1, 6);
    h.position = { x: 500, y: 0, z: 0 }; // beyond the last key the value holds
    kit.frame();
    expect(v.volume).toBeCloseTo(dbGain(-40), 6);
  });

  it("the reverb send follows its curve and stays independent of the volume curve", async () => {
    await kit.boot({
      ...withListener,
      "r.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: { minDistance: 0, maxDistance: 40, curves: { volume: [[0, 0], [40, -6]], reverbSend: [[0, 0], [40, -12]] } } } }),
    });
    kit.frame();
    const h = Audio.play("r.playlist.json", { position: { x: 20, y: 0, z: 0 } });
    const req = fake.plays[0]!;
    // -6 dB of send over -3 dB of dry: the voice's send level is -3 dB, so dry × send = -6 dB.
    expect(req.reverbSend).toBeCloseTo(dbGain(-6) / dbGain(-3), 4);
    expect(req.reverbSendCurve).toEqual([[0, 1], [1, 1]]);
    h.position = { x: 40, y: 0, z: 0 };
    kit.frame();
    expect(fake.voices[0]!.events).toContainEqual({ kind: "spatialOptions", options: { reverbSend: expect.closeTo(dbGain(-12) / dbGain(-6), 4) } });
  });

  it("the source's reverbSend scales the curve's send", async () => {
    await kit.boot({ ...withListener, "r.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: { minDistance: 0, maxDistance: 10, curves: { reverbSend: [[0, -6], [10, -6]] } } } }) });
    kit.frame();
    Audio.play("r.playlist.json", { position: { x: 5, y: 0, z: 0 }, reverbSend: 0.5 });
    expect(fake.plays[0]!.reverbSend).toBeCloseTo(0.5 * dbGain(-6), 4);
  });

  it("Audio.play's minDistance and maxDistance options stretch the curves the same way", async () => {
    await kit.boot({ ...withListener, "v.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: curves } }) });
    kit.frame();
    Audio.play("v.playlist.json", { position: { x: 41, y: 0, z: 0 }, maxDistance: 80 }); // halfway between Min 2 and Max 80
    expect(fake.plays[0]!.volume).toBeCloseTo(dbGain(-20), 6);
    Audio.play("v.playlist.json", { position: { x: 15, y: 0, z: 0 }, minDistance: 10, maxDistance: 20 });
    expect(fake.plays[1]!.volume).toBeCloseTo(dbGain(-20), 6);
  });

  it("AudioSource minDistance and maxDistance stretch the curves; defaults leave them", async () => {
    await kit.boot({ ...withListener, "v.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: curves } }) });
    kit.frame();
    const near = GameObject.create("near").addBehavior(AudioSource, { clip: "v.playlist.json", playOnAwake: false });
    near.node.transform!.position.set(21, 0, 0);
    near.play();
    expect(fake.plays[0]!.volume).toBeCloseTo(dbGain(-20), 6);
    expect(fake.plays[0]!.owner).toBe("near");
    const far = GameObject.create("far").addBehavior(AudioSource, { clip: "v.playlist.json", playOnAwake: false, maxDistance: 80 });
    far.node.transform!.position.set(41, 0, 0); // halfway between Min 2 and the stretched Max 80
    far.play();
    expect(fake.plays[1]!.volume).toBeCloseTo(dbGain(-20), 6);
    const both = GameObject.create("both").addBehavior(AudioSource, { clip: "v.playlist.json", playOnAwake: false, minDistance: 10, maxDistance: 20 });
    both.node.transform!.position.set(15, 0, 0);
    both.play();
    expect(fake.plays[2]!.volume).toBeCloseTo(dbGain(-20), 6);
  });

  it("without a volume curve the voice keeps the inverse law between the attenuation's distances", async () => {
    await kit.boot({ ...withListener, "i.playlist.json": pla("clip", [sample("a.wav")], { spatial: { attenuation: { minDistance: 3, maxDistance: 9, curves: { lowpass: [[0, 8000], [9, 1000]] } } } }) });
    kit.frame();
    Audio.play("i.playlist.json", { position: { x: 9, y: 0, z: 0 } });
    expect(fake.plays[0]).toMatchObject({ attenuation: { minDistance: 3, maxDistance: 9, rolloff: "inverse" }, volume: 1, filter: { lowpass: 1000 } });
  });

  it("plain clips keep the legacy rolloff", async () => {
    await kit.boot(withListener);
    Audio.playOneShot("a.wav", { position: { x: 5, y: 0, z: 0 }, minDistance: 2, maxDistance: 30 });
    expect(fake.plays[0]!.attenuation).toEqual({ minDistance: 2, maxDistance: 30, rolloff: "inverse" });
    const src = GameObject.create("c").addBehavior(AudioSource, { clip: "a.wav", playOnAwake: false, spatial: true, rolloff: "linear" });
    src.play();
    expect(fake.plays[1]!.attenuation).toEqual({ minDistance: 1, maxDistance: 100, rolloff: "linear" });
  });
});
