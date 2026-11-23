// ADR 0347: the spatial test scene player on the fake backend — the scene built from the engine's own components, moving
// emitters along their routes, the active listener, live edits, the readout, A/B replacement in a base scene, dispose.
import { describe, expect, it } from "vitest";
import { getComponentClass } from "../../../../engine/core/registry";
import { parseAudioTestScene } from "../../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_FORMAT } from "../../../../engine/audio/spatial/testSceneTypes";
import { World } from "../../../../engine/core/World";
import { eventKit, pla, sample } from "../playlists/testKit";
import { AudioListener } from "../AudioListener";
import { AudioOccluder } from "../AudioOccluder";
import { AudioReverbZone } from "../AudioReverbZone";
import { AudioSource } from "../AudioSource";
import { AudioZone } from "../AudioZone";
import { playAudioTestScene } from "./player";

const kit = eventKit();
const fake = kit.fake;

const scene = () => parseAudioTestScene({
  format: AUDIO_SCENE_FORMAT,
  listeners: [{ id: "p1", name: "Player 1", position: { x: 0, y: 1.7, z: 0 } }, { id: "p2", name: "Player 2", position: { x: 50, y: 1.7, z: 0 }, yaw: 90 }],
  activeListener: "p1",
  emitters: [
    { id: "fire", kind: "static", position: { x: 0, y: 0.5, z: 10 }, sound: "fire.playlist.json", volume: -6 },
    { id: "drone", kind: "moving", route: [{ x: 0, z: 0 }, { x: 20, z: 0 }], height: 9, speed: 10, start: 0, loop: true, sound: "a.wav", volume: 0, output: "SFX" },
  ],
  obstacles: [{ id: "wall", box: { center: { x: 5, y: 0, z: 5 }, width: 4, depth: 1, yaw: 30, bottom: 0, top: 3 }, material: "Rock" }],
  reverbZones: [{ id: "cave", box: { center: { x: 80, y: 0, z: 0 }, width: 40, depth: 40, yaw: 0, bottom: 0, top: 10 }, preset: "smallStone", wet: -6, priority: 2, levelDefault: false }],
  audioZones: [{ id: "wind", box: { center: { x: 0, y: 0, z: -30 }, width: 10, depth: 10, yaw: 0, bottom: 0, top: 20 }, sound: "wind.playlist.json", heard: "edge", feather: 5, volume: 0 }],
  sounds2d: [{ id: "music", sound: "b.wav", volume: -6, output: "SFX" }],
}).scene;

const assets = {
  "fire.playlist.json": pla("clip", [sample("c.wav")], { playback: { plays: "untilStopped" }, spatial: { attenuation: { minDistance: 1, maxDistance: 40, curves: { volume: [[0, 0], [40, -40]] } } } }),
  "wind.playlist.json": pla("clip", [sample("d.wav")], { playback: { plays: "untilStopped" }, spatial: { attenuation: null } }),
};

const voiceOf = (path: string) => fake.voices.find((v) => v.request.path === path)!;

