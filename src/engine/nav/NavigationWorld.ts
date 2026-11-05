/**
 * A World's navigation (ADR 0065). Internal: game code uses the navigation components and the `Navigation`
 * facade. Loaded on demand by `ensureNavigation` (navigation.ts), like `Physics3DWorld`.
 *
 * Each fixed step:
 * - `sync` (engine.NavSync): chunks load or unload, gates open or close, agents / groups / obstacles get runtime
 *   handles (lazily, per component, recreated when a setting that can't change in place does), nodes moved since
 *   the last write-back (by scripts, physics, parents) are written into `agentsIn` / `obstaclesIn` straight from
 *   the World's transform arrays, queued commands are applied, and host targets' positions are pushed in bulk.
 * - `step` (engine.NavStep): one runtime tick; warnings and logs go to the console.
 * - `writeBack` (engine.NavWriteBack): positions and rotations back to the transforms (honouring `updatePosition`
 *   / `updateRotation`), before the physics pushes, so a kinematic RigidBody follows its transform; `_state` is
 *   filled for the getters.
 */
import type { World } from "../core/World";
import { getComponentClass } from "../core/registry";
import { Quaternion, Vector3 } from "../core/math";
import { Mat4 } from "../core/math";
import type { GameObject } from "../scene/GameObject";
import { SceneInstance } from "../scene/SceneLoader";
import { NavAgent, NavAvoidanceObstacle, NavChunk, NavFlowGoal, NavGate, NavGroup, NavSurround, type NavAgentStateData, type NavWaypoint } from "./components";
import { loadNavigation, type NavigationModule } from "./loader";
import { formationMask, readFormationValue, type NavFormationAsset } from "./formation";
import { Assets } from "../scene/Assets";
import { loadNavBake, navBakeBytesIfLoaded, navDebugOf, type NavDebugSettings } from "./navigationSystems";
import {
  AGENT_IN_STRIDE,
  AGENT_OUT_STRIDE,
  AGENT_STATE_STRIDE,
  NavigationRuntime,
  OBSTACLE_IN_STRIDE,
  agentRow,
  type NavAgentDesc,
  type NavAreaCostOverride,
  type NavGroupDesc,
  type NavHandle,
  type NavWaypoint as RawWaypoint,
  type Vec3,
} from "./runtime";

let navModule: NavigationModule | null = null;

/** The formation asset whose mask each group body was last sent (by body, so a recreated body gets it again). */
const appliedFormations = new WeakMap<NavAgentBackend, NavFormationAsset | null>();

/** @internal Loads the navigation module (once). */
export async function initNavigationModule(): Promise<void> {
  navModule ??= await loadNavigation();
}

/** @internal An agent's or group body's runtime handle and what it was made with. */
export interface NavAgentBackend {
  handle: NavHandle;
  /** A group body's settings that need a new agent when they change. */
  signature: string;
  /** An agent's settings that need a new agent when they change: type, priority, updatePosition, updateRotation. */
  settings?: readonly unknown[];
  speed: number;
  turnSpeed: number;
  /** The area costs applied, as JSON ("" for none). */
  costs: string;
  /** The node's `tVersion` when its transform was last written into or from the runtime. */
  syncedVersion: number;
  /** Position and rotation last written to a parented node (the slow path), so unchanged poses aren't rewritten. */
  written?: Float32Array;
}

/** @internal */
export interface NavChunkBackend {
  key: string;
  chunkId: string;
  loaded: boolean;
  pending: boolean;
}

/** @internal */
export interface NavGateBackend {
  gateId: string;
  open: boolean;
}

/** @internal */
export interface NavObstacleBackend {
  handle: NavHandle;
  signature: string;
  syncedVersion: number;
}

/** @internal A NavSurround's or NavFlowGoal's registration on its node's host target. */
export interface NavTargetBackend {
  targetId: number;
  signature: string;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const tmpP = new Float32Array(3);
const tmpQ = new Float32Array(4);
const tmpS = new Float32Array(3);

const toWaypoint = (w: RawWaypoint): NavWaypoint => ({
  position: new Vector3(w.position[0], w.position[1], w.position[2]),
  normal: new Vector3(w.normal[0], w.normal[1], w.normal[2]),
  flags: w.flags,
});

/** @internal */
export class NavigationWorld {
  readonly runtime: NavigationRuntime;
  private readonly module: NavigationModule;
  private readonly warned = new Set<string>();
  /** Host targets (chased nodes, NavSurround / NavFlowGoal nodes) by node. */
  private readonly targets = new Map<GameObject, number>();
  private nextTargetId = 1;
  /** Loaded chunks' users: a scene loaded twice shares its chunk. */
  private readonly chunkUsers = new Map<string, number>();

