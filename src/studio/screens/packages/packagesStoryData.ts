// @internal Stories only: a small project for the Packages screen's views — three packages (Core preloads, Forest, Boss on
// desktop and web), a playlist naming a sound and a derived sample, encoding profiles and rules, budgets, and source facts
// for the estimates. Never imported by the screen's code.
import { parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { SourceFacts } from "../../encoding/estimate";
import type { StudioPlanSource } from "../../encoding/studioPlan";

export const STORY_FILES = [
  "audio.json",
  "audio/ui/click.wav", "audio/ui/hover.wav",
  "audio/amb/forest_bed.wav", "audio/amb/birds.ogg",
  "audio/sfx/hit.wav", "audio/sfx/hit_soft.sample.json",
  "audio/music/boss.wav", "audio/music/credits.wav",
  "playlists/ui/menu.playlist.json", "playlists/forest/day.playlist.json", "playlists/boss_theme.playlist.json",
];

const NAMES: Record<string, string[]> = {
  "playlists/ui/menu.playlist.json": ["audio/ui/hover.wav"],
  "playlists/forest/day.playlist.json": ["audio/amb/birds.ogg", "audio/sfx/hit_soft.sample.json"],
  "audio/sfx/hit_soft.sample.json": ["audio/sfx/hit.wav"],
  "playlists/boss_theme.playlist.json": ["audio/music/boss.wav"],
};
export const storyDeps = (p: string): string[] => NAMES[p] ?? [];

export function storyProject(): AudioProject {
  return parseAudioProject({
    format: "myco.audio@1",
    encoding: {
      default: "Default",
      profiles: {
        Default: { codec: "auto", quality: 0.5, load: "decode", platforms: { android: { quality: 0.35, sampleRate: 32000 } } },
        Music: { codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250 },
        UI: { codec: "adpcm", load: "compressed" },
      },
      rules: [{ path: "audio/music/**", profile: "Music" }, { path: "audio/ui/**", profile: "UI" }, { path: "audio/**/*.wav", profile: "Default" }],
      budgets: { web: { downloadMB: 1, memoryMB: 64 }, android: { downloadMB: 60, memoryMB: 48 } },
    },
    packages: [
      { name: "Core", preload: true, include: ["audio/ui/**", "playlists/ui/**"] },
      { name: "Forest", include: ["playlists/forest/**", "audio/amb/forest_bed.wav"] },
      { name: "Boss", include: ["playlists/boss_theme.playlist.json", "audio/ui/click.wav"], platforms: ["desktop", "web"] },
    ],
  }).project;
}

const FACTS: Record<string, SourceFacts> = {
  "audio/ui/click.wav": { bytes: 96_044, frames: 24_000, rate: 48_000, channels: 1 },
  "audio/ui/hover.wav": { bytes: 48_044, frames: 12_000, rate: 48_000, channels: 1 },
  "audio/amb/forest_bed.wav": { bytes: 18_432_044, frames: 48_000 * 96, rate: 48_000, channels: 2 },
  "audio/amb/birds.ogg": { bytes: 412_000, frames: 48_000 * 30, rate: 48_000, channels: 2 },
  "audio/sfx/hit.wav": { bytes: 192_044, frames: 48_000, rate: 48_000, channels: 2 },
  "audio/music/boss.wav": { bytes: 40_320_044, frames: 48_000 * 210, rate: 48_000, channels: 2 },
  "audio/music/credits.wav": { bytes: 23_040_044, frames: 48_000 * 120, rate: 48_000, channels: 2 },
};
export const storyFacts = (p: string): SourceFacts => FACTS[p] ?? { bytes: 0, frames: null, rate: null, channels: null };

/** The plan source over `audio` (playlists' JSON made from the names above). */
export const storyPlanSource = (audio: AudioProject): StudioPlanSource => ({
  files: STORY_FILES,
  audio,
  json: (p) => (p.endsWith(".playlist.json") && NAMES[p] ? { format: "myco.playlist@1", type: "clip", clips: NAMES[p]!.map((path) => ({ path })) } : p.endsWith(".sample.json") && NAMES[p] ? { format: "myco.sample@1", source: NAMES[p]![0], range: null, lineage: { kind: "duplicate", parent: NAMES[p]![0] } } : undefined),
});
