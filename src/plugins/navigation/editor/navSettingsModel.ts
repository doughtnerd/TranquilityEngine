// The Project panel's Navigation section (ADR 0065): `project.json`'s `navigation` key as part of the
// settings draft, edited by pure functions like the graphics tiers. Edits start from the leniently parsed
// section and write the whole section back, so values the parser rejects show as problems (and keep the
// draft from saving) until they're fixed or undone.
import {
  defaultNavArea,
  defaultNavAgentType,
  describeNavAvoidanceMask,
  isNavAvoidanceLayerNamed,
  MAX_NAV_AGENT_TYPES,
  MAX_NAV_AREAS,
  MAX_NAV_AVOIDANCE_LAYERS,
  NAV_AVOID_EVERYTHING,
  navAvoidanceLayerName,
  navLayerBit,
  navMaskHas,
  navShownLayers,
  parseNavigationSettings,
  type NavAgentType,
  type NavArea,
  type NavigationSettings,
} from "../../../engine/nav/settings";
import type { SettingsDraft } from "../../../editor/sdk";

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

// --- avoidance layers (Foxfire's NavAvoidanceLayerNames, NavAvoidanceLayersSettingsProvider, NavAvoidanceSummary) ---

const withLayerNames = (draft: SettingsDraft, nav: NavigationSettings, names: string[]): SettingsDraft => {
  const out = [...names];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return withNavigation(draft, { ...nav, avoidanceLayers: out });
};

/** The first unnamed layer slot, or -1 when all 32 are named. */
export function nextFreeNavAvoidanceLayer(nav: NavigationSettings): number {
  for (let i = 0; i < MAX_NAV_AVOIDANCE_LAYERS; i++) if (!isNavAvoidanceLayerNamed(nav, i)) return i;
  return -1;
}

/** Name the next unnamed layer slot ("Layer n", to be renamed). */
export function addNavAvoidanceLayer(draft: SettingsDraft): SettingsDraft {
  const nav = navigationOf(draft);
  const slot = nextFreeNavAvoidanceLayer(nav);
  if (slot < 0) return draft;
  return renameNavAvoidanceLayer(draft, slot, uniqueName(`Layer ${slot}`, nav.avoidanceLayers));
}

/** Name a layer; "" leaves it unnamed (it still works, shown as "Layer n"). */
export function renameNavAvoidanceLayer(draft: SettingsDraft, layer: number, name: string): SettingsDraft {
  const nav = navigationOf(draft);
  if (layer < 0 || layer >= MAX_NAV_AVOIDANCE_LAYERS || (nav.avoidanceLayers[layer] ?? "") === name) return draft;
  const names = [...nav.avoidanceLayers];
  while (names.length <= layer) names.push("");
  names[layer] = name;
  return withLayerNames(draft, nav, names);
}

/** The agent types that take part in avoidance (walk with avoidance on: flyers only separate), by name. */
export function navAvoidingTypes(nav: NavigationSettings): { index: number; t: NavAgentType }[] {
  return nav.agentTypes
    .map((t, index) => ({ index, t }))
    .filter(({ t }) => t.canWalk && t.avoidance !== null)
    .sort((a, b) => (a.t.name < b.t.name ? -1 : a.t.name > b.t.name ? 1 : 0));
}

/** The avoiding agent types on layer `layer`. */
const typesOn = (nav: NavigationSettings, layer: number) => navAvoidingTypes(nav).filter(({ t }) => navMaskHas(t.avoidance!.layers, layer));

/** The names of the agent types on an avoidance layer (to warn when it's left unnamed). */
export const navAvoidanceLayerUsers = (nav: NavigationSettings, layer: number): string[] =>
  nav.agentTypes.filter((t) => t.avoidance && navMaskHas(t.avoidance.layers, layer)).map((t) => t.name);

/** The layers the names block lists: layer 0, the named ones, and any an agent type is on or avoids by name. */
export function navListedLayers(nav: NavigationSettings): number[] {
  let used = 0;
  for (const t of nav.agentTypes) {
    if (!t.avoidance) continue;
    used |= t.avoidance.layers;
    if (t.avoidance.avoidLayers >>> 0 !== NAV_AVOID_EVERYTHING) used |= t.avoidance.avoidLayers;
  }
  return navShownLayers(nav, used >>> 0);
}

