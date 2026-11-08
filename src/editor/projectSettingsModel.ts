// The Project panel's model (ADR 0038): the parts of `project.json` beyond the bootstrap (name,
// display, time, physics, render, autoloads) as a draft, edited by pure functions, checked, and
// written back into the file's text one top-level key at a time so the rest keeps its layout.
import { defaultSettings, pluginSettingsProblems, SCALE_MODES, type ProjectSettings, type ProjectSettingsInput } from "../engine/core/settings";
import { defaultTier, parseGraphics, PLATFORMS, type GraphicsSettings, type Platform, type PlatformDefaults, type QualityTier } from "../engine/core/graphics";
import { parseAudioSettings } from "../engine/audio/settings";
import { parseNavigationSettings } from "../engine/nav/settings";
import { uniqueName, withMember } from "./worldsConfig";

/** The top-level keys the Project panel edits (the Worlds panel edits `bootstrap`). */
export const SETTINGS_SECTIONS = ["name", "display", "time", "physics", "render", "autoload", "graphics", "navigation", "audio", "plugins", "build"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The panel's sections of `project.json`, as written (missing values fall back to the engine's defaults). */
export interface SettingsDraft {
  name?: string;
  display?: Partial<ProjectSettings["display"]> & Record<string, unknown>;
  time?: Partial<ProjectSettings["time"]> & Record<string, unknown>;
  physics?: Partial<ProjectSettings["physics"]> & Record<string, unknown>;
  render?: Partial<ProjectSettings["render"]> & Record<string, unknown>;
  autoload?: string[];
  /** Graphics quality tiers (ADR 0050), as written; read leniently by `parseGraphics`. */
  graphics?: Record<string, unknown>;
  /** Navigation (ADR 0065): agent types, areas and bake settings, as written; read leniently by `parseNavigationSettings`. */
  navigation?: Record<string, unknown>;
  /** Audio mixer buses, snapshots, ducking and backend (ADR 0097): as written; read leniently by `parseAudioSettings`. */
  audio?: Record<string, unknown>;
  /** Per-project plugin enabling (ADR 0133): only the plugins that are off. */
  plugins?: { disabled?: string[] } & Record<string, unknown>;
  /** Game export settings (ADR 0041), read by the exporter; other keys in it are kept. */
  build?: { icon?: string; identifier?: string; version?: string } & Record<string, unknown>;
}

/** A problem, with the field it's about (`"display.width"`, `"physics.layers.2"`), for highlighting. */
export interface SettingsProblem {
  field: string;
  message: string;
}

/** Physics layers are bits in a 16-bit collision mask. */
export const MAX_LAYERS = 16;

/** The panel's sections from parsed `project.json` settings (a deep copy). */
export function readDraft(settings: ProjectSettingsInput | Record<string, unknown>): SettingsDraft {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_SECTIONS) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = structuredClone(value);
  }
  return out as SettingsDraft;
}

/** The draft's sections as one comparable string. */
export const sectionsKey = (draft: SettingsDraft) => JSON.stringify(SETTINGS_SECTIONS.map((k) => draft[k] ?? null));

/**
 * `project.json`'s text with the draft's sections written in. Only sections that differ from
 * `previous` (the file's parsed settings) are rewritten; an unset section is removed.
 */
export function withSettings(text: string, draft: SettingsDraft, previous: ProjectSettingsInput | Record<string, unknown>): string {
  let out = text;
  for (const key of SETTINGS_SECTIONS) {
    const next = draft[key];
    if (JSON.stringify(next) === JSON.stringify((previous as Record<string, unknown>)[key])) continue;
    out = withMember(out, key, next);
  }
  return out;
}

// --- reading values with defaults -----------------------------------------------------------------

export const layersOf = (d: SettingsDraft): string[] => d.physics?.layers ?? defaultSettings.physics.layers;
export const sortingLayersOf = (d: SettingsDraft): string[] => d.render?.sortingLayers ?? defaultSettings.render.sortingLayers;
export const autoloadsOf = (d: SettingsDraft): string[] => d.autoload ?? [];

