// The prototype's mix as an `audio.json` (Mixer.dc.html's seed): the bus tree, the Reverb return, two VCAs, inserts,
// automation by game parameters, ducking rules and five snapshots in folders. Read through the engine's parse, so the
// fixture is a valid file. For the Mixer's tests and stories, and an empty project (Master only) beside it.
import { parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";

export const MIXER_FIXTURE_JSON = {
  format: "myco.audio@1",
  parameters: [
    { name: "threat", min: 0, max: 1, default: 0 },
    { name: "health", min: 0, max: 100, default: 100 },
    { name: "depth", min: 0, max: 30, default: 0 },
    { name: "tod", min: 0, max: 24, default: 12 },
    { name: "gameState", labels: ["Playing", "Paused", "Cutscene", "Loading"], default: "Playing" },
    { name: "combat", labels: ["Off", "On"], default: "Off" },
    { name: "inCombat", type: "bool", default: false },
    { name: "surface", type: "text", labels: ["Dirt", "Gravel", "Wood", "Metal", "Water"], default: "Dirt" },
  ],
  buses: [
    { name: "Master", volumeDb: 0, voiceLimit: 64, effects: [{ id: "fx1", type: "limiter" }] },
    { name: "SFX", parent: "Master", volumeDb: -2, voiceLimit: 48 },
    { name: "Vehicles", parent: "SFX", volumeDb: -4, effects: [{ id: "fx1", type: "compressor", params: { threshold: -14, ratio: 2 } }], sends: [{ to: "Reverb", levelDb: -12 }] },
    { name: "Engine", parent: "Vehicles", volumeDb: -3, voiceLimit: 4, effects: [{ id: "fx1", type: "eq" }] },
    { name: "Footsteps", parent: "SFX", volumeDb: -6, voiceLimit: 12 },
    { name: "Weapons", parent: "SFX", volumeDb: -2, voiceLimit: 16 },
    { name: "Ambience", parent: "Master", volumeDb: -10, bed: { own: true, priority: 80 }, effects: [{ id: "fx1", type: "lowpass" }], sends: [{ to: "Reverb", levelDb: -6 }] },
    { name: "Rain", parent: "Ambience", volumeDb: -12, bed: { own: true, priority: 60 } },
    { name: "Dialogue", parent: "Master", volumeDb: 0, voiceLimit: 2, effects: [{ id: "fx1", type: "highpass", params: { cutoff: 120 } }, { id: "fx2", type: "compressor", params: { threshold: -20, ratio: 3 } }], sends: [{ to: "Reverb", levelDb: -18 }] },
    { name: "Music", parent: "Master", volumeDb: -10, effects: [{ id: "fx1", type: "sidechainCompressor", key: "Dialogue" }] },
    { name: "UI", parent: "Master", volumeDb: -8 },
  ],
  returns: [{ name: "Reverb", output: "Master", volumeDb: -3, effects: [{ id: "fx1", type: "reverb", params: { size: 0.6, decay: 2.4, mix: 100 } }] }],
  vcas: [
    { name: "Gameplay SFX", volumeDb: 0, members: ["Vehicles", "Footsteps", "Weapons"] },
    { name: "All voice", volumeDb: 0, members: ["Dialogue"] },
  ],
  automation: [
    { on: "Music", target: "volume", parameter: "threat", curve: [[0, 0], [1, -3, "easeOut"]] },
    { on: "Ambience", target: "volume", parameter: "threat", curve: [[0, 0], [1, -2]] },
    { on: "Ambience", target: "fx:fx1:cutoff", parameter: "depth", curve: [[0, 20000], [30, 800, "easeOut"]] },
  ],
  ducking: [
    { target: "Music", trigger: "Dialogue", mode: "presence", amountDb: -6, attackMs: 80, releaseMs: 400 },
    { target: "Ambience", trigger: "Dialogue", mode: "presence", amountDb: -4, attackMs: 80, releaseMs: 400 },
    { target: "Ambience", trigger: "Weapons", mode: "level", thresholdDb: -20, amountDb: -8, attackMs: 20, releaseMs: 600 },
  ],
  snapshots: [
    { name: "Gameplay", start: { kind: "base" } },
    { name: "Underwater", folder: "States", start: { kind: "conditions", match: "all", conditions: [{ parameter: "depth", op: "gt", value: 0 }] }, fadeInMs: 300, fadeOutMs: 500, priority: 20, buses: { Ambience: -20, Music: -6, Footsteps: -12, Vehicles: -10 }, effects: { Ambience: { fx1: { cutoff: 800 } } } },
    { name: "Pause menu", folder: "States", start: { kind: "conditions", match: "all", conditions: [{ parameter: "gameState", op: "is", value: "Paused" }] }, priority: 40, buses: { SFX: -24, Ambience: -18, Music: -14 } },
    { name: "Cinematic", folder: "Cutscenes", start: { kind: "conditions", match: "all", conditions: [{ parameter: "gameState", op: "is", value: "Cutscene" }] }, priority: 30, buses: { Footsteps: -18, Weapons: -12, UI: -60 } },
    { name: "Low health", folder: "States", start: { kind: "conditions", match: "all", conditions: [{ parameter: "health", op: "lt", value: 20 }] }, priority: 10, buses: { Ambience: -22, Music: -16 } },
  ],
};

/** The prototype's mix, parsed. */
export function mixerFixture(): AudioProject {
  const { project, problems } = parseAudioProject(structuredClone(MIXER_FIXTURE_JSON));
  if (problems.length > 0) throw new Error(`The mixer fixture doesn't parse cleanly: ${problems.join(" ")}`);
  return project;
}

/** An empty project's mix: Master only. */
export function emptyMix(): AudioProject {
  return parseAudioProject({ format: "myco.audio@1", buses: [{ name: "Master" }] }).project;
}
