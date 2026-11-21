/**
 * Interest management (ADR 0121): which ghosts each connection is sent.
 *
 * A ghost is sent to a connection only while it's relevant to it. `Replicated.relevantDistance`
 * and `Replicated.group` say when a ghost is (`replication/server.ts` applies them); this module
 * sets the per-connection side, kept on the connection in the session (ADR 0311): the groups a
 * connection is in and the node its distance is measured from. Whether a ghost is relevant to a
 * connection is the session's answer, as server replication reported it.
 *
 * ```ts
 * // A server system: put each player in their team's group, and see from their camera rig.
 * Interest.join(connection, "red");
 * Interest.setViewer(connection, rig);
 * ```
 */
import type { GameObject } from "../scene/GameObject";
import { Connection } from "./connection";
import type { ConnectionNode } from "./messages";
import { Replicated } from "./Replicated";
import { netSession, type NetPeer, type NetSession } from "./session";

/** The server session and open connection `connection` is the node of; throws for anything else. */
function connectionOf(connection: ConnectionNode, what: string): { session: NetSession; peer: NetPeer } {
  const id = connection.isValid ? (connection.getData(Connection) as { id: number } | null)?.id : undefined;
  if (!id) throw new Error(`Interest.${what}: ${connection} isn't an open connection node (one with net.Connection and an id).`);
  const world = connection.world;
  const session = netSession(world);
  if (!session?.isServer) throw new Error(`Interest.${what}: World "${world.name}" isn't a network server; interest is set on the server.`);
  const peer = session.openPeer(id);
  if (!peer) throw new Error(`Interest.${what}: ${connection} isn't an open connection node (one with net.Connection and an id).`);
  return { session, peer };
}

/** What `connection` is interested in: kept on its connection in the session, gone when it closes. */
function interestOf(connection: ConnectionNode, what: string): NetPeer["interest"] {
  return connectionOf(connection, what).peer.interest;
}

/** Interest management on a server World (ADR 0121): connections' groups and viewpoints. */
export const Interest = {
  /** Put a connection in an interest group: ghosts whose `Replicated.group` is `group` become relevant to it. */
  join(connection: ConnectionNode, group: string): void {
    if (!group) throw new Error(`Interest.join: the group name is empty ("" means no group).`);
    interestOf(connection, "join").groups.add(group);
  },

  /** Take a connection out of an interest group. */
  leave(connection: ConnectionNode, group: string): void {
    interestOf(connection, "leave").groups.delete(group);
  },

  /** The groups a connection is in. */
  groups(connection: ConnectionNode): readonly string[] {
    return [...interestOf(connection, "groups").groups];
  },

  /** Whether a connection is in a group. */
  inGroup(connection: ConnectionNode, group: string): boolean {
    return interestOf(connection, "inGroup").groups.has(group);
  },

  /**
   * The node a connection's `relevantDistance` is measured from (a camera rig, a spectated
   * player), or null for the default: the root ghosts the connection owns (`Replicated.ownerId`).
   */
  setViewer(connection: ConnectionNode, viewer: GameObject | null): void {
    if (viewer && viewer.world !== connection.world) throw new Error(`Interest.setViewer: ${viewer} is in another World than ${connection}.`);
    interestOf(connection, "setViewer").viewer = viewer;
  },

  /** The node set with `setViewer`, or null. */
  viewer(connection: ConnectionNode): GameObject | null {
    const v = interestOf(connection, "viewer").viewer;
    return v?.isValid ? v : null;
  },

  /** Whether the ghost `node` is currently sent to `connection` (as of the last snapshot). */
  isRelevant(connection: ConnectionNode, node: GameObject): boolean {
    const { session, peer } = connectionOf(connection, "isRelevant");
    const ghostId = node.isValid ? (node.getBehavior(Replicated)?.ghostId ?? 0) : 0;
    return session.isRelevant(peer.id, ghostId);
  },
};
