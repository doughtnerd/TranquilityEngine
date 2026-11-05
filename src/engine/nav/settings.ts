/**
 * Internal (ADR 0065): the `navigation` section of project settings (`project.json`), Foxfire's
 * `NavigationSetup` plus the runtime budgets. Field names are the Rust crates' field names in camelCase
 * (`nav-bake`'s `settings.rs`, `nav-crowd`'s `settings.rs`), so the JSON of a parsed section is exactly
 * what `NavRuntime` and `NavBaker` read (`native/nav/crates/nav-wasm/src/dto.rs`).
 *
 * Units are metres and seconds. The defaults here are Myco's (a person-sized walker); the Rust structs'
 * own defaults are Foxfire's larger-unit ones and only apply to fields left out of the JSON, which a
 * parsed section never does.
 */

export type NavEase =
  | "constant" | "inSine" | "outSine" | "inOutSine" | "inQuad" | "outQuad" | "inOutQuad"
  | "inCubic" | "outCubic" | "inOutCubic" | "inQuart" | "outQuart" | "inOutQuart";
export const NAV_EASES: readonly NavEase[] = [
  "constant", "inSine", "outSine", "inOutSine", "inQuad", "outQuad", "inOutQuad",
  "inCubic", "outCubic", "inOutCubic", "inQuart", "outQuart", "inOutQuart",
];

/** How speed eases at the ends of a journey (`NavMotion`). */
export interface NavMotionSettings {
  ease: NavEase;
  /** Seconds from setting off to full speed (In and InOut eases). */
  easeInTime: number;
  /** Seconds from full speed to the stop (Out and InOut eases). */
  easeOutTime: number;
}

/** A walking agent type (`NavMeshAgent`). */
export interface NavWalkSettings {
  radius: number;
  height: number;
  stepHeight: number;
  /** Distance from the surface to the node's pivot, along the surface normal. */
  pivotOffset: number;
  speed: number;
  /** Orientation smoothing rate (1/s). */
  turnSpeed: number;
  motion: NavMotionSettings;
  canClimbWalls: boolean;
  canWalkCeilings: boolean;
  /** Sharpest fold crossed, 0-90 degrees. */
  maxFoldAngleDeg: number;
  wallCostMultiplier: number;
  ceilingCostMultiplier: number;
  canJump: boolean;
  maxJumpUpHeight: number;
  maxJumpDistance: number;
  maxFallDistance: number;
  jumpArcHeight: number;
  jumpCost: number;
  jumpApexSpeed: number;
  jumpRiseGravity: number;
  jumpFallGravity: number;
  waypointReachedDistance: number;
  arrivalDistance: number;
  maxSnapDistance: number;
  maxSearchNodes: number;
  /** Seconds without getting closer to the next waypoint before skipping it; 0 = never. */
  stuckSkipTime: number;
  flowFieldPortalMiddles: boolean;
  /** Seconds between timed repaths; 0 = never on a timer. */
  repathInterval: number;
  /** Repath if pushed this far off the current segment; 0 = off. */
  offPathDistance: number;
  congestionCost: number;
}

/** A flying agent type (`NavFlightAgent`); the walk-and-fly fields apply to types that do both. */
export interface NavFlightSettings {
  radius: number;
  speed: number;
  turnSpeed: number;
  motion: NavMotionSettings;
  waypointReachedDistance: number;
  arrivalDistance: number;
  maxSnapDistance: number;
  maxSearchNodes: number;
  repathInterval: number;
  offPathDistance: number;
  /** Longest flight between takeoff and landing; 0 = unlimited. */
  maxFlightDistance: number;
  landWhenOutOfReach: boolean;
  hoverAtChunkFaces: boolean;
  flightCostMultiplier: number;
  takeoffCost: number;
  landingCost: number;
  takeoffSpeed: number;
  maxLandingSlopeDeg: number;
  takeoffHeight: number;
  walkInsteadRatio: number;
  separationStrength: number;
  separationRadiusScale: number;
  maxSeparationNeighbors: number;
}

