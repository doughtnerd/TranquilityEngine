// The Project panel's Navigation section (ADR 0065): `project.json`'s `navigation` key as part of the
// settings draft, edited by pure functions like the graphics tiers. Edits start from the leniently parsed
// section and write the whole section back, so values the parser rejects show as problems (and keep the
// draft from saving) until they're fixed or undone.
import {
  defaultNavArea,
  defaultNavAgentType,
  MAX_NAV_AGENT_TYPES,
  MAX_NAV_AREAS,
  parseNavigationSettings,
  type NavAgentType,
  type NavArea,
  type NavigationSettings,
} from "../engine/nav/settings";
import type { SettingsDraft } from "./projectSettingsModel";
import { uniqueName } from "./worldsConfig";

/** The draft's navigation settings (the defaults when there's no section). */
export const navigationOf = (d: SettingsDraft): NavigationSettings => parseNavigationSettings(d.navigation).settings;

/** The parse problems of the draft's navigation section. */
export const navigationProblems = (d: SettingsDraft): string[] => parseNavigationSettings(d.navigation).problems;

const withNavigation = (draft: SettingsDraft, nav: NavigationSettings): SettingsDraft => ({ ...draft, navigation: nav as unknown as Record<string, unknown> });

/** A new id for an agent type or area. */
export function newNavId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** Set a value at a dotted path (`"walk.radius"`, `"walk.motion.ease"`) in a copy of `obj`. */
function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const copy = (Array.isArray(obj) ? [...obj] : { ...obj }) as Record<string, unknown>;
  if (rest.length === 0) copy[head] = value;
  else copy[head] = setPath((copy[head] ?? {}) as object, rest.join("."), value);
  return copy as T;
}

// --- agent types ------------------------------------------------------------------------------------

export function addNavAgentType(draft: SettingsDraft, id = newNavId()): SettingsDraft {
  const nav = navigationOf(draft);
  if (nav.agentTypes.length >= MAX_NAV_AGENT_TYPES) return draft;
  const name = uniqueName("Agent", nav.agentTypes.map((t) => t.name));
  return withNavigation(draft, { ...nav, agentTypes: [...nav.agentTypes, defaultNavAgentType(id, name)] });
}

/** Remove an agent type (the last one stays: agents need a type). */
export function removeNavAgentType(draft: SettingsDraft, index: number): SettingsDraft {
  const nav = navigationOf(draft);
  if (nav.agentTypes[index] === undefined || nav.agentTypes.length <= 1) return draft;
  return withNavigation(draft, { ...nav, agentTypes: nav.agentTypes.filter((_, i) => i !== index) });
}

export function renameNavAgentType(draft: SettingsDraft, index: number, name: string): SettingsDraft {
  const nav = navigationOf(draft);
  const t = nav.agentTypes[index];
  if (!t || name.trim() === "" || t.name === name) return draft;
  return withNavigation(draft, { ...nav, agentTypes: nav.agentTypes.map((a, i) => (i === index ? { ...a, name } : a)) });
}

/** Set one value of an agent type by dotted path (`"canFly"`, `"walk.radius"`, `"avoidance.layers"`), as given. */
export function setNavAgentValue(draft: SettingsDraft, index: number, path: string, value: unknown): SettingsDraft {
  const nav = navigationOf(draft);
  const t = nav.agentTypes[index];
  if (!t) return draft;
  return withNavigation(draft, { ...nav, agentTypes: nav.agentTypes.map((a, i) => (i === index ? setPath(a, path, value) : a)) });
}

/** Turn an agent type's local avoidance on (with the defaults) or off. */
export function setNavAgentAvoidance(draft: SettingsDraft, index: number, on: boolean): SettingsDraft {
  const t = navigationOf(draft).agentTypes[index];
  if (!t || (t.avoidance !== null) === on) return draft;
  return setNavAgentValue(draft, index, "avoidance", on ? defaultNavAgentType("", "").avoidance : null);
}

/**
 * Override an area's cost for an agent type: a number, `"excluded"` (never walks it), or null to use the
 * area's own cost.
 */
export function setNavAgentAreaCost(draft: SettingsDraft, index: number, area: string, cost: number | "excluded" | null): SettingsDraft {
  const t = navigationOf(draft).agentTypes[index];
  if (!t) return draft;
  const others = t.areaCosts.filter((c) => c.area !== area);
  const next = cost === null ? others : [...others, { area, cost: cost === "excluded" ? -1 : cost, excluded: cost === "excluded" }];
  return setNavAgentValue(draft, index, "areaCosts", next);
}

