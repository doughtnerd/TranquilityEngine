import { parseGraphics, type GraphicsSettings } from "./graphics";
import { parseLighting2D, type Lighting2DSettings } from "../render/lights2D/settings";
import { parseNavigationSettings, type NavigationSettings } from "../nav/settings";
import { parseAudioSettings, type AudioSettings } from "../audio/settings";
import type { BootstrapSetting } from "./worlds";
import { lobbyOptionProblems } from "../net/lobby/protocol";
import { bootstrapTopology } from "./bootstrapTopology";
import { parseLanguages, type LanguageSettings } from "../localisation/languages";
import { parseSubtitleSettings, type SubtitleProjectSettings } from "../localisation/subtitleSettings";

/** How the game canvas scales to its container (see `ProjectSettings.display.scaleMode`). */
export type ScaleMode = "fit" | "stretch" | "pixel-perfect";
export type InputJoinPolicy = "single" | "onePerDevice" | "pressToJoin" | "manual";
export const INPUT_JOIN_POLICIES: readonly InputJoinPolicy[] = ["single", "onePerDevice", "pressToJoin", "manual"];
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
    /**
     * The physics backend for 2D and for 3D, by id (ADR 0137; Rapier's is `"rapier"`). Omitted: the only
     * one enabled. Backends come from plugins, so the engine checks only the form (`RUNTIME_SETTINGS.physics`).
     */
    backend2d?: string;
    backend3d?: string;
  };
  render: {
    /** Sorting layers from back to front (ADR 0014). */
    sortingLayers: string[];
    /** Default sprite pixels per world unit (ADR 0014). */
    pixelsPerUnit: number;
    /**
     * How many decals each World's `Decals` pool holds of each kind, 3D and 2D (ADR 0395); spawning past it fades out
     * the oldest. Placed decal Components don't count. Optional in `project.json`: 1000.
     */
    maxDecals: number;
  };
  /** Graphics quality tiers (ADR 0050). Omitted: Low, Medium, High and Ultra, defaulting to High. */
  graphics: GraphicsSettings;
  /** 2D lighting (ADR 0399): the light blend styles. Omitted: one, Multiply. */
  lighting2D: Lighting2DSettings;
  /** Built-in navigation (ADR 0065): agent types, areas, voxel sizes, runtime budgets. Omitted: one person-sized walker. */
  navigation: NavigationSettings;
  /** Audio mixer buses, snapshots, ducking and the backend (ADR 0097, 0098): `audio.json`'s runtime view (ADR 0344), never a `project.json` section. Omitted: Master with Music, SFX, UI and Voice. */
  audio: AudioSettings;
  /**
   * Input players (ADR 0337): how players join, and how many local players there can be. `single` (default):
   * player 0 owns every device; `onePerDevice`: the keyboard and pointer are one player, each gamepad another;
   * `pressToJoin`: a device's first press makes it a new player; `manual`: the game joins players (`InputPlayers`).
   */
  input: {
    join: InputJoinPolicy;
    maxPlayers: number;
    /** Action set assets (`*.actions.json`, ADR 0417) defined at boot, in this order. */
    actionSets: string[];
  };
  /** Scene/prefab files instanced under the World root at startup; they persist across scene loads (ADR 0016). */
  autoload: string[];
  /** Which Worlds the Engine creates at start (ADR 0032). Omitted: the default bootstrap, one World. */
  bootstrap?: BootstrapSetting;
  /**
   * Per-project plugin enabling (ADR 0133): only what's off is stored, so new first-party plugins default on.
   * A plugin is also off when one it depends on is. Names are read by the hosts (`resolveEnabledPlugins`).
   */
  plugins?: PluginSettings;
  /**
   * The game's languages for text and audio (ADR 0354 §1, 0356 §3, 0357 §2): codes, reference, default, fallbacks,
   * shipping, fonts, direction, voice. Omitted: English only (`localisation/languages.ts`).
   */
  languages: LanguageSettings;
  /** Subtitles (ADR 0357 §5): player defaults, reading speed, speakers. Omitted: the defaults (`localisation/subtitleSettings.ts`). */
  subtitles: SubtitleProjectSettings;
}

