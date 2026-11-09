import { mixer } from "../audio/backend";
import { useFmodBackendIfConfigured } from "../audio/fmodBackend";
import { parseAudioSettings } from "../audio/settings";
import { BrowserStorage } from "../platform/BrowserStorage";
import { getFileSystem, isTauri } from "../platform/FileSystem";
import { MemoryStorage, Storage, type StorageBackend } from "../platform/Storage";
import { TauriStorage } from "../platform/TauriStorage";
import { AUTO_QUALITY_KEY, Graphics, QUALITY_KEY } from "../render/Graphics";
import { FrameMonitor } from "../render/qualityDetect";
import { Assets, type AssetSource } from "../scene/Assets";
import { parseGraphics } from "./graphics";
import { navigationSettingsProblems, physicsBackendProblems, type ProjectSettings, type ProjectSettingsInput } from "./settings";
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
 * What an Engine sets up from project settings before its bootstrap runs (ADR 0159): asset sources,
 * storage (ADR 0024), warnings for bad graphics, navigation, physics and audio sections, the mixer
 * and FMOD (ADR 0097), and the graphics tier (ADR 0050, 0055). Returns the automatic-quality monitor
 * when the tier is being detected, else null.
 */
export async function bootProject(settings: ProjectSettings, options: ProjectBootOptions): Promise<FrameMonitor | null> {
  for (const source of ([] as AssetSource[]).concat(options.assets ?? [])) Assets.addSource(source);
  Storage.use(options.storage ?? (await defaultStorage(settings.name, !options.draws)));
  // Graphics quality (ADR 0050): the project's tiers, and the player's saved choice; with
  // `autoDetect`, a detected tier until the player picks one (ADR 0055).
  for (const p of parseGraphics(options.project?.graphics).problems) console.warn(`[myco] project.json ${p}`);
  // Navigation (ADR 0065): a bad section falls back to defaults, so say what was replaced.
  if (options.project?.navigation !== undefined) for (const p of navigationSettingsProblems(options.project.navigation)) console.warn(`[myco] project.json ${p}`);
  // Physics backends (ADR 0137): a bad id is ignored (the only enabled backend is used).
  for (const p of physicsBackendProblems(options.project?.physics)) console.warn(`[myco] project.json ${p}`);
  // Audio (ADR 0097): the project's mixer buses; one shared mixer, like the one audio context.
  for (const p of parseAudioSettings(options.project?.audio).problems) console.warn(`[myco] project.json ${p}`);
  mixer.configure(settings.audio);
  if (settings.audio.backend === "fmod" && options.kind === "runtime") await useFmodBackendIfConfigured(settings.audio);
  if (options.quality !== "player") return null;
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

/** Platform storage (ADR 0024): files in the app data folder under Tauri, IndexedDB in a browser, memory when headless. */
async function defaultStorage(gameName: string, headless: boolean): Promise<StorageBackend> {
  if (headless) return new MemoryStorage();
  if (isTauri()) return TauriStorage.create(await getFileSystem());
  if (typeof indexedDB !== "undefined") return new BrowserStorage(gameName);
  return new MemoryStorage();
}