export type NavMatrixState = "on" | "off" | "mixed";

export interface NavMatrixRow {
  layer: number;
  /** "Enemy (Grunt, Brute)". */
  label: string;
  types: string[];
  cells: { layer: number; state: NavMatrixState; tip: string }[];
}

/**
 * Who avoids whom: rows are the layers avoiding agent types are on, columns the named layers plus any an agent type
 * is on or avoids by name. A cell is on when every type on the row's layer avoids the column's, mixed when some do.
 * Not symmetric; layers with only obstacles get no row.
 */
export function navAvoidanceMatrix(nav: NavigationSettings): { columns: number[]; rows: NavMatrixRow[] } {
  const agents = navAvoidingTypes(nav);
  let on = 0;
  let avoided = 0;
  for (const { t } of agents) {
    on |= t.avoidance!.layers;
    if (t.avoidance!.avoidLayers >>> 0 !== NAV_AVOID_EVERYTHING) avoided |= t.avoidance!.avoidLayers;
  }
  const columns = navShownLayers(nav, (on | avoided) >>> 0);
  const rows: NavMatrixRow[] = [];
  for (let row = 0; row < MAX_NAV_AVOIDANCE_LAYERS; row++) {
    if (!navMaskHas(on, row)) continue;
    const types = typesOn(nav, row).map(({ t }) => t);
    const names = types.map((t) => t.name);
    const rowName = navAvoidanceLayerName(nav, row);
    rows.push({
      layer: row,
      label: `${rowName} (${names.join(", ")})`,
      types: names,
      cells: columns.map((col) => {
        const avoiding = types.filter((t) => navMaskHas(t.avoidance!.avoidLayers, col)).map((t) => t.name);
        const state: NavMatrixState = avoiding.length === 0 ? "off" : avoiding.length === types.length ? "on" : "mixed";
        const tip = `${rowName} avoids ${navAvoidanceLayerName(nav, col)}${state === "mixed" ? `: only ${avoiding.join(", ")}` : ""}`;
        return { layer: col, state, tip };
      }),
    });
  }
  return { columns, rows };
}

/** Click a matrix cell: set (or clear) layer `col` in the avoid layers of every avoiding type on layer `row`. */
export function setNavAvoidanceCell(draft: SettingsDraft, row: number, col: number, avoid: boolean): SettingsDraft {
  const nav = navigationOf(draft);
  const onRow = new Set(typesOn(nav, row).map(({ index }) => index));
  if (onRow.size === 0) return draft;
  const bit = navLayerBit(col);
  return withNavigation(draft, {
    ...nav,
    agentTypes: nav.agentTypes.map((t, i) => {
      if (!onRow.has(i) || !t.avoidance) return t;
      const mask = t.avoidance.avoidLayers >>> 0;
      return { ...t, avoidance: { ...t.avoidance, avoidLayers: (avoid ? mask | bit : mask & ~bit) >>> 0 } };
    }),
  });
}

/** Put an agent type on one avoidance layer (null = none). */
export function setNavAgentLayer(draft: SettingsDraft, index: number, layer: number | null): SettingsDraft {
  const t = navigationOf(draft).agentTypes[index];
  if (!t?.avoidance) return draft;
  return setNavAgentValue(draft, index, "avoidance.layers", layer === null ? 0 : navLayerBit(layer));
}

/** The layer an agent type is on (null = none), for the "On layer" dropdown. */
export function navAgentLayer(t: NavAgentType): number | null {
  const l = t.avoidance?.layers ?? 0;
  for (let i = 0; i < MAX_NAV_AVOIDANCE_LAYERS; i++) if (navMaskHas(l, i)) return i;
  return null;
}

const onText = (nav: NavigationSettings, layers: number) => (layers >>> 0 === 0 ? "no layer (nothing avoids it)" : describeNavAvoidanceMask(nav, layers));

function avoidedByText(nav: NavigationSettings, layers: number): string {
  if (layers >>> 0 === 0) return "nothing";
  const names = navAvoidingTypes(nav)
    .filter(({ t }) => ((t.avoidance!.avoidLayers >>> 0) & (layers >>> 0)) !== 0)
    .map(({ t }) => t.name);
  return names.length === 0 ? "no agent type" : names.join(", ");
}

