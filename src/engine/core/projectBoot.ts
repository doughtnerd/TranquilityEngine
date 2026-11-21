import { mixer } from "../audio/mixer";
import { MemoryStorage, Storage, type StorageBackend } from "../platform/Storage";
import { openStorage } from "../platform/storageScope";
import { AUTO_QUALITY_KEY, Graphics, QUALITY_KEY } from "../render/Graphics";
import { FrameMonitor } from "../render/qualityDetect";
import { Assets, type AssetSource } from "../scene/Assets";
import { notifyAudioConfigured } from "./audioConfigure";
import { settingsIssues, type ProjectSettings, type ProjectSettingsInput } from "./settings";
import type { WorldKind } from "./World";

export interface ProjectBootOptions {
  /** `project.json` as given, for the sections' warnings. */
  project?: ProjectSettingsInput;
  assets?: AssetSource | AssetSource[];
  storage?: StorageBackend;
  /** Whether the Engine draws (it has a container). */
  draws: boolean;
  kind: WorldKind;
  quality: "player" | "keep";
}

/**
 * What an Engine sets up from project settings before its bootstrap runs (ADR 0238): asset sources,
 * storage (ADR 0024), warnings for every runtime section's problems and warnings (ADR 0272), the mixer
 * (ADR 0097) and its configure notice, and the graphics tier (ADR 0050, 0055). Returns the automatic-quality monitor
 * when the tier is being detected, else null.
 */
export async function bootProject(settings: ProjectSettings, options: ProjectBootOptions): Promise<FrameMonitor | null> {
  for (const source of ([] as AssetSource[]).concat(options.assets ?? [])) Assets.addSource(source);
  // Storage for this game (ADR 0317): a host that knows better (the editor's Play: the project's own) passes it.
  Storage.use(options.storage ?? (options.draws ? await openStorage({ kind: "game", name: settings.name }) : new MemoryStorage()));
  // One rule for every runtime section (ADR 0272): each problem and warning its parse reports. A bad value was
  // replaced by its default in `settings`, and the problem says so.
  const issues = settingsIssues(options.project);
  for (const issue of [...issues.problems, ...issues.warnings]) console.warn(`[myco] project.json ${issue.message}`);
  // Audio (ADR 0097): the project's mixer buses; one shared mixer, like the one audio context.
  mixer.configure(settings.audio);
  // Listeners (the audio core's page host, `./audioConfigure`) remap live voices to the new buses.
  notifyAudioConfigured(settings.audio);
  if (options.quality !== "player") return null;
  // Graphics quality (ADR 0050): the project's tiers, and the player's saved choice; with
  // `autoDetect`, a detected tier until the player picks one (ADR 0055).
  const graphics = settings.graphics;
  const saved = await Storage.load(QUALITY_KEY, "settings").catch(() => undefined);
  const auto = graphics.autoDetect ? await Storage.load(AUTO_QUALITY_KEY, "settings").catch(() => undefined) : undefined;
  Graphics._configure(graphics, saved, auto);
  const detect = graphics.autoDetect && options.draws && options.kind === "runtime" && (saved === undefined || Graphics.autoDetected);
  if (!detect) return null;
  if (!Graphics.autoDetected) Graphics._applyDetected(Graphics.detectQuality());
  const monitor = new FrameMonitor({ targetFps: graphics.targetFrameRate });
  monitor.setAtLowest(Graphics.tiers.indexOf(Graphics.quality) <= 0);
  return monitor;
}
