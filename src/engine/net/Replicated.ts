/**
 * The `net.Replicated` component (ADR 0033 §3): it makes a node a ghost, a node the server World
 * sends to its clients. Put it on a prefab's root (and on any of the prefab's nodes that should
 * replicate too) or on a node placed in a scene. See `replication/server.ts` for what's sent and
 * how ghosts spawn and match.
 *
 * On the server, game code sets `ownerId` (a connection id) and `mode`; on clients the component
 * exists on ghosts and the replication systems write it, so game code there only reads it.
 */
import { Component } from "../core/Component";
import { World } from "../core/World";
import { component, field } from "../core/registry";
import type { GameObject } from "../scene/GameObject";
import type { ReplicatedSettings, ReplicationMode } from "./replication";
import { registerInputOwnerResolver } from "./input";
import { netSession } from "./session";
// The replication systems and message kinds come with the component.
import "./replication/systems";

@component("net.Replicated")
export class Replicated extends Component implements ReplicatedSettings {
  /** `"interpolated"` (default) or `"predicted"` (the owning client predicts it, T13). */
  @field(String) mode: ReplicationMode = "interpolated";
  /** The owning connection's id (`Connection.id`); 0: the server owns it. (Not `owner`: that's every component's owning node.) */
  @field(Number) ownerId = 0;
  /** Relative priority when a snapshot is full (1 = normal). */
  @field(Number) importance = 1;
  /** Replicate the local position, rotation and scale (default true). */
  @field(Boolean) replicateTransform = true;

  /** @internal The ghost id: assigned by the server, received by clients. 0 until then. */
  _ghostId = 0;
  /** @internal Client: true once the server drives this node (it spawned or matched it). */
  _isGhost = false;

  /** The ghost id the server gave this node (the same in every World), or 0 before it has one. */
  get ghostId(): number {
    return this._ghostId;
  }

  /** True on a client World for nodes the server drives. */
  get isGhost(): boolean {
    return this._isGhost;
  }

  /**
   * True if this World owns the node: on a client, if `ownerId` is its connection's id; on a
   * server, if `ownerId` is 0; in a World that isn't networked, always. Inputs (T12) and prediction
   * (T13) act on locally owned nodes.
   */
  get isOwnedLocally(): boolean {
    return ownedIn(this._node.world, this.ownerId);
  }

  /** True on the owning client of a `"predicted"` ghost: the node T13 predicts. */
  get isPredictedLocally(): boolean {
    return this.mode === "predicted" && this._isGhost && this.isOwnedLocally;
  }

  /** Whether `node` has a `Replicated` component that's owned in its World (see `isOwnedLocally`). */
  static isOwnedLocally(node: GameObject): boolean {
    return node.getBehavior(Replicated)?.isOwnedLocally ?? false;
  }
}

// Inputs (T12) for an owned ghost: `Move.of(playerNode)` reads its owner's connection's input on
// the server, and the local input on the owning client.
registerInputOwnerResolver((world, node) => {
  const rep = node.getBehavior(Replicated);
  const session = netSession(world);
  if (!rep || !session || rep.ownerId === 0) return null;
  if (session.isServer) return session.openPeers().find((p) => p.id === rep.ownerId)?.node ?? null;
  const peer = session.serverPeer;
  return peer?.state === "open" && peer.id === rep.ownerId ? peer.node : null;
});

function ownedIn(world: World, owner: number): boolean {
  const session = netSession(world);
  if (!session || !(session.isClient || session.isServer)) return true;
  if (session.isServer) return owner === 0;
  const peer = session.serverPeer;
  return owner !== 0 && !!peer && peer.state === "open" && peer.id === owner;
}