/** Local avoidance (ORCA, `NavAvoidance`). */
export interface NavAvoidanceSettings {
  /** 0 = the agent's radius. */
  radius: number;
  neighborDistance: number;
  /** At most 30. */
  maxNeighbors: number;
  timeHorizon: number;
  obstacleTimeHorizon: number;
  /** 0-99, lower is more important. */
  priority: number;
  /** The avoidance layers the agent is on (bits). */
  layers: number;
  /** Layers it steers around (bits). */
  avoidLayers: number;
}

/** An area cost override: `cost` < 0 keeps the area's default cost. */
export interface NavAreaCost {
  area: string;
  cost: number;
  excluded: boolean;
}

/** One agent type (`NavAgentSettings`). Up to 32 walking types get navmeshes. */
export interface NavAgentType {
  /** Stable id (a UUID); what bakes and agents refer to. */
  id: string;
  name: string;
  canWalk: boolean;
  walk: NavWalkSettings;
  canFly: boolean;
  flight: NavFlightSettings;
  /** null: no avoidance. */
  avoidance: NavAvoidanceSettings | null;
  /** Lone agents of this type may join groups going to the same place. */
  joinGroups: boolean;
  /** Every agent of the type starts with these. */
  areaCosts: NavAreaCost[];
}

/** An area type (up to 62). */
export interface NavArea {
  id: string;
  name: string;
  /** Default cost multiplier. */
  cost: number;
  /** Debug colour, rgba 0-1. */
  color: [number, number, number, number];
}

/** Orientation bins (`OrientationConfig`). */
export interface NavOrientationSettings {
  maxSurfaceDeg: number;
  groundCaptureDeg: number;
  ceilingCaptureDeg: number;
  coverageDeg: number;
  maxFoldDeg: number;
}

/** A ring of wall/slope bins (`SurfaceRing`). */
export interface NavSurfaceRing {
  tiltDeg: number;
  count: number;
  azimuthOffsetDeg: number;
}

/** Recast's polygon build settings, in voxels (`NavMeshBuildSettings`). */
export interface NavBuildSettings {
  minRegionArea: number;
  mergeRegionArea: number;
  maxSimplificationError: number;
  maxEdgeLength: number;
  vertsPerPoly: number;
  detailSampleDistance: number;
  detailSampleMaxError: number;
}

/** The runtime's budgets (`NavigationRuntimeSettings`). */
export interface NavRuntimeSettings {
  /** Most ground path searches at once; 0 = 256. */
  maxPathsPerFrame: number;
  congestionWindow: number;
  congestionSlot: number;
  congestionRepathInterval: number;
  idleAgentsHoldGround: boolean;
  flowFieldMemoryMb: number;
  avoidanceNeighborRefresh: number;
}

export type NavVoxelSizing = "auto" | "fixed";
export type NavFlightAutoRefine = "off" | "x2" | "x4" | "x8";

/** The `navigation` project settings section. */
export interface NavigationSettings {
  agentTypes: NavAgentType[];
  areas: NavArea[];
  orientation: NavOrientationSettings;
  surfaceRings: NavSurfaceRing[];
  voxels: NavVoxelSizing;
  /** Auto voxels: cells across an agent's radius. */
  cellsPerRadius: number;
  /** Fixed voxels: width and height. */
  cellSize: number;
  cellHeight: number;
  /** Columns per tile side (16-256). */
  tileSize: number;
  build: NavBuildSettings;
  flightVoxels: NavVoxelSizing;
  flightCellsPerRadius: number;
  flightCellSize: number;
  flightHeadroomRadii: number;
  flightOpenToSkyOnly: boolean;
  flightAutoRefine: NavFlightAutoRefine;
  flightAutoRefineMaxCells: number;
  /** Chunk bounds snap to this world grid (x and z); 0 = none. */
  chunkGrid: number;
  runtime: NavRuntimeSettings;
}

