// ADR 0347: spatial test scenes — the lenient parse, the writer's round trip and the references with their rewrite.
import { describe, expect, it } from "vitest";
import { audioTestSceneToJson, AUDIO_SCENE_LIMITS, emptyAudioTestScene, parseAudioTestScene, rewriteTestSceneReferences, routeLength, routePose, testSceneReferences } from "./testScene";
import { AUDIO_SCENE_FORMAT } from "./testSceneTypes";

const full = {
  format: AUDIO_SCENE_FORMAT,
  folder: "Canyon level",
  listeners: [{ id: "p1", name: "Player 1", position: { x: 1, y: 1.7, z: 2 }, yaw: 90 }, { id: "p2", name: "Player 2", position: { x: 5, y: 1.7, z: 5 }, yaw: 0, hidden: true }],
  activeListener: "p2",
  emitters: [
    { id: "e1", name: "Waterfall", kind: "static", position: { x: 8, y: 14, z: 8 }, sound: "audio/waterfall.playlist.json", volume: -3 },
    { id: "e2", name: "Drone", kind: "moving", route: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], height: 9, speed: 12, start: 0.25, loop: true, sound: "audio/drone.playlist.json", volume: 0, locked: true },
  ],
  obstacles: [{ id: "o1", name: "Rock wall", box: { center: { x: 5, y: 0, z: 5 }, width: 5, depth: 35, yaw: 20, bottom: 0, top: 16 }, material: "Rock" }],
  reverbZones: [{ id: "r1", name: "Cave", box: { center: { x: 80, y: 0, z: 22 }, width: 40, depth: 45, yaw: 0, bottom: 0, top: 10 }, preset: "smallStone", wet: -6, priority: 2, levelDefault: true }],
  audioZones: [{ id: "z1", name: "Wind", box: { center: { x: 0, y: 0, z: 0 }, width: 20, depth: 10, yaw: -30, bottom: 4, top: 20 }, sound: "audio/wind.playlist.json", heard: "inside", feather: 6, volume: -2 }],
  sounds2d: [{ id: "s1", name: "Music", sound: "audio/theme.playlist.json", volume: -6, output: "Music" }],
  base: "scenes/canyon.scene.json",
  replace: { "Campfire/AudioSource": "audio/campfire_b.playlist.json" },
};

describe("parseAudioTestScene", () => {
  it("reads a full scene without problems and writes it back unchanged", () => {
    const { scene, problems } = parseAudioTestScene(full);
    expect(problems).toEqual([]);
    expect(scene.activeListener).toBe("p2");
    expect(scene.emitters[1]).toMatchObject({ kind: "moving", route: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }], start: 0.25, locked: true });
    expect(audioTestSceneToJson(scene)).toEqual(full);
    const again = parseAudioTestScene(JSON.parse(JSON.stringify(audioTestSceneToJson(scene))));
    expect(again).toEqual({ scene, problems: [] });
  });

  it("never throws: a non-object is an empty scene with one listener", () => {
    for (const raw of [null, 3, "x", []]) {
      const { scene, problems } = parseAudioTestScene(raw);
      expect(scene).toEqual(emptyAudioTestScene());
      expect(problems).toHaveLength(1);
    }
  });

  it("adds a listener when there is none and repairs a missing active listener", () => {
    const a = parseAudioTestScene({ format: AUDIO_SCENE_FORMAT, listeners: [] });
    expect(a.scene.listeners).toHaveLength(1);
    expect(a.scene.activeListener).toBe(a.scene.listeners[0]!.id);
    expect(a.problems.some((p) => p.includes("needs a listener"))).toBe(true);
    const b = parseAudioTestScene({ format: AUDIO_SCENE_FORMAT, listeners: [{ id: "a" }], activeListener: "zz" });
    expect(b.scene.activeListener).toBe("a");
    expect(b.problems.some((p) => p.includes('no listener "zz"'))).toBe(true);
  });

  it("makes ids unique across every list", () => {
    const { scene, problems } = parseAudioTestScene({
      format: AUDIO_SCENE_FORMAT,
      listeners: [{ id: "x" }],
      emitters: [{ id: "x", position: { x: 0, y: 0, z: 0 } }, {}],
    });
    const ids = [...scene.listeners, ...scene.emitters].map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    expect(problems.filter((p) => p.includes("id"))).toHaveLength(2);
  });

  it("completes a route with fewer than 2 points and repairs a box without height", () => {
    const { scene, problems } = parseAudioTestScene({
      format: AUDIO_SCENE_FORMAT,
      emitters: [{ kind: "moving", route: [{ x: 3, z: 4 }] }],
      obstacles: [{ box: { bottom: 5, top: 5.2 } }],
    });
    expect((scene.emitters[0] as { route: unknown }).route).toEqual([{ x: 3, y: 0, z: 4 }, { x: 13, y: 0, z: 4 }]);
    expect(scene.obstacles[0]!.box).toMatchObject({ bottom: 5, top: 5 + AUDIO_SCENE_LIMITS.minHeight });
    expect(problems.filter((p) => !p.includes("has no id"))).toHaveLength(2);
  });

  it("clamps values to the declared limits with a problem each, and defaults the rest", () => {
    const { scene, problems } = parseAudioTestScene({
      format: AUDIO_SCENE_FORMAT,
      audioZones: [{ feather: 1000, heard: "around", volume: 99 }],
      reverbZones: [{ priority: 2.5, preset: "" }],
    });
    expect(scene.audioZones[0]).toMatchObject({ feather: 100, heard: "edge", volume: 12 });
    expect(scene.reverbZones[0]).toMatchObject({ priority: 3, preset: "hall", levelDefault: false });
    expect(problems.filter((p) => !p.includes("has no id"))).toHaveLength(5);
  });

  it("drops objects past the limit with one problem", () => {
    const many = Array.from({ length: AUDIO_SCENE_LIMITS.objects + 3 }, () => ({}));
    const { scene, problems } = parseAudioTestScene({ format: AUDIO_SCENE_FORMAT, sounds2d: many });
    expect(scene.sounds2d).toHaveLength(AUDIO_SCENE_LIMITS.objects);
    expect(problems.filter((p) => p.includes("at most"))).toHaveLength(1);
  });

  it("reads a wrong format with one problem", () => {
    const { problems } = parseAudioTestScene({ format: "myco.scene@1" });
    expect(problems).toHaveLength(1);
  });
});

