// ADR 0333: a spatial test scene over a base game scene, headless, as the Studio plays it: the base scene's walls (their
// colliders and occluders) load into the World underneath the test scene, run on the 3D physics plugin, and the engine's
// own occlusion pass (the core backend's, on the recording host: no wasm) muffles a test emitter behind one. Measured
// through the public readout: the player's Voices rows (the runtime's `Audio.debug()` voice rows) and `occlusionGain`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { parseAudioTestScene } from "../../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_FORMAT, type AudioTestScene } from "../../../../engine/audio/spatial/testSceneTypes";
import { AudioSource } from "../AudioSource";
import { setAudioBackend } from "../backend";
import { closeRecordingAudio, endAudioSession, makeFakeClipRegistry, recordingAudio } from "../testing";
import { loadBaseScene, type LoadedBaseScene } from "./baseScene";
import { playAudioTestScene, type AudioTestScenePlayer } from "./player";

const wood = Math.pow(10, -12 / 20); // the built-in "wood" material's loss

const yard = {
  format: "myco.scene@4",
  nodes: [
    { id: "house", name: "House", components: [{ type: "engine.Transform", data: { position: [5, 0, 0] } }, { type: "engine.AudioOccluder", data: { material: "wood" } }] },
    { id: "wall", name: "Wall", parent: "house", components: [{ type: "engine.Transform", data: {} }, { type: "engine.BoxCollider", data: { size: [0.5, 6, 6] } }, { type: "engine.MeshRenderer", data: {} }] },
    { id: "radio", name: "Radio", components: [{ type: "engine.Transform", data: { position: [0, 0, -8] } }, { type: "engine.AudioSource", data: { clip: "asset:b.wav", loop: true, spatial: true } }, { type: "game.Script", data: {} }] },
    { id: "hero", name: "Hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.AudioListener", data: {} }] },
  ],
};

/** A listener at the origin and an emitter 10 m along +x: the base's wall stands between them at x = 5. */
const testScene = (base: string | null): AudioTestScene =>
  parseAudioTestScene({
    format: AUDIO_SCENE_FORMAT,
    listeners: [{ id: "p1", name: "Player 1", position: { x: 0, y: 0, z: 0 } }],
    activeListener: "p1",
    emitters: [{ id: "bell", name: "Bell", kind: "static", position: { x: 10, y: 0, z: 0 }, sound: "a.wav", volume: 0 }],
    base,
  }).scene;

let engine: Engine;
let base: LoadedBaseScene | null = null;
let player: AudioTestScenePlayer | null = null;

beforeEach(async () => {
  setAudioBackend(null);
  endAudioSession();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "a.wav": "data:audio/wav;base64,AAAA", "b.wav": "data:audio/wav;base64,AAAA", "scenes/yard.scene.json": yard }));
  // The Studio's World: no scene of its own, the audio and physics plugins (the test setup activates every first-party one).
  engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }] } } });
  engine.world.render = {} as never;
  recordingAudio({ preset: { maxLogical: 16 }, clips: makeFakeClipRegistry() });
});

afterEach(async () => {
  player?.dispose();
  player = null;
  base?.dispose();
  base = null;
  engine.world.render = undefined as never;
  engine.dispose();
  await closeRecordingAudio();
  Assets.clearSources();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

const run = (frames: number) => {
  for (let i = 0; i < frames; i++) engine.step(1 / 60);
};
const bell = () => player!.voices().find((r) => r.id === "bell")!;

describe("a test scene over a base game scene (headless)", () => {
  it("without its base the emitter is heard open", () => {
    player = playAudioTestScene(engine.world, testScene(null));
    run(10);
    expect(bell().playing).toBe(true);
    expect(bell().occlusion?.gain ?? 1).toBe(1);
  });

  it("the base scene's wall occludes the emitter behind it, with the wall's material", async () => {
    const s = testScene("scenes/yard.scene.json");
    base = await loadBaseScene(s.base!);
    player = playAudioTestScene(engine.world, s);
    run(10);
    const row = bell();
    expect(row.playing).toBe(true);
    expect(row.occlusion!.gain).toBeCloseTo(wood, 3);
    expect(row.occlusion!.material).toBe("wood");
    expect(player.root.find("bell")!.getBehavior(AudioSource)!.occlusionGain).toBeCloseTo(wood, 3);
  });

  it("without a base, the test scene's own obstacle occludes: its collider starts the World's 3D physics", async () => {
    const s = testScene(null);
    s.obstacles = [{ id: "fence", name: "Fence", hidden: false, locked: false, material: "metal", box: { center: { x: 5, y: 0, z: 0 }, width: 0.5, depth: 6, yaw: 0, bottom: -3, top: 3 } }];
    player = playAudioTestScene(engine.world, s);
    // The physics service loads asynchronously when the first collider attaches (Rapier), as in a game.
    for (let i = 0; i < 50 && (bell().occlusion?.gain ?? 1) === 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
      run(2);
    }
    expect(bell().occlusion!.gain).toBeLessThan(0.5);
    expect(bell().occlusion!.material).toBe("metal");
  });

  it("loads the base's audio and colliders underneath, read-only, and unloads them", async () => {
    base = await loadBaseScene("scenes/yard.scene.json");
    const scene = base.scene!;
    expect(SceneManager.scenes).toContain(scene);
    expect(scene.name).toBe("yard");
    expect(scene.find("House/Wall")).not.toBeNull();
    expect(scene.find("Radio")!.getBehavior(AudioSource)!.clip).toBe("b.wav");
    expect(scene.find("Hero")).toBeNull(); // the listener's node: nothing of it is loaded
    expect(Assets.has(base.import.path)).toBe(true); // the game scene; the loaded copy isn't an asset
    expect(base.import.problems).toEqual([expect.stringMatching(/AudioListener isn't loaded/)]);
    base.dispose();
    base = null;
    run(1);
    expect(scene.isValid).toBe(false);
  });

  it("a base scene that isn't there loads nothing and says so", async () => {
    base = await loadBaseScene("scenes/gone.scene.json");
    expect(base.scene).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('The base scene "scenes/gone.scene.json" isn\'t in the project'));
  });
});