/** `project.json`'s `plugins` section. */
export interface PluginSettings {
  disabled?: string[];
  /**
   * ADR 0358 §6: where plugin audio effects' wasm modules run. "chromium" (absent) runs them on Chromium's engine only
   * (the only one measured so far); "all" runs them everywhere. Read by the audio plugin.
   */
  audioEffectEngines?: "chromium" | "all";
}

/**
 * Everything wrong with a `plugins` section, as readable sentences: `problems` are malformed values,
 * `warnings` are names in `disabled` that aren't among `known` (checked only when `known` is given: the
 * engine doesn't know the plugins, ADR 0010; a removed plugin must not stop a project from loading).
 */
export function pluginSettingsProblems(input: unknown, known?: readonly string[]): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (input === undefined) return { problems, warnings };
  if (!isRecord(input)) return { problems: [`plugins must be an object with a disabled list (got ${describe(input)}).`], warnings };
  unknownKeys(input, ["disabled", "audioEffectEngines"], "plugins", problems);
  const engines = input.audioEffectEngines;
  if (engines !== undefined && engines !== "chromium" && engines !== "all") problems.push(`plugins.audioEffectEngines must be "chromium" or "all" (got ${describe(engines)}); using "chromium".`);
  const list = input.disabled;
  if (list === undefined) return { problems, warnings };
  if (!isStringList(list)) return { problems: [...problems, `plugins.disabled must be a list of plugin names (got ${describe(list)}).`], warnings };
  const seen = new Set<string>();
  for (const name of list) {
    if (seen.has(name)) problems.push(`plugins.disabled lists "${name}" twice.`);
    seen.add(name);
    if (known && !known.includes(name)) warnings.push(`plugins.disabled names "${name}", which isn't a known plugin; it is ignored.`);
  }
  return { problems, warnings };
}

export type ProjectSettingsInput = {
  [K in Exclude<keyof ProjectSettings, "audio">]?: ProjectSettings[K] extends object[] | string[]
    ? ProjectSettings[K]
    : ProjectSettings[K] extends object
      ? Partial<ProjectSettings[K]>
      : ProjectSettings[K];
} & {
  /** The runtime's audio settings: `audio.json`'s runtime view, which hosts set with `projectWithAudio` (ADR 0344; a `project.json` `audio` section is refused there). Read leniently by `parseAudioSettings`; bad entries are reported, not fatal. */
  audio?: Record<string, unknown>;
};

// --- Runtime sections (ADR 0272) ------------------------------------------------------------------

/** Physics layers are bits in a 16-bit collision mask. */
export const MAX_PHYSICS_LAYERS = 16;

/** Something wrong with a `project.json` value: the dotted field it's about (`"display.width"`, `"physics.layers.2"`, or the section's key) and a sentence. */
export interface SettingsIssue {
  readonly field: string;
  readonly message: string;
}

/** The project.json keys the engine reads itself, each declared once in `RUNTIME_SETTINGS`. `bootstrap` isn't one: it's checked against the system catalog when the bootstrap runs (`validateBootstrap`). */
export type RuntimeSettingsKey = Exclude<keyof ProjectSettings, "bootstrap">;

/**
 * One runtime `project.json` section (ADR 0272): its key, its default, and a lenient parse. `parse(written)` never
 * throws: `value` is what the engine runs with (what's written over the default, a value of the wrong type or range
 * replaced by its default), `problems` say what's wrong (and what was replaced), and `warnings` are things that work
 * but are probably unintended. An absent section (`undefined`) parses to the default with nothing to say.
 */
export interface RuntimeSettingsSection<K extends RuntimeSettingsKey = RuntimeSettingsKey> {
  readonly key: K;
  readonly default: ProjectSettings[K];
  parse(written: unknown): { value: ProjectSettings[K]; problems: SettingsIssue[]; warnings: SettingsIssue[] };
}