describe("routes", () => {
  const route = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }];
  const out = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 } };

  it("places an emitter by arc length, at its height, facing along the segment", () => {
    expect(routeLength(route)).toBe(20);
    routePose(route, 3, 0.25, true, out);
    expect(out).toEqual({ position: { x: 5, y: 3, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    routePose(route, 3, 0.75, true, out);
    expect(out).toEqual({ position: { x: 10, y: 3, z: 5 }, direction: { x: 0, y: 0, z: 1 } });
  });

  it("wraps when looping and clamps when not", () => {
    routePose(route, 0, 1.25, true, out);
    expect(out.position).toEqual({ x: 5, y: 0, z: 0 });
    routePose(route, 0, 1.25, false, out);
    expect(out.position).toEqual({ x: 10, y: 0, z: 10 });
  });
});

describe("references", () => {
  it("lists sounds and the base in file order, and rewrites moved paths", () => {
    const { scene } = parseAudioTestScene(full);
    expect(testSceneReferences(scene).map((r) => [r.kind, r.path, r.where])).toEqual([
      ["sound", "audio/waterfall.playlist.json", "emitters[0].sound"],
      ["sound", "audio/drone.playlist.json", "emitters[1].sound"],
      ["sound", "audio/wind.playlist.json", "audioZones[0].sound"],
      ["sound", "audio/theme.playlist.json", "sounds2d[0].sound"],
      ["scene", "scenes/canyon.scene.json", "base"],
      ["sound", "audio/campfire_b.playlist.json", "replace.Campfire/AudioSource"],
    ]);
    const moved = rewriteTestSceneReferences(scene, { "audio/wind.playlist.json": "amb/wind.playlist.json", "scenes/canyon.scene.json": "levels/canyon.scene.json", "audio/campfire_b.playlist.json": "amb/fire.playlist.json" });
    expect(moved.audioZones[0]!.sound).toBe("amb/wind.playlist.json");
    expect(moved.base).toBe("levels/canyon.scene.json");
    expect(moved.replace).toEqual({ "Campfire/AudioSource": "amb/fire.playlist.json" });
    expect(moved.emitters).toBe(scene.emitters); // untouched lists are shared
    expect(scene.audioZones[0]!.sound).toBe("audio/wind.playlist.json"); // the original is not changed
  });

  it("returns the scene itself when nothing moves", () => {
    const { scene } = parseAudioTestScene(full);
    expect(rewriteTestSceneReferences(scene, (p) => p)).toBe(scene);
    expect(rewriteTestSceneReferences(scene, new Map([["nope", "x"]]))).toBe(scene);
  });
});