export const MAX_NAV_AGENT_TYPES = 32;
export const MAX_NAV_AREAS = 62;

export const defaultNavMotion = (): NavMotionSettings => ({ ease: "constant", easeInTime: 1, easeOutTime: 1 });

export const defaultNavWalk = (): NavWalkSettings => ({
  radius: 0.5, height: 2, stepHeight: 0.4, pivotOffset: 0,
  speed: 3.5, turnSpeed: 10, motion: defaultNavMotion(),
  canClimbWalls: false, canWalkCeilings: false, maxFoldAngleDeg: 90, wallCostMultiplier: 1.5, ceilingCostMultiplier: 2,
  canJump: false, maxJumpUpHeight: 1, maxJumpDistance: 2, maxFallDistance: 3, jumpArcHeight: 1,
  jumpCost: 1.25, jumpApexSpeed: 6, jumpRiseGravity: 15, jumpFallGravity: 25,
  waypointReachedDistance: 0.5, arrivalDistance: 0.5, maxSnapDistance: 2, maxSearchNodes: 4096,
  stuckSkipTime: 2, flowFieldPortalMiddles: false,
  repathInterval: 2, offPathDistance: 5, congestionCost: 3,
});

export const defaultNavFlight = (): NavFlightSettings => ({
  radius: 0.5, speed: 5, turnSpeed: 10, motion: defaultNavMotion(),
  waypointReachedDistance: 1, arrivalDistance: 1, maxSnapDistance: 2, maxSearchNodes: 8192,
  repathInterval: 2, offPathDistance: 5,
  maxFlightDistance: 0, landWhenOutOfReach: false, hoverAtChunkFaces: false, flightCostMultiplier: 1,
  takeoffCost: 2, landingCost: 2, takeoffSpeed: 2, maxLandingSlopeDeg: 30, takeoffHeight: 2, walkInsteadRatio: 1.5,
  separationStrength: 1, separationRadiusScale: 1.5, maxSeparationNeighbors: 8,
});

export const defaultNavAvoidance = (): NavAvoidanceSettings => ({
  radius: 0, neighborDistance: 6, maxNeighbors: 10, timeHorizon: 1.5, obstacleTimeHorizon: 0.5,
  priority: 50, layers: 1, avoidLayers: 0xffffffff,
});

/** A new agent type: walks, doesn't fly, avoids. */
export const defaultNavAgentType = (id: string, name: string): NavAgentType => ({
  id, name, canWalk: true, walk: defaultNavWalk(), canFly: false, flight: defaultNavFlight(),
  avoidance: defaultNavAvoidance(), joinGroups: false, areaCosts: [],
});

export const defaultNavArea = (id: string, name: string): NavArea => ({ id, name, cost: 1, color: [0.2, 0.6, 1, 1] });

/** The id of the agent type a new project starts with. */
export const DEFAULT_NAV_AGENT_TYPE_ID = "6e2a0f1c-5b7d-4c3e-9a10-4d2f8b6c1e01";

export const defaultNavigationSettings = (): NavigationSettings => ({
  agentTypes: [defaultNavAgentType(DEFAULT_NAV_AGENT_TYPE_ID, "Humanoid")],
  areas: [],
  // Coverage 55 rather than Foxfire's 60: with the default agent (step 0.4 m, auto voxels 0.25 × 0.125 m) a voxel
  // field holds slopes up to ~56°, so a bin taking surfaces 60° off would leave strips with gaps (the bake warns).
  orientation: { maxSurfaceDeg: 180, groundCaptureDeg: 45, ceilingCaptureDeg: 45, coverageDeg: 55, maxFoldDeg: 90 },
  surfaceRings: [{ tiltDeg: 90, count: 4, azimuthOffsetDeg: 0 }],
  voxels: "auto",
  cellsPerRadius: 2,
  cellSize: 0.25,
  cellHeight: 0.1,
  tileSize: 64,
  build: { minRegionArea: 2, mergeRegionArea: 8, maxSimplificationError: 4, maxEdgeLength: 24, vertsPerPoly: 6, detailSampleDistance: 2, detailSampleMaxError: 1 },
  flightVoxels: "auto",
  flightCellsPerRadius: 1,
  flightCellSize: 1,
  flightHeadroomRadii: 4,
  flightOpenToSkyOnly: true,
  flightAutoRefine: "off",
  flightAutoRefineMaxCells: 20000,
  chunkGrid: 4,
  runtime: { maxPathsPerFrame: 32, congestionWindow: 4, congestionSlot: 0.5, congestionRepathInterval: 1.5, idleAgentsHoldGround: false, flowFieldMemoryMb: 64, avoidanceNeighborRefresh: 0 },
});

