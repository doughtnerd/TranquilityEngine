// The Project panel's model (ADR 0038, 0151): the parts of `project.json` beyond the bootstrap (name,
// display, time, render, autoloads, and the keys plugins' settings sections own, such as `physics`) as a
// draft, edited by pure functions, checked, and written back into the file's text one top-level key at a
// time so the rest keeps its layout.
import { defaultSettings, pluginSettingsProblems, RUNTIME_SETTINGS, type ProjectSettings, type ProjectSettingsInput } from "../engine/core/settings";
import { defaultTier, parseGraphics, PLATFORMS, type GraphicsSettings, type Platform, type PlatformDefaults, type QualityTier } from "../engine/core/graphics";
import { projectSettingsSections } from "./sdk/contributions";
import { withMember } from "./jsonMember";
import { uniqueName } from "../engine/core/uniqueName";

/** The top-level keys the shell's own Project panel categories edit (the Worlds panel edits `bootstrap`). */
const CORE_SETTINGS_KEYS = ["name", "display", "time", "render", "input", "autoload", "graphics", "plugins", "build"] as const;

/** Keys no settings section may own: `bootstrap` (the Worlds panel's) and `audio`, which moved to `audio.json` (ADR 0344; the Audio Studio edits it). */
const RESERVED_KEYS: readonly string[] = ["bootstrap", "audio"];

/**
 * Every key the Project panel edits: the core keys, then those the registered settings sections declare
 * (ADR 0151; `physics` while the Physics plugin is on). `bootstrap` stays the Worlds panel's.
 */
export function settingsKeys(): string[] {
  const keys: string[] = [...CORE_SETTINGS_KEYS];
  for (const section of projectSettingsSections.list()) for (const key of section.keys) if (!RESERVED_KEYS.includes(key) && !keys.includes(key)) keys.push(key);
  return keys;
}

/** `section`, if the keys it declares are free: not core, not reserved (`bootstrap`, `audio`), not another registered section's. Throws otherwise. */
export function checkSettingsSectionKeys<T extends { readonly id: string; readonly keys: readonly string[] }>(section: T): T {
  for (const key of section.keys) {
    if ((CORE_SETTINGS_KEYS as readonly string[]).includes(key) || key === "bootstrap") throw new Error(`Project settings section "${section.id}" can't own "${key}": the editor owns that project.json key.`);
    if (key === "audio") throw new Error(`Project settings section "${section.id}" can't own "audio": the project's audio is audio.json's (ADR 0344).`);
    const owner = projectSettingsSections.list().find((s) => s.id !== section.id && s.keys.includes(key));
    if (owner) throw new Error(`Project settings section "${section.id}" can't own "${key}": section "${owner.id}" owns it.`);
  }
  return section;
}

/** The panel's sections of `project.json`, as written (missing values fall back to the engine's defaults). */
export interface SettingsDraft {
  name?: string;
  display?: Partial<ProjectSettings["display"]> & Record<string, unknown>;
  time?: Partial<ProjectSettings["time"]> & Record<string, unknown>;
  /** Owned by the Physics plugin's settings section (ADR 0151). */
  physics?: Partial<ProjectSettings["physics"]> & Record<string, unknown>;
  render?: Partial<ProjectSettings["render"]> & Record<string, unknown>;
  autoload?: string[];
  /** Graphics quality tiers (ADR 0050), as written; read leniently by `parseGraphics`. */
  graphics?: Record<string, unknown>;
  /** Navigation (ADR 0065): agent types, areas and bake settings, as written; owned by the Navigation plugin's settings section (ADR 0151). */
  navigation?: Record<string, unknown>;
  /** Per-project plugin enabling (ADR 0133): only the plugins that are off. */
  plugins?: { disabled?: string[] } & Record<string, unknown>;
  /** Game export settings (ADR 0041), read by the exporter; other keys in it are kept. */
  build?: { icon?: string; identifier?: string; version?: string } & Record<string, unknown>;
  /** A key a plugin's settings section owns (ADR 0151), as written. */
  [key: string]: unknown;
}

/** A problem, with the field it's about (`"display.width"`, `"physics.layers.2"`), for highlighting. */
export interface SettingsProblem {
  field: string;
  message: string;
}

