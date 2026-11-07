/**
 * Interest management (ADR 0121): which ghosts each connection is sent.
 *
 * A ghost is sent to a connection only while it's relevant to it. `Replicated.relevantDistance`
 * and `Replicated.group` say when a ghost is (`replication/server.ts` applies them); this module
 * holds the per-connection side, set by server code: the groups a connection is in and the node
 * its distance is measured from.
 *
 * ```ts
 * // A server system: put each player in their team's group, and see from their camera rig.
 * Interest.join(connection, "red");
 * Interest.setViewer(connection, rig);
 * ```
 */
import { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { Connection } from "./connection";
import type { ConnectionNode } from "./messages";
import { netSession } from "./session";

/** @internal What one connection is interested in. */
export interface ConnectionInterest {
  readonly groups: Set<string>;
  viewer: GameObject | null;
}

const byWorld = new WeakMap<World, Map<number, ConnectionInterest>>();

function connectionId(connection: ConnectionNode, what: string): { world: World; id: number } {
  const id = connection.isValid ? (connection.getData(Connection) as { id: number } | null)?.id : undefined;
  if (!id) throw new Error(`Interest.${what}: ${connection} isn't an open connection node (one with net.Connection and an id).`);
  const world = connection.world;
  if (!netSession(world)?.isServer) throw new Error(`Interest.${what}: World "${world.name}" isn't a network server; interest is set on the server.`);
  return { world, id };
}

function entry(connection: ConnectionNode, what: string): ConnectionInterest {
  const { world, id } = connectionId(connection, what);
  let map = byWorld.get(world);
  if (!map) byWorld.set(world, (map = new Map()));
  let e = map.get(id);
  if (!e) map.set(id, (e = { groups: new Set(), viewer: null }));
  return e;
}

/** @internal The interest of connection `id` in `world`, if any was set. */
export function _interestOf(world: World, id: number): ConnectionInterest | undefined {
  return byWorld.get(world)?.get(id);
}

/** @internal Forget connections that are gone (ids are never reused, so this only frees memory). */
export function _pruneInterest(world: World, open: ReadonlySet<number>): void {
  const map = byWorld.get(world);
  if (!map) return;
  for (const id of map.keys()) if (!open.has(id)) map.delete(id);
}

type RelevanceQuery = (world: World, connectionId: number, node: GameObject) => boolean;
let relevanceQuery: RelevanceQuery = () => false;

/** @internal Replication answers `Interest.isRelevant`. */
export function _setRelevanceQuery(query: RelevanceQuery): void {
  relevanceQuery = query;
}

/** Interest management on a server World (ADR 0121): connections' groups and viewpoints. */
export const Interest = {
  /** Put a connection in an interest group: ghosts whose `Replicated.group` is `group` become relevant to it. */
  join(connection: ConnectionNode, group: string): void {
    if (!group) throw new Error(`Interest.join: the group name is empty ("" means no group).`);
    entry(connection, "join").groups.add(group);
  },

  /** Take a connection out of an interest group. */
  leave(connection: ConnectionNode, group: string): void {
    entry(connection, "leave").groups.delete(group);
  },

  /** The groups a connection is in. */
  groups(connection: ConnectionNode): readonly string[] {
    const { world, id } = connectionId(connection, "groups");
    return [..._interestOf(world, id)?.groups ?? []];
  },

  /** Whether a connection is in a group. */
  inGroup(connection: ConnectionNode, group: string): boolean {
    const { world, id } = connectionId(connection, "inGroup");
    return _interestOf(world, id)?.groups.has(group) ?? false;
  },

  /**
   * The node a connection's `relevantDistance` is measured from (a camera rig, a spectated
   * player), or null for the default: the root ghosts the connection owns (`Replicated.ownerId`).
   */
  setViewer(connection: ConnectionNode, viewer: GameObject | null): void {
    if (viewer && viewer.world !== connection.world) throw new Error(`Interest.setViewer: ${viewer} is in another World than ${connection}.`);
    entry(connection, "setViewer").viewer = viewer;
  },

  /** The node set with `setViewer`, or null. */
  viewer(connection: ConnectionNode): GameObject | null {
    const { world, id } = connectionId(connection, "viewer");
    const v = _interestOf(world, id)?.viewer ?? null;
    return v?.isValid ? v : null;
  },

  /** Whether the ghost `node` is currently sent to `connection` (as of the last snapshot). */
  isRelevant(connection: ConnectionNode, node: GameObject): boolean {
    const { world, id } = connectionId(connection, "isRelevant");
    return relevanceQuery(world, id, node);
  },
};
