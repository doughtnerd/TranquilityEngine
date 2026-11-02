/**
 * Bootstraps (ADR 0032): which Worlds an Engine creates at start, and which catalog systems a new
 * World gets. Contract for wave 1: T1's `Engine.create` calls `resolveBootstrap` and runs the
 * result, and T1's `createWorld` adds the systems `selectSystems` picks. T4 implements the
 * declarative and code bootstraps and the validation.
 */
import type { SystemCatalogEntry } from "./systems";
import { DEFAULT_WORLD_NAME, DEFAULT_WORLD_TAGS, notYet, worldsMatch, type Bootstrap, type BootstrapSetting, type WorldConfig } from "./worlds";

/** The default bootstrap: one World named Default, tagged default and local (it renders and takes input if the Engine can). */
export const defaultBootstrap: Bootstrap = (engine) => {
  engine.createWorld({ name: DEFAULT_WORLD_NAME, tags: DEFAULT_WORLD_TAGS });
};

export interface ResolveBootstrapOptions {
  /** Load a project script's `bootstrap` export, for `"bootstrap": "scripts/Bootstrap.ts"` (the editor passes its script loader, ADR 0030). */
  loadScript?: (path: string) => Promise<Bootstrap>;
}

/**
 * The bootstrap to run for `setting` (`EngineOptions.bootstrap`, else `project.json`'s): a function
 * as is, nothing for the default one. Declarative configs and script paths: T4.
 */
export async function resolveBootstrap(setting: BootstrapSetting | Bootstrap | undefined, _options: ResolveBootstrapOptions = {}): Promise<Bootstrap> {
  if (setting === undefined) return defaultBootstrap;
  if (typeof setting === "function") return setting;
  return notYet("T4", typeof setting === "string" ? `The code bootstrap "${setting}"` : "Declarative bootstraps");
}

/**
 * The catalog systems a World made from `config` gets: those whose `worlds` filter matches its
 * tags, plus `systems.include`, minus `systems.exclude`, in catalog order. (T4 adds errors for
 * unknown names.)
 */
export function selectSystems(config: WorldConfig, catalog: readonly SystemCatalogEntry[]): string[] {
  const tags = config.tags ?? DEFAULT_WORLD_TAGS;
  const include = new Set(config.systems?.include ?? []);
  const exclude = new Set(config.systems?.exclude ?? []);
  return catalog.filter((s) => (worldsMatch(s.worlds, tags) || include.has(s.name)) && !exclude.has(s.name)).map((s) => s.name);
}
