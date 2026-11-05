/**
 * Internal (ADR 0065): a typed wrapper over the navigation module's `NavRuntime` (`native/nav/crates/nav-wasm`).
 * Never exported from the engine's public API (ADR 0010): the `NavAgent` components, the built-in systems and the
 * `Navigation` facade sit on top of it.
 *
 * Per step (`engine.NavSync` / `NavStep` / `NavWriteBack`): call {@link NavigationRuntime.views}, write each live
 * agent's transform into `agentsIn` at its row (`row * AGENT_IN_STRIDE`), call {@link NavigationRuntime.tick}, call
 * `views()` again (a tick can grow the buffers) and read `agentsOut` / `agentState`. No per-agent call crosses the
 * boundary in the hot path.
 *
 * Buffer layouts (floats unless noted; row = the low 32 bits of an agent handle, see {@link agentRow}):
 * - `agentsIn` (host writes): position xyz, rotation quaternion xyzw, up xyz — stride 10.
 * - `agentsOut` (tick writes): position xyz, rotation xyzw, up xyz, velocity xyz, desired velocity xyz,
 *   remaining distance — stride 17.
 * - `agentState` (bytes, tick writes): path state, motion mode, flags ({@link NavStateFlags}), kind — stride 4.
 * - `obstaclesIn` (host writes): position xyz, up xyz — stride 6.
 */
import { loadNavigation, type NavigationModule } from "./loader";
import type { NavigationSettings } from "./settings";
import type { NavRuntime as RawRuntime } from "./wasm/myco_nav.js";

export const AGENT_IN_STRIDE = 10;
export const AGENT_OUT_STRIDE = 17;
export const AGENT_STATE_STRIDE = 4;
export const OBSTACLE_IN_STRIDE = 6;
export const WAYPOINT_STRIDE = 7;

/** An agent or obstacle handle: `row + generation * 2^32` (stale handles are ignored by the runtime). */
export type NavHandle = number;

/** The handle's row in the boundary buffers. */
export const agentRow = (handle: NavHandle): number => handle >>> 0;

export enum NavPathState {
  None = 0,
  Following = 1,
  Partial = 2,
  Arrived = 3,
  Failed = 4,
}

export enum NavMotionMode {
  Walking = 0,
  TakingOff = 1,
  Flying = 2,
  Landing = 3,
}

export enum NavAgentKind {
  None = 0,
  Walker = 1,
  Flyer = 2,
  WalkFly = 3,
}

/** Bits of an agent's flags byte (`agentState[row * 4 + 2]`). */
export const NavStateFlags = {
  steering: 1 << 0,
  /** Waiting for its chunk to load: nothing runs for it. */
  paused: 1 << 1,
  chasing: 1 << 2,
  groupMember: 1 << 3,
  requestPending: 1 << 4,
  groupBody: 1 << 5,
} as const;

/** Waypoint flags: the navmesh's bits, and {@link WAYPOINT_FLIGHT} on flight points. */
export const WAYPOINT_FLIGHT = 0x80;

export type Vec3 = readonly [number, number, number];

export interface NavAreaCostOverride {
  area: string;
  /** < 0: the area's default cost. */
  cost?: number;
  excluded?: boolean;
}

/** A runtime cost volume (ADR 0070, `NavCostVolume`): the box `center` ± `halfSize` in the space `worldToLocal` maps into. */
export interface NavCostVolumeDesc {
  /** The node's inverse world matrix, column-major (16 numbers). */
  worldToLocal: readonly number[];
  center: Vec3;
  halfSize: Vec3;
  /** Multiplier ≥ 0. */
  cost: number;
  excluded: boolean;
  /** Agent type ids; empty = every type. */
  agents: readonly string[];
  domain: "ground" | "air" | "both";
}

/** A group body's settings (`NavGroup`); every field optional. */
export interface NavGroupDesc {
  mode?: "formation" | "flock";
  formation?: "box" | "line" | "column" | "wedge" | "circle" | "mask";
  spacing?: number;
  slack?: number;
  catchUp?: number;
  memberPriority?: number;
  minPace?: number;
  layers?: number;
  layerSpacing?: number;
  flockRadius?: number;
  flockSeparation?: number;
  flockAlignment?: number;
  flockCohesion?: number;
  surround?: boolean;
  squeeze?: boolean;
  swapSlots?: boolean;
  bendColumns?: boolean;
  turnInPlace?: boolean;
  passThroughEachOther?: boolean;
  acceptJoiners?: boolean;
  joinDistance?: number;
  sameGoalDistance?: number;
  maxMembers?: number;
  merge?: boolean;
  mergePriority?: number;
}