/** An agent type's override for an area, if it has one. */
export function navAreaCostOf(t: NavAgentType, area: string): number | "excluded" | null {
  const c = t.areaCosts.find((o) => o.area === area);
  if (!c) return null;
  return c.excluded ? "excluded" : c.cost;
}

// --- areas ------------------------------------------------------------------------------------------

export function addNavArea(draft: SettingsDraft, id = newNavId()): SettingsDraft {
  const nav = navigationOf(draft);
  if (nav.areas.length >= MAX_NAV_AREAS) return draft;
  const name = uniqueName("Area", nav.areas.map((a) => a.name));
  return withNavigation(draft, { ...nav, areas: [...nav.areas, defaultNavArea(id, name)] });
}

/** Remove an area, with the agent types' cost overrides for it. */
export function removeNavArea(draft: SettingsDraft, index: number): SettingsDraft {
  const nav = navigationOf(draft);
  const gone = nav.areas[index];
  if (!gone) return draft;
  return withNavigation(draft, {
    ...nav,
    areas: nav.areas.filter((_, i) => i !== index),
    agentTypes: nav.agentTypes.map((t) => ({ ...t, areaCosts: t.areaCosts.filter((c) => c.area !== gone.id) })),
  });
}

export function setNavAreaValue<K extends "name" | "cost" | "color">(draft: SettingsDraft, index: number, key: K, value: NavArea[K]): SettingsDraft {
  const nav = navigationOf(draft);
  if (!nav.areas[index]) return draft;
  if (key === "name" && String(value).trim() === "") return draft;
  return withNavigation(draft, { ...nav, areas: nav.areas.map((a, i) => (i === index ? { ...a, [key]: value } : a)) });
}

// --- the rest of the section ------------------------------------------------------------------------

/** Set a section value by dotted path (`"tileSize"`, `"build.vertsPerPoly"`, `"orientation.maxSurfaceDeg"`), as given. */
export function setNavValue(draft: SettingsDraft, path: string, value: unknown): SettingsDraft {
  return withNavigation(draft, setPath(navigationOf(draft), path, value));
}

/** Replace the surface rings. */
export const setNavSurfaceRings = (draft: SettingsDraft, rings: NavigationSettings["surfaceRings"]): SettingsDraft => withNavigation(draft, { ...navigationOf(draft), surfaceRings: rings });

/** Put the defaults back (the section is removed from `project.json`). */
export const resetNavigation = (draft: SettingsDraft): SettingsDraft => ({ ...draft, navigation: undefined });

// --- the voxel preview ------------------------------------------------------------------------------

/** `Round3` (nav-bake's settings.rs): three significant digits. */
function round3(v: number): number {
  if (!(v > 0)) return v;
  const scale = Math.pow(10, Math.floor(Math.log10(v)) - 2);
  return Math.round(v / scale) * scale;
}

/**
 * The voxel size an agent type bakes with (`NavigationSetup.ToBakeProfile`): the fixed size, or Recast's
 * rule of thumb from its radius and step height. Rounded for display.
 */
export function navVoxelSize(nav: NavigationSettings, t: NavAgentType): { cellSize: number; cellHeight: number; radiusCells: number; stepCells: number; heightCells: number } {
  let cellSize: number, cellHeight: number;
  if (nav.voxels === "fixed") {
    cellSize = nav.cellSize;
    cellHeight = nav.cellHeight;
  } else {
    cellSize = round3(Math.max(t.walk.radius, 0.01) / Math.max(nav.cellsPerRadius, 0.5));
    cellHeight = t.walk.stepHeight > 0 ? round3(Math.min(0.5 * cellSize, 0.5 * t.walk.stepHeight)) : round3(0.5 * cellSize);
  }
  const tidy = (n: number) => Math.round(n * 1e4) / 1e4;
  return {
    cellSize: tidy(cellSize),
    cellHeight: tidy(cellHeight),
    radiusCells: Math.ceil(t.walk.radius / cellSize),
    stepCells: Math.floor(t.walk.stepHeight / cellHeight),
    heightCells: Math.ceil(t.walk.height / cellHeight),
  };
}

/** `[r, g, b, a]` (0-1) → `#rrggbb`. */
export const navColorHex = (c: readonly number[]): string =>
  `#${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;

/** `#rrggbb` → `[r, g, b, a]`, keeping `alpha`. */
export function navHexColor(hex: string, alpha = 1): [number, number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1, alpha];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, alpha];
}
