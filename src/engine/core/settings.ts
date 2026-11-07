import { parseGraphics, type GraphicsSettings } from "./graphics";
import { parseNavigationSettings, type NavigationSettings } from "../nav/settings";
import { parseAudioSettings, type AudioSettings } from "../audio/settings";
import type { BootstrapSetting } from "./worlds";
import { lobbyOptionProblems } from "../net/lobby/protocol";

/** How the game canvas scales to its container (see `ProjectSettings.display.scaleMode`). */
export type ScaleMode = "fit" | "stretch" | "pixel-perfect";
export const SCALE_MODES: readonly ScaleMode[] = ["fit", "stretch", "pixel-perfect"];

/** Project settings, normally loaded from the game's `project.json`. */
export interface ProjectSettings {
  name: string;
  display: {
    /** Reference resolution. The canvas keeps this aspect ratio and scales to fit its container. */
    width: number;
    height: number;
    backgroundColor: string;
    /**
     * How the canvas fits its container (ADR 0116): "fit" keeps the aspect ratio and scales to the
     * largest size that fits (letterboxed); "stretch" fills the container, ignoring the aspect
     * ratio; "pixel-perfect" scales by whole numbers only (falling back to "fit" when the
     * container is smaller than the reference size).
     */
    scaleMode: ScaleMode;
  };
  time: {
    fixedDeltaTime: number;
    maxSubSteps: number;
    maxFrameTime: number;
  };
  physics: {
    /** Gravity in m/s²: `[x, y]`, or `[x, y, z]` for 3D physics (z is 0 when left out, ADR 0045). */
    gravity: [number, number] | [number, number, number];
    /** Named collision layers (max 16). Index 0 is the default layer. */
    layers: string[];
    /**
     * Which layers collide, as symmetric pairs: `{ "Player": ["Ground", "Obstacle"] }`.
     * When omitted, every layer collides with every other layer.
     */
    collisionMatrix?: Record<string, string[]>;
  };
  render: {
    /** Sorting layers from back to front (ADR 0014). */
    sortingLayers: string[];
    /** Default sprite pixels per world unit (ADR 0014). */
    pixelsPerUnit: number;
  };
  /** Graphics quality tiers (ADR 0050). Omitted: Low, Medium, High and Ultra, defaulting to High. */
  graphics: GraphicsSettings;
  /** Built-in navigation (ADR 0065): agent types, areas, voxel sizes, runtime budgets. Omitted: one person-sized walker. */
  navigation: NavigationSettings;
  /** Audio mixer buses, snapshots, ducking and the backend (ADR 0097, 0098). Omitted: Master with Music, SFX, UI and Voice. */
  audio: AudioSettings;
  /** Scene/prefab files instanced under the World root at startup; they persist across scene loads (ADR 0016). */
  autoload: string[];
  /** Which Worlds the Engine creates at start (ADR 0032). Omitted: the default bootstrap, one World. */
  bootstrap?: BootstrapSetting;
}

export type ProjectSettingsInput = {
  [K in Exclude<keyof ProjectSettings, "audio">]?: ProjectSettings[K] extends object[] | string[]
    ? ProjectSettings[K]
    : ProjectSettings[K] extends object
      ? Partial<ProjectSettings[K]>
      : ProjectSettings[K];
} & {
  /** Read leniently by `parseAudioSettings`; bad entries are reported, not fatal. */
  audio?: Record<string, unknown>;
};

export const defaultSettings: ProjectSettings = {
  name: "Untitled",
  display: { width: 1280, height: 720, backgroundColor: "#000000", scaleMode: "fit" },
  time: { fixedDeltaTime: 1 / 60, maxSubSteps: 5, maxFrameTime: 0.25 },
  physics: { gravity: [0, -9.81], layers: ["Default"] },
  render: { sortingLayers: ["Default"], pixelsPerUnit: 100 },
  graphics: parseGraphics(undefined).graphics,
  navigation: parseNavigationSettings(undefined).settings,
  audio: parseAudioSettings(undefined).settings,
  autoload: [],
};

