// The Audio Studio's screens in four groups (ADR 0341 "The shell"): Author (Samples, Playlists, Dialogue, ADR 0354 §9), Mix (Mixer,
// Spatial), Run (Take, Profiler) and Ship (Packages, ADR 0351 §6). Each has its place in the header, its Ctrl/⌘+digit
// and what it is for, which its empty state says until there is something to show.
import type { IconName } from "../components/Icon";

export type ScreenId = "samples" | "playlists" | "dialogue" | "mixer" | "spatial" | "take" | "profiler" | "packages";
export type ScreenGroup = "author" | "mix" | "run" | "ship";

export interface ScreenInfo {
  readonly id: ScreenId;
  readonly title: string;
  readonly group: ScreenGroup;
  /** Its digit in Ctrl/⌘+1…8. */
  readonly digit: number;
  /** What the screen is for, in a sentence (its empty state and the header's tooltip). */
  readonly purpose: string;
  /** The kind badge its now-playing tile shows. */
  readonly art: string;
  /** Its icon in the header (an `Icon` name, ADR 0361). */
  readonly icon: IconName;
}

export const GROUP_TITLES: Readonly<Record<ScreenGroup, string>> = { author: "Author", mix: "Mix", run: "Run", ship: "Ship" };

export const SCREENS: readonly ScreenInfo[] = [
  { id: "samples", icon: "samples", title: "Samples", group: "author", digit: 1, art: "WAV", purpose: "Audio files and their non-destructive edits: markers, loops, trim, tempo and root, normalise and baked effects." },
  { id: "playlists", icon: "playlists", title: "Playlists", group: "author", digit: 2, art: "PL", purpose: "What the game plays: clips, queues, switches, blends, layers and sequences, auditioned with test parameters." },
  { id: "dialogue", icon: "dialogue", title: "Dialogue", group: "author", digit: 8, art: "VO", purpose: "Voice-over lines and their recordings per language, subtitles, languages, batch import and dialogue events." },
  { id: "mixer", icon: "mixer", title: "Mixer", group: "mix", digit: 3, art: "MIX", purpose: "Buses, returns and VCAs with their effects, sends, ducking and snapshots." },
  { id: "spatial", icon: "spatial", title: "Spatial", group: "mix", digit: 4, art: "3D", purpose: "Attenuation curves, audio zones and test scenes for how sound behaves in space." },
  { id: "take", icon: "take", title: "Take", group: "run", digit: 5, art: "TAKE", purpose: "Recordings of what a game asked of audio, replayed against the current audio and annotated." },
  { id: "profiler", icon: "profiler", title: "Profiler", group: "run", digit: 6, art: "CAP", purpose: "Engine performance captures: voices, CPU, buses and loudness over time, and why each sound played." },
  { id: "packages", icon: "packages", title: "Packages", group: "ship", digit: 7, art: "PAK", purpose: "What each platform ships: packages of sounds loaded together, encoding profiles and folder rules, sizes and memory against budgets." },
];

export const DEFAULT_SCREEN: ScreenId = "samples";

/** ADR 0408: the screens a takes folder workspace (no project) offers; the rest need a project. */
export const TAKES_FOLDER_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(["take", "profiler"]);

/** ADR 0410: a takes folder with a build's audio mounted also shows Playlists and the Mixer (read-only). */
export const TAKES_FOLDER_AUDIO_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(["take", "profiler", "playlists", "mixer"]);

/** A screen by id, or undefined for anything else. */
export const screenById = (id: string): ScreenInfo | undefined => SCREENS.find((s) => s.id === id);

/** Whether `id` names a screen. */
export const isScreenId = (id: string): id is ScreenId => screenById(id) !== undefined;

/** The screens of each group, in header order. */
export function screenGroups(): { group: ScreenGroup; title: string; screens: ScreenInfo[] }[] {
  return (Object.keys(GROUP_TITLES) as ScreenGroup[]).map((group) => ({ group, title: GROUP_TITLES[group], screens: SCREENS.filter((s) => s.group === group) }));
}
