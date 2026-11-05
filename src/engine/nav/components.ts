/**
 * The navigation components (ADR 0065; ids and fields from `CONTRACT.md`). Public: no WASM or Foxfire types
 * (ADR 0010). Methods queue commands in `_commands`; the built-in systems (`navigation.ts`, `NavigationWorld.ts`)
 * apply them, own the runtime handles in `_backend`, and write `_state`, which the getters read.
 *
 * Bake-only components (NavSurface, NavObstacle, NavModifierVolume, NavResolutionVolume) are data the editor's
 * bake reads; nothing runs for them at runtime.
 */
import { Component } from "../core/Component";
import { Vector3, type Vec3Input } from "../core/math";
import { AssetRef, PlainObject, component, field } from "../core/registry";
import type { ProjectSettings } from "../core/settings";
import type { World } from "../core/World";
import { GameObject } from "../scene/GameObject";
import type { NavAgentBackend, NavChunkBackend, NavGateBackend, NavObstacleBackend, NavTargetBackend } from "./NavigationWorld";
import { ensureNavigationFor, readVec3 } from "./navigationSystems";
import { navAvoidanceLayerName, navLayerBit, navShownLayers } from "./settings";

/** Where an agent is on its path. */
export type NavPathState = "none" | "following" | "partial" | "arrived" | "failed";
/** How an agent is moving (walk-fly agent types switch between them). */
export type NavMode = "walking" | "takingOff" | "flying" | "landing";

const PATH_STATES: readonly NavPathState[] = ["none", "following", "partial", "arrived", "failed"];
const MODES: readonly NavMode[] = ["walking", "takingOff", "flying", "landing"];

/** One point of a path. */
export interface NavWaypoint {
  position: Vector3;
  /** The surface normal there (up for flight points). */
  normal: Vector3;
  /** Navmesh waypoint bits; 0x80 marks a flight point. */
  flags: number;
}

/** Labelled choices (ADR 0066): a repeated label gets its value in brackets so every entry stays. */
function labelled(entries: readonly [label: string, value: string | number][]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [label, value] of entries) out[label in out ? `${label} (${value})` : label] = value;
  return out;
}
/** Agent type names, storing ids. */
const agentTypeChoices = (s: ProjectSettings) => labelled(s.navigation.agentTypes.map((t) => [t.name, t.id]));
/** Area names, storing ids ("" = plain walkable). */
const areaChoices = (s: ProjectSettings) => labelled([["Walkable", ""], ...s.navigation.areas.map((a): [string, string] => [a.name, a.id])]);
/** One avoidance layer (Foxfire's NavAvoidanceLayerDrawer): "Nothing" and the named layers, storing the bit. */
const avoidanceLayerChoices = (s: ProjectSettings) =>
  labelled([["Nothing", 0], ...navShownLayers(s.navigation).map((l): [string, number] => [navAvoidanceLayerName(s.navigation, l), navLayerBit(l)])]);
const SOURCES = ["mesh", "collider", "both"];

/** @internal What the backend writes after each step. */
export interface NavAgentStateData {
  pathState: number;
  mode: number;
  flags: number;
  velocity: [number, number, number];
  desiredVelocity: [number, number, number];
  remainingDistance: number;
}

/** @internal A queued agent command. */
export type NavAgentCommand =
  | { op: "destination"; point: [number, number, number] }
  | { op: "chase"; target: GameObject; repathDistance: number }
  | { op: "stop" }
  | { op: "warp"; point: [number, number, number] };

/** @internal A queued group command. */
export type NavGroupCommand =
  | { op: "join"; agent: NavAgent }
  | { op: "leave"; agent: NavAgent; goal: [number, number, number] | null }
  | { op: "destination"; point: [number, number, number] }
  | { op: "mask"; mask: { bits: boolean[]; width: number; height: number } | null };

/** Releases the World's navigation handles of a component (if it has a navigation world). */
function navOf(world: World) {
  return world.navigation;
}