export function resolveSettings(input: ProjectSettingsInput = {}): ProjectSettings {
  return {
    name: input.name ?? defaultSettings.name,
    display: { ...defaultSettings.display, ...input.display },
    time: { ...defaultSettings.time, ...input.time },
    physics: { ...defaultSettings.physics, ...input.physics },
    render: { ...defaultSettings.render, ...input.render },
    graphics: parseGraphics(input.graphics).graphics, // problems are reported by the Engine and the Project panel
    navigation: parseNavigationSettings(input.navigation).settings, // problems are reported by the Engine (`navigationSettingsProblems`) and the Project panel
    audio: parseAudioSettings(input.audio).settings, // problems are reported by the Engine and the Project panel
    autoload: input.autoload ?? [],
    ...(input.bootstrap !== undefined ? { bootstrap: input.bootstrap } : {}), // checked by validateBootstrap when the bootstrap runs
  };
}

/** Everything wrong with a `navigation` section (ADR 0065), as readable sentences, like `parseGraphics(...).problems`. */
export function navigationSettingsProblems(input: unknown): string[] {
  return parseNavigationSettings(input).problems;
}

const BOOTSTRAP_KEYS = ["worlds", "links", "templates"];
const WORLD_KEYS = ["name", "tags", "tickRate", "timeScale", "renders", "input", "scenes", "systems", "lobby"];
const LINK_KEYS = ["from", "to", "transport", "options"];

/**
 * Everything wrong with a `bootstrap` setting (ADR 0032), as readable sentences; empty when it's
 * valid. `catalog` is the system catalog (`listSystemCatalog()`) that `systems.include` and
 * `exclude` are checked against; without it, system names aren't checked. A script path is only
 * checked for being non-empty, since loading it is the bootstrap's job.
 *
 * Unknown keys are errors, not warnings: the editor writes `project.json`, so an unknown key is
 * almost always a typo (`"tickrate"`) that would otherwise be silently ignored.
 */
export function validateBootstrap(setting: unknown, catalog?: readonly { readonly name: string }[]): string[] {
  const problems: string[] = [];
  if (setting === undefined || typeof setting === "function") return problems;
  if (typeof setting === "string") {
    if (setting.trim() === "") problems.push("bootstrap: a code bootstrap's script path can't be empty.");
    return problems;
  }
  if (!isRecord(setting)) {
    problems.push(`bootstrap must be an object listing Worlds, or the path of a bootstrap script (got ${describe(setting)}).`);
    return problems;
  }
  unknownKeys(setting, BOOTSTRAP_KEYS, "bootstrap", problems);
  const known = catalog ? catalog.map((s) => s.name) : undefined;

  const names: string[] = [];
  if (!Array.isArray(setting.worlds)) {
    problems.push(`bootstrap.worlds must be a list of Worlds (got ${describe(setting.worlds)}).`);
  } else if (setting.worlds.length === 0) {
    problems.push("bootstrap.worlds must list at least one World.");
  } else {
    setting.worlds.forEach((world: unknown, i) => {
      const name = isRecord(world) && typeof world.name === "string" && world.name.trim() !== "" ? world.name : undefined;
      const where = `bootstrap.worlds[${i}]${name !== undefined ? ` ("${name}")` : ""}`;
      worldProblems(world, where, true, known, problems);
      if (name === undefined) return;
      if (names.includes(name)) problems.push(`${where}: another World is already named "${name}"; World names must be unique.`);
      else names.push(name);
    });
  }

  // Links name start-up Worlds or Spawnable Worlds: a template's World name, its `name` or its key (ADR 0062).
  const spawnable = isRecord(setting.templates)
    ? Object.entries(setting.templates).map(([key, t]) => (isRecord(t) && typeof t.name === "string" && t.name.trim() !== "" ? t.name : key))
    : [];
  if (setting.links !== undefined) {
    if (!Array.isArray(setting.links)) problems.push(`bootstrap.links must be a list of links (got ${describe(setting.links)}).`);
    else setting.links.forEach((link: unknown, i) => linkProblems(link, `bootstrap.links[${i}]`, [...names, ...spawnable], problems));
  }

  if (setting.templates !== undefined) {
    if (!isRecord(setting.templates)) {
      problems.push(`bootstrap.templates must be an object of World configs by template name (got ${describe(setting.templates)}).`);
    } else {
      for (const [key, template] of Object.entries(setting.templates)) {
        if (key.trim() === "") problems.push("bootstrap.templates: a template's name can't be empty.");
        worldProblems(template, `bootstrap.templates["${key}"]`, false, known, problems);
      }
    }
  }
  return problems;
}

/** `"an unknown system: "x". Known systems: a, b."`, to end a problem sentence. */
export function describeUnknownSystems(names: readonly string[], known: readonly string[]): string {
  const which = names.length === 1 ? "an unknown system" : "unknown systems";
  const listed = known.length > 0 ? `Known systems: ${known.join(", ")}.` : "No systems are defined.";
  return `${which}: ${names.map((n) => `"${n}"`).join(", ")}. ${listed}`;
}

