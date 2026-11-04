/**
 * The `Navigation` facade (ADR 0065): one-shot queries and per-World settings on the current World's navigation.
 * Agent types and areas are named by id or by name (project settings); an empty agent type means the first.
 *
 * Navigation loads asynchronously (its WebAssembly module): before it has, queries return null / empty results
 * with a warning. Scenes with navigation components load it before they're instantiated.
 */
import { Vector3, type Vec3Input } from "../core/math";
import { World } from "../core/World";
import type { NavWaypoint } from "./components";
import { navDebugOf, readVec3, type NavDebugSettings } from "./navigationSystems";

/** How far a found path goes: all the way, as close as it could get, or nowhere (no path). */
export type NavPathStatus = "success" | "partial" | "none";

export interface NavPathResult {
  status: NavPathStatus;
  waypoints: NavWaypoint[];
}

export interface NavRaycastHit {
  /** Something (a navmesh edge) blocked the way before `to`. */
  hit: boolean;
  /** Where the walk stopped. */
  point: Vector3;
  /** The blocking edge's normal (zero when not hit). */
  normal: Vector3;
  /** Fraction of the way travelled. */
  t: number;
}

export interface NavNearestPoint {
  point: Vector3;
  /** The surface normal there. */
  normal: Vector3;
}

const warned = new WeakSet<World>();

function nav(what: string) {
  const world = World.require();
  const n = world.navigation;
  if (!n && !warned.has(world)) {
    warned.add(world);
    console.warn(`[myco] nav: Navigation.${what} called before navigation loaded in World "${world.name}" (load a scene with navigation components first); returning nothing.`);
  }
  return n;
}

const v3 = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]);

export class Navigation {
  /** A path from `from` to `to` for an agent type: walking, flying or hybrid by the type's abilities. */
  static findPath(from: Vec3Input, to: Vec3Input, agentType = ""): NavPathResult {
    const r = nav("findPath")?.findPath(readVec3(from), readVec3(to), agentType);
    return r ?? { status: "none", waypoints: [] };
  }

  /** The nearest walkable point (or free air, for fly-only types) within `maxDistance`; null if none. */
  static nearestPoint(point: Vec3Input, agentType = "", maxDistance = 2): NavNearestPoint | null {
    const r = nav("nearestPoint")?.nearestPoint(readVec3(point), agentType, maxDistance);
    return r ? { point: v3(r.point), normal: v3(r.normal) } : null;
  }

  /** True if an agent of the type can get from `from` to `to`. */
  static isReachable(from: Vec3Input, to: Vec3Input, agentType = ""): boolean {
    return nav("isReachable")?.isReachable(readVec3(from), readVec3(to), agentType) ?? false;
  }

  /** Walks the navmesh surface from `from` towards `to`; null if `from` isn't on the navmesh. */
  static raycast(from: Vec3Input, to: Vec3Input, agentType = ""): NavRaycastHit | null {
    const r = nav("raycast")?.raycast(readVec3(from), readVec3(to), agentType);
    return r ? { hit: r.hit, point: v3(r.point), normal: v3(r.normal), t: r.t } : null;
  }

  /** This World's cost for an area (over its default, under agents' own `areaCosts`), or `"excluded"`. */
  static setAreaCost(area: string, cost: number | "excluded"): void {
    nav("setAreaCost")?.setAreaCost(area, cost);
  }

  /** The ids of the chunks loaded in this World. */
  static get loadedChunks(): string[] {
    return World.require().navigation?.loadedChunks() ?? [];
  }

  /** True once this World's navigation has loaded. */
  static get isReady(): boolean {
    return World.require().navigation !== null;
  }

  /** What the navigation debug drawing shows in this World (toggle fields; drawing reads them). */
  static get debug(): NavDebugSettings {
    return navDebugOf(World.require());
  }
}