/** A scene's navigation chunk: its bake, loaded while the chunk node exists. */
@component("engine.NavChunk")
export class NavChunk extends Component {
  /** The baked `<scene>.nav.bin`, written by the editor's Bake. */
  @field(AssetRef) bake = "";
  /** Bake only inside the box `center` / `size` (world space). */
  @field(Boolean) useChunkBounds = false;
  @field(Vector3) center = new Vector3(0, 0, 0);
  @field(Vector3) size = new Vector3(64, 32, 64);
  /** What the bake collects: render meshes, colliders, both or nothing (only NavSurface / NavObstacle nodes). */
  @field(String, { choices: ["renderMeshes", "colliders", "both", "none"] }) collect = "both";
  /** Collect from the chunk node's children or the whole scene. */
  @field(String, { choices: ["children", "scene"] }) scope = "scene";
  /** Agent type ids that get nothing in this chunk. */
  @field([String], { choices: agentTypeChoices }) skipAgents: string[] = [];
  @field(Number) minOverlayDepth = 1;
  @field(Number) maxOverlayDepth = 2;

  /** @internal */ _backend: NavChunkBackend | null = null;

  /** True once the chunk's bake is loaded into the World's navigation. */
  get isLoaded(): boolean {
    return this._backend?.loaded ?? false;
  }

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }

  override _onDetach(): void {
    navOf(this.world)?.releaseChunk(this);
  }
}

/** Marks geometry walkable for some agent types, optionally as an area. */
@component("engine.NavSurface")
export class NavSurface extends Component {
  /** Agent type ids; empty = every type. */
  @field([String], { choices: agentTypeChoices }) walkableFor: string[] = [];
  /** Area id; "" = plain walkable. */
  @field(String, { choices: areaChoices }) area = "";
  @field(String, { choices: SOURCES }) source = "mesh";
}

/** Geometry that's solid and never walkable. */
@component("engine.NavObstacle")
export class NavObstacle extends Component {
  @field(String, { choices: SOURCES }) source = "mesh";
}

/** An oriented box (node transform × `center` / `size`) that marks an area. */
@component("engine.NavModifierVolume")
export class NavModifierVolume extends Component {
  @field(Vector3) center = new Vector3(0, 0, 0);
  @field(Vector3) size = new Vector3(1, 1, 1);
  @field(String, { choices: areaChoices }) area = "";
  @field(String, { choices: ["ground", "air", "both"] }) appliesTo = "both";
  /** Agent type ids; empty = every type. */
  @field([String], { choices: agentTypeChoices }) agents: string[] = [];
}

/** An oriented box baked at a finer (or coarser) cell size. */
@component("engine.NavResolutionVolume")
export class NavResolutionVolume extends Component {
  @field(Vector3) center = new Vector3(0, 0, 0);
  @field(Vector3) size = new Vector3(1, 1, 1);
  @field(Number) cellSize = 0.1;
  /** The flying agent types whose flight volumes it refines (Foxfire's Affected Agents); empty = every type. */
  @field([String], { choices: agentTypeChoices }) agents: string[] = [];
}

/** An oriented box of navmesh that can be closed at runtime (a door). */
@component("engine.NavGate")
export class NavGate extends Component {
  @field(Vector3) center = new Vector3(0, 0, 0);
  @field(Vector3) size = new Vector3(1, 2, 1);
  @field(String) gateId = "";
  /** Toggle at runtime: closed gates block paths through them. */
  @field(Boolean) open = true;

  /** @internal */ _backend: NavGateBackend | null = null;

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }
}

/**
 * A navigation agent: walks, flies or both by its agent type, avoiding other agents. With `updatePosition` /
 * `updateRotation` off, the node is left alone (drive it yourself from `desiredVelocity`).
 */
