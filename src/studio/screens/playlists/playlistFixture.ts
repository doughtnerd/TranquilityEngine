// Fixture playlists for the Playlists screen's stories: footsteps (a Switch over surface with a rule waiting for a bar),
// dirt (a random Queue), engine (a 1D Blend over rpm with an envelope), wind (a 2D Blend), boom (a Clip), music (a
// Sequence), and the project files and parameters around them. Parsed through the format, as a project reads them.
import { parsePlaylist } from "../../../engine/audio/playlist/format";
import type { PlaylistAsset, PlaylistBody } from "../../../engine/audio/playlist/types";
import type { ParameterDef } from "../../../engine/audio/eventFormat";
import { lintPlaylist } from "../../../engine/audio/playlist/lint";

const clip = (sample: string, extra: Record<string, unknown> = {}) => ({ embedded: { type: "clip", entries: [{ sample }] }, ...extra });

const raw: Record<string, unknown> = {
  "audio/footsteps/footsteps.playlist.json": {
    format: "myco.playlist@1", type: "switch", output: "SFX",
    entries: [{ playlist: "audio/footsteps/dirt.playlist.json" }, clip("audio/footsteps/metal_01.wav"), { embedded: { type: "queue", entries: [clip("audio/footsteps/grass_01.wav"), clip("audio/footsteps/grass_02.wav")] } }],
    switch: { parameter: "surface", map: { dirt: 0, metal: 1, grass: 2 }, labelGain: { metal: -3 }, onChange: { when: "now", how: "crossfade", length: { ms: 200 } }, rules: [{ from: "*", to: "metal", when: "bar", how: "crossfade", length: { beats: 1 } }] },
  },
  "audio/footsteps/dirt.playlist.json": {
    format: "myco.playlist@1", type: "queue",
    entries: [clip("audio/footsteps/dirt_01.wav"), clip("audio/footsteps/dirt_02.wav", { weight: 2 }), clip("audio/footsteps/dirt_03.wav", { weight: 0, volume: -2 })],
    queue: { pick: "random", avoidRepeat: 1 },
  },
  "audio/vehicles/engine.playlist.json": {
    format: "myco.playlist@1", type: "blend", playback: { plays: "untilStopped", maxInstances: 4, whenFull: "stealQuietest" },
    entries: [clip("audio/vehicles/engine_idle.wav", { x: 800 }), clip("audio/vehicles/engine_mid.wav", { x: 3200 }), clip("audio/vehicles/engine_high.wav", { x: 6400 })],
    blend: { axes: ["rpm"], fade: "crossfade", curve: "equalPower", follow: { glideMs: 120 }, envelope: { mode: "morph", low: { attackMs: 45, decayMs: 320, sustain: 0.35, releaseMs: 420 }, high: { attackMs: 2, decayMs: 120, sustain: 0.18, releaseMs: 260 } } },
  },
  "audio/ambience/wind.playlist.json": {
    format: "myco.playlist@1", type: "blend",
    entries: [clip("audio/ambience/wind_soft.wav", { x: 0, y: 0 }), clip("audio/ambience/wind_gust.wav", { x: 1, y: 0 }), clip("audio/ambience/wind_storm.wav", { x: 1, y: 1 }), clip("audio/ambience/wind_howl.wav", { x: 0, y: 1 })],
    blend: { axes: ["wind", "rain"], fade: "crossfade", curve: "linear", follow: "hold" },
  },
  "audio/ui/boom.playlist.json": { format: "myco.playlist@1", type: "clip", volumeRandom: [-3, 0], pitchRandom: [-1, 1], entries: [{ sample: "audio/ui/boom.wav", loop: "off" }] },
  "music/theme.playlist.json": { format: "myco.playlist@1", type: "sequence", sequence: { length: 8, tempo: { bpm: 120, meter: "4/4" }, tracks: [] } },
};

export const FIXTURE_PLAYLISTS: Readonly<Record<string, PlaylistAsset>> = Object.fromEntries(Object.entries(raw).map(([p, v]) => [p, parsePlaylist(v, p).playlist]));

export const loadFixture = (path: string): PlaylistBody | null => FIXTURE_PLAYLISTS[path] ?? null;

export const FIXTURE_FILES: readonly string[] = [
  ...Object.keys(FIXTURE_PLAYLISTS),
  "audio/footsteps/dirt_01.wav", "audio/footsteps/dirt_02.wav", "audio/footsteps/dirt_03.wav", "audio/footsteps/metal_01.wav", "audio/footsteps/grass_01.wav", "audio/footsteps/grass_02.wav",
  "audio/vehicles/engine_idle.wav", "audio/vehicles/engine_mid.wav", "audio/vehicles/engine_high.wav", "audio/vehicles/skid.sample.json",
  "audio/ambience/wind_soft.wav", "audio/ui/boom.wav", "audio.json", "project.json",
].sort();

export const FIXTURE_FOLDERS: readonly string[] = ["audio", "audio/footsteps", "audio/vehicles", "audio/ambience", "audio/ui", "music", "drafts"];

export const FIXTURE_PARAMETERS: readonly ParameterDef[] = [
  { name: "surface", labels: ["dirt", "metal", "grass"], default: "dirt" },
  { name: "rpm", min: 0, max: 8000, default: 3200, seekSpeed: 0 },
  { name: "speed", min: 0, max: 200, default: 0, seekSpeed: 0 },
  { name: "wind", min: 0, max: 1, default: 0.3, seekSpeed: 0 },
  { name: "rain", min: 0, max: 1, default: 0.6, seekSpeed: 0 },
];

/** The fixture's lints for a playlist (no sample has a tempo, so a rule waiting for a bar is linted). */
export const fixtureLints = (path: string) => lintPlaylist(FIXTURE_PLAYLISTS[path]!, { playlist: loadFixture, sampleTempo: () => null });