/**
 * `project.json`'s text with the draft's sections written in. Only sections that differ from
 * `previous` (the file's parsed settings) are rewritten; an unset section is removed.
 */
export function withSettings(text: string, draft: SettingsDraft, previous: ProjectSettingsInput | Record<string, unknown>, keys: readonly string[] = settingsKeys()): string {
  let out = text;
  for (const key of keys) {
    const next = draft[key];
    if (JSON.stringify(next) === JSON.stringify((previous as Record<string, unknown>)[key])) continue;
    out = withMember(out, key, next);
  }
  return out;
}

// --- reading values with defaults -----------------------------------------------------------------

export const sortingLayersOf = (d: SettingsDraft): string[] => d.render?.sortingLayers ?? defaultSettings.render.sortingLayers;
export const autoloadsOf = (d: SettingsDraft): string[] => d.autoload ?? [];

/** Set one value in a section (undefined removes it, so the default applies); drops a section left empty. */
export function setValue<S extends "display" | "time" | "physics" | "render" | "build" | "input">(draft: SettingsDraft, section: S, key: string, value: unknown): SettingsDraft {
  const next: Record<string, unknown> = { ...(draft[section] ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return { ...draft, [section]: Object.keys(next).length > 0 ? next : undefined };
}

export function setName(draft: SettingsDraft, name: string): SettingsDraft {
  return { ...draft, name: name.trim() === "" ? undefined : name.trim() };
}

// --- lists: sorting layers, autoloads --------------------------------------------------------------

function moved<T>(list: readonly T[], index: number, by: number): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item);
  return out;
}

export const addSortingLayer = (d: SettingsDraft) => setValue(d, "render", "sortingLayers", [...sortingLayersOf(d), uniqueName("Layer", sortingLayersOf(d))]);
export const renameSortingLayer = (d: SettingsDraft, index: number, name: string) =>
  setValue(d, "render", "sortingLayers", sortingLayersOf(d).map((l, i) => (i === index ? name : l)));
export const removeSortingLayer = (d: SettingsDraft, index: number) => setValue(d, "render", "sortingLayers", sortingLayersOf(d).filter((_, i) => i !== index));
/** Move a sorting layer towards the back (-1) or front (+1). */
export const moveSortingLayer = (d: SettingsDraft, index: number, by: number) => setValue(d, "render", "sortingLayers", moved(sortingLayersOf(d), index, by));

export const addAutoload = (d: SettingsDraft, path: string): SettingsDraft => ({ ...d, autoload: [...autoloadsOf(d), path] });
export const removeAutoload = (d: SettingsDraft, index: number): SettingsDraft => ({ ...d, autoload: autoloadsOf(d).filter((_, i) => i !== index) });
export const moveAutoload = (d: SettingsDraft, index: number, by: number): SettingsDraft => ({ ...d, autoload: moved(autoloadsOf(d), index, by) });

// --- action set files (ADR 0417) -------------------------------------------------------------------

/** The draft's `input.actionSets`: the action set files defined at boot, in order. */
export const actionSetsOf = (d: SettingsDraft): string[] => {
  const input = d.input;
  const list = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).actionSets : undefined;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
};
const withActionSets = (d: SettingsDraft, list: string[]): SettingsDraft => setValue(d, "input", "actionSets", list);
/** Add an action set file at the end of the list (no change when it's listed already). */
export const addActionSet = (d: SettingsDraft, path: string): SettingsDraft => (actionSetsOf(d).includes(path) ? d : withActionSets(d, [...actionSetsOf(d), path]));
export const removeActionSet = (d: SettingsDraft, index: number): SettingsDraft => withActionSets(d, actionSetsOf(d).filter((_, i) => i !== index));
/** Move the action set at `index` to position `to` (a drag drops it there; ↑ ↓ move by one). */
export const moveActionSetTo = (d: SettingsDraft, index: number, to: number): SettingsDraft => withActionSets(d, moved(actionSetsOf(d), index, to - index));

// --- graphics quality tiers (ADR 0050) ------------------------------------------------------------

/** The draft's tiers (leniently read: the default tiers when there's no section). */
export const graphicsOf = (d: SettingsDraft): GraphicsSettings => parseGraphics(d.graphics).graphics;