describe("playAudioTestScene", () => {
  it("builds the scene from the engine's components and plays it", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    kit.frame();
    expect(player.root.children.map((c) => c.name)).toEqual(["p1", "p2", "wall", "cave", "wind", "fire", "drone", "music"]);
    const [p1, p2] = player.root.children;
    expect(p1!.getBehavior(AudioListener)!.enabled).toBe(true);
    expect(p2!.getBehavior(AudioListener)!.enabled).toBe(false);
    expect(player.root.find("cave")!.getBehavior(AudioReverbZone)).toMatchObject({ preset: "smallStone", priority: 2, wet: expect.closeTo(Math.pow(10, -6 / 20), 6) });
    expect(player.root.find("wall")!.getBehavior(AudioOccluder)!.material).toBe("Rock");
    expect(player.root.find("wind")!.getBehavior(AudioZone)).toMatchObject({ sound: "wind.playlist.json", width: 10, top: 20 });
    expect(fake.plays.map((p) => p.path).sort()).toEqual(["a.wav", "b.wav", "c.wav", "d.wav"]);
    // The fire's playlist curve at its distance (-1 dB per metre) on top of its -6 dB.
    const d = Math.hypot(10, 1.2);
    expect(voiceOf("c.wav").volume).toBeCloseTo(Math.pow(10, (-6 - d) / 20), 4);
    expect(voiceOf("c.wav").request.owner).toBe("fire");
    expect(voiceOf("b.wav").request.bus).toBe("SFX");
    expect(voiceOf("a.wav").request.bus).toBe("SFX"); // the emitter's output bus
    expect(voiceOf("b.wav").request.position).toBeUndefined();
    player.dispose();
  });

  it("gives obstacles a box collider sized to the box when the physics plugin is there", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    const BoxCollider = getComponentClass("engine.BoxCollider");
    expect(BoxCollider).toBeDefined(); // the physics plugin is part of a headless Engine
    const wall = player.root.find("wall")!;
    if (BoxCollider) {
      const c = wall.getBehavior(BoxCollider as never) as unknown as { size: { x: number; y: number; z: number }; center: { y: number } };
      expect([c.size.x, c.size.y, c.size.z]).toEqual([4, 3, 1]);
      expect(c.center.y).toBe(1.5);
    }
    expect(wall.transform!.eulerAngles.y).toBeCloseTo((30 * Math.PI) / 180, 4); // radians (ADR 0164)
    player.dispose();
  });

  it("moves a moving emitter along its route at its speed and height", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    kit.frame(0.5); // 5 m along a 20 m route
    kit.frame(0.5);
    const p = voiceOf("a.wav").position!;
    expect(p.y).toBeCloseTo(9, 6);
    expect(p.x).toBeGreaterThan(4.9);
    expect(p.x).toBeLessThan(10.1);
    player.dispose();
  });

  it("reads back where each emitter is as the World moves it, and a new start puts it back", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    kit.frame(0);
    const drone = () => player.motion().find((m) => m.id === "drone")!;
    expect(player.motion().find((m) => m.id === "fire")).toEqual({ id: "fire", position: { x: 0, y: 0.5, z: 10 }, direction: null, speed: 0 });
    expect(drone()).toMatchObject({ position: { x: 0, y: 9, z: 0 }, direction: { x: 1, y: 0, z: 0 }, speed: 10 });
    for (let i = 0; i < 10; i++) kit.frame(0.1); // 10 m along the 20 m route
    expect(drone().position.x).toBeCloseTo(10, 6);
    expect(voiceOf("a.wav").position!.x).toBeCloseTo(10, 6);
    expect(player.moveObject("drone", { at: 0 })).toBe(true);
    expect(drone().position.x).toBe(0);
    player.dispose();
  });

  it("switches the active listener and moves objects live", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    kit.frame();
    expect(player.setActiveListener("p2")).toBe(true);
    expect(player.setActiveListener("nobody")).toBe(false);
    expect(player.root.find("p1")!.getBehavior(AudioListener)!.enabled).toBe(false);
    expect(player.root.find("p2")!.getBehavior(AudioListener)!.enabled).toBe(true);
    expect(player.moveObject("fire", { position: { x: 3, y: 1, z: 4 } })).toBe(true);
    expect(player.moveObject("drone", { at: 0.5 })).toBe(true);
    expect(player.moveObject("wind", { box: { center: { x: 0, y: 0, z: 30 }, width: 2, depth: 2, yaw: 0, bottom: 0, top: 5 } })).toBe(true);
    expect(player.moveObject("cave", { position: { x: 0, y: 0, z: 0 } })).toBe(false);
    expect(player.moveObject("nobody", { position: { x: 0, y: 0, z: 0 } })).toBe(false);
    kit.frame(0);
    expect(voiceOf("c.wav").position).toEqual({ x: 3, y: 1, z: 4 });
    expect(voiceOf("a.wav").position).toMatchObject({ x: 10, y: 9, z: 0 });
    expect(player.root.find("wind")!.getBehavior(AudioZone)).toMatchObject({ width: 2, top: 5 });
    player.dispose();
  });

  it("reads back how each sound is heard: rendering, distance, occlusion", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    kit.frame(0);
    voiceOf("c.wav").setOcclusion(0.5, 2000);
    const rows = player.voices();
    expect(rows.map((r) => [r.id, r.kind])).toEqual([["fire", "emitter"], ["drone", "emitter"], ["wind", "zone"], ["music", "sound2d"]]);
    const fire = rows[0]!;
    expect(fire).toMatchObject({ playing: true, rendered: "panned", occlusion: { gain: 0.5 } });
    expect(fire.distance).toBeCloseTo(Math.hypot(10, 1.2), 6);
    expect(rows[2]!.distance).toBeCloseTo(25, 6);
    expect(rows[3]).toMatchObject({ rendered: "2d", distance: null, occlusion: null });
    player.dispose();
  });

  it("swaps a base scene's sounds per replace and puts them back on dispose", async () => {
    await kit.boot({
      ...assets,
      "s.json": { format: "myco.scene@1", nodes: [{ id: "camp", name: "Campfire", components: [{ type: "engine.Transform", data: {} }, { type: "engine.AudioSource", data: { clip: "a.wav", loop: true } }] }] },
    });
    const base = World.require().activeScene!.find("Campfire")!.getBehavior(AudioSource)!;
    const s = scene();
    s.replace = { "Campfire/AudioSource": "b.wav", "Nowhere/AudioSource": "c.wav" };
    const player = playAudioTestScene(World.require(), s);
    expect(base.clip).toBe("b.wav");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Nowhere/AudioSource"));
    player.dispose();
    expect(base.clip).toBe("a.wav");
  });

  it("dispose removes every node it made and stops its sounds", async () => {
    await kit.boot(assets);
    const player = playAudioTestScene(World.require(), scene());
    kit.frame();
    const name = player.root.name;
    player.dispose();
    kit.frame();
    expect(voiceOf("c.wav").stopped || !voiceOf("c.wav").playing).toBe(true);
    expect(voiceOf("a.wav").stopped).toBe(true);
    expect(World.require().activeScene!.find(name)).toBeNull();
  });
});