function worldProblems(world: unknown, where: string, nameRequired: boolean, known: readonly string[] | undefined, problems: string[]): void {
  if (!isRecord(world)) {
    problems.push(`${where} must be a World config object (got ${describe(world)}).`);
    return;
  }
  unknownKeys(world, WORLD_KEYS, where, problems);
  if ((nameRequired || world.name !== undefined) && (typeof world.name !== "string" || world.name.trim() === "")) {
    problems.push(`${where}: name must be a non-empty string (got ${describe(world.name)}).`);
  }
  if (world.tags !== undefined && !isStringList(world.tags)) problems.push(`${where}: tags must be a list of strings (got ${describe(world.tags)}).`);
  const tickRate = world.tickRate;
  if (tickRate !== undefined && !(typeof tickRate === "number" && Number.isFinite(tickRate) && tickRate > 0)) {
    problems.push(`${where}: tickRate must be a positive number (got ${describe(tickRate)}).`);
  }
  const timeScale = world.timeScale;
  if (timeScale !== undefined && !(typeof timeScale === "number" && Number.isFinite(timeScale) && timeScale >= 0)) {
    problems.push(`${where}: timeScale must be 0 (paused) or more (got ${describe(timeScale)}).`);
  }
  for (const key of ["renders", "input"]) {
    if (world[key] !== undefined && typeof world[key] !== "boolean") problems.push(`${where}: ${key} must be true or false (got ${describe(world[key])}).`);
  }
  if (world.scenes !== undefined && !isStringList(world.scenes)) problems.push(`${where}: scenes must be a list of scene paths (got ${describe(world.scenes)}).`);
  if (world.lobby !== undefined) problems.push(...lobbyOptionProblems(world.lobby, `${where}: lobby`)); // ADR 0068

  const systems = world.systems;
  if (systems === undefined) return;
  if (!isRecord(systems)) {
    problems.push(`${where}: systems must be an object with include and exclude lists (got ${describe(systems)}).`);
    return;
  }
  unknownKeys(systems, ["include", "exclude"], `${where}.systems`, problems);
  for (const key of ["include", "exclude"]) {
    const list = systems[key];
    if (list === undefined) continue;
    if (!isStringList(list)) {
      problems.push(`${where}: systems.${key} must be a list of system names (got ${describe(list)}).`);
      continue;
    }
    const unknown = known ? list.filter((name) => !known.includes(name)) : [];
    if (known && unknown.length > 0) problems.push(`${where}: systems.${key} names ${describeUnknownSystems(unknown, known)}`);
  }
  if (isStringList(systems.include) && isStringList(systems.exclude)) {
    const exclude = systems.exclude;
    const both = systems.include.filter((name) => exclude.includes(name));
    if (both.length > 0) problems.push(`${where}: systems.include and systems.exclude both list ${both.map((n) => `"${n}"`).join(", ")}.`);
  }
}

function linkProblems(link: unknown, where: string, worlds: readonly string[], problems: string[]): void {
  if (!isRecord(link)) {
    problems.push(`${where} must be a link object with from, to and transport (got ${describe(link)}).`);
    return;
  }
  unknownKeys(link, LINK_KEYS, where, problems);
  for (const end of ["from", "to"]) {
    const name = link[end];
    if (typeof name !== "string" || name === "") problems.push(`${where}: ${end} must name a World (got ${describe(name)}).`);
    else if (!worlds.includes(name)) problems.push(`${where}: ${end} names the World "${name}", which neither bootstrap.worlds nor bootstrap.templates lists.`);
  }
  if (typeof link.from === "string" && link.from !== "" && link.from === link.to) problems.push(`${where}: links the World "${link.from}" to itself.`);
  if (typeof link.transport !== "string" || link.transport.trim() === "") {
    problems.push(`${where}: transport must be a transport name such as "loopback" (got ${describe(link.transport)}).`);
  }
  if (link.options !== undefined && !isRecord(link.options)) problems.push(`${where}: options must be an object (got ${describe(link.options)}).`);
}

function unknownKeys(value: Record<string, unknown>, keys: readonly string[], where: string, problems: string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) problems.push(`${where}: unknown key "${key}" (expected ${keys.join(", ")}).`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const json = JSON.stringify(value);
    return json.length <= 40 ? json : "a list";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return String(value);
}