/** `rename` carries a tier's new name (or null when it is gone) into the platform defaults. */
const withGraphics = (draft: SettingsDraft, tiers: QualityTier[], defaultName: string, rename?: { from: string; to: string | null }): SettingsDraft => {
  const g = graphicsOf(draft);
  const graphics: Record<string, unknown> = { ...draft.graphics, defaultTier: defaultName, tiers, autoDetect: g.autoDetect, targetFrameRate: g.targetFrameRate };
  const platformDefaults: PlatformDefaults = {};
  for (const p of PLATFORMS) {
    let name = g.platformDefaults?.[p];
    if (name !== undefined && rename && name === rename.from) name = rename.to ?? undefined;
    if (name !== undefined) platformDefaults[p] = name;
  }
  if (Object.keys(platformDefaults).length) graphics.platformDefaults = platformDefaults;
  else delete graphics.platformDefaults;
  return { ...draft, graphics };
};

/** The highest tier's name (the last: tiers run lowest first). */
const highest = (tiers: readonly QualityTier[]) => tiers[tiers.length - 1].name;

export function addTier(draft: SettingsDraft): SettingsDraft {
  const g = graphicsOf(draft);
  const name = uniqueName("Tier", g.tiers.map((t) => t.name));
  return withGraphics(draft, [...g.tiers, defaultTier(name)], g.defaultTier);
}

/** Remove a tier. The last one stays; a removed default gives way to the highest remaining tier. */
export function removeTier(draft: SettingsDraft, index: number): SettingsDraft {
  const g = graphicsOf(draft);
  const gone = g.tiers[index];
  if (gone === undefined || g.tiers.length <= 1) return draft;
  const tiers = g.tiers.filter((_, i) => i !== index);
  return withGraphics(draft, tiers, gone.name === g.defaultTier ? highest(tiers) : g.defaultTier, { from: gone.name, to: null });
}

/** Rename a tier (empty and duplicate names are refused), keeping it the default if it was. */
export function renameTier(draft: SettingsDraft, index: number, name: string): SettingsDraft {
  const g = graphicsOf(draft);
  const old = g.tiers[index];
  if (old === undefined || name.trim() === "" || old.name === name) return draft;
  if (g.tiers.some((t, i) => i !== index && t.name === name)) return draft;
  return withGraphics(draft, g.tiers.map((t, i) => (i === index ? { ...t, name } : t)), old.name === g.defaultTier ? name : g.defaultTier, { from: old.name, to: name });
}

/** Move a tier towards lower (-1) or higher (+1) quality. */
export function moveTier(draft: SettingsDraft, index: number, by: number): SettingsDraft {
  const g = graphicsOf(draft);
  if (index < 0 || index >= g.tiers.length || index + by < 0 || index + by >= g.tiers.length) return draft;
  return withGraphics(draft, moved(g.tiers, index, by), g.defaultTier);
}

export type TierValueKey = "renderScale" | "antialias" | "shadows" | "shadowCascades" | "cascadedLights" | "shadowDistance" | "anisotropy" | "shaderLevel" | "postProcessing" | "bloom" | "ambientOcclusion" | "depthOfField" | "reflectionProbes" | "particles" | "lights2D";

/** Set one value of a tier (as given: a bad one is reported by `settingsProblems`). */
export function setTierValue(draft: SettingsDraft, index: number, key: TierValueKey, value: unknown): SettingsDraft {
  const g = graphicsOf(draft);
  if (g.tiers[index] === undefined) return draft;
  return withGraphics(draft, g.tiers.map((t, i) => (i === index ? { ...t, [key]: value } : t)), g.defaultTier);
}

/** Set the tier a platform starts on (ADR 0050); undefined (or an unknown tier) goes back to the project default. */
export function setPlatformDefault(draft: SettingsDraft, platform: Platform, name: string | undefined): SettingsDraft {
  const g = graphicsOf(draft);
  const next = { ...g.platformDefaults };
  if (name !== undefined && g.tiers.some((t) => t.name === name)) next[platform] = name;
  else delete next[platform];
  const base = withGraphics(draft, g.tiers, g.defaultTier);
  const graphics = { ...base.graphics };
  if (Object.keys(next).length) graphics.platformDefaults = next;
  else delete graphics.platformDefaults;
  return { ...base, graphics };
}