/** Set one value in a section (undefined removes it, so the default applies); drops a section left empty. */
export function setValue<S extends "display" | "time" | "physics" | "render" | "build">(draft: SettingsDraft, section: S, key: string, value: unknown): SettingsDraft {
  const next: Record<string, unknown> = { ...(draft[section] ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return { ...draft, [section]: Object.keys(next).length > 0 ? next : undefined };
}

export function setName(draft: SettingsDraft, name: string): SettingsDraft {
  return { ...draft, name: name.trim() === "" ? undefined : name.trim() };
}

// --- physics layers and the collision matrix ------------------------------------------------------

/** Pair key for two layer names, order-free. */
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Every colliding pair (by name). With no matrix, every layer collides with every layer, itself included. */
function pairsOf(draft: SettingsDraft): Set<string> {
  const layers = layersOf(draft);
  const matrix = draft.physics?.collisionMatrix;
  const pairs = new Set<string>();
  if (!matrix) {
    for (let i = 0; i < layers.length; i++) for (let j = i; j < layers.length; j++) pairs.add(pairKey(layers[i], layers[j]));
    return pairs;
  }
  for (const [a, list] of Object.entries(matrix)) if (Array.isArray(list)) for (const b of list) pairs.add(pairKey(a, b));
  return pairs;
}

/** Whether layers `a` and `b` collide (the engine's rule: the matrix is symmetric). */
export function collides(draft: SettingsDraft, a: string, b: string): boolean {
  return pairsOf(draft).has(pairKey(a, b));
}

/** The matrix for a set of pairs: each pair listed under its earlier layer, or none at all when every pair collides. */
function matrixOf(layers: readonly string[], pairs: Set<string>): Record<string, string[]> | undefined {
  let all = true;
  const out: Record<string, string[]> = {};
  for (let i = 0; i < layers.length; i++) {
    for (let j = i; j < layers.length; j++) {
      if (!pairs.has(pairKey(layers[i], layers[j]))) {
        all = false;
        continue;
      }
      (out[layers[i]] ??= []).push(layers[j]);
    }
  }
  return all ? undefined : out;
}

function withLayers(draft: SettingsDraft, layers: string[], pairs: Set<string>): SettingsDraft {
  const physics: Record<string, unknown> = { ...(draft.physics ?? {}), layers };
  const matrix = matrixOf(layers, pairs);
  if (matrix === undefined) delete physics.collisionMatrix;
  else physics.collisionMatrix = matrix;
  return { ...draft, physics };
}

export function setCollides(draft: SettingsDraft, a: string, b: string, on: boolean): SettingsDraft {
  const pairs = pairsOf(draft);
  if (on) pairs.add(pairKey(a, b));
  else pairs.delete(pairKey(a, b));
  const physics: Record<string, unknown> = { ...(draft.physics ?? {}) };
  const matrix = matrixOf(layersOf(draft), pairs);
  if (matrix === undefined) delete physics.collisionMatrix;
  else physics.collisionMatrix = matrix;
  return { ...draft, physics };
}

/** Add a layer. It collides with everything until unchecked (with no matrix), or with nothing (with one). */
export function addLayer(draft: SettingsDraft): SettingsDraft {
  const layers = layersOf(draft);
  const name = uniqueName("Layer", layers);
  const pairs = pairsOf(draft);
  if (draft.physics?.collisionMatrix === undefined) for (const l of [...layers, name]) pairs.add(pairKey(name, l));
  return withLayers(draft, [...layers, name], pairs);
}

/** Rename a layer, in the matrix too. (The scenes that name it are updated by `layerRename.ts`.) */
export function renameLayer(draft: SettingsDraft, index: number, name: string): SettingsDraft {
  const layers = [...layersOf(draft)];
  const old = layers[index];
  if (old === undefined || old === name) return draft;
  layers[index] = name;
  const rename = (n: string) => (n === old ? name : n);
  const pairs = new Set([...pairsOf(draft)].map((k) => k.split("\u0000")).map(([a, b]) => pairKey(rename(a), rename(b))));
  return withLayers(draft, layers, pairs);
}

export function removeLayer(draft: SettingsDraft, index: number): SettingsDraft {
  const layers = layersOf(draft);
  const gone = layers[index];
  if (gone === undefined || layers.length <= 1) return draft;
  const pairs = new Set([...pairsOf(draft)].filter((k) => !k.split("\u0000").includes(gone)));
  return withLayers(draft, layers.filter((_, i) => i !== index), pairs);
}

/** Set one axis of gravity; z (3D physics, ADR 0045) is kept only while it's not 0. */
export function setGravity(draft: SettingsDraft, axis: 0 | 1 | 2, value: number): SettingsDraft {
  const g: number[] = [...(draft.physics?.gravity ?? defaultSettings.physics.gravity)];
  while (g.length < 3) g.push(0);
  g[axis] = value;
  const gravity = g[2] === 0 ? [g[0], g[1]] : g.slice(0, 3);
  return setValue(draft, "physics", "gravity", gravity);
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

export type TierValueKey = "renderScale" | "antialias" | "shadows" | "shadowCascades" | "cascadedLights" | "shadowDistance" | "anisotropy" | "shaderLevel" | "postProcessing" | "bloom" | "ambientOcclusion" | "depthOfField" | "reflectionProbes" | "particles";

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

const isPositive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isPositiveInt = (v: unknown) => isPositive(v) && Number.isInteger(v);
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function nameList(list: unknown, field: string, what: string, problems: SettingsProblem[]): void {
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

/**
 * Everything wrong with the draft, as sentences. `files` (the project's files) lets autoloads be
 * checked for existing. Problems keep the draft from being saved.
 */
export function settingsProblems(draft: SettingsDraft, files?: readonly string[]): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const p = (field: string, message: string) => problems.push({ field, message });
  if (draft.name !== undefined && (typeof draft.name !== "string" || draft.name.trim() === "")) p("name", "The project name can't be empty.");

  const display = draft.display ?? {};
  for (const key of ["width", "height"] as const) {
    if (display[key] !== undefined && !isPositiveInt(display[key])) p(`display.${key}`, `Display ${key} must be a whole number of pixels above 0.`);
  }
  if (display.backgroundColor !== undefined && (typeof display.backgroundColor !== "string" || !COLOR.test(display.backgroundColor))) {
    p("display.backgroundColor", "Background colour must be a hex colour such as #1d1f24.");
  }

  if (display.scaleMode !== undefined && !(SCALE_MODES as readonly unknown[]).includes(display.scaleMode)) p("display.scaleMode", `Scale mode must be one of ${SCALE_MODES.join(", ")}.`);

  const time = draft.time ?? {};
  if (time.fixedDeltaTime !== undefined && !isPositive(time.fixedDeltaTime)) p("time.fixedDeltaTime", "The fixed timestep must be above 0 seconds.");
  if (time.maxFrameTime !== undefined && !isPositive(time.maxFrameTime)) p("time.maxFrameTime", "The max frame time must be above 0 seconds.");
  if (time.maxSubSteps !== undefined && !isPositiveInt(time.maxSubSteps)) p("time.maxSubSteps", "Max sub-steps must be a whole number above 0.");
  const fixed = time.fixedDeltaTime ?? defaultSettings.time.fixedDeltaTime, maxFrame = time.maxFrameTime ?? defaultSettings.time.maxFrameTime;
  if (isPositive(fixed) && isPositive(maxFrame) && fixed > maxFrame) p("time.fixedDeltaTime", "The fixed timestep is longer than the max frame time, so no fixed step would ever run.");

  const physics = draft.physics ?? {};
  if (physics.gravity !== undefined && !(Array.isArray(physics.gravity) && (physics.gravity.length === 2 || physics.gravity.length === 3) && physics.gravity.every((g) => typeof g === "number" && Number.isFinite(g)))) {
    p("physics.gravity", "Gravity must be two numbers, x and y, or three with z.");
  }
  if (physics.layers !== undefined) nameList(physics.layers, "physics.layers", "Physics layers", problems);
  const layers = layersOf(draft);
  if (Array.isArray(layers) && layers.length > MAX_LAYERS) p("physics.layers", `There can be at most ${MAX_LAYERS} physics layers.`);
  const matrix = physics.collisionMatrix;
  if (matrix !== undefined) {
    if (typeof matrix !== "object" || matrix === null || Array.isArray(matrix)) p("physics.collisionMatrix", "The collision matrix must be an object of layer lists.");
    else {
      const unknown = new Set<string>();
      for (const [a, list] of Object.entries(matrix)) {
        if (!layers.includes(a)) unknown.add(a);
        if (!Array.isArray(list)) p("physics.collisionMatrix", `The collision matrix entry for "${a}" must be a list of layers.`);
        else for (const b of list) if (!layers.includes(b)) unknown.add(String(b));
      }
      if (unknown.size > 0) p("physics.collisionMatrix", `The collision matrix names ${[...unknown].map((n) => `"${n}"`).join(", ")}, which ${unknown.size === 1 ? "isn't a physics layer" : "aren't physics layers"}.`);
    }
  }

  const render = draft.render ?? {};
  if (render.sortingLayers !== undefined) nameList(render.sortingLayers, "render.sortingLayers", "Sorting layers", problems);
  if (render.pixelsPerUnit !== undefined && !isPositive(render.pixelsPerUnit)) p("render.pixelsPerUnit", "Pixels per unit must be above 0.");

  if (draft.autoload !== undefined) {
    if (!Array.isArray(draft.autoload)) p("autoload", "Autoloads must be a list of scene or prefab files.");
    else {
      const seen = new Set<string>();
      draft.autoload.forEach((path, i) => {
        const field = `autoload.${i}`;
        if (typeof path !== "string" || !/\.(scene|prefab)\.json$/.test(path)) p(field, `Autoload ${i + 1} must be a .scene.json or .prefab.json file.`);
        else if (seen.has(path)) p(field, `${path} is autoloaded twice.`);
        else if (files && !files.includes(path)) p(field, `${path} isn't in the project.`);
        seen.add(String(path));
      });
    }
  }

  for (const message of parseGraphics(draft.graphics).problems) p("graphics", message);
  for (const message of parseNavigationSettings(draft.navigation).problems) p("navigation", message);
  for (const message of parseAudioSettings(draft.audio).problems) p("audio", message);

  for (const message of pluginSettingsProblems(draft.plugins).problems) p("plugins", message);

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
  if (!sortingLayersOf(draft).includes("Default")) out.push('There\'s no "Default" sorting layer, which sprites use unless they name another.');
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