// ---------------------------------------------------------------------------------------------------------
// Lenient parsing
// ---------------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Rule {
  min?: number;
  max?: number;
  int?: boolean;
  choices?: readonly string[];
}

type Rules = Record<string, Rule>;

/**
 * A copy of `defaults` with the values of `raw` that have the right type (and fit the field's rule);
 * nested objects whose default is an object are merged the same way when `nested` names them. Problems
 * name the field and the value used instead.
 */
function merge<T extends object>(defaults: T, raw: unknown, where: string, problems: string[], rules: Rules = {}, nested: Record<string, Rules> = {}): T {
  const out = structuredClone(defaults) as Record<string, unknown>;
  if (raw === undefined) return out as T;
  if (!isObject(raw)) {
    problems.push(`${where} must be an object; using the defaults.`);
    return out as T;
  }
  for (const [key, value] of Object.entries(raw)) {
    const at = `${where}.${key}`;
    if (!(key in out)) {
      problems.push(`${where}: unknown setting "${key}".`);
      continue;
    }
    const def = out[key];
    const rule = rules[key] ?? {};
    const bad = (expected: string) => problems.push(`${at} should be ${expected}; using ${JSON.stringify(def)}.`);
    if (typeof def === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) bad("a number");
      else if (rule.int && !Number.isInteger(value)) bad("a whole number");
      else if (rule.min !== undefined && value < rule.min) bad(`at least ${rule.min}`);
      else if (rule.max !== undefined && value > rule.max) bad(`at most ${rule.max}`);
      else out[key] = value;
    } else if (typeof def === "boolean") {
      if (typeof value === "boolean") out[key] = value;
      else bad("true or false");
    } else if (typeof def === "string") {
      if (typeof value !== "string") bad("a string");
      else if (rule.choices && !rule.choices.includes(value)) bad(rule.choices.map((c) => `"${c}"`).join(", "));
      else out[key] = value;
    } else if (isObject(def) && key in nested) {
      out[key] = merge(def, value, at, problems, nested[key]);
    }
  }
  return out as T;
}

const NON_NEGATIVE: Rule = { min: 0 };
const POSITIVE: Rule = { min: 0.001 };
const MOTION_RULES: Rules = { ease: { choices: NAV_EASES }, easeInTime: NON_NEGATIVE, easeOutTime: NON_NEGATIVE };
const WALK_RULES: Rules = {
  radius: POSITIVE, height: POSITIVE, stepHeight: NON_NEGATIVE, speed: NON_NEGATIVE, turnSpeed: NON_NEGATIVE,
  maxFoldAngleDeg: { min: 0, max: 90 }, maxSearchNodes: { min: 1, int: true }, maxSnapDistance: NON_NEGATIVE,
  arrivalDistance: NON_NEGATIVE, waypointReachedDistance: NON_NEGATIVE,
};
const FLIGHT_RULES: Rules = {
  radius: { min: 0.01 }, speed: NON_NEGATIVE, maxSearchNodes: { min: 1, int: true }, maxLandingSlopeDeg: { min: 0, max: 90 },
  maxSeparationNeighbors: { min: 0, max: 16, int: true },
};
const AVOIDANCE_RULES: Rules = {
  maxNeighbors: { min: 0, max: 30, int: true }, priority: { min: 0, max: 99, int: true },
  layers: { min: 0, max: 0xffffffff, int: true }, avoidLayers: { min: 0, max: 0xffffffff, int: true },
};
const AGENT_KEYS = ["id", "name", "canWalk", "walk", "canFly", "flight", "avoidance", "joinGroups", "areaCosts"];
const SECTION_KEYS = Object.keys(defaultNavigationSettings());