/** Turn automatic tier detection on or off (ADR 0055). */
export function setAutoDetect(draft: SettingsDraft, on: boolean): SettingsDraft {
  const g = graphicsOf(draft);
  return { ...draft, graphics: { ...withGraphics(draft, g.tiers, g.defaultTier).graphics, autoDetect: on } };
}

/** Set the frame rate automatic detection aims for (as given: a bad one is reported by `settingsProblems`). */
export function setTargetFrameRate(draft: SettingsDraft, fps: number): SettingsDraft {
  const g = graphicsOf(draft);
  return { ...draft, graphics: { ...withGraphics(draft, g.tiers, g.defaultTier).graphics, targetFrameRate: fps } };
}

export function setDefaultTier(draft: SettingsDraft, name: string): SettingsDraft {
  const g = graphicsOf(draft);
  if (!g.tiers.some((t) => t.name === name)) return draft;
  return withGraphics(draft, g.tiers, name);
}

// --- validation -----------------------------------------------------------------------------------

/** The core keys the engine reads itself, checked by their runtime sections (ADR 0272). */
const RUNTIME_CORE_KEYS = ["name", "display", "time", "render", "autoload", "graphics", "plugins"] as const;

/**
 * Everything wrong with the draft, as sentences. `files` (the project's files) lets autoloads be
 * checked for existing. Problems keep the draft from being saved.
 */
export function settingsProblems(draft: SettingsDraft, files?: readonly string[]): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const p = (field: string, message: string) => problems.push({ field, message });
  // What the engine would warn about at start-up and replace with defaults (ADR 0272), by field.
  for (const key of RUNTIME_CORE_KEYS) problems.push(...RUNTIME_SETTINGS[key].parse(draft[key]).problems);
  // Beyond the runtime's checks: autoloads must exist in the project.
  if (files && Array.isArray(draft.autoload)) {
    draft.autoload.forEach((path, i) => {
      if (typeof path === "string" && /\.(scene|prefab)\.json$/.test(path) && draft.autoload!.indexOf(path) === i && !files.includes(path)) p(`autoload.${i}`, `${path} isn't in the project.`);
    });
  }

  // The keys plugins' settings sections own check themselves (ADR 0151).
  for (const section of projectSettingsSections.list()) if (section.problems) problems.push(...section.problems(draft));

  // The export's own checks (src/export/desktop.ts), so a bad value shows here rather than at export.
  const build = draft.build ?? {};
  if (build.identifier !== undefined && !(typeof build.identifier === "string" && /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/.test(build.identifier))) {
    p("build.identifier", "The app identifier must be a reverse-DNS name like com.example.mygame.");
  }
  if (build.version !== undefined && !(typeof build.version === "string" && /^\d+\.\d+\.\d+$/.test(build.version))) p("build.version", "The version must look like 1.2.3.");
  if (build.icon !== undefined) {
    if (typeof build.icon !== "string" || !/\.(png|svg)$/i.test(build.icon)) p("build.icon", "The icon must be a .png or .svg file.");
    else if (files && !files.includes(build.icon)) p("build.icon", `${build.icon} isn't in the project.`);
  }
  return problems;
}

/** Notes that don't stop a save: things that work but are probably unintended. */
export function settingsWarnings(draft: SettingsDraft, knownPlugins?: readonly string[]): string[] {
  const out: string[] = [];
  out.push(...pluginSettingsProblems(draft.plugins, knownPlugins).warnings);
  out.push(...RUNTIME_SETTINGS.render.parse(draft.render).warnings.map((w) => w.message));
  return out;
}

// --- plugins ----------------------------------------------------------------------------------------

/** The plugins listed as off (what's stored; dependents are implied by `resolveEnabledPlugins`). */
export const disabledPluginsOf = (d: SettingsDraft): string[] => (Array.isArray(d.plugins?.disabled) ? d.plugins.disabled.filter((n) => typeof n === "string") : []);

/** Set the list of plugins that are off; an empty list removes the section, so the defaults apply. */
export function setDisabledPlugins(draft: SettingsDraft, disabled: readonly string[]): SettingsDraft {
  const { disabled: _old, ...rest } = draft.plugins ?? {};
  const next = disabled.length > 0 ? { ...rest, disabled: [...disabled] } : rest;
  return { ...draft, plugins: Object.keys(next).length > 0 ? next : undefined };
}
