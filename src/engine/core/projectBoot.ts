import { BrowserStorage } from "../platform/BrowserStorage";
import { getFileSystem, isTauri } from "../platform/FileSystem";
import { MemoryStorage, type StorageBackend } from "../platform/Storage";
import { TauriStorage } from "../platform/TauriStorage";
import { AUTO_QUALITY_KEY, Graphics, QUALITY_KEY } from "../render/Graphics";
import { FrameMonitor } from "../render/qualityDetect";
import type { AssetSource } from "../scene/Assets";
import { acquireProjectContext, type ProjectContext } from "./projectContext";
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

export interface BootedProject {
  /** What the Engine registered (ADR 0319); its dispose releases it. */
  context: ProjectContext;
  /** The automatic-quality monitor when the tier is being detected, else null. */
  monitor: FrameMonitor | null;
}

/**
 * What an Engine sets up from project settings before its bootstrap runs (ADR 0238): warnings for every runtime
 * section's problems and warnings (ADR 0272), then one project context (ADR 0319) holding its asset sources, storage
 * (ADR 0024), the mixer (ADR 0097) and the graphics tier (ADR 0050, 0055), acquired once everything it needs is read,
 * so a failure leaves nothing registered. Returns the context and the automatic-quality monitor.
 */
export async function bootProject(settings: ProjectSettings, options: ProjectBootOptions): Promise<BootedProject> {
  const storage = options.storage ?? (await defaultStorage(settings.name, !options.draws));
  // One rule for every runtime section (ADR 0272): each problem and warning its parse reports. A bad value was
  // replaced by its default in `settings`, and the problem says so.
  const issues = settingsIssues(options.project);
  for (const issue of [...issues.problems, ...issues.warnings]) console.warn(`[myco] project.json ${issue.message}`);
  // Graphics quality (ADR 0050): the project's tiers, and the player's saved choice; with
  // `autoDetect`, a detected tier until the player picks one (ADR 0055).
  const graphics = settings.graphics;
  const player = options.quality === "player";
  const read = (key: string) => Promise.resolve().then(() => storage.load("settings", key)).catch(() => undefined);
  const saved = player ? await read(QUALITY_KEY) : undefined;
  const auto = player && graphics.autoDetect ? await read(AUTO_QUALITY_KEY) : undefined;
  // Audio (ADR 0097): the project's mixer buses; one shared mixer, like the one audio context.
  const context = acquireProjectContext({ assets: options.assets, storage, audio: settings.audio, ...(player ? { graphics: { settings: graphics, saved, auto } } : {}) });
  if (!player) return { context, monitor: null };
  const detect = graphics.autoDetect && options.draws && options.kind === "runtime" && (saved === undefined || Graphics.autoDetected);
  if (!detect) return { context, monitor: null };
  if (!Graphics.autoDetected) Graphics._applyDetected(Graphics.detectQuality());
  const monitor = new FrameMonitor({ targetFps: graphics.targetFrameRate });
  monitor.setAtLowest(Graphics.tiers.indexOf(Graphics.quality) <= 0);
  return { context, monitor };
}

/** Platform storage (ADR 0024): files in the app data folder under Tauri, IndexedDB in a browser, memory when headless. */
async function defaultStorage(gameName: string, headless: boolean): Promise<StorageBackend> {
  if (headless) return new MemoryStorage();
  if (isTauri()) return TauriStorage.create(await getFileSystem());
  if (typeof indexedDB !== "undefined") return new BrowserStorage(gameName);
  return new MemoryStorage();
}