@component("engine.NavAgent")
export class NavAgent extends Component {
  /** The agent type's id (project settings); "" = the first type. */
  @field(String, { choices: agentTypeChoices }) agentType = "";
  /** 0 = the type's. */
  @field(Number) speed = 0;
  /** 0 = the type's. */
  @field(Number) turnSpeed = 0;
  @field(Boolean) updatePosition = true;
  @field(Boolean) updateRotation = true;
  /** Avoidance priority; −1 = the type's. (Avoidance layers are the type's, as in Foxfire.) */
  @field(Number) priority = -1;
  /** Per-area costs over the type's: `{ areaId: cost | "excluded" }`. */
  @field(PlainObject) areaCosts: Record<string, number | "excluded"> = {};
  /** Where the agent heads as soon as it starts (Foxfire's NavAgentAuthoring `InitialGoal`); null = nowhere. */
  @field(GameObject) initialGoal: GameObject | null = null;
  /** Chase `initialGoal` (follow it as it moves) instead of going to where it is once. */
  @field(Boolean) chaseGoal = false;
  /** While chasing `initialGoal`: plan a new path once it has moved this far (metres). */
  @field(Number) chaseRepathDistance = 1;

  /** @internal */ _commands: NavAgentCommand[] = [];
  /** @internal True once `initialGoal` has been acted on (the agent's first sync). */
  _goalQueued = false;
  /** @internal */ _state: NavAgentStateData = { pathState: 0, mode: 0, flags: 0, velocity: [0, 0, 0], desiredVelocity: [0, 0, 0], remainingDistance: 0 };
  /** @internal */ _backend: NavAgentBackend | null = null;

  /** Plans a path to `point` and follows it. */
  setDestination(point: Vec3Input): void {
    this._commands.push({ op: "destination", point: readVec3(point) });
  }

  /**
   * Follows `node` (another agent, a NavSurround / NavFlowGoal target, or any node), planning a new path whenever
   * it has moved `repathDistance` metres (default 1) from where the current path ends.
   */
  chase(node: GameObject, repathDistance = 1): void {
    this.world._assertOwns(node, "NavAgent.chase");
    this._commands.push({ op: "chase", target: node, repathDistance });
  }

  /** Drops the path or chase and stops. */
  stop(): void {
    this._commands.push({ op: "stop" });
  }

  /** Moves the agent to `point` at once (snapped to the navmesh), dropping its path. */
  warp(point: Vec3Input): void {
    this._commands.push({ op: "warp", point: readVec3(point) });
  }

  get pathState(): NavPathState {
    return PATH_STATES[this._state.pathState] ?? "none";
  }

  get mode(): NavMode {
    return MODES[this._state.mode] ?? "walking";
  }

  /** Velocity in the last step (units/s). A copy. */
  get velocity(): Vector3 {
    const v = this._state.velocity;
    return new Vector3(v[0], v[1], v[2]);
  }

  /** The velocity the agent wants (before avoidance limits; what to drive a node with). A copy. */
  get desiredVelocity(): Vector3 {
    const v = this._state.desiredVelocity;
    return new Vector3(v[0], v[1], v[2]);
  }

  /** Distance left along the path. */
  get remainingDistance(): number {
    return this._state.remainingDistance;
  }

  /** True while the agent waits for its chunk to load. */
  get isWaitingForChunk(): boolean {
    return (this._state.flags & 2) !== 0;
  }

  /** The current path's waypoints (empty without one). */
  get path(): NavWaypoint[] {
    return navOf(this.world)?.agentPath(this) ?? [];
  }

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }

  override _onDetach(): void {
    navOf(this.world)?.releaseAgent(this);
  }
}

