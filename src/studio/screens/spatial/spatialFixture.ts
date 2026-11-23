// A test scene for the Spatial screen's tests and stories: the prototype's "Canyon run" in the engine's coordinates
// (x east, z north, y up): a player, a waterfall high on the cliff, a generator in the cave, a campfire, a drone flying a
// route, a rock wall, a crate stack and a metal bridge, the cave's reverb zone, a wind zone and a storm front, and the
// music. Also a voices readout as the test scene player would give it.
import { importBaseScene, type BaseSceneImport } from "../../../engine/audio/spatial/baseScene";
import { parseAudioTestScene } from "../../../engine/audio/spatial/testScene";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import type { TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";

const raw = {
  format: "myco.audioscene@1",
  folder: "Canyon level",
  listeners: [
    { id: "listener1", name: "Player 1", position: { x: 50, y: 1.7, z: 35 }, yaw: 0 },
    { id: "listener2", name: "Player 2", position: { x: 82, y: 1.7, z: 28 }, yaw: 90 },
  ],
  activeListener: "listener1",
  emitters: [
    { id: "emitter1", name: "Waterfall", kind: "static", position: { x: 8, y: 14, z: 62 }, sound: "audio/ambience/waterfall.playlist.json", volume: 0 },
    { id: "emitter2", name: "Generator", kind: "static", position: { x: 82, y: 1, z: 48 }, sound: "audio/sfx/generator_hum.wav", volume: -3 },
    { id: "emitter3", name: "Campfire", kind: "static", position: { x: 30, y: 0.5, z: 22 }, sound: "audio/ambience/campfire.playlist.json", volume: 0, locked: true },
    { id: "emitter4", name: "Drone", kind: "moving", route: [{ x: 10, z: 40 }, { x: 35, z: 52 }, { x: 60, z: 40 }, { x: 85, z: 52 }, { x: 95, z: 30 }], height: 9, speed: 12, start: 0.4, loop: true, sound: "audio/sfx/drone.playlist.json", volume: 0 },
  ],
  obstacles: [
    { id: "obstacle1", name: "Rock wall", box: { center: { x: 67.5, y: 0, z: 47.5 }, width: 5, depth: 35, yaw: 0, bottom: 0, top: 16 }, material: "concrete" },
    { id: "obstacle2", name: "Crate stack", box: { center: { x: 20, y: 0, z: 40 }, width: 9, depth: 5, yaw: 20, bottom: 0, top: 3 }, material: "wood" },
    { id: "obstacle3", name: "Metal bridge", box: { center: { x: 42, y: 0, z: 50 }, width: 34, depth: 4, yaw: -25, bottom: 6, top: 7 }, material: "metal", hidden: true },
  ],
  reverbZones: [{ id: "reverb1", name: "Cave", box: { center: { x: 80, y: 0, z: 47.5 }, width: 40, depth: 45, yaw: 0, bottom: 0, top: 10 }, preset: "smallStone", wet: -6, priority: 2 }],
  audioZones: [
    { id: "zone1", name: "Wind zone", box: { center: { x: 25, y: 0, z: 12 }, width: 30, depth: 12, yaw: 0, bottom: 4, top: 20 }, sound: "audio/ambience/wind.playlist.json", heard: "edge", feather: 6, volume: 0 },
    { id: "zone2", name: "Storm front", box: { center: { x: 50, y: 0, z: 5 }, width: 90, depth: 8, yaw: 0, bottom: 0, top: 30 }, sound: "audio/ambience/rain.playlist.json", heard: "inside", feather: 8, volume: -3 },
  ],
  sounds2d: [{ id: "sound1", name: "Music", sound: "audio/music/canyon_theme.playlist.json", volume: -6, output: "Music" }],
  base: null,
  replace: {},
};

/** The fixture scene (parsed, so it is what the format reads). */
export const fixtureScene = (): AudioTestScene => parseAudioTestScene(structuredClone(raw), "fixture").scene;

/** Scene files for the Scenes panel. */
export const FIXTURE_SCENE_FILES: readonly { path: string; folder: string }[] = [
  { path: "audio/scenes/canyon_run.audioscene.json", folder: "Canyon level" },
  { path: "audio/scenes/cave_approach.audioscene.json", folder: "Canyon level" },
  { path: "audio/scenes/drone_flyby.audioscene.json", folder: "Moving sources" },
  { path: "audio/scenes/behind_crates.audioscene.json", folder: "" },
  { path: "audio/scenes/level_02.audioscene.json", folder: "From the game" },
];

/** A readout as the player gives it for the fixture: the waterfall in HRTF, the generator occluded by the rock wall, the drone moving. */
export const fixtureVoices = (): TestSceneVoiceRow[] => [
  { id: "emitter1", kind: "emitter", playing: true, rendered: "hrtf", distance: 53.4, occlusion: { gain: 1, cutoffHz: null, material: null }, doppler: 1, dopplerCents: 0 },
  { id: "emitter2", kind: "emitter", playing: true, rendered: "panned", distance: 34.5, occlusion: { gain: 0.35, cutoffHz: 1200, material: "concrete" }, doppler: 1, dopplerCents: 0 },
  { id: "emitter3", kind: "emitter", playing: true, rendered: "hrtf", distance: 23.3, occlusion: { gain: 1, cutoffHz: null, material: null }, doppler: 1, dopplerCents: 0 },
  { id: "emitter4", kind: "emitter", playing: true, rendered: "bed", distance: 48.2, occlusion: null, doppler: 1.02, dopplerCents: 34.3 },
  { id: "zone1", kind: "zone", playing: true, rendered: "panned", distance: 24.8, occlusion: { gain: 1, cutoffHz: null, material: null }, doppler: null, dopplerCents: null },
  { id: "zone2", kind: "zone", playing: true, rendered: "ambisonic", distance: 26, occlusion: null, doppler: null, dopplerCents: null },
  { id: "sound1", kind: "sound2d", playing: true, rendered: "2d", distance: null, occlusion: null, doppler: null, dopplerCents: null },
];

/** The game scene a fixture scene can name as its base: a ruined tower (walls with a stone occluder), a well, a fountain zone and a courtyard reverb. */
export const FIXTURE_BASE_PATH = "scenes/canyon.scene.json";
const baseFile = {
  format: "myco.scene@4",
  nodes: [
    { id: "tower", name: "Tower", components: [{ type: "engine.Transform", data: { position: [40, 0, 30] } }, { type: "engine.AudioOccluder", data: { material: "stone" } }] },
    { id: "north", name: "North wall", parent: "tower", components: [{ type: "engine.Transform", data: { position: [0, 0, 6] } }, { type: "engine.BoxCollider", data: { size: [12, 5, 1], center: [0, 2.5, 0] } }] },
    { id: "pillar", name: "Pillar", parent: "tower", components: [{ type: "engine.Transform", data: { position: [-4, 0, 0] } }, { type: "engine.CapsuleCollider", data: { radius: 0.8, height: 5 } }] },
    { id: "well", name: "Well", components: [{ type: "engine.Transform", data: { position: [58, 0, 22] } }, { type: "engine.AudioSource", data: { clip: "asset:audio/ambience/well_drip.wav", spatial: true } }] },
    { id: "fountain", name: "Fountain", components: [{ type: "engine.Transform", data: { position: [12, 0, 28] } }, { type: "engine.AudioZone", data: { sound: "asset:audio/ambience/fountain.playlist.json", width: 8, depth: 8, top: 4 } }] },
    { id: "yard", name: "Courtyard", components: [{ type: "engine.Transform", data: { position: [40, 0, 30] } }, { type: "engine.AudioReverbZone", data: { shape: "sphere", radius: 14, preset: "room" } }] },
  ],
};

/** The fixture's base scene as the Spatial screen imports it (`base: null` reads as a missing scene). */
export const fixtureBase = (path: string | null = FIXTURE_BASE_PATH): BaseSceneImport =>
  importBaseScene(path ?? "scenes/gone.scene.json", { read: (p) => (path !== null && p === FIXTURE_BASE_PATH ? structuredClone(baseFile) : undefined) });