type Parsed<K extends RuntimeSettingsKey> = ReturnType<RuntimeSettingsSection<K>["parse"]>;

const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isPositiveInt = (v: unknown): v is number => isPositive(v) && Number.isInteger(v);
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const asIssues = (field: string, messages: readonly string[]): SettingsIssue[] => messages.map((message) => ({ field, message }));

/** A record's fields over `defaults`, each field kept only when `valid` (else its default, and `message` as a problem under `section.field`). */
function fieldsOver<T extends object>(section: string, written: unknown, defaults: T, rules: { [F in keyof T]?: [valid: (v: unknown) => boolean, message: string] }, problems: SettingsIssue[]): T {
  if (written === undefined) return { ...defaults };
  if (!isRecord(written)) {
    problems.push({ field: section, message: `${section} must be an object (got ${describe(written)}); the defaults are used.` });
    return { ...defaults };
  }
  const out: Record<string, unknown> = { ...defaults, ...written };
  for (const field of Object.keys(rules) as (keyof T & string)[]) {
    const v = written[field];
    if (v === undefined) continue;
    const [valid, message] = rules[field]!;
    if (valid(v)) continue;
    problems.push({ field: `${section}.${field}`, message });
    out[field] = defaults[field];
  }
  return out as T;
}

/** A list of unique, non-empty names: problems by entry (`field.i`). */
function nameListProblems(list: unknown, field: string, what: string, problems: SettingsIssue[]): void {
  if (!Array.isArray(list)) {
    problems.push({ field, message: `${what} must be a list of names.` });
    return;
  }
  if (list.length === 0) problems.push({ field, message: `There must be at least one ${what.replace(/s$/, "")}.` });
  const seen = new Set<string>();
  list.forEach((name, i) => {
    if (typeof name !== "string" || name.trim() === "") problems.push({ field: `${field}.${i}`, message: `${what}: entry ${i + 1} needs a name.` });
    else if (seen.has(name)) problems.push({ field: `${field}.${i}`, message: `${what}: "${name}" is listed twice.` });
    else seen.add(name);
  });
}

/** A name list's runtime value: the list when it's a non-empty list of strings, else the default. */
const nameListValue = (list: unknown, fallback: string[]): string[] => (isStringList(list) && list.length > 0 ? list : [...fallback]);

const DEFAULT_DISPLAY: ProjectSettings["display"] = { width: 1280, height: 720, backgroundColor: "#000000", scaleMode: "fit" };
const DEFAULT_TIME: ProjectSettings["time"] = { fixedDeltaTime: 1 / 60, maxSubSteps: 5, maxFrameTime: 0.25 };
const DEFAULT_PHYSICS: ProjectSettings["physics"] = { gravity: [0, -9.81], layers: ["Default"] };
const DEFAULT_RENDER: ProjectSettings["render"] = { sortingLayers: ["Default"], pixelsPerUnit: 100, maxDecals: 1000 };
const DEFAULT_INPUT: ProjectSettings["input"] = { join: "single", maxPlayers: 4, actionSets: [] };

function parseName(written: unknown): Parsed<"name"> {
  if (written === undefined) return { value: "Untitled", problems: [], warnings: [] };
  if (typeof written === "string" && written.trim() !== "") return { value: written, problems: [], warnings: [] };
  return { value: "Untitled", problems: [{ field: "name", message: "The project name can't be empty." }], warnings: [] };
}

function parseDisplay(written: unknown): Parsed<"display"> {
  const problems: SettingsIssue[] = [];
  const value = fieldsOver("display", written, DEFAULT_DISPLAY, {
    width: [isPositiveInt, "Display width must be a whole number of pixels above 0."],
    height: [isPositiveInt, "Display height must be a whole number of pixels above 0."],
    backgroundColor: [(v) => typeof v === "string" && HEX_COLOR.test(v), "Background colour must be a hex colour such as #1d1f24."],
    scaleMode: [(v) => (SCALE_MODES as readonly unknown[]).includes(v), `Scale mode must be one of ${SCALE_MODES.join(", ")}.`],
  }, problems);
  return { value, problems, warnings: [] };
}

