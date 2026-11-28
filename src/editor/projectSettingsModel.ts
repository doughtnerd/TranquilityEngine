// The Project panel's model (ADR 0038, 0151, 0446): edits of the draft of `project.json`'s keys the panel owns, as pure
// functions, and writing the draft back into the file's text one top-level key at a time so the rest keeps its layout.
// Which keys those are, and what's wrong with a draft, are the engine's settings module's (`projectSettingsKeys`,
// `projectSettingsIssues`); the functions here only bind them to the registered settings sections.
import { defaultSettings, projectSettingsIssues, projectSettingsKeys, sectionKeyConflict, type ProjectSettingsDraft, type ProjectSettingsInput, type SettingsIssue } from "../engine/core/settings";
import { defaultTier, parseGraphics, PLATFORMS, type GraphicsSettings, type Platform, type PlatformDefaults, type QualityTier } from "../engine/core/graphics";
import { projectSettingsSections } from "./sdk/contributions";
import { withMember } from "./jsonMember";
import { uniqueName } from "../engine/core/uniqueName";

/** The panel's keys of `project.json`, as written (missing values fall back to the engine's defaults). */
export type SettingsDraft = ProjectSettingsDraft;

/** A problem, with the field it's about (`"display.width"`, `"physics.layers.2"`), for highlighting. */
export type SettingsProblem = SettingsIssue;

/** Every key the Project panel edits: its own, then those the registered settings sections own (ADR 0151, 0446). */
export const settingsKeys = (): string[] => projectSettingsKeys(projectSettingsSections.list());

/** `section`, if the keys it declares are free (not the panel's own, not reserved, not another registered section's). Throws otherwise. */
export function checkSettingsSectionKeys<T extends { readonly id: string; readonly keys: readonly string[] }>(section: T): T {
  const conflict = sectionKeyConflict(section, projectSettingsSections.list());
  if (conflict) throw new Error(conflict);
  return section;
}

/** Everything wrong with the draft, by field, given the registered sections; `files` (the project's) checks that autoloads and the icon exist. Problems keep the draft from being saved. */
export const settingsProblems = (draft: SettingsDraft, files?: readonly string[]): SettingsProblem[] => projectSettingsIssues(draft, { files, sections: projectSettingsSections.list() }).problems;

/** Notes that don't stop a save: things that work but are probably unintended. */
export const settingsWarnings = (draft: SettingsDraft, knownPlugins?: readonly string[]): string[] =>
  projectSettingsIssues(draft, { knownPlugins, sections: projectSettingsSections.list() }).warnings.map((w) => w.message);

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
/** The y-sorted sorting layers (ADR 0440), as written. */
export const ySortedLayersOf = (d: SettingsDraft): string[] => (Array.isArray(d.render?.ySortedLayers) ? d.render.ySortedLayers : []);

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
/** Write the y-sorted layers (ADR 0440); none removes the key. */
const withYSorted = (d: SettingsDraft, names: string[]) => setValue(d, "render", "ySortedLayers", names.length ? names : undefined);
/** Rename a sorting layer; a y-sorted one stays y-sorted. */
export const renameSortingLayer = (d: SettingsDraft, index: number, name: string): SettingsDraft => {
  const from = sortingLayersOf(d)[index];
  const next = setValue(d, "render", "sortingLayers", sortingLayersOf(d).map((l, i) => (i === index ? name : l)));
  return ySortedLayersOf(d).includes(from) ? withYSorted(next, ySortedLayersOf(d).map((l) => (l === from ? name : l))) : next;
};
/** Remove a sorting layer, and its y-sorting. */
export const removeSortingLayer = (d: SettingsDraft, index: number): SettingsDraft => {
  const gone = sortingLayersOf(d)[index];
  const next = setValue(d, "render", "sortingLayers", sortingLayersOf(d).filter((_, i) => i !== index));
  return ySortedLayersOf(d).includes(gone) ? withYSorted(next, ySortedLayersOf(d).filter((l) => l !== gone)) : next;
};
/** Whether a sorting layer is y-sorted (ADR 0440). */
export const isYSortedLayer = (d: SettingsDraft, index: number): boolean => ySortedLayersOf(d).includes(sortingLayersOf(d)[index]);
/** Y-sort a sorting layer or stop (ADR 0440): kept in sorting layer order. */
export const setYSortedLayer = (d: SettingsDraft, index: number, on: boolean): SettingsDraft => {
  const name = sortingLayersOf(d)[index];
  const set = new Set(ySortedLayersOf(d));
  if (on) set.add(name);
  else set.delete(name);
  return withYSorted(d, sortingLayersOf(d).filter((l) => set.has(l)));
};
/** Move a sorting layer towards the back (-1) or front (+1). */
export const moveSortingLayer = (d: SettingsDraft, index: number, by: number) => setValue(d, "render", "sortingLayers", moved(sortingLayersOf(d), index, by));

export const addAutoload = (d: SettingsDraft, path: string): SettingsDraft => ({ ...d, autoload: [...autoloadsOf(d), path] });
export const removeAutoload = (d: SettingsDraft, index: number): SettingsDraft => ({ ...d, autoload: autoloadsOf(d).filter((_, i) => i !== index) });
export const moveAutoload = (d: SettingsDraft, index: number, by: number): SettingsDraft => ({ ...d, autoload: moved(autoloadsOf(d), index, by) });

// --- action set files (ADR 0433) -------------------------------------------------------------------

/** The draft's `input.actionSets` (the action set files defined at boot, in order) as written, entry for entry (so entry `i` is the one `input.actionSets.i`'s problems are about; a bad entry stays listed to be removed). */
export const actionSetsOf = (d: SettingsDraft): string[] => {
  const list: unknown = d.input?.actionSets;
  return Array.isArray(list) ? list.map(String) : [];
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

// --- plugins ----------------------------------------------------------------------------------------

/** The plugins listed as off (what's stored; dependents are implied by `resolveEnabledPlugins`). */
export const disabledPluginsOf = (d: SettingsDraft): string[] => (Array.isArray(d.plugins?.disabled) ? d.plugins.disabled.filter((n) => typeof n === "string") : []);

/** Set the list of plugins that are off; an empty list removes the section, so the defaults apply. */
export function setDisabledPlugins(draft: SettingsDraft, disabled: readonly string[]): SettingsDraft {
  const { disabled: _old, ...rest } = draft.plugins ?? {};
  const next = disabled.length > 0 ? { ...rest, disabled: [...disabled] } : rest;
  return { ...draft, plugins: Object.keys(next).length > 0 ? next : undefined };
}