/** How an agent is added. */
export interface NavAgentDesc {
  /** The agent type's id (from the navigation settings). */
  agentType: string;
  position: Vec3;
  rotation?: readonly [number, number, number, number];
  up?: Vec3;
  updatePosition?: boolean;
  updateRotation?: boolean;
  /** 0 = the type's. */
  speedOverride?: number;
  turnSpeedOverride?: number;
  avoidanceLayers?: number;
  avoidLayers?: number;
  avoidancePriority?: number;
  /** Over the type's own area costs. */
  areaCosts?: NavAreaCostOverride[];
  /** Makes the agent a group body. */
  group?: NavGroupDesc;
}

export interface NavObstacleDesc {
  radius: number;
  height: number;
  /** Avoidance layer bits. */
  layers?: number;
}

export interface NavSurroundDesc {
  radius?: number;
  spacing?: number;
  airSpacing?: number;
  claimDistance?: number;
  maxSlots?: number;
}

export interface NavWaypoint {
  position: Vec3;
  normal: Vec3;
  flags: number;
}

export type NavQueryStatus = "success" | "partial" | "none";

export interface NavPathResult {
  status: NavQueryStatus;
  waypoints: NavWaypoint[];
}

export interface NavRaycastResult {
  /** Fraction of the way travelled. */
  t: number;
  /** Something blocked the ray before `to`. */
  hit: boolean;
  point: Vec3;
  /** The blocking edge's normal (zero when not hit). */
  normal: Vec3;
}

export interface NavAgentSnapshot {
  kind: NavAgentKind;
  pathState: NavPathState;
  mode: NavMotionMode;
  flags: number;
  position: Vec3;
  rotation: readonly [number, number, number, number];
  up: Vec3;
  velocity: Vec3;
  desiredVelocity: Vec3;
  remainingDistance: number;
}

export interface NavTickStats {
  tick: number;
  agents: number;
  paused: number;
  commands: { applied: number; ignored: number };
  chunks: {
    snapshotChanged: boolean;
    gatesChanged: boolean;
    overlaysBuilt: number;
    overlaysRemoved: number;
    overlayFailures: number;
    seamsChanged: boolean;
    graphsRebuilt: boolean;
    gathers: number;
  };
}

/** Typed-array views of the boundary buffers; valid until {@link NavigationRuntime.views} returns new ones. */
export interface NavBufferViews {
  agentsIn: Float32Array;
  agentsOut: Float32Array;
  agentState: Uint8Array;
  obstaclesIn: Float32Array;
  /** Rows in the agent buffers (slots ever made; free rows hold stale data). */
  agentRows: number;
  obstacleRows: number;
  /** The runtime's buffer epoch these views were made for. */
  epoch: number;
}

const QUERY_STATUS: NavQueryStatus[] = ["success", "partial", "none"];

function waypoints(flat: Float32Array, offset: number): NavWaypoint[] {
  const out: NavWaypoint[] = [];
  for (let i = offset; i + WAYPOINT_STRIDE <= flat.length; i += WAYPOINT_STRIDE) {
    out.push({ position: [flat[i], flat[i + 1], flat[i + 2]], normal: [flat[i + 3], flat[i + 4], flat[i + 5]], flags: flat[i + 6] });
  }
  return out;
}

/** A World's navigation runtime. */
export class NavigationRuntime {
  private raw: RawRuntime | null;
  private memory: WebAssembly.Memory;
  private cached: NavBufferViews | null = null;
  private cachedBuffer: ArrayBufferLike | null = null;

  private constructor(readonly module: NavigationModule, raw: RawRuntime) {
    this.raw = raw;
    this.memory = module.wasmMemory() as WebAssembly.Memory;
  }

  /** Loads the module (once) and makes a runtime with these settings. */
  static async create(settings: NavigationSettings): Promise<NavigationRuntime> {
    const mod = await loadNavigation();
    return new NavigationRuntime(mod, new mod.NavRuntime(JSON.stringify(settings)));
  }

  /** A runtime on an already loaded module. */
  static createSync(mod: NavigationModule, settings: NavigationSettings): NavigationRuntime {
    return new NavigationRuntime(mod, new mod.NavRuntime(JSON.stringify(settings)));
  }

  private get rt(): RawRuntime {
    if (!this.raw) throw new Error("NavigationRuntime: used after dispose()");
    return this.raw;
  }