function parseTime(written: unknown): Parsed<"time"> {
  const problems: SettingsIssue[] = [];
  const value = fieldsOver("time", written, DEFAULT_TIME, {
    fixedDeltaTime: [isPositive, "The fixed timestep must be above 0 seconds."],
    maxFrameTime: [isPositive, "The max frame time must be above 0 seconds."],
    maxSubSteps: [isPositiveInt, "Max sub-steps must be a whole number above 0."],
  }, problems);
  return { value, problems, warnings: [] };
}

function parsePhysics(written: unknown): Parsed<"physics"> {
  const problems: SettingsIssue[] = [];
  const p = (field: string, message: string) => problems.push({ field, message });
  const validGravity = (g: unknown) => Array.isArray(g) && (g.length === 2 || g.length === 3) && g.every((x) => typeof x === "number" && Number.isFinite(x));
  const value = fieldsOver("physics", written, DEFAULT_PHYSICS, { gravity: [validGravity, "Gravity must be two numbers, x and y, or three with z."] }, problems);
  const physics = isRecord(written) ? written : {};
  if (physics.layers !== undefined) {
    nameListProblems(physics.layers, "physics.layers", "Physics layers", problems);
    // Physics layers are named by index: keep a list of names even with a duplicate or a blank (both reported).
    value.layers = isStringList(physics.layers) && physics.layers.length > 0 ? physics.layers : [...DEFAULT_PHYSICS.layers];
  }
  // A bad backend id is dropped: the only enabled backend is used (ADR 0137). Backends come from plugins, so only the form is checked.
  for (const key of ["backend2d", "backend3d"] as const) {
    const v = physics[key];
    if (v !== undefined && (typeof v !== "string" || !v.trim())) {
      p(`physics.${key}`, `physics.${key} must be a physics backend's id, such as "rapier" (got ${describe(v)}).`);
      delete value[key];
    }
  }
  if (value.layers.length > MAX_PHYSICS_LAYERS) p("physics.layers", `There can be at most ${MAX_PHYSICS_LAYERS} physics layers.`);
  const matrix = physics.collisionMatrix;
  if (matrix !== undefined) {
    if (!isRecord(matrix)) {
      p("physics.collisionMatrix", "The collision matrix must be an object of layer lists.");
      delete value.collisionMatrix; // every layer collides with every layer
    } else {
      const unknown = new Set<string>();
      for (const [a, list] of Object.entries(matrix)) {
        if (!value.layers.includes(a)) unknown.add(a);
        if (!Array.isArray(list)) p("physics.collisionMatrix", `The collision matrix entry for "${a}" must be a list of layers.`);
        else for (const b of list) if (!value.layers.includes(b)) unknown.add(String(b));
      }
      if (unknown.size > 0) p("physics.collisionMatrix", `The collision matrix names ${[...unknown].map((n) => `"${n}"`).join(", ")}, which ${unknown.size === 1 ? "isn't a physics layer" : "aren't physics layers"}.`);
    }
  }
  return { value, problems, warnings: [] };
}

function parseRender(written: unknown): Parsed<"render"> {
  const problems: SettingsIssue[] = [];
  const value = fieldsOver("render", written, DEFAULT_RENDER, { pixelsPerUnit: [isPositive, "Pixels per unit must be above 0."], maxDecals: [isPositiveInt, "Max decals must be a whole number above 0."] }, problems);
  const layers = isRecord(written) ? written.sortingLayers : undefined;
  if (layers !== undefined) {
    nameListProblems(layers, "render.sortingLayers", "Sorting layers", problems);
    value.sortingLayers = nameListValue(layers, DEFAULT_RENDER.sortingLayers);
  }
  const warnings: SettingsIssue[] = value.sortingLayers.includes("Default") ? [] : [{ field: "render.sortingLayers", message: 'There\'s no "Default" sorting layer, which sprites use unless they name another.' }];
  return { value, problems, warnings };
}