/** A group: members move together in a formation or a flock towards the group's destination. */
@component("engine.NavGroup")
export class NavGroup extends Component {
  /** The agent type the group body plans with; "" = the first type. */
  @field(String, { choices: agentTypeChoices }) agentType = "";
  @field(String, { choices: ["formation", "flock"] }) mode = "formation";
  @field(String, { choices: ["box", "line", "column", "wedge", "circle", "mask"] }) formation = "box";
  /**
   * A formation asset (`*.formation.json`, Foxfire's NavFormation): when set, its shape, layers, layer spacing and
   * painted mask replace `formation`, `layers` and `layerSpacing`.
   */
  @field(AssetRef) formationAsset = "";
  @field(Number) spacing = 3;
  @field(Number) slack = 4;
  @field(Number) catchUp = 2;
  @field(Number) memberPriority = 20;
  @field(Number) minPace = 0.25;
  @field(Number) layers = 1;
  @field(Number) layerSpacing = 0;
  @field(Number) flockRadius = 0;
  @field(Number) flockSeparation = 1.5;
  @field(Number) flockAlignment = 1;
  @field(Number) flockCohesion = 0.5;
  @field(Boolean) surround = true;
  @field(Boolean) squeeze = true;
  @field(Boolean) swapSlots = true;
  @field(Boolean) bendColumns = true;
  @field(Boolean) turnInPlace = true;
  @field(Boolean) passThroughEachOther = false;
  @field(Boolean) acceptJoiners = true;
  @field(Number) joinDistance = 4;
  @field(Number) sameGoalDistance = 5;
  @field(Number) maxMembers = 100;
  @field(Boolean) merge = true;
  @field(Number) mergePriority = 50;

  /** @internal */ _commands: NavGroupCommand[] = [];
  /** @internal */ _state: NavAgentStateData = { pathState: 0, mode: 0, flags: 0, velocity: [0, 0, 0], desiredVelocity: [0, 0, 0], remainingDistance: 0 };
  /** @internal */ _backend: NavAgentBackend | null = null;

  /** Adds an agent to the group. */
  join(agent: NavAgent): void {
    this.world._assertOwns(agent, "NavGroup.join");
    this._commands.push({ op: "join", agent });
  }

  /** Takes an agent out of the group, optionally sending it to `goal`. */
  leave(agent: NavAgent, goal?: Vec3Input): void {
    this.world._assertOwns(agent, "NavGroup.leave");
    this._commands.push({ op: "leave", agent, goal: goal === undefined ? null : readVec3(goal) });
  }

  /** Sends the group to `point`. */
  setDestination(point: Vec3Input): void {
    this._commands.push({ op: "destination", point: readVec3(point) });
  }

  /** A painted formation (`formation: "mask"`): `width` × `height` cells, row 0 the front; null drops it. */
  setMask(bits: readonly boolean[] | null, width = 0, height = 0): void {
    this._commands.push({ op: "mask", mask: bits ? { bits: [...bits], width, height } : null });
  }

  get pathState(): NavPathState {
    return PATH_STATES[this._state.pathState] ?? "none";
  }

  get remainingDistance(): number {
    return this._state.remainingDistance;
  }

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }

  override _onDetach(): void {
    navOf(this.world)?.releaseGroup(this);
  }
}

/** On a target node: agents chasing it spread into slots around it. */
@component("engine.NavSurround")
export class NavSurround extends Component {
  @field(Number) radius = 3;
  @field(Number) spacing = 3;
  /** 0 = no air slots. */
  @field(Number) airSpacing = 0;
  @field(Number) claimDistance = 30;
  @field(Number) maxSlots = 64;

  /** @internal */ _backend: NavTargetBackend | null = null;

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }

  override _onDetach(): void {
    navOf(this.world)?.releaseTargetFeature(this);
  }
}

/** On a target node: agents chasing it share one flow field (many agents, one goal). */
@component("engine.NavFlowGoal")
export class NavFlowGoal extends Component {
  /** How far the node moves before the field is rebuilt; 0 = the default. */
  @field(Number) moveThreshold = 0;

  /** @internal */ _backend: NavTargetBackend | null = null;

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }

  override _onDetach(): void {
    navOf(this.world)?.releaseTargetFeature(this);
  }
}

/** A moving or still obstacle agents avoid (not baked into the navmesh). */
@component("engine.NavAvoidanceObstacle")
export class NavAvoidanceObstacle extends Component {
  @field(Number) radius = 0.5;
  /** The avoidance layer it's on (one bit; the editor shows the named layers). */
  @field(Number, { choices: avoidanceLayerChoices }) layers = 1;

  /** @internal */ _backend: NavObstacleBackend | null = null;

  override _onAttach(): void {
    ensureNavigationFor(this.world);
  }

  override _onDetach(): void {
    navOf(this.world)?.releaseObstacle(this);
  }
}
