import { describe, expect, it } from "vitest";
import { audioTestSceneToJson, parseAudioTestScene } from "../../../engine/audio/spatial/testScene";
import type { Attenuation } from "../../../engine/audio/attenuation/types";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import type { TakeRequest } from "../../../engine/audio/take/types";
import { attenuationDialog, attenuationFromResult, attenuationOwner, attenuationSummary, newAttenuation, ownerText, presetNameFor, ROLLOFF_PRESETS } from "./attenuationModel";
import { blankScene, copyScene, gameScene, gameScenePaths, sceneFromTake, takeClock } from "./newScene";
import { deleteSceneFolder, moveSceneFolder, newSceneFolder, renameSceneFolder, sceneFolders, sceneName, sceneTree, searchScenes, whyNotRenameScene } from "./sceneTree";
import { FIXTURE_SCENE_FILES, fixtureScene, fixtureVoices } from "./spatialFixture";
import { occlusionText, raysOf, voiceTable } from "./voicesTable";

describe("the Scenes tree", () => {
  it("puts scene files under their folder fields, folders first", () => {
    const t = sceneTree(FIXTURE_SCENE_FILES);
    expect(t.map((n) => `${n.kind}:${n.name}`)).toEqual(["folder:Canyon level", "folder:From the game", "folder:Moving sources", "scene:behind_crates"]);
    const canyon = t[0]!;
    expect(canyon.kind === "folder" && canyon.children.map((c) => c.name)).toEqual(["canyon_run", "cave_approach"]);
    expect(sceneFolders(FIXTURE_SCENE_FILES, ["Canyon level/Night"])).toContain("Canyon level/Night");
    expect(sceneName("a/b/drone_flyby.audioscene.json")).toBe("drone_flyby");
  });

  it("searches by name and folder", () => {
    expect(searchScenes(FIXTURE_SCENE_FILES, "canyon cave")).toEqual([{ path: "audio/scenes/cave_approach.audioscene.json", label: "Canyon level › cave_approach" }]);
    expect(searchScenes(FIXTURE_SCENE_FILES, "")).toEqual([]);
  });

  it("renames, moves and deletes folders by changing the scenes' folder fields", () => {
    const r = renameSceneFolder(FIXTURE_SCENE_FILES, "Canyon level", "Canyon");
    expect("changes" in r && r.changes.map((c) => c.folder)).toEqual(["Canyon", "Canyon"]);
    expect(renameSceneFolder(FIXTURE_SCENE_FILES, "Canyon level", "Moving sources")).toEqual({ refused: 'there\'s already a folder "Moving sources"' });
    expect(renameSceneFolder(FIXTURE_SCENE_FILES, "Canyon level", "a/b")).toEqual({ refused: "a folder name can't be empty or hold a /" });
    const m = moveSceneFolder(FIXTURE_SCENE_FILES, "Moving sources", "Canyon level");
    expect("changes" in m && m.changes).toEqual([{ path: "audio/scenes/drone_flyby.audioscene.json", folder: "Canyon level/Moving sources" }]);
    expect(moveSceneFolder(FIXTURE_SCENE_FILES, "Canyon level", "Canyon level/x")).toEqual({ refused: "a folder can't move into itself" });
    expect(deleteSceneFolder([{ path: "a.audioscene.json", folder: "X/Y/Z" }], "X/Y")).toEqual([{ path: "a.audioscene.json", folder: "X/Z" }]);
    expect(newSceneFolder(FIXTURE_SCENE_FILES, "", ["New folder"])).toBe("New folder 2");
  });

  it("checks scene file names", () => {
    const files = FIXTURE_SCENE_FILES.map((f) => f.path);
    expect(whyNotRenameScene(files, files[0]!, "cave_approach")).toBe("there's already a scene named cave_approach");
    expect(whyNotRenameScene(files, files[0]!, "a/b")).toMatch(/can't hold/);
    expect(whyNotRenameScene(files, files[0]!, "canyon_run_2")).toBeNull();
  });
});

describe("new scenes", () => {
  it("blank, copy and over a game scene", () => {
    expect(blankScene("X").listeners).toHaveLength(1);
    expect(blankScene("X").folder).toBe("X");
    const c = copyScene(fixtureScene(), "");
    expect(c.emitters).toEqual(fixtureScene().emitters);
    expect(c.folder).toBe("");
    expect(gameScene("scenes/canyon.scene.json").base).toBe("scenes/canyon.scene.json");
    expect(gameScenePaths(["b.scene.json", "a.audioscene.json", "a.scene.json"])).toEqual(["a.scene.json", "b.scene.json"]);
  });

  it("from a take: positions at a moment from the POSE requests, sounds from the last play on each emitter", () => {
    const v = { x: 0, y: 0, z: 0 };
    const requests: TakeRequest[] = [
      { kind: "pose", t: 1, emitter: 0, position: { x: 1, y: 1.7, z: 1 }, velocity: v, forward: { x: 1, y: 0, z: 0 } },
      { kind: "play", t: 2, instance: 1, path: "audio/engine.playlist.json", emitter: 7, options: {} },
      { kind: "pose", t: 2, emitter: 7, position: { x: 10, y: 0.5, z: 4 }, velocity: v },
      { kind: "pose", t: 30, emitter: 0, position: { x: 5, y: 1.7, z: 6 }, velocity: v },
      { kind: "pose", t: 41, emitter: 9, position: { x: 3, y: 0, z: 3 }, velocity: v },
      { kind: "pose", t: 50, emitter: 7, position: { x: 99, y: 0, z: 99 }, velocity: v },
    ];
    const s = sceneFromTake({ meta: { emitters: { 7: "Level/Truck", 9: "Bird" } }, requests }, 41);
    expect(s.listeners[0]!.position).toEqual({ x: 5, y: 1.7, z: 6 });
    expect(s.emitters.map((e) => [e.name, e.kind === "static" && e.position, e.sound])).toEqual([
      ["Truck", { x: 10, y: 0.5, z: 4 }, "audio/engine.playlist.json"],
      ["Bird", { x: 3, y: 0, z: 3 }, ""],
    ]);
    const early = sceneFromTake({ meta: { emitters: {} }, requests }, 1);
    expect(early.listeners[0]!.yaw).toBe(90);
    expect(early.emitters).toEqual([]);
    expect(parseAudioTestScene(audioTestSceneToJson(s)).problems).toEqual([]);
    expect(takeClock(41)).toBe("0:41");
  });
});

describe("attenuation", () => {
  const preset: Attenuation = { minDistance: 2, maxDistance: 40, curves: { volume: [[0, 0], [2, 0], [40, -60, "easeOut"]] } };
  const playlist = (spatial: PlaylistAsset["spatial"]) => ({ spatial }) as PlaylistAsset;
  const files: Record<string, PlaylistAsset> = {
    "a.playlist.json": playlist({ attenuation: "audio/attenuation/near.attenuation.json", occlusion: true, doppler: 0, spread: null }),
    "b.playlist.json": playlist({ attenuation: { minDistance: 1, maxDistance: 20, curves: {} }, occlusion: false, doppler: 0, spread: null }),
    "c.playlist.json": playlist({ attenuation: null, occlusion: false, doppler: 0, spread: null }),
    "d.playlist.json": playlist(null),
  };
  const read = (p: string) => files[p] ?? null;
  const presets = (p: string) => (p === "audio/attenuation/near.attenuation.json" ? preset : null);

  it("finds who owns an emitter's attenuation", () => {
    expect(attenuationOwner("", read, presets).kind).toBe("silent");
    expect(attenuationOwner("x.wav", read, presets).kind).toBe("notPlaylist");
    expect(attenuationOwner("z.playlist.json", read, presets).kind).toBe("missing");
    expect(attenuationOwner("a.playlist.json", read, presets)).toEqual({ kind: "preset", playlist: "a.playlist.json", preset: "audio/attenuation/near.attenuation.json", attenuation: preset });
    expect(attenuationOwner("b.playlist.json", read, presets).kind).toBe("inline");
    expect(attenuationOwner("c.playlist.json", read, presets).kind).toBe("none");
    expect(attenuationOwner("d.playlist.json", read, presets).kind).toBe("flat");
    expect(ownerText(attenuationOwner("x.wav", read, presets))).toMatch(/sample: attenuation lives on playlists/);
  });

  it("summarises", () => {
    expect(attenuationSummary(preset)).toBe("Min 2.0 m · Max 40.0 m · ∿ Volume");
    expect(attenuationSummary({ minDistance: 1, maxDistance: 50, curves: {} })).toBe("Min 1.0 m · Max 50.0 m · flat");
  });

  it("opens the distance dialog with four lanes and writes back only curves that say something", () => {
    const spec = attenuationDialog(preset, 12);
    expect(spec).toMatchObject({ kind: "distance", minDistance: 2, maxDistance: 40, now: 12 });
    expect(spec.lanes.map((l) => [l.id, l.unit, l.scale ?? "linear"])).toEqual([["volume", "dB", "linear"], ["lowpass", "Hz", "log"], ["reverbSend", "dB", "linear"], ["spread", "°", "linear"]]);
    expect(spec.lanes[1]!.curve).toEqual([[0, 20000], [40, 20000]]);
    const result = {
      kind: "distance" as const,
      minDistance: 3,
      maxDistance: 30,
      lanes: [
        { id: "volume", curve: [[0, 0], [3, 0], [30, -60]] as never, input: "distance", bypass: false },
        { id: "lowpass", curve: [[0, 20000], [30, 20000]] as never, input: "distance", bypass: false },
        { id: "reverbSend", curve: [[0, 0], [30, -6]] as never, input: "distance", bypass: true },
        { id: "spread", curve: [[0, 180], [30, 20]] as never, input: "distance", bypass: false },
      ],
    };
    expect(attenuationFromResult(preset, result)).toEqual({ minDistance: 3, maxDistance: 30, curves: { volume: [[0, 0], [3, 0], [30, -60]], spread: [[0, 180], [30, 20]] } });
  });

  it("makes new attenuation from the format's presets", () => {
    const a = newAttenuation();
    expect(a.curves.volume!.length).toBeGreaterThan(1);
    expect(ROLLOFF_PRESETS.map((p) => p.label)).toEqual(["Linear", "Inverse", "Exponential", "Inverse square"]);
    expect(presetNameFor("audio/sfx/drone.playlist.json")).toBe("drone");
  });
});

describe("the Voices table and rays", () => {
  it("reads how each sound is heard from the readout", () => {
    const rows = voiceTable(fixtureScene(), fixtureVoices(), (id) => id === "emitter3");
    expect(rows.map((r) => [r.name, r.renderedText, r.distanceText, r.occlusionText, r.dopplerText])).toEqual([
      ["Waterfall", "HRTF", "53.4 m", "Clear", "—"],
      ["Generator", "Panned", "34.5 m", "−9.1 dB · low-pass 1.2 kHz · concrete", "—"],
      ["Campfire", "Muted", "23.3 m", "Clear", "—"],
      ["Drone", "Ambisonic bed", "48.2 m", "not traced (bed)", "+34 ct"],
      ["Wind zone", "Panned", "24.8 m", "Clear", "—"],
      ["Storm front", "Ambisonic bed", "26.0 m", "not traced (bed)", "—"],
      ["Music", "2D", "—", "not traced (2D)", "—"],
    ]);
    expect(occlusionText({ ...fixtureVoices()[0]!, playing: false })).toBe("—");
  });

  it("draws rays to sounds heard in place: dashed when occluded", () => {
    expect(raysOf(fixtureVoices())).toEqual([
      { id: "emitter1", occluded: false },
      { id: "emitter2", occluded: true },
      { id: "emitter3", occluded: false },
      { id: "zone1", occluded: false },
    ]);
  });
});