function parseInput(written: unknown): Parsed<"input"> {
  const problems: SettingsIssue[] = [];
  const value = fieldsOver("input", written, DEFAULT_INPUT, {
    join: [(v) => (INPUT_JOIN_POLICIES as readonly unknown[]).includes(v), `Input join must be one of ${INPUT_JOIN_POLICIES.join(", ")}.`],
    maxPlayers: [isPositiveInt, "Max players must be a whole number above 0."],
  }, problems);
  const sets = isRecord(written) ? written.actionSets : undefined;
  if (sets === undefined) value.actionSets = [];
  else if (!Array.isArray(sets)) {
    problems.push({ field: "input.actionSets", message: "Action sets must be a list of .actions.json files." });
    value.actionSets = [];
  } else {
    const seen = new Set<string>();
    sets.forEach((path: unknown, i) => {
      const field = `input.actionSets.${i}`;
      if (typeof path !== "string" || !path.endsWith(".actions.json")) problems.push({ field, message: `Action set ${i + 1} must be a .actions.json file.` });
      else if (seen.has(path)) problems.push({ field, message: `${path} is listed twice.` });
      seen.add(String(path));
    });
    value.actionSets = [...new Set(sets.filter((p): p is string => typeof p === "string" && p.endsWith(".actions.json")))];
  }
  return { value, problems, warnings: [] };
}

function parseAutoload(written: unknown): Parsed<"autoload"> {
  if (written === undefined) return { value: [], problems: [], warnings: [] };
  if (!Array.isArray(written)) return { value: [], problems: [{ field: "autoload", message: "Autoloads must be a list of scene or prefab files." }], warnings: [] };
  const problems: SettingsIssue[] = [];
  const seen = new Set<string>();
  written.forEach((path: unknown, i) => {
    const field = `autoload.${i}`;
    if (typeof path !== "string" || !/\.(scene|prefab)\.json$/.test(path)) problems.push({ field, message: `Autoload ${i + 1} must be a .scene.json or .prefab.json file.` });
    else if (seen.has(path)) problems.push({ field, message: `${path} is autoloaded twice.` });
    seen.add(String(path));
  });
  return { value: written.filter((p): p is string => typeof p === "string"), problems, warnings: [] };
}

function parsePlugins(written: unknown): Parsed<"plugins"> {
  const { problems } = pluginSettingsProblems(written);
  return { value: isRecord(written) ? (written as PluginSettings) : undefined, problems: asIssues("plugins", problems), warnings: [] };
}

function declare<K extends RuntimeSettingsKey>(key: K, parse: (written: unknown) => Parsed<K>): RuntimeSettingsSection<K> {
  return { key, default: parse(undefined).value, parse };
}

/**
 * Every runtime `project.json` section, declared once (ADR 0272): `resolveSettings`, the Engine's start-up warnings
 * (`settingsIssues`) and the editor's Project panel and settings sections all go through these. The sections whose
 * editor half is a plugin (physics, navigation, audio) are declared here too: the engine reads them, and the engine
 * core doesn't know plugins (ADR 0010).
 */
export const RUNTIME_SETTINGS: { readonly [K in RuntimeSettingsKey]: RuntimeSettingsSection<K> } = {
  name: declare("name", parseName),
  display: declare("display", parseDisplay),
  time: declare("time", parseTime),
  physics: declare("physics", parsePhysics),
  render: declare("render", parseRender),
  graphics: declare("graphics", (w) => {
    const { graphics, problems } = parseGraphics(w);
    return { value: graphics, problems: asIssues("graphics", problems), warnings: [] };
  }),
  lighting2D: declare("lighting2D", (w) => {
    const { settings, problems } = parseLighting2D(w);
    return { value: settings, problems: asIssues("lighting2D", problems), warnings: [] };
  }),
  navigation: declare("navigation", (w) => {
    const { settings, problems } = parseNavigationSettings(w);
    return { value: settings, problems: asIssues("navigation", problems), warnings: [] };
  }),
  audio: declare("audio", (w) => {
    const { settings, problems, warnings } = parseAudioSettings(w);
    return { value: settings, problems: asIssues("audio", problems), warnings: asIssues("audio", warnings) };
  }),
  input: declare("input", parseInput),
  autoload: declare("autoload", parseAutoload),
  plugins: declare("plugins", parsePlugins),
  languages: declare("languages", (w) => {
    const { languages, problems } = parseLanguages(w);
    return { value: languages, problems: asIssues("languages", problems), warnings: [] };
  }),
  subtitles: declare("subtitles", (w) => {
    const { subtitles, problems } = parseSubtitleSettings(w);
    return { value: subtitles, problems: asIssues("subtitles", problems), warnings: [] };
  }),
};

