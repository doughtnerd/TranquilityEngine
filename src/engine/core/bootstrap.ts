/**
 * Bootstraps (ADR 0032): which Worlds an Engine creates at start, and which catalog systems a new
 * World gets. `Engine.create` calls `resolveBootstrap` and runs the result; `createWorld` adds the
 * systems `selectSystems` picks. A bootstrap is the default one, a declarative `BootstrapConfig`
 * from `project.json`, or a project script's `bootstrap(engine)` export.
 */
import { describeUnknownSystems, validateBootstrap } from "./settings";
import { listSystemCatalog, type SystemCatalogEntry } from "./systems";
import { DEFAULT_WORLD_NAME, DEFAULT_WORLD_TAGS, worldsMatch, type Bootstrap, type BootstrapConfig, type BootstrapSetting, type LinkConfig, type WorldConfig } from "./worlds";

/** A bootstrap setting or World config that isn't valid. `problems` lists everything wrong, one sentence each. */
export class BootstrapError extends Error {
  constructor(
    summary: string,
    readonly problems: readonly string[],
  ) {
    super(`${summary}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "BootstrapError";
  }
}

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
 * as is, the default one for nothing, a declarative one for a `BootstrapConfig`, and the script's
 * export for a path. A declarative bootstrap validates its config when it runs, against the system
 * catalog at that time, since project scripts may define systems before it.
 */
export async function resolveBootstrap(setting: BootstrapSetting | Bootstrap | undefined, options: ResolveBootstrapOptions = {}): Promise<Bootstrap> {
  if (setting === undefined) return defaultBootstrap;
  if (typeof setting === "function") return setting;
  if (typeof setting === "string") return loadCodeBootstrap(setting, options);
  return declarativeBootstrap(setting);
}

async function loadCodeBootstrap(path: string, options: ResolveBootstrapOptions): Promise<Bootstrap> {
  const problems = validateBootstrap(path);
  if (problems.length > 0) throw new BootstrapError("Invalid bootstrap", problems);
  if (!options.loadScript) {
    throw new Error(
      `The code bootstrap "${path}" needs a script loader to import it (the editor provides one). ` +
        `Outside the editor, import the script's bootstrap function yourself and pass it as EngineOptions.bootstrap: ` +
        `Engine.create({ bootstrap }).`,
    );
  }
  const bootstrap: unknown = await options.loadScript(path);
  if (typeof bootstrap !== "function") throw new Error(`The bootstrap script "${path}" must export a function named bootstrap(engine).`);
  return bootstrap as Bootstrap;
}

function declarativeBootstrap(config: BootstrapConfig): Bootstrap {
  return async (engine) => {
    assertValidBootstrap(config, listSystemCatalog());
    for (const world of config.worlds) engine.createWorld(world);
    // Links are validated above; connecting them is T10's (ADR 0033), through `bootstrapLinks`.
  };
}

/** Throw a `BootstrapError` listing every problem `validateBootstrap` finds in `setting`. */
export function assertValidBootstrap(setting: unknown, catalog: readonly SystemCatalogEntry[] = listSystemCatalog()): void {
  const problems = validateBootstrap(setting, catalog);
  if (problems.length > 0) throw new BootstrapError("Invalid bootstrap", problems);
}

/**
 * The links between start-up Worlds that `setting` declares, after validating it (system names
 * aren't checked here). Empty for code bootstraps and the default one.
 */
export function bootstrapLinks(setting: BootstrapSetting | Bootstrap | undefined): readonly LinkConfig[] {
  if (setting === undefined || typeof setting === "function" || typeof setting === "string") return [];
  const problems = validateBootstrap(setting);
  if (problems.length > 0) throw new BootstrapError("Invalid bootstrap", problems);
  return setting.links ?? [];
}

/**
 * The World config for `Engine.createWorld("Match")`: the template named `name` in `setting`, named
 * after the template unless it names itself. Throws if there's no such template.
 */
export function templateConfig(setting: BootstrapSetting | Bootstrap | undefined, name: string): WorldConfig {
  const templates = typeof setting === "object" ? setting.templates : undefined;
  const template = templates && Object.hasOwn(templates, name) ? templates[name] : undefined;
  if (!template) {
    const known = templates ? Object.keys(templates) : [];
    const listed = known.length > 0 ? `Templates: ${known.join(", ")}.` : "The project's bootstrap defines no templates.";
    throw new Error(`There's no World template named "${name}". ${listed}`);
  }
  const config = { ...template, name: template.name ?? name };
  const problems = validateBootstrap({ worlds: [config] }).map((p) => p.replace(/^bootstrap\.worlds\[0\]/, `bootstrap.templates["${name}"]`));
  if (problems.length > 0) throw new BootstrapError(`Invalid World template "${name}"`, problems);
  return config;
}

/**
 * The catalog systems a World made from `config` gets: those whose `worlds` filter matches its
 * tags, plus `systems.include`, minus `systems.exclude`, in catalog order. Throws a
 * `BootstrapError` if include or exclude names a system the catalog doesn't have.
 */
export function selectSystems(config: WorldConfig, catalog: readonly SystemCatalogEntry[]): string[] {
  const tags = config.tags ?? DEFAULT_WORLD_TAGS;
  const include = new Set(config.systems?.include ?? []);
  const exclude = new Set(config.systems?.exclude ?? []);
  const known = catalog.map((s) => s.name);
  const problems: string[] = [];
  for (const [key, names] of [["include", include], ["exclude", exclude]] as const) {
    const unknown = [...names].filter((n) => !known.includes(n));
    if (unknown.length > 0) problems.push(`systems.${key} names ${describeUnknownSystems(unknown, known)}`);
  }
  if (problems.length > 0) throw new BootstrapError(`Invalid systems for the World "${config.name}"`, problems);
  return catalog.filter((s) => (worldsMatch(s.worlds, tags) || include.has(s.name)) && !exclude.has(s.name)).map((s) => s.name);
}