function separationText(nav: NavigationSettings, t: NavAgentType): string {
  if (t.flight.separationStrength <= 0) return "Separation is off: it passes through other flyers.";
  const a = t.avoidance ?? { layers: 1, avoidLayers: NAV_AVOID_EVERYTHING };
  return `It separates from flyers on: ${describeNavAvoidanceMask(nav, a.avoidLayers)} (it's on: ${onText(nav, a.layers)}).`;
}

/** Foxfire's NavAvoidanceSummary for an agent type, as lines ("On: Enemy", "Avoids: Player, Enemy", "Avoided by: …"). */
export function navAvoidanceSummary(nav: NavigationSettings, t: NavAgentType): string[] {
  if (!t.canWalk) return t.canFly ? ["Avoidance: this agent only flies, and flying agents don't use avoidance.", separationText(nav, t)] : [];
  if (!t.avoidance) {
    const off = "Avoidance is off: this agent doesn't steer around anything, and other agents don't steer around it.";
    return t.canFly ? [off, separationText(nav, t)] : [off];
  }
  const lines = [`On: ${onText(nav, t.avoidance.layers)}`, `Avoids: ${describeNavAvoidanceMask(nav, t.avoidance.avoidLayers)}`, `Avoided by: ${avoidedByText(nav, t.avoidance.layers)}`];
  if (t.canFly) lines.push("While flying it takes no part in avoidance.", separationText(nav, t));
  return lines;
}

/** The summary of an avoidance obstacle on `layers` ("On: …", "Avoided by: …"). */
export const navObstacleSummary = (nav: NavigationSettings, layers: number): string[] => [`On: ${onText(nav, layers)}`, `Avoided by: ${avoidedByText(nav, layers)}`];

// --- per-agent-type warnings (Foxfire's NavigationSetupEditor) ----------------------------------------

/** A number as Rust's `{}` prints an f32 (its shortest text as an f32). */
const f32Text = (v: number): string => String(Number(Math.fround(v).toPrecision(7)));

/**
 * Why this agent type's voxels will break the navmesh up, or null (nav-bake's `BakeProfile::voxel_warning`): a step
 * below one cell, or a voxel field that can't hold the slopes the orientation bins take.
 */
export function navVoxelWarning(nav: NavigationSettings, t: NavAgentType): string | null {
  const { cellSize, cellHeight } = navVoxelSize(nav, t);
  const step = t.walk.stepHeight;
  const climb = Math.floor(step / cellHeight) * cellHeight;
  if (climb <= 0) {
    return (
      `Step Height (${f32Text(step)}) is below Cell Height (${f32Text(cellHeight)}): no two voxel columns at different heights connect, so every ` +
      "surface that isn't exactly level in its bin breaks into strips with gaps. Use a Cell Height of Step Height / 2 or less."
    );
  }
  const maxTilt = (Math.atan(climb / cellSize) * 180) / Math.PI;
  const coverage = nav.orientation.coverageDeg;
  if (maxTilt < coverage) {
    return (
      `Surfaces tilted more than ~${maxTilt.toFixed(0)} degrees from their bin's up break into strips with gaps (Step Height ${f32Text(step)} ` +
      `over Cell Size ${f32Text(cellSize)}), but Coverage Deg lets a bin take surfaces up to ${coverage.toFixed(0)} degrees off. Lower Cell Height ` +
      "or Cell Size, or lower Coverage Deg and add surface rings."
    );
  }
  return null;
}

/** The warnings Foxfire's NavigationSetup inspector shows for an agent type. */
export function navAgentTypeWarnings(nav: NavigationSettings, t: NavAgentType): string[] {
  const out: string[] = [];
  if (!t.canWalk && !t.canFly) out.push(`${t.name} can neither walk nor fly: nothing is baked for it.`);
  if (!t.canWalk) return out;
  const voxel = navVoxelWarning(nav, t);
  if (voxel) out.push(`${t.name}: ${voxel}`);
  return out;
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

/** `base`, or "<base> 2", "<base> 3"… whichever isn't taken. */
function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}
