// ADR 0333: AudioZone through the public API on the fake backend — an edge zone heard from its nearest point (rotated
// boxes and heights too) and around the listener inside, an inside zone's feather, `zoneDepth`, samples, and stopping.
import { describe, expect, it } from "vitest";
import { Audio, AudioZone } from "./index";
import { eventKit, pla, sample } from "./playlists/testKit";
import { GameObject } from "../../../myco";

const kit = eventKit();
const fake = kit.fake;

/** A scene with an AudioListener node "ear" at the origin. */
const withListener = { "s.json": { format: "myco.scene@1", nodes: [{ id: "ear", name: "ear", components: [{ type: "engine.Transform", data: { position: [0, 1, 0] } }, { type: "engine.AudioListener", data: {} }] }] } };
const rain = pla("clip", [sample("a.wav")], { playback: { plays: "untilStopped" }, spatial: { attenuation: null } });
const flat = pla("clip", [sample("a.wav")], { playback: { plays: "untilStopped" } });
const dbGain = (db: number) => Math.pow(10, db / 20);

function zone(at: [number, number, number], fields: Partial<Pick<AudioZone, "sound" | "heard" | "feather" | "volume" | "width" | "depth" | "yaw" | "bottom" | "top">>): AudioZone {
  const z = GameObject.create("zone").addBehavior(AudioZone, fields);
  z.node.transform!.position.set(...at);
  return z;
}

const depthOf = () => Audio.debug().events?.find((e) => e.asset.endsWith(".playlist.json"))?.parameters.zoneDepth;

describe("AudioZone", () => {
  it("edge zone, outside: plays from the box's nearest point, its spread narrowing with distance", async () => {
    await kit.boot({ ...withListener, "rain.playlist.json": rain });
    const z = zone([20, 0, 0], { sound: "rain.playlist.json", width: 10, depth: 10, bottom: 0, top: 10 });
    kit.frame();
    expect(fake.plays).toHaveLength(1);
    expect(fake.plays[0]!.owner).toBe("zone");
    expect(fake.voices[0]!.position).toEqual({ x: 15, y: 1, z: 0 });
    expect(z.distance).toBeCloseTo(15, 6);
    expect(z.spread).toBeCloseTo(40 + 600 / 15, 6);
    expect(depthOf()).toBe(0);
    z.node.transform!.position.set(200, 0, 0);
    kit.frame();
    expect(z.spread).toBeCloseTo(40 + 600 / 195, 6);
    z.node.transform!.position.set(7, 0, 0); // 2 m away: at most 180°
    kit.frame();
    expect(z.spread).toBe(180);
  });

  it("a turned box and its height: the nearest point follows yaw, bottom and top", async () => {
    await kit.boot({ ...withListener, "rain.playlist.json": rain });
    // 20 m long along local x, 2 m deep; turned 90° right its length lies along world -z..+z; from 4 m up to 8 m.
    zone([5, 0, 0], { sound: "rain.playlist.json", width: 20, depth: 2, yaw: 90, bottom: 4, top: 8 });
    kit.frame();
    const p = fake.voices[0]!.position!;
    expect(p.x).toBeCloseTo(4, 6);
    expect(p.y).toBeCloseTo(4, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it("the node's turn turns the box and its centre offset: a right turn takes local +x to world -z (ADR 0164)", async () => {
    await kit.boot({ ...withListener, "rain.playlist.json": rain });
    const z = zone([0, 0, 0], { sound: "rain.playlist.json", width: 2, depth: 2 });
    z.center.set(10, 0, 0);
    z.node.transform!.eulerAngles = [0, Math.PI / 2, 0];
    kit.frame();
    const p = fake.voices[0]!.position!;
    expect(p.x).toBeCloseTo(0, 4);
    expect(p.z).toBeCloseTo(-9, 4);
  });

  it("edge zone, inside: plays at the listener, and zoneDepth is 1 at the centre and 0 at the edge", async () => {
    await kit.boot({ ...withListener, "rain.playlist.json": rain });
    const z = zone([0, 0, 0], { sound: "rain.playlist.json", width: 10, depth: 10, bottom: 0, top: 10 });
    kit.frame();
    expect(fake.voices[0]!.position).toEqual({ x: 0, y: 1, z: 0 });
    expect(z.distance).toBe(0);
    expect(z.spread).toBe(360);
    expect(depthOf()).toBeCloseTo(1, 6);
    z.node.transform!.position.set(2.5, 0, 0); // the listener halfway to the edge
    kit.frame();
    expect(depthOf()).toBeCloseTo(0.5, 6);
  });

  it("inside zone: full level inside, falling linearly to silence over the feather outside", async () => {
    await kit.boot({ ...withListener, "storm.playlist.json": flat });
    const z = zone([8, 0, 0], { sound: "storm.playlist.json", heard: "inside", width: 10, depth: 10, bottom: 0, top: 10, feather: 6, volume: -6 });
    kit.frame(); // 3 m outside a 6 m feather
    const v = fake.voices[0]!;
    expect(v.volume).toBeCloseTo(dbGain(-6) * 0.5, 6);
    z.node.transform!.position.set(0, 0, 0);
    kit.frame();
    expect(v.volume).toBeCloseTo(dbGain(-6), 6);
    z.node.transform!.position.set(50, 0, 0);
    kit.frame();
    expect(v.volume).toBe(0);
  });

  it("a sample loops from the nearest point; disabling the zone stops it", async () => {
    await kit.boot(withListener);
    const z = zone([0, 0, 20], { sound: "a.wav", width: 4, depth: 4 });
    kit.frame();
    const req = fake.plays[0]!;
    expect(req).toMatchObject({ path: "a.wav", loop: true, attenuation: { minDistance: 1, maxDistance: 100, rolloff: "inverse" } });
    expect(fake.voices[0]!.position).toEqual({ x: 0, y: 1, z: 18 });
    expect(fake.voices[0]!.volume).toBeCloseTo(1, 6);
    z.enabled = false;
    kit.frame();
    expect(fake.voices[0]!.stopped).toBe(true);
    z.enabled = true;
    kit.frame();
    expect(fake.plays).toHaveLength(2);
  });

  it("changing the sound swaps what plays", async () => {
    await kit.boot({ ...withListener, "rain.playlist.json": rain });
    const z = zone([0, 0, 20], { sound: "rain.playlist.json" });
    kit.frame();
    z.sound = "b.wav";
    kit.frame();
    expect(fake.voices[0]!.stopped).toBe(true);
    expect(fake.plays.at(-1)!.path).toBe("b.wav");
  });
});