  get disposed(): boolean {
    return this.raw === null;
  }

  /** Frees the WASM side. The runtime can't be used afterwards. */
  dispose(): void {
    this.raw?.free();
    this.raw = null;
    this.cached = null;
    this.cachedBuffer = null;
  }

  /** Replaces the agent types and runtime budgets (agents keep the settings they were added with). */
  setSettings(settings: NavigationSettings): void {
    this.rt.setSettings(JSON.stringify(settings));
  }

  // ------------------------------------------------------------------------------------------- buffers

  /**
   * The boundary buffers' views, rebuilt when the runtime's epoch changed (buffers grew) or WASM memory grew
   * (which detaches every view). Cheap when nothing changed: call it before writing and after each tick.
   */
  views(): NavBufferViews {
    const rt = this.rt;
    const epoch = rt.epoch();
    const buffer = this.memory.buffer;
    if (this.cached && this.cached.epoch === epoch && this.cachedBuffer === buffer) return this.cached;
    const agentRows = rt.agentRows();
    const obstacleRows = rt.obstacleRows();
    const f32 = (ptr: number, rows: number, stride: number) => (rows === 0 ? new Float32Array(0) : new Float32Array(buffer, ptr, rows * stride));
    this.cached = {
      agentsIn: f32(rt.agentsInPtr(), agentRows, AGENT_IN_STRIDE),
      agentsOut: f32(rt.agentsOutPtr(), agentRows, AGENT_OUT_STRIDE),
      agentState: agentRows === 0 ? new Uint8Array(0) : new Uint8Array(buffer, rt.agentStatePtr(), agentRows * AGENT_STATE_STRIDE),
      obstaclesIn: f32(rt.obstaclesInPtr(), obstacleRows, OBSTACLE_IN_STRIDE),
      agentRows,
      obstacleRows,
      epoch,
    };
    this.cachedBuffer = buffer;
    return this.cached;
  }

  // ------------------------------------------------------------------------------------------- chunks

  /** Loads (or replaces) a chunk's bake; `chunkId` from {@link chunkIdOf} (or the bake report's `chunkId`). */
  loadChunk(chunkId: string, bytes: Uint8Array): void {
    this.rt.loadChunk(chunkId, bytes);
  }

  unloadChunk(chunkId: string): boolean {
    return this.rt.unloadChunk(chunkId);
  }

  loadedChunks(): string[] {
    return JSON.parse(this.rt.loadedChunks()) as string[];
  }

  // ------------------------------------------------------------------------------------------- agents

  /** Queues an agent (live from the next tick). Its row is valid at once. */
  addAgent(desc: NavAgentDesc): NavHandle {
    return this.rt.addAgent(JSON.stringify(desc));
  }

  removeAgent(agent: NavHandle): void {
    this.rt.removeAgent(agent);
  }

  isLive(agent: NavHandle): boolean {
    return this.rt.isLive(agent);
  }

  addObstacle(desc: NavObstacleDesc, position: Vec3): NavHandle {
    return this.rt.addObstacle(JSON.stringify(desc), position[0], position[1], position[2]);
  }

  removeObstacle(obstacle: NavHandle): void {
    this.rt.removeObstacle(obstacle);
  }

  // ------------------------------------------------------------------------------------------- commands (applied at the next tick)

  setDestination(agent: NavHandle, p: Vec3): void {
    this.rt.setDestination(agent, p[0], p[1], p[2]);
  }

  /** Chases another agent; `repathDistance` 0 = the default. */
  chaseAgent(agent: NavHandle, target: NavHandle, repathDistance = 0): void {
    this.rt.chaseAgent(agent, target, repathDistance);
  }

  /** Chases a host target (a node registered by an id of the caller's choosing; see {@link setTargetPositions}). */
  chaseTarget(agent: NavHandle, targetId: number, repathDistance = 0): void {
    this.rt.chaseTarget(agent, targetId, repathDistance);
  }

  stopChase(agent: NavHandle): void {
    this.rt.stopChase(agent);
  }

  stop(agent: NavHandle): void {
    this.rt.stop(agent);
  }

  warp(agent: NavHandle, p: Vec3): void {
    this.rt.warp(agent, p[0], p[1], p[2]);
  }

  /** 0 = the type's. */
  setSpeed(agent: NavHandle, speed: number, turnSpeed = 0): void {
    this.rt.setSpeed(agent, speed, turnSpeed);
  }

