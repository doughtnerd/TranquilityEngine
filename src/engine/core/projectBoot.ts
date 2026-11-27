import { bootActionSets } from "../input/actionAssets";
import { bootLocale } from "../localisation/runtime/boot";
import { MemoryStorage, type StorageBackend } from "../platform/Storage";
import { openStorage } from "../platform/storageScope";
import { AUTO_QUALITY_KEY, startAutoQuality, type AutoQuality } from "../render/autoQuality";
import { QUALITY_KEY } from "../render/Graphics";
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
  /** Automatic quality (ADR 0322) when the tier is being detected, else null; the Engine hands it each frame's time step. */
  autoQuality: AutoQuality | null;
}

/**
 * What an Engine sets up from project settings before its bootstrap runs (ADR 0238): warnings for every runtime
 * section's problems and warnings (ADR 0272), then one project context (ADR 0319) holding its asset sources, storage
 * (ADR 0024), the mixer (ADR 0097) and the graphics tier (ADR 0050, 0055), acquired once everything it needs is read,
 * so a failure leaves nothing registered; then the action set assets (ADR 0433); then `Locale` (ADR 0356) in the start language. Returns the context and automatic quality (ADR 0322).
 */
export async function bootProject(settings: ProjectSettings, options: ProjectBootOptions): Promise<BootedProject> {
  // Storage for this game (ADR 0317): a host that knows better (the editor's Play: the project's own) passes it.
  const storage = options.storage ?? (options.draws ? await openStorage({ kind: "game", name: settings.name }) : new MemoryStorage());
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
  // Action set assets (ADR 0433), in the listed order, before the bootstrap so every World's players get them. Lenient.
  bootActionSets(settings.input.actionSets);
  // Text localisation (ADR 0356 §6): the project's languages and strings, and the start language's strings and fonts,
  // loaded before the first scene. Lenient: it never throws.
  await bootLocale(settings, { storage, kind: options.kind, player, draws: options.draws });
  // Automatic quality (ADR 0055, 0322) for a runtime that draws: it decides whether to detect and makes the first pick.
  const autoQuality = player && options.draws && options.kind === "runtime" ? startAutoQuality(graphics, saved) : null;
  return { context, autoQuality };
}