function areaCosts(raw: unknown, where: string, problems: string[]): NavAreaCost[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be a list; ignored.`);
    return [];
  }
  const out: NavAreaCost[] = [];
  raw.forEach((c: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(c) || typeof c.area !== "string" || !c.area) {
      problems.push(`${at}: an area cost needs an area id; skipped.`);
      return;
    }
    out.push(merge({ area: c.area, cost: -1, excluded: false }, c, at, problems));
  });
  return out;
}

function agentType(raw: unknown, i: number, problems: string[]): NavAgentType | null {
  const where = `navigation.agentTypes[${i}]`;
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
    problems.push(`${where}: an agent type needs an id; skipped.`);
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name : raw.id;
  const at = `${where} ("${name}")`;
  const t = defaultNavAgentType(raw.id, name);
  for (const key of Object.keys(raw)) if (!AGENT_KEYS.includes(key)) problems.push(`${at}: unknown setting "${key}".`);
  for (const key of ["canWalk", "canFly", "joinGroups"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === "boolean") t[key] = raw[key] as boolean;
    else problems.push(`${at}.${key} should be true or false; using ${t[key]}.`);
  }
  t.walk = merge(t.walk, raw.walk, `${at}.walk`, problems, WALK_RULES, { motion: MOTION_RULES });
  t.flight = merge(t.flight, raw.flight, `${at}.flight`, problems, FLIGHT_RULES, { motion: MOTION_RULES });
  if (raw.avoidance === null) t.avoidance = null;
  else t.avoidance = merge(defaultNavAvoidance(), raw.avoidance, `${at}.avoidance`, problems, AVOIDANCE_RULES);
  t.areaCosts = areaCosts(raw.areaCosts, `${at}.areaCosts`, problems);
  if (!t.canWalk && !t.canFly) problems.push(`${at}: neither walks nor flies, so nothing is baked for it.`);
  return t;
}

function area(raw: unknown, i: number, problems: string[]): NavArea | null {
  const where = `navigation.areas[${i}]`;
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
    problems.push(`${where}: an area needs an id; skipped.`);
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name : raw.id;
  const a = defaultNavArea(raw.id, name);
  const at = `${where} ("${name}")`;
  for (const key of Object.keys(raw)) if (!["id", "name", "cost", "color"].includes(key)) problems.push(`${at}: unknown setting "${key}".`);
  if (raw.cost !== undefined) {
    if (typeof raw.cost === "number" && raw.cost > 0) a.cost = raw.cost;
    else problems.push(`${at}.cost should be a positive number; using 1.`);
  }
  if (raw.color !== undefined) {
    if (Array.isArray(raw.color) && raw.color.length === 4 && raw.color.every((c) => typeof c === "number")) a.color = raw.color as NavArea["color"];
    else problems.push(`${at}.color should be [r, g, b, a] (0-1); using the default.`);
  }
  return a;
}

/**
 * Read a `navigation` section leniently: bad values are reported and replaced by the default; agent
 * types and areas without an id, or with a duplicate id, are skipped. Undefined gives the defaults.
 */
export function parseNavigationSettings(input: unknown): { settings: NavigationSettings; problems: string[] } {
  const problems: string[] = [];
  const defaults = defaultNavigationSettings();
  if (input === undefined) return { settings: defaults, problems };
  if (!isObject(input)) return { settings: defaults, problems: ["navigation must be an object; using the default navigation settings."] };
  for (const key of Object.keys(input)) if (!SECTION_KEYS.includes(key)) problems.push(`navigation: unknown setting "${key}".`);

  const settings = merge(
    defaults,
    Object.fromEntries(Object.entries(input).filter(([k]) => !["agentTypes", "areas", "surfaceRings"].includes(k) && SECTION_KEYS.includes(k))),
    "navigation",
    problems,
    {
      voxels: { choices: ["auto", "fixed"] }, flightVoxels: { choices: ["auto", "fixed"] }, flightAutoRefine: { choices: ["off", "x2", "x4", "x8"] },
      cellsPerRadius: { min: 0.5 }, cellSize: POSITIVE, cellHeight: POSITIVE, tileSize: { min: 16, max: 256, int: true },
      flightCellsPerRadius: { min: 0.25 }, flightCellSize: POSITIVE, flightHeadroomRadii: NON_NEGATIVE,
      flightAutoRefineMaxCells: { min: 0, int: true }, chunkGrid: NON_NEGATIVE,
    },
    {
      orientation: { maxSurfaceDeg: { min: 0, max: 180 }, groundCaptureDeg: { min: 0, max: 90 }, ceilingCaptureDeg: { min: 0, max: 90 }, coverageDeg: { min: 1, max: 85 }, maxFoldDeg: { min: 0, max: 90 } },
      build: { minRegionArea: { min: 0, int: true }, mergeRegionArea: { min: 0, int: true }, maxEdgeLength: { min: 0, int: true }, vertsPerPoly: { min: 3, max: 6, int: true }, maxSimplificationError: NON_NEGATIVE, detailSampleDistance: NON_NEGATIVE, detailSampleMaxError: NON_NEGATIVE },
      runtime: { maxPathsPerFrame: { min: 0, int: true }, avoidanceNeighborRefresh: { min: 0, int: true }, congestionWindow: NON_NEGATIVE, congestionSlot: NON_NEGATIVE, flowFieldMemoryMb: NON_NEGATIVE },
    },
  );

  if (input.agentTypes !== undefined) {
    if (!Array.isArray(input.agentTypes)) problems.push("navigation.agentTypes must be a list; using the default agent types.");
    else {
      settings.agentTypes = [];
      input.agentTypes.forEach((raw: unknown, i) => {
        const t = agentType(raw, i, problems);
        if (!t) return;
        if (settings.agentTypes.some((o) => o.id === t.id)) problems.push(`navigation.agentTypes[${i}]: another agent type has the id "${t.id}"; skipped.`);
        else settings.agentTypes.push(t);
      });
      if (settings.agentTypes.filter((t) => t.canWalk).length > MAX_NAV_AGENT_TYPES) problems.push(`navigation.agentTypes: more than ${MAX_NAV_AGENT_TYPES} walking agent types; the rest get no navmesh.`);
    }
  }
  if (input.areas !== undefined) {
    if (!Array.isArray(input.areas)) problems.push("navigation.areas must be a list; ignored.");
    else {
      input.areas.forEach((raw: unknown, i) => {
        const a = area(raw, i, problems);
        if (!a) return;
        if (settings.areas.some((o) => o.id === a.id)) problems.push(`navigation.areas[${i}]: another area has the id "${a.id}"; skipped.`);
        else settings.areas.push(a);
      });
      if (settings.areas.length > MAX_NAV_AREAS) problems.push(`navigation.areas: more than ${MAX_NAV_AREAS} areas; the rest are dropped.`);
    }
  }
  if (input.surfaceRings !== undefined) {
    if (!Array.isArray(input.surfaceRings)) problems.push("navigation.surfaceRings must be a list; using the default ring.");
    else {
      const ringRules: Rules = { tiltDeg: { min: 0.001, max: 179.999 }, count: { min: 1, max: 32, int: true } };
      settings.surfaceRings = input.surfaceRings.map((r: unknown, i) => merge(defaults.surfaceRings[0], r, `navigation.surfaceRings[${i}]`, problems, ringRules));
    }
  }
  return { settings, problems };
}