  joinGroup(agent: NavHandle, group: NavHandle): void {
    this.rt.joinGroup(agent, group);
  }

  leaveGroup(agent: NavHandle, goal?: Vec3): void {
    this.rt.leaveGroup(agent, goal !== undefined, goal?.[0] ?? 0, goal?.[1] ?? 0, goal?.[2] ?? 0);
  }

  setGroupJoining(agent: NavHandle, joining: boolean): void {
    this.rt.setGroupJoining(agent, joining);
  }

  /** A group body's painted formation: `width` x `height` bits, row 0 the front; null drops it. */
  setGroupMask(group: NavHandle, mask: { bits: boolean[]; width: number; height: number } | null): void {
    if (!mask) {
      this.rt.setGroupMask(group, new BigUint64Array(0), 0, 0);
      return;
    }
    const words = new BigUint64Array(Math.ceil((mask.width * mask.height) / 64));
    mask.bits.forEach((on, i) => {
      if (on) words[i >> 6] |= 1n << BigInt(i & 63);
    });
    this.rt.setGroupMask(group, words, mask.width, mask.height);
  }

  setGate(gateId: string, open: boolean): void {
    this.rt.setGate(gateId, open);
  }

  /** An agent's own area cost (`cost` < 0: the area's default). */
  setAreaCost(agent: NavHandle, area: string, cost: number, excluded = false): void {
    this.rt.setAreaCost(agent, area, cost, excluded);
  }

  clearAreaCosts(agent: NavHandle): void {
    this.rt.clearAreaCosts(agent);
  }

  /** The World's override of an area (`Navigation.setAreaCost`), under agents' own overrides. */
  setWorldAreaCost(area: string, cost: number, excluded = false): void {
    this.rt.setWorldAreaCost(area, cost, excluded);
  }

  /** Replaces the runtime cost volumes (ADR 0070). Queries see them at once; agents and routes from the next tick. */
  setCostVolumes(volumes: readonly NavCostVolumeDesc[]): void {
    this.rt.setCostVolumes(JSON.stringify(volumes));
  }

  setTargetSurround(targetId: number, surround: NavSurroundDesc | null): void {
    this.rt.setTargetSurround(targetId, surround ? JSON.stringify(surround) : "");
  }

  /** A shared flow field towards a host target (null removes it); `moveThreshold` 0 = the default. */
  setFlowGoal(targetId: number, goal: { moveThreshold?: number } | null): void {
    this.rt.setFlowGoal(targetId, goal !== null, goal?.moveThreshold ?? 0);
  }

  removeTarget(targetId: number): void {
    this.rt.removeTarget(targetId);
  }

  /** Host targets' positions for the next tick (`positions` xyz per id). Unlisted targets keep theirs. */
  setTargetPositions(ids: Uint32Array, positions: Float32Array): void {
    this.rt.setTargetPositions(ids, positions);
  }

  // ------------------------------------------------------------------------------------------- the tick

  /** One step: `dt` seconds, `time` the World's elapsed seconds. Re-take {@link views} afterwards. */
  tick(dt: number, time: number): void {
    this.rt.tick(dt, time);
  }

  tickStats(): NavTickStats {
    return JSON.parse(this.rt.tickStats()) as NavTickStats;
  }

  // ------------------------------------------------------------------------------------------- state

  /** An agent's state as of the last tick (a call; the hot path reads the buffers instead). */
  agentState(agent: NavHandle): NavAgentSnapshot | null {
    const s = this.rt.agentState(agent);
    if (s.length === 0) return null;
    return {
      kind: s[0],
      pathState: s[1],
      mode: s[2],
      flags: s[3],
      position: [s[4], s[5], s[6]],
      rotation: [s[7], s[8], s[9], s[10]],
      up: [s[11], s[12], s[13]],
      velocity: [s[14], s[15], s[16]],
      desiredVelocity: [s[17], s[18], s[19]],
      remainingDistance: s[20],
    };
  }

  /** The agent's current path (`NavAgent.path`). */
  path(agent: NavHandle): NavWaypoint[] {
    return waypoints(this.rt.pathWaypoints(agent), 0);
  }

  drainWarnings(): string[] {
    return JSON.parse(this.rt.drainWarnings()) as string[];
  }

  drainLogs(): string[] {
    return JSON.parse(this.rt.drainLogs()) as string[];
  }

  // ------------------------------------------------------------------------------------------- queries