  constructor(private readonly world: World) {
    if (!navModule) throw new Error("NavigationWorld: the navigation module isn't loaded (use ensureNavigation).");
    this.module = navModule;
    this.runtime = NavigationRuntime.createSync(navModule, world.settings.navigation);
  }

  /** Debug-drawing toggles (`Navigation.debug`). */
  get debug(): NavDebugSettings {
    return navDebugOf(this.world);
  }

  /** The loaded chunks' ids. */
  loadedChunks(): string[] {
    return this.runtime.loadedChunks();
  }

  /** A chunk's id from its scene's project path and the NavChunk node's id. */
  chunkId(scenePath: string, chunkNodeId: string): string {
    return this.module.chunkId(scenePath, chunkNodeId);
  }

  dispose(): void {
    this.runtime.dispose();
    this.targets.clear();
    this.chunkUsers.clear();
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] nav: ${message}`);
  }

  // ------------------------------------------------------------------------------------------- settings lookups

  /** An agent type's id from an id or a name; "" = the first type. Null (warned once) if unknown. */
  resolveAgentType(idOrName: string, who: string): string | null {
    const types = this.world.settings.navigation.agentTypes;
    if (idOrName === "") {
      if (types.length) return types[0].id;
      this.warnOnce("no-types", "the project has no navigation agent types.");
      return null;
    }
    const t = types.find((x) => x.id === idOrName) ?? types.find((x) => x.name === idOrName);
    if (t) return t.id;
    this.warnOnce(`type:${idOrName}`, `${who}: unknown agent type "${idOrName}".`);
    return null;
  }

  /** An area's id from an id or a name (unknown ones pass through: the runtime ignores them). */
  resolveArea(idOrName: string): string {
    const areas = this.world.settings.navigation.areas;
    return (areas.find((a) => a.id === idOrName) ?? areas.find((a) => a.name === idOrName))?.id ?? idOrName;
  }

  // ------------------------------------------------------------------------------------------- transforms

  private worldMatrixAt(e: number): Float32Array {
    return this.world.worldMatrix(e);
  }

  /** True if the node's parent space is the world's (so its local position and rotation are world ones). */
  private parentIsIdentity(e: number): boolean {
    const p = this.world.parentOf[e];
    if (p < 0) return true;
    const m = this.world.worldMatrix(p);
    const o = p * 16;
    for (let i = 0; i < 16; i++) if (m[o + i] !== IDENTITY[i]) return false;
    return true;
  }

  /** Writes a node's world position, rotation and up into a boundary row. */
  private readPose(e: number, out: Float32Array, o: number, withUp: boolean): void {
    const m = this.worldMatrixAt(e);
    const mo = e * 16;
    out[o] = m[mo + 12];
    out[o + 1] = m[mo + 13];
    out[o + 2] = m[mo + 14];
    if (!withUp) {
      // Obstacles: position, up.
      const ux = m[mo + 4], uy = m[mo + 5], uz = m[mo + 6];
      const l = Math.hypot(ux, uy, uz) || 1;
      out[o + 3] = ux / l;
      out[o + 4] = uy / l;
      out[o + 5] = uz / l;
      return;
    }
    if (this.parentIsIdentity(e)) {
      const r = this.world.tRot, ro = e * 4;
      out[o + 3] = r[ro];
      out[o + 4] = r[ro + 1];
      out[o + 5] = r[ro + 2];
      out[o + 6] = r[ro + 3];
    } else {
      Mat4.decompose(m, mo, tmpP, 0, tmpQ, 0, tmpS, 0);
      out[o + 3] = tmpQ[0];
      out[o + 4] = tmpQ[1];
      out[o + 5] = tmpQ[2];
      out[o + 6] = tmpQ[3];
    }
    const ux = m[mo + 4], uy = m[mo + 5], uz = m[mo + 6];
    const l = Math.hypot(ux, uy, uz) || 1;
    out[o + 7] = ux / l;
    out[o + 8] = uy / l;
    out[o + 9] = uz / l;
  }

  private pose(e: number): { position: Vec3; rotation: [number, number, number, number]; up: Vec3 } {
    const row = new Float32Array(AGENT_IN_STRIDE);
    this.readPose(e, row, 0, true);
    return { position: [row[0], row[1], row[2]], rotation: [row[3], row[4], row[5], row[6]], up: [row[7], row[8], row[9]] };
  }

  // ------------------------------------------------------------------------------------------- engine.NavSync

  /** @internal */
  sync(): void {
    const w = this.world;
    for (const c of w._componentsOfType(NavChunk)) this.syncChunk(c);
    for (const g of w._componentsOfType(NavGate)) this.syncGate(g);

    const ghostType = getComponentClass("net.Replicated") as (abstract new () => unknown) | undefined;
    const anyGhosts = ghostType !== undefined && (w._componentsOfType(ghostType as never) as unknown as { _isGhost: boolean }[]).some((r) => r._isGhost);
    const isGhost = (node: GameObject): boolean => {
      if (!anyGhosts) return false;
      for (let n: GameObject | null = node; n; n = n.parent) {
        const rep = n.getBehavior(ghostType as never) as { _isGhost?: boolean } | null;
        if (rep) return !!rep._isGhost;
      }
      return false;
    };

    const groups = w._componentsOfType(NavGroup);
    const agents = w._componentsOfType(NavAgent);
    const obstacles = w._componentsOfType(NavAvoidanceObstacle);
    for (const g of groups) this.ensureGroup(g, isGhost);
    for (const a of agents) this.ensureAgent(a, isGhost);
    for (const o of obstacles) this.ensureObstacle(o, isGhost);
    for (const s of w._componentsOfType(NavSurround)) this.syncSurround(s);
    for (const f of w._componentsOfType(NavFlowGoal)) this.syncFlowGoal(f);

    // Nodes moved since the last write-back (scripts, physics, parents), and agents the game drives itself.
    const v = this.runtime.views();
    const tVersion = w.tVersion;
    for (const g of groups) {
      const b = g._backend;
      if (!b) continue;
      const e = g.node.entity;
      if (tVersion[e] === b.syncedVersion) continue;
      this.readPose(e, v.agentsIn, agentRow(b.handle) * AGENT_IN_STRIDE, true);
      b.syncedVersion = tVersion[e];
    }
    for (const a of agents) {
      const b = a._backend;
      if (!b) continue;
      const e = a.node.entity;
      if (tVersion[e] === b.syncedVersion && a.updatePosition) continue;
      this.readPose(e, v.agentsIn, agentRow(b.handle) * AGENT_IN_STRIDE, true);
      b.syncedVersion = tVersion[e];
    }
    for (const o of obstacles) {
      const b = o._backend;
      if (!b) continue;
      const e = o.node.entity;
      if (tVersion[e] === b.syncedVersion) continue;
      this.readPose(e, v.obstaclesIn, agentRow(b.handle) * OBSTACLE_IN_STRIDE, false);
      b.syncedVersion = tVersion[e];
    }

    for (const g of groups) this.applyGroupCommands(g);
    for (const a of agents) this.applyAgentCommands(a);
    this.pushTargets();
  }

  // --- chunks

  /** The project path of the scene a node was loaded with: its scene node's source (else the nearest prefab's). */
  private scenePathOf(node: GameObject): string {
    let fallback = "";
    for (let n: GameObject | null = node; n; n = n.parent) {
      const inst = n.getBehavior(SceneInstance);
      if (inst && n.isSceneNode) return inst.source;
      if (inst && !fallback) fallback = inst.source;
    }
    return fallback;
  }

  private syncChunk(c: NavChunk): void {
    const active = c.isActiveAndEnabled && c.bake !== "";
    if (!active) {
      if (c._backend) this.releaseChunk(c);
      return;
    }
    const scenePath = this.scenePathOf(c.node);
    const nodeId = c.node.id;
    const key = `${scenePath}\n${nodeId}\n${c.bake}`;
    if (c._backend?.key === key) return;
    if (c._backend) this.releaseChunk(c);
    let chunkId: string;
    try {
      chunkId = this.chunkId(scenePath, nodeId);
    } catch (err) {
      this.warnOnce(`chunkid:${key}`, `${c.node.name}: NavChunk has no chunk id (${(err as Error).message}).`);
      return;
    }
    const backend: NavChunkBackend = { key, chunkId, loaded: false, pending: false };
    c._backend = backend;
    const bytes = navBakeBytesIfLoaded(c.bake);
    if (bytes === undefined) {
      this.warnOnce(`missing:${c.bake}`, `${c.node.name}: NavChunk's bake "${c.bake}" isn't among the project's assets (bake the scene).`);
      return;
    }
    if (bytes) {
      this.loadChunkBytes(c, backend, bytes);
      return;
    }
    // Not preloaded (a NavChunk added at runtime): load it, then add the chunk.
    backend.pending = true;
    void loadNavBake(c.bake).then((loaded) => {
      backend.pending = false;
      if (c._backend !== backend || c._destroyed || this.runtime.disposed || !loaded) return;
      this.loadChunkBytes(c, backend, loaded);
    });
  }

  private loadChunkBytes(c: NavChunk, backend: NavChunkBackend, bytes: Uint8Array): void {
    const users = this.chunkUsers.get(backend.chunkId) ?? 0;
    if (users > 0) {
      // Already loaded by another instance of the scene: share it.
      backend.loaded = true;
      this.chunkUsers.set(backend.chunkId, users + 1);
      return;
    }
    try {
      this.runtime.loadChunk(backend.chunkId, bytes);
    } catch (err) {
      this.warnOnce(`load:${backend.key}`, `${c.node.name}: couldn't load NavChunk's bake "${c.bake}": ${(err as Error).message ?? err}`);
      return;
    }
    backend.loaded = true;
    this.chunkUsers.set(backend.chunkId, (this.chunkUsers.get(backend.chunkId) ?? 0) + 1);
  }

  /** @internal */
  releaseChunk(c: NavChunk): void {
    const b = c._backend;
    c._backend = null;
    if (!b?.loaded || this.runtime.disposed) return;
    const users = (this.chunkUsers.get(b.chunkId) ?? 1) - 1;
    if (users > 0) {
      this.chunkUsers.set(b.chunkId, users);
      return;
    }
    this.chunkUsers.delete(b.chunkId);
    this.runtime.unloadChunk(b.chunkId);
  }

  // --- gates

  private syncGate(g: NavGate): void {
    if (!g.isActiveAndEnabled || g.gateId === "") return;
    const b = g._backend;
    if (b && b.gateId === g.gateId && b.open === g.open) return;
    this.runtime.setGate(g.gateId, g.open);
    g._backend = { gateId: g.gateId, open: g.open };
  }

  // --- agents

  private agentDesc(a: NavAgent, type: string, e: number): NavAgentDesc {
    const { position, rotation, up } = this.pose(e);
    const desc: NavAgentDesc = {
      agentType: type,
      position,
      rotation,
      up,
      updatePosition: a.updatePosition,
      updateRotation: a.updateRotation,
      speedOverride: Math.max(0, a.speed),
      turnSpeedOverride: Math.max(0, a.turnSpeed),
      areaCosts: this.areaCostList(a.areaCosts),
    };
    if (a.priority >= 0) desc.avoidancePriority = a.priority;
    return desc;
  }

  private areaCostList(costs: Record<string, number | "excluded"> | null | undefined): NavAreaCostOverride[] {
    const out: NavAreaCostOverride[] = [];
    for (const [area, cost] of Object.entries(costs ?? {})) {
      if (cost === "excluded") out.push({ area: this.resolveArea(area), excluded: true });
      else if (typeof cost === "number") out.push({ area: this.resolveArea(area), cost });
    }
    return out;
  }

  private ensureAgent(a: NavAgent, isGhost: (node: GameObject) => boolean): void {
    const node = a.node;
    const active = a.isActiveAndEnabled && node.transform !== null && !this.world.inEditMode(node.entity) && !isGhost(node);
    if (!active) {
      if (a._backend) this.releaseAgent(a);
      a._commands.length = 0;
      return;
    }
    const type = this.resolveAgentType(a.agentType, node.name);
    if (type === null) {
      if (a._backend) this.releaseAgent(a);
      return;
    }
    // Compared field by field (no strings built per agent per step); area costs only when there are any.
    let b = a._backend;
    const s = b?.settings;
    if (b && (!s || s[0] !== type || s[1] !== a.priority || s[2] !== a.updatePosition || s[3] !== a.updateRotation)) {
      this.releaseAgent(a);
      b = null;
    }
    let costs = "";
    for (const _ in a.areaCosts ?? {}) {
      costs = JSON.stringify(a.areaCosts);
      break;
    }
    const e = node.entity;
    if (!b) {
      const handle = this.runtime.addAgent(this.agentDesc(a, type, e));
      a._backend = { handle, signature: "", settings: [type, a.priority, a.updatePosition, a.updateRotation], speed: a.speed, turnSpeed: a.turnSpeed, costs, syncedVersion: this.world.tVersion[e] };
      if (!a._goalQueued) this.queueInitialGoal(a);
      return;
    }
    if (b.speed !== a.speed || b.turnSpeed !== a.turnSpeed) {
      this.runtime.setSpeed(b.handle, Math.max(0, a.speed), Math.max(0, a.turnSpeed));
      b.speed = a.speed;
      b.turnSpeed = a.turnSpeed;
    }
    if (b.costs !== costs) {
      this.runtime.clearAreaCosts(b.handle);
      for (const c of this.areaCostList(a.areaCosts)) this.runtime.setAreaCost(b.handle, c.area, c.cost ?? -1, c.excluded ?? false);
      b.costs = costs;
    }
  }

  /**
   * The agent's first sync (Foxfire's NavAgentAuthoring): head for `initialGoal`, or chase it. Put ahead of the
   * commands scripts queued before the first step, so theirs win.
   */
  private queueInitialGoal(a: NavAgent): void {
    a._goalQueued = true;
    const goal = a.initialGoal;
    if (!goal || !goal.isValid || goal.world !== this.world || goal.transform === null) return;
    if (a.chaseGoal) a._commands.unshift({ op: "chase", target: goal, repathDistance: a.chaseRepathDistance > 0 ? a.chaseRepathDistance : 1 });
    else a._commands.unshift({ op: "destination", point: [...this.pose(goal.entity).position] });
  }

  /** @internal */
  releaseAgent(a: NavAgent): void {
    const b = a._backend;
    a._backend = null;
    if (b && !this.runtime.disposed) this.runtime.removeAgent(b.handle);
  }

  private applyAgentCommands(a: NavAgent): void {
    if (!a._commands.length) return;
    const b = a._backend;
    if (!b) return; // waiting for its agent type, or the module (they're applied once it exists)
    const rt = this.runtime;
    for (const cmd of a._commands) {
      switch (cmd.op) {
        case "destination":
          rt.setDestination(b.handle, cmd.point);
          break;
        case "stop":
          rt.stop(b.handle);
          break;
        case "warp":
          rt.warp(b.handle, cmd.point);
          break;
        case "chase": {
          const target = cmd.target;
          if (!target.isValid) break;
          const other = target.getBehavior(NavAgent);
          const hostTarget = target.getBehavior(NavSurround) !== null || target.getBehavior(NavFlowGoal) !== null;
          if (other?._backend && !hostTarget) rt.chaseAgent(b.handle, other._backend.handle, cmd.repathDistance);
          else rt.chaseTarget(b.handle, this.targetId(target), cmd.repathDistance);
          break;
        }
      }
    }
    a._commands.length = 0;
  }

  /** @internal An agent's current path. */
  agentPath(a: NavAgent): NavWaypoint[] {
    const b = a._backend;
    if (!b || this.runtime.disposed) return [];
    return this.runtime.path(b.handle).map(toWaypoint);
  }

  // --- groups

  /** The group's formation asset's contents, or null without one (or when it can't be read: warned once). */
  private groupFormation(g: NavGroup): NavFormationAsset | null {
    const ref = g.formationAsset;
    if (!ref) return null;
    if (!Assets.has(ref)) {
      this.warnOnce(`formation:${ref}`, `${g.node.name}: NavGroup's formation asset "${ref}" isn't among the project's assets.`);
      return null;
    }
    let raw: unknown;
    try {
      raw = Assets.json(ref);
    } catch {
      raw = null;
    }
    return readFormationValue(raw, ref.replace(/^asset:/, ""));
  }

  /** Sends a formation asset's mask to the group body when the asset (or the body) changes. */
  private applyFormationMask(g: NavGroup, asset: NavFormationAsset | null): void {
    const b = g._backend;
    if (!b) return;
    const applied = appliedFormations.get(b);
    if (applied === asset || (applied === undefined && asset === null)) return;
    appliedFormations.set(b, asset);
    this.runtime.setGroupMask(b.handle, asset ? formationMask(asset) : null);
  }

  private groupDesc(g: NavGroup, asset: NavFormationAsset | null = null): NavGroupDesc {
    return {
      mode: g.mode === "flock" ? "flock" : "formation",
      formation: (asset ? asset.shape : g.formation) as NavGroupDesc["formation"],
      spacing: g.spacing,
      slack: g.slack,
      catchUp: g.catchUp,
      memberPriority: g.memberPriority,
      minPace: g.minPace,
      layers: asset ? asset.layers : g.layers,
      layerSpacing: asset ? asset.layerSpacing : g.layerSpacing,
      flockRadius: g.flockRadius,
      flockSeparation: g.flockSeparation,
      flockAlignment: g.flockAlignment,
      flockCohesion: g.flockCohesion,
      surround: g.surround,
      squeeze: g.squeeze,
      swapSlots: g.swapSlots,
      bendColumns: g.bendColumns,
      turnInPlace: g.turnInPlace,
      passThroughEachOther: g.passThroughEachOther,
      acceptJoiners: g.acceptJoiners,
      joinDistance: g.joinDistance,
      sameGoalDistance: g.sameGoalDistance,
      maxMembers: g.maxMembers,
      merge: g.merge,
      mergePriority: g.mergePriority,
    };
  }

  private ensureGroup(g: NavGroup, isGhost: (node: GameObject) => boolean): void {
    const node = g.node;
    const active = g.isActiveAndEnabled && node.transform !== null && !this.world.inEditMode(node.entity) && !isGhost(node);
    if (!active) {
      if (g._backend) this.releaseGroup(g);
      g._commands.length = 0;
      return;
    }
    const type = this.resolveAgentType(g.agentType, node.name);
    if (type === null) {
      if (g._backend) this.releaseGroup(g);
      return;
    }
    const asset = this.groupFormation(g);
    const group = this.groupDesc(g, asset);
    const signature = `${type}|${JSON.stringify(group)}`;
    if (g._backend?.signature !== signature) {
      if (g._backend) this.releaseGroup(g);
      const e = node.entity;
      const { position, rotation, up } = this.pose(e);
      const handle = this.runtime.addAgent({ agentType: type, position, rotation, up, group });
      g._backend = { handle, signature, speed: 0, turnSpeed: 0, costs: "", syncedVersion: this.world.tVersion[e] };
    }
    this.applyFormationMask(g, asset);
  }

  /** @internal */
  releaseGroup(g: NavGroup): void {
    const b = g._backend;
    g._backend = null;
    if (b && !this.runtime.disposed) this.runtime.removeAgent(b.handle);
  }

  private applyGroupCommands(g: NavGroup): void {
    if (!g._commands.length) return;
    const b = g._backend;
    if (!b) return;
    const rt = this.runtime;
    for (const cmd of g._commands) {
      switch (cmd.op) {
        case "join":
          if (cmd.agent._backend) rt.joinGroup(cmd.agent._backend.handle, b.handle);
          break;
        case "leave":
          if (cmd.agent._backend) rt.leaveGroup(cmd.agent._backend.handle, cmd.goal ?? undefined);
          break;
        case "destination":
          rt.setDestination(b.handle, cmd.point);
          break;
        case "mask":
          rt.setGroupMask(b.handle, cmd.mask);
          break;
      }
    }
    g._commands.length = 0;
  }

  // --- avoidance obstacles

  private ensureObstacle(o: NavAvoidanceObstacle, isGhost: (node: GameObject) => boolean): void {
    const node = o.node;
    const active = o.isActiveAndEnabled && node.transform !== null && !this.world.inEditMode(node.entity) && !isGhost(node);
    if (!active) {
      if (o._backend) this.releaseObstacle(o);
      return;
    }
    const signature = `${o.radius}|${o.layers}`;
    if (o._backend?.signature === signature) return;
    if (o._backend) this.releaseObstacle(o);
    const e = node.entity;
    const handle = this.runtime.addObstacle({ radius: Math.max(0, o.radius), height: 2, layers: o.layers }, this.pose(e).position);
    o._backend = { handle, signature, syncedVersion: -1 }; // its up-vector is written at the next pass
  }

  /** @internal */
  releaseObstacle(o: NavAvoidanceObstacle): void {
    const b = o._backend;
    o._backend = null;
    if (b && !this.runtime.disposed) this.runtime.removeObstacle(b.handle);
  }

  // --- host targets

  /** A node's host-target id (registered on first use; positions pushed each step until the node is gone). */
  private targetId(node: GameObject): number {
    let id = this.targets.get(node);
    if (id === undefined) {
      id = this.nextTargetId++;
      this.targets.set(node, id);
    }
    return id;
  }

  private pushTargets(): void {
    if (this.targets.size === 0) return;
    const ids = new Uint32Array(this.targets.size);
    const positions = new Float32Array(this.targets.size * 3);
    let n = 0;
    for (const [node, id] of this.targets) {
      if (!node.isValid) {
        this.targets.delete(node);
        this.runtime.removeTarget(id);
        continue;
      }
      const e = node.entity;
      const m = this.world.worldMatrix(e);
      ids[n] = id;
      positions[n * 3] = m[e * 16 + 12];
      positions[n * 3 + 1] = m[e * 16 + 13];
      positions[n * 3 + 2] = m[e * 16 + 14];
      n++;
    }
    if (n) this.runtime.setTargetPositions(ids.subarray(0, n), positions.subarray(0, n * 3));
  }

  private syncSurround(s: NavSurround): void {
    if (!s.isActiveAndEnabled) {
      if (s._backend) this.releaseTargetFeature(s);
      return;
    }
    const desc = { radius: s.radius, spacing: s.spacing, airSpacing: s.airSpacing, claimDistance: s.claimDistance, maxSlots: s.maxSlots };
    const signature = JSON.stringify(desc);
    if (s._backend?.signature === signature) return;
    const targetId = this.targetId(s.node);
    this.runtime.setTargetSurround(targetId, desc);
    s._backend = { targetId, signature };
  }

  private syncFlowGoal(f: NavFlowGoal): void {
    if (!f.isActiveAndEnabled) {
      if (f._backend) this.releaseTargetFeature(f);
      return;
    }
    const signature = String(f.moveThreshold);
    if (f._backend?.signature === signature) return;
    const targetId = this.targetId(f.node);
    this.runtime.setFlowGoal(targetId, { moveThreshold: Math.max(0, f.moveThreshold) });
    f._backend = { targetId, signature };
  }

  /** @internal */
  releaseTargetFeature(c: NavSurround | NavFlowGoal): void {
    const b = c._backend;
    c._backend = null;
    if (!b || this.runtime.disposed) return;
    if (c instanceof NavSurround) this.runtime.setTargetSurround(b.targetId, null);
    else this.runtime.setFlowGoal(b.targetId, null);
  }

  // ------------------------------------------------------------------------------------------- engine.NavStep

  /** @internal */
  step(dt: number): void {
    this.runtime.tick(dt, this.world.time.fixedTime);
    for (const w of this.runtime.drainWarnings()) console.warn(`[myco] nav: ${w}`);
    for (const l of this.runtime.drainLogs()) console.info(`[myco] nav: ${l}`);
  }

  // ------------------------------------------------------------------------------------------- engine.NavWriteBack

  /** @internal */
  writeBack(): void {
    const v = this.runtime.views();
    for (const g of this.world._componentsOfType(NavGroup)) if (g._backend) this.writeAgent(g._backend, g._state, g.node, true, true, v.agentsOut, v.agentState);
    for (const a of this.world._componentsOfType(NavAgent)) if (a._backend) this.writeAgent(a._backend, a._state, a.node, a.updatePosition, a.updateRotation, v.agentsOut, v.agentState);
  }

  private writeAgent(b: NavAgentBackend, state: NavAgentStateData, node: GameObject, updatePosition: boolean, updateRotation: boolean, out: Float32Array, st: Uint8Array): void {
    const row = agentRow(b.handle);
    const o = row * AGENT_OUT_STRIDE;
    if (o + AGENT_OUT_STRIDE > out.length) return;
    const so = row * AGENT_STATE_STRIDE;
    state.pathState = st[so];
    state.mode = st[so + 1];
    state.flags = st[so + 2];
    state.velocity[0] = out[o + 10];
    state.velocity[1] = out[o + 11];
    state.velocity[2] = out[o + 12];
    state.desiredVelocity[0] = out[o + 13];
    state.desiredVelocity[1] = out[o + 14];
    state.desiredVelocity[2] = out[o + 15];
    state.remainingDistance = out[o + 16];
    if (!updatePosition && !updateRotation) return;
    const w = this.world;
    const e = node.entity;
    if (this.parentIsIdentity(e)) {
      // Fast path: local is world. Written only when something changed, so idle agents don't look moved.
      const p = w.tPos, r = w.tRot, po = e * 3, ro = e * 4;
      let changed = false;
      if (updatePosition && (p[po] !== out[o] || p[po + 1] !== out[o + 1] || p[po + 2] !== out[o + 2])) {
        p[po] = out[o];
        p[po + 1] = out[o + 1];
        p[po + 2] = out[o + 2];
        changed = true;
      }
      if (updateRotation && (r[ro] !== out[o + 3] || r[ro + 1] !== out[o + 4] || r[ro + 2] !== out[o + 5] || r[ro + 3] !== out[o + 6])) {
        r[ro] = out[o + 3];
        r[ro + 1] = out[o + 4];
        r[ro + 2] = out[o + 5];
        r[ro + 3] = out[o + 6];
        changed = true;
      }
      if (changed) w.markTransformDirty(e);
    } else {
      // Under a moved parent: written through the world-space setters, and only when the runtime's pose changed since
      // the last write (or the node was moved by something else since then), so idle agents don't look moved.
      const t = node.transform!;
      const last = (b.written ??= new Float32Array(7).fill(Number.NaN));
      const movedElsewhere = w.tVersion[e] !== b.syncedVersion;
      if (updatePosition && (movedElsewhere || last[0] !== out[o] || last[1] !== out[o + 1] || last[2] !== out[o + 2])) {
        t.worldPosition = [out[o], out[o + 1], out[o + 2]];
        last.set(out.subarray(o, o + 3), 0);
      }
      if (updateRotation && (movedElsewhere || last[3] !== out[o + 3] || last[4] !== out[o + 4] || last[5] !== out[o + 5] || last[6] !== out[o + 6])) {
        t.worldRotation = new Quaternion(out[o + 3], out[o + 4], out[o + 5], out[o + 6]);
        last.set(out.subarray(o + 3, o + 7), 3);
      }
    }
    b.syncedVersion = w.tVersion[e];
  }

  // ------------------------------------------------------------------------------------------- queries (the facade)

  /** Gates changed since the last step reach the runtime before a query, so it sees a gate closed this frame. */
  private syncGatesForQuery(): void {
    for (const g of this.world._componentsOfType(NavGate)) this.syncGate(g);
  }

  findPath(from: Vec3, to: Vec3, agentType: string) {
    this.syncGatesForQuery();
    const type = this.resolveAgentType(agentType, "Navigation.findPath");
    if (type === null) return null;
    const r = this.runtime.findPath(type, from, to);
    return { status: r.status, waypoints: r.waypoints.map(toWaypoint) };
  }

  nearestPoint(p: Vec3, agentType: string, maxDistance: number) {
    this.syncGatesForQuery();
    const type = this.resolveAgentType(agentType, "Navigation.nearestPoint");
    if (type === null) return null;
    return this.runtime.nearestPoint(type, p, maxDistance);
  }

  isReachable(from: Vec3, to: Vec3, agentType: string): boolean {
    this.syncGatesForQuery();
    const type = this.resolveAgentType(agentType, "Navigation.isReachable");
    return type !== null && this.runtime.isReachable(type, from, to);
  }

  raycast(from: Vec3, to: Vec3, agentType: string) {
    this.syncGatesForQuery();
    const type = this.resolveAgentType(agentType, "Navigation.raycast");
    if (type === null) return null;
    return this.runtime.raycast(type, from, to);
  }

  setAreaCost(area: string, cost: number | "excluded"): void {
    if (cost === "excluded") this.runtime.setWorldAreaCost(this.resolveArea(area), -1, true);
    else this.runtime.setWorldAreaCost(this.resolveArea(area), cost, false);
  }
}