const SECTIONS = Object.values(RUNTIME_SETTINGS) as RuntimeSettingsSection[];

/** Settings `resolveSettings` made: resolving one again gives it back as it is (an Engine's Worlds take the Engine's). */
const resolved = new WeakSet<object>();

/** The settings of a project with no `project.json` values: every section's default. */
export const defaultSettings: ProjectSettings = resolveSettings({});

/**
 * `project.json`'s values with the defaults for what's left out and for what's wrong (`settingsIssues` says what).
 * Settings it returned come back unchanged, without parsing them again.
 */
export function resolveSettings(input: ProjectSettingsInput | ProjectSettings = {}): ProjectSettings {
  if (resolved.has(input)) return input as ProjectSettings;
  const out: Record<string, unknown> = {};
  const written = input as Record<string, unknown>;
  for (const section of SECTIONS) {
    const value = section.parse(written[section.key]).value;
    if (value !== undefined) out[section.key] = value;
  }
  if (input.bootstrap !== undefined) out.bootstrap = input.bootstrap; // checked by validateBootstrap when the bootstrap runs
  resolved.add(out);
  return out as unknown as ProjectSettings;
}

/** Everything wrong with `project.json`'s runtime sections: each section's problems and warnings, in section order. */
export function settingsIssues(input: ProjectSettingsInput | Record<string, unknown> = {}): { problems: SettingsIssue[]; warnings: SettingsIssue[] } {
  const problems: SettingsIssue[] = [];
  const warnings: SettingsIssue[] = [];
  const written = input as Record<string, unknown>;
  for (const section of SECTIONS) {
    const parsed = section.parse(written[section.key]);
    problems.push(...parsed.problems);
    warnings.push(...parsed.warnings);
  }
  return { problems, warnings };
}

const BOOTSTRAP_KEYS = ["worlds", "links", "templates"];
const WORLD_KEYS = ["name", "tags", "tickRate", "timeScale", "renders", "input", "scenes", "systems", "lobby", "replication"];
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
  // Lobbies a dedicated server wouldn't run (ADR 0281): classified by the bootstrap topology, once the shape is right.
  if (problems.length === 0) problems.push(...(bootstrapTopology(setting as unknown as BootstrapSetting)?.lobbyProblems ?? []));
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
  if (world.replication !== undefined) replicationProblems(world.replication, `${where}: replication`, problems); // ADR 0101

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

/** Problems with a World config's `replication` settings (ADR 0101). */
function replicationProblems(value: unknown, where: string, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object with sendRate and maxSnapshotBytes (got ${describe(value)}).`);
    return;
  }
  unknownKeys(value, ["sendRate", "maxSnapshotBytes"], where, problems);
  const { sendRate, maxSnapshotBytes } = value;
  if (sendRate !== undefined && !(typeof sendRate === "number" && Number.isFinite(sendRate) && sendRate > 0)) {
    problems.push(`${where}: sendRate must be a positive number of snapshots per second (got ${describe(sendRate)}).`);
  }
  if (maxSnapshotBytes !== undefined && !(typeof maxSnapshotBytes === "number" && Number.isInteger(maxSnapshotBytes) && maxSnapshotBytes >= 256)) {
    problems.push(`${where}: maxSnapshotBytes must be a whole number of bytes, 256 or more (got ${describe(maxSnapshotBytes)}).`);
  }
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