  /** A path for an agent type: walking, flying or hybrid by its abilities. */
  findPath(agentType: string, from: Vec3, to: Vec3): NavPathResult {
    const flat = this.rt.findPath(agentType, from[0], from[1], from[2], to[0], to[1], to[2]);
    return { status: QUERY_STATUS[flat[0]] ?? "none", waypoints: waypoints(flat, 1) };
  }

  isReachable(agentType: string, from: Vec3, to: Vec3): boolean {
    return this.rt.isReachable(agentType, from[0], from[1], from[2], to[0], to[1], to[2]);
  }

  /** The nearest walkable point (or free air, for fly-only types) within `maxDistance`, with its surface normal. */
  nearestPoint(agentType: string, p: Vec3, maxDistance: number): { point: Vec3; normal: Vec3 } | null {
    const r = this.rt.nearestPoint(agentType, p[0], p[1], p[2], maxDistance);
    return r.length === 0 ? null : { point: [r[0], r[1], r[2]], normal: [r[3], r[4], r[5]] };
  }

  /** Walks the surface from `from` towards `to`; null if `from` isn't on the navmesh. */
  raycast(agentType: string, from: Vec3, to: Vec3): NavRaycastResult | null {
    const r = this.rt.raycast(agentType, from[0], from[1], from[2], to[0], to[1], to[2]);
    if (r.length === 0) return null;
    return { t: r[0], hit: r[1] === 0, point: [r[2], r[3], r[4]], normal: [r[5], r[6], r[7]] };
  }

  // ------------------------------------------------------------------------------------------- debug geometry (flat, see debug.rs)

  /** Navmesh edges and links, stride 7: a xyz, b xyz, kind (0 outline, 1 shared edge, 2 fold, 3 jump, 4 chunk-face edge). */
  debugNavmeshLines(chunkId: string, agentType: string): Float32Array {
    return this.rt.debugNavmeshLines(chunkId, agentType);
  }

  /** Navmesh polygons as triangles, stride 11: a xyz, b xyz, c xyz, bin, area. */
  debugNavmeshTriangles(chunkId: string, agentType: string): Float32Array {
    return this.rt.debugNavmeshTriangles(chunkId, agentType);
  }

  /** Free flight leaves, stride 5: min xyz, edge length, area. */
  debugVolumeLeaves(chunkId: string, agentType: string): Float32Array {
    return this.rt.debugVolumeLeaves(chunkId, agentType);
  }

  /** Landing links, stride 6: ground xyz, air xyz. */
  debugLandingLinks(chunkId: string, agentType: string): Float32Array {
    return this.rt.debugLandingLinks(chunkId, agentType);
  }

  /** A chunk's polygons whose runtime cost multiplier isn't 1, as outlines: stride 7 (a xyz, b xyz, multiplier; Infinity = excluded). */
  debugCosts(chunkId: string, agentType: string): Float32Array {
    return this.rt.debugCosts(chunkId, agentType);
  }

  /** Seam links between loaded chunks, stride 7: a xyz, b xyz, kind (0 ground, 1 air rectangle diagonal). */
  debugSeams(): Float32Array {
    return this.rt.debugSeams();
  }

  /** Every agent's current path as segments, stride 7: a xyz, b xyz, agent row. */
  debugAgentPaths(): Float32Array {
    return this.rt.debugAgentPaths();
  }
}

/** A chunk's id (hex) from its scene's project path (forward slashes) and the chunk node's id. */
export async function chunkIdOf(scenePath: string, chunkNodeId: string): Promise<string> {
  return (await loadNavigation()).chunkId(scenePath, chunkNodeId);
}

/** A bake's navmesh lines without a runtime (the editor's scene view before play); stride 7 as above. */
export async function debugBakeLines(bytes: Uint8Array, group = 0): Promise<Float32Array> {
  return (await loadNavigation()).debugBakeLines(bytes, group);
}

/** The navmesh and flight volume sections a bake holds for an agent type (by id); -1 where it has none. */
export async function bakeAgentGroups(bytes: Uint8Array, agentType: string): Promise<{ walk: number; fly: number }> {
  const g = (await loadNavigation()).bakeAgentGroups(bytes, agentType);
  return { walk: g[0] ?? -1, fly: g[1] ?? -1 };
}

/** A bake's navmesh triangles without a runtime; stride 11 as above. */
export async function debugBakeTriangles(bytes: Uint8Array, group = 0): Promise<Float32Array> {
  return (await loadNavigation()).debugBakeTriangles(bytes, group);
}
