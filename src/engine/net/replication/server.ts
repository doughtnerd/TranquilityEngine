/**
 * The server half of replication (ADR 0033 §3, T11): ghosts, per-connection snapshots, acks.
 *
 * ## Ghosts
 *
 * Every node with an enabled-or-not, attached `net.Replicated` component in a server World is a
 * ghost. The server gives it an id (1, 2, …, never reused) the first time `engine.ReplicationSend`
 * sees it, and from then on sends it to every open connection. Clients find or make its node by
 * its spawn (`wire.ts`):
 * - **Prefab** (`kind 0`): the root of a prefab instantiated at runtime (`GameObject.instantiate`)
 *   spawns on clients by prefab path, under the parent its structure names (below).
 * - **Nested** (`kind 2`): a replicated node inside such an instance (not its root) matches the
 *   node at the same id path inside the client's instance of the root ghost. The root must be
 *   replicated too.
 * - **Scene** (`kind 1`): a node placed in a scene (directly or inside a sub-scene or a prefab
 *   placed in the scene) matches by the scene file, which loaded copy of it (for a scene loaded
 *   twice additively) and the node id path from the scene node: pre-spawned ghosts, since both
 *   Worlds load the same scene (ADR 0032). Clients don't spawn these; one whose scene the client
 *   hasn't loaded waits until it has.
 * - Anything else (a node made with `GameObject.create`, or inside an instance whose root isn't
 *   replicated) can't be found on clients: it's skipped, with a warning once.
 * A ghost's layout (what's sent, `layout.ts`) is worked out when it's first seen, and again when
 * its components change (ADR 0121): a changed layout bumps its `layoutVersion` and goes to
 * connections in a relayout section. When its node or `Replicated` component is destroyed, it
 * despawns.
 *
 * ## Relevancy (ADR 0121)
 *
 * A connection is sent only the ghosts relevant to it: a ghost passes for a connection that owns
 * it, or when its `group` is "" or one the connection joined (`Interest.join`) and its
 * `relevantDistance` is 0 or reaches one of the connection's viewpoints (`Interest.setViewer`, else
 * the root ghosts it owns), with 10% hysteresis on leaving. It's relevant when it and every ghost
 * above it pass. A ghost that stops being relevant goes in that tick's lifecycle message as a leave
 * (clients destroy prefab ghosts and deactivate scene and nested ones); one that becomes relevant
 * again is spawned afresh in a later one, and acks of messages from before it came back no longer
 * count for it (the client forgot that stay). One that's destroyed after it left is still
 * despawned, so clients destroy a deactivated scene or nested ghost and forget its strings.
 *
 * ## Structure (ADR 0100)
 *
 * A ghost's node's own active flag and its parent, plus (ADR 0121) its order among sibling
 * ghosts (`after`) and its layout's disabled behaviors, versioned: the version goes up (with the
 * tick) on each sent tick that finds any of them changed. The parent is the World root, a ghost's node or a
 * node with ids below one (a weapon under a player's "Hand"), a scene-placed node, or, for a
 * parent clients can't find (a node made with `GameObject.create`; warned once), their active
 * scene. A scene or nested ghost has no parent in its structure until it's moved (clients find it
 * where it is). Spawns carry the current structure (so a late joiner's ghost spawns under its
 * current parent); later changes go in a lifecycle message's structure section, once. Clients show
 * a change when their interpolation tick reaches its tick (owned predicted ghosts at once) and
 * don't interpolate across a move.
 *
 * ## The string table (ADR 0100)
 *
 * Strings in lifecycle messages (prefab paths, scene files, node ids, component ids) go through a
 * per-connection table (`StringTableOut` in `wire.ts`): inline with an index the first time, then
 * the index alone (a byte or two). Lifecycle messages are reliable and in order, so a string is the
 * client's from the moment it's written.
 *
 * ## Lifecycle messages (reliable, `net.ghosts`, tagged with the server tick; ADR 0402)
 *
 * Creation goes reliably and apart from per-tick state, as Unreal's actor channels open with a
 * reliable bunch: on a sent tick with any, each connection gets one message of its lifecycle events:
 *
 * ```
 * varuint  despawn count, then ghost ids (ascending, each as the gap from the previous)
 * varuint  leave count,   then ghost ids (ADR 0121: no longer relevant to this connection)
 * varuint  relayout count, then per ghost: id gap, layout version, layout spec, the codec's full record (ADR 0121)
 * varuint  structure change count, then per ghost: id gap, its structure
 * per spawn: 1 bit (1), id gap, the spawn and layout spec, layout version, its structure (wire.ts),
 *            the codec's full record; then 1 bit (0)
 * ```
 *
 * Each event is sent once. Spawns go in id order while the tick's budget lasts (at least one); the
 * rest wait for the next tick. Relayouts and structure changes are only for ghosts whose spawn
 * went before; a spawn carries the current layout and structure. Despawns and leaves always go.
 *
 * ## Snapshots (unreliable, `net.snapshot`, tagged with the server tick)
 *
 * Once per tick that advanced since the last one (or at `sendRate`), each open connection gets
 * one snapshot, in one part or more (ADR 0334, below), of ghost states only. It carries a ghost's
 * state only once the client has acked the lifecycle message with its spawn, and since its last
 * relayout only once it acked that relayout (ADR 0402): so a client never reads a state before its
 * ghost's spawn, or in a layout it doesn't have yet. Each part is:
 *
 * ```
 * varuint  part index (0, 1, …)
 * varuint  baseline: server tick − the connection's newest acked tick (0: none, or too old)
 * varuint  state count,   then per ghost: id gap,
 *            1 bit   uses the snapshot's baseline; if not, 1 bit has a baseline, and if it
 *                    does, varuint server tick − its baseline tick
 *            with a baseline: 1 bit changed, and if so the codec's delta against it
 *            without one: the codec's full record
 * ```
 *
 * A ghost's baseline is the state in the newest acked message that included it: the full state of
 * its spawn or relayout (once that lifecycle message is acked), or its state in an acked snapshot
 * part. Both ends keep what was sent per tick (the server for `BASELINE_WINDOW` ticks), so an
 * unchanged ghost costs its id gap and two bits, about a byte. A baseline is only used while it has
 * the ghost's current layout.
 *
 * ## Parts and the budget (ADR 0334)
 *
 * A tick's replication to a connection is at most `maxSnapshotBytes` (64 KiB): its lifecycle
 * message first, then snapshot parts in what's left. Over a plain stream (loopback, a WebSocket
 * without a data channel) the snapshot is one part. While the connection's transport sends
 * unreliable messages as lossy datagrams (ADR 0333), each part fits one datagram, and a tick has
 * as many as the budget allows; losing one loses only its ghosts' states. A snapshot that fits one
 * part is written once. Otherwise parts are filled first-fit with ghosts by priority (the ghosts
 * unsent longest, times their `importance`); what doesn't fit goes next tick. A ghost whose state
 * alone is bigger than a datagram still goes, alone, by the transport's slower reliable path. When
 * the next tick's datagrams overtake it, the client still reads it (ADR 0405): its states are filed
 * in tick order, and it's acked like any part, so a ghost whose state is always that big keeps
 * updating, a little behind, instead of starving.
 *
 * ## Acks (unreliable, `net.snapshotAck`)
 *
 * A client that read lifecycle messages or snapshot parts in a frame sends, at the end of it, the
 * newest lifecycle tick it applied, the newest snapshot tick it read and every part of that tick it
 * has read, then older ticks it read a late part of lately, each repeated by a few acks (ADR 0405):
 * `varuint lifecycle tick, varuint tick count`, then per tick (the newest, then each older one as the
 * gap back from the one before) `varuint part count`, the first part index and the gaps between the
 * rest. Lifecycle messages arrive in order, so the first tick
 * acks every one up to it: their spawns and relayouts' full states become baselines and their
 * ghosts' states may go in snapshots. For each snapshot part not acked before, the server makes its
 * states the baselines where they're newer than the ghost's (a late part's may not be: a baseline
 * never goes back). It sets the connection's `lastAckedTick` (which shows on its `Connection`
 * node) to the newest snapshot tick acked.
 */
import type { Component } from "../../core/Component";
import type { DataComponentDef } from "../../core/data";
import { getComponentClass } from "../../core/registry";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { SceneInstance, _instantiatedPrefabOf } from "../../scene/SceneLoader";
import { BitWriterImpl } from "../bits";
import { Replicated } from "../Replicated";
import { netSession, type NetPeer, type NetSession } from "../session";
import { layoutOf, readState, sameState, specOf, type GhostState, type Layout } from "./layout";
import { ServerStrings } from "./strings";
import {
  ACK,
  AFTER_UNSPECIFIED,
  BASELINE_WINDOW,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  MAX_ACK_TICKS,
  MAX_SNAPSHOT_PARTS,
  PARENT_GHOST,
  PARENT_NODE,
  PARENT_ROOT,
  PARENT_SCENE,
  GHOSTS,
  SNAPSHOT,
  SPAWN_NESTED,
  SPAWN_PREFAB,
  SPAWN_SCENE,
  StringTableOut,
  sameOrderAndEnabled,
  sameParent,
  writeSpawn,
  writeSpec,
  writeStructure,
  type ComponentRef,
  type ParentRef,
  type SpawnInfo,
  type Structure,
  type WriteString,
} from "./wire";

interface ServerGhost {
  readonly id: number;
  readonly rep: Replicated;
  readonly node: GameObject;
  /** What it sends; replaced when its components change (ADR 0121). */
  layout: Layout;
  /** Bumped when `layout` changes (0 at first sight). */
  layoutVersion: number;
  /** Its node's components and data components when `layout` was worked out (to notice changes). */
  components: readonly Component[];
  dataDefs: readonly DataComponentDef[];
  replicateTransform: boolean;
  /** Its sibling order (`after`) at first sight: a scene or nested ghost sends none until it differs. */
  readonly afterSeen: number;
  readonly spawn: SpawnInfo;
  /** What kind of ghost it is, for bandwidth per ghost type (tools): its prefab path, or for a scene ghost its scene and node path. */
  readonly type: string;
  /** This tick's values (read once per sent tick, shared by every connection). */
  state: GhostState;
  /** Its active flag and parent as last sent (ADR 0100). */
  structure: Structure;
  /** The parent node `structure` was worked out from. */
  parentNode: GameObject | null;
  /** Warned that clients can't find a parent it was moved under. */
  warnedParent: boolean;
}

/** What one connection has been told about one ghost. */
interface PeerGhost {
  /**
   * The tick it (last) became relevant to the connection: acks of messages from before it carried
   * an earlier stay (before it left), whose spawn, states and structures the client has forgotten.
   */
  readonly since: number;
  /** Its spawn went in a lifecycle message (ADR 0402). */
  spawnSent: boolean;
  /** The client acked the lifecycle message with its spawn: snapshots may carry its state. */
  spawnAcked: boolean;
  /** The state in the newest acked message (a spawn, relayout or snapshot part) that included this ghost, and that message's tick. */
  baseline: GhostState | null;
  baselineTick: number;
  /** The last tick its state was in a snapshot (for priority). */
  lastSentTick: number;
  /** The newest structure version sent (ADR 0100), in a spawn or a structure change; -1: none. */
  structureSent: number;
  /** The layout version of `baseline` (ADR 0121): a baseline in an older layout isn't used. */
  baselineLayout: number;
  /** The newest layout version sent (in a spawn or relayout); -1: none. */
  layoutSent: number;
  /** The newest layout version the client acked; snapshots carry its state only in that layout. */
  layoutAcked: number;
}

/** What one snapshot part carried (states only, ADR 0402), kept until acked or too old. */
interface Sent {
  readonly states: Map<number, GhostState>;
  /** The layout version of each state. */
  readonly layouts: Map<number, number>;
}

/**
 * What one lifecycle message carried that matters once it's acked (ADR 0402): the full state each
 * spawn and relayout sent, which becomes the ghost's baseline, in which layout version.
 */
interface Lifecycle {
  readonly states: { readonly id: number; readonly layout: number; readonly state: GhostState; readonly spawn: boolean }[];
}

interface PeerState {
  /** Ghosts relevant to this connection, by id; `spawnSent` says whether it has been sent their spawn. */
  readonly known: Map<number, PeerGhost>;
  /**
   * Ghosts that left: a despawn is still sent if they go. Clients keep scene and nested ones
   * deactivated, and keep a prefab one's strings.
   */
  readonly dormant: Set<number>;
  /** What each part of a sent tick carried (ADR 0334); a part is nulled once acked. */
  readonly history: Map<number, (Sent | null)[]>;
  /** Lifecycle messages not yet acked, by tick, oldest first (ADR 0402). */
  readonly lifecycle: Map<number, Lifecycle>;
  /** Bytes of the last tick's snapshot, all its parts (for tests and tools). */
  lastBytes: number;
  /** Bytes of the last tick's lifecycle message (ADR 0402), 0 when it had none. */
  lastLifecycleBytes: number;
  /** How many parts the last tick's snapshot took (ADR 0334). */
  lastParts: number;
  /** Bits each ghost's state took when last written for this connection, to plan before writing when it's over a part. */
  lastCosts: Map<number, number>;
  /** Bits of the last snapshot written whole (before splitting), or 0. */
  lastFullBits: number;
  /**
   * Bits sent on this connection per ghost type (`ServerGhost.type`) since it opened: each ghost's
   * spawn and state in the snapshots actually sent (tools: bandwidth per ghost type).
   */
  readonly typeBits: Map<string, number>;
  /** Strings in lifecycle messages, by index once the client has them (ADR 0100). */
  readonly table: StringTableOut;
}

/** @internal Replication settings of a server World. */
export interface ReplicationOptions {
  /** Snapshots per second (at most the tick rate). Default: the tick rate. */
  sendRate?: number;
  /** Snapshot budget in bytes. Default 64 KiB. */
  maxSnapshotBytes?: number;
}

/** @internal A server World's replication state. */
export class ServerReplication {
  readonly ghosts = new Map<Replicated, ServerGhost>();
  private readonly byId = new Map<number, ServerGhost>();
  sendRate: number;
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES;
  private nextId = 1;
  private lastSentTick = -1;
  private readonly peers = new WeakMap<NetPeer, PeerState>();
  /** Replicated components that can't be spawned on clients (warned once). */
  private readonly unspawnable = new WeakSet<Replicated>();
  /** String behavior fields (ADR 0068), sent whole when they change. */
  private readonly strings = new ServerStrings();

  constructor(
    readonly world: World,
    readonly session: NetSession,
  ) {
    this.sendRate = session.tickRate;
    // ADR 0101: the World config's `replication` settings.
    const settings = world._owner?._worldConfig(world.name)?.replication;
    if (settings) applyReplicationOptions(this, settings);
  }

  /** @internal The per-connection state, for tests and tools. */
  peerState(peer: NetPeer): PeerState | undefined {
    return this.peers.get(peer);
  }

  /** `engine.ReplicationSend`: acks, then (on a new tick) one snapshot per open connection. */
  run(): void {
    const session = this.session;
    for (const m of session.drain(ACK)) {
      try {
        const r = m.reader();
        const lifecycleTick = r.readVarUint();
        const ticks = r.readVarUint();
        if (ticks > MAX_ACK_TICKS) continue;
        const acks: { tick: number; parts: number[] }[] = [];
        // The newest tick, then each older one as the gap back from the one before (ADR 0405); per tick
        // its part count, the first index, then each as the gap from the one before.
        for (let t = 0, tick = 0; t < ticks; t++) {
          tick = t === 0 ? r.readVarUint() : tick - r.readVarUint();
          const count = r.readVarUint();
          if (count > MAX_SNAPSHOT_PARTS) throw new Error("too many parts");
          const parts: number[] = [];
          for (let i = 0, part = 0; i < count; i++) parts.push((part = i === 0 ? r.readVarUint() : part + r.readVarUint()));
          acks.push({ tick, parts });
        }
        this.lifecycleAcked(m.peer, lifecycleTick);
        for (const { tick, parts } of acks) this.acked(m.peer, tick, parts);
      } catch {
        // A malformed ack is ignored; the next one will do.
      }
    }
    const tick = session.tick;
    if (tick === 0 || tick === this.lastSentTick) return;
    const interval = Math.max(1, Math.round(session.tickRate / Math.max(1e-6, this.sendRate)));
    if (this.lastSentTick >= 0 && tick - this.lastSentTick < interval) return;
    this.lastSentTick = tick;

    const despawned = this.updateGhosts(tick);
    for (const g of this.ghosts.values()) g.state = readState(g.layout, g.node, g.rep);
    const peers = session.openPeers();
    const interest = this.interestFrame();
    for (const peer of peers) {
      let ps = this.peers.get(peer);
      if (!ps) {
        this.peers.set(peer, (ps = { known: new Map(), dormant: new Set(), history: new Map(), lifecycle: new Map(), lastBytes: 0, lastLifecycleBytes: 0, lastParts: 0, lastCosts: new Map(), lastFullBits: 0, typeBits: new Map(), table: new StringTableOut() }));
        peer.relevantGhosts = ps.known; // what Interest.isRelevant answers from (ADR 0311)
      }
      const despawns: number[] = [];
      for (const id of despawned) if (ps.known.delete(id) || ps.dormant.delete(id)) despawns.push(id);
      const leaves: number[] = [];
      const relevant = interest ? this.relevantTo(peer, ps, interest) : null;
      if (relevant) {
        for (const id of [...ps.known.keys()]) {
          if (relevant.has(id)) continue;
          ps.known.delete(id);
          leaves.push(id);
          ps.dormant.add(id);
        }
      }
      for (const g of this.ghosts.values()) {
        if (ps.known.has(g.id) || (relevant && !relevant.has(g.id))) continue;
        // Back after leaving: spawned afresh (the client applies the leave, then this spawn, in order).
        ps.known.set(g.id, { since: tick, spawnSent: false, spawnAcked: false, baseline: null, baselineTick: 0, lastSentTick: -1, structureSent: -1, baselineLayout: -1, layoutSent: -1, layoutAcked: -1 });
        ps.dormant.delete(g.id);
      }
      // Lifecycle first, reliably (ADR 0402); then the states that fit what the budget has left.
      const lifecycleBytes = this.lifecycleMessage(peer, ps, tick, despawns, leaves);
      const parts = this.snapshot(peer, ps, tick, Math.max(PART_HEADER_BITS / 8, this.maxSnapshotBytes - lifecycleBytes));
      ps.lastLifecycleBytes = lifecycleBytes;
      ps.lastBytes = parts.reduce((n, part) => n + part.byteLength, 0);
      ps.lastParts = parts.length;
      for (const part of parts) session.send(SNAPSHOT, peer, "unreliable", part, tick);
    }
    this.strings.send(session, this.ghosts.values(), despawned, (peer, id) => this.peers.get(peer)?.known.has(id) ?? false);
  }

  /**
   * What relevancy needs this sent tick (ADR 0121): each ghost's nearest ghost above it, and the
   * world positions of distance-limited ghosts and owned root ghosts (viewpoints). Null when no
   * ghost has a distance or a group (everything is relevant to everyone).
   */
  private interestFrame(): InterestFrame | null {
    let filtered = false;
    for (const g of this.ghosts.values()) {
      if (g.rep.relevantDistance > 0 || g.rep.group) {
        filtered = true;
        break;
      }
    }
    if (!filtered) return null;
    const world = this.world;
    const above = new Map<ServerGhost, ServerGhost | null>();
    const positions = new Map<ServerGhost, Float64Array>();
    for (const g of this.ghosts.values()) {
      let parent: ServerGhost | null = null;
      for (let n = g.node.parent; n && n !== world.root && !parent; n = n.parent) {
        const rep = n.getBehavior(Replicated);
        parent = (rep && this.ghosts.get(rep)) || null;
      }
      above.set(g, parent);
      if (g.rep.relevantDistance > 0 || (g.rep.ownerId !== 0 && !parent)) positions.set(g, worldPositionOf(world, g.node));
    }
    return { above, positions };
  }

  /** The ids of the ghosts relevant to `peer` (ADR 0121; see the top of this file). */
  private relevantTo(peer: NetPeer, ps: PeerState, frame: InterestFrame): Set<number> {
    const session = this.session;
    const interest = peer.interest;
    const viewpoints: Float64Array[] = [];
    const viewer = interest.viewer;
    if (viewer?.isValid && viewer.world === this.world) viewpoints.push(worldPositionOf(this.world, viewer));
    else {
      for (const [g, parent] of frame.above) {
        if (!parent && session.owns(peer, g.rep.ownerId)) viewpoints.push(frame.positions.get(g)!);
      }
    }
    const passes = (g: ServerGhost): boolean => {
      const rep = g.rep;
      if (session.owns(peer, rep.ownerId)) return true;
      if (rep.group && !interest.groups.has(rep.group)) return false;
      const r = rep.relevantDistance;
      if (!(r > 0)) return true;
      const limit = ps.known.has(g.id) ? r * LEAVE_HYSTERESIS : r;
      const p = frame.positions.get(g)!;
      for (const v of viewpoints) {
        const dx = p[0] - v[0], dy = p[1] - v[1], dz = p[2] - v[2];
        if (dx * dx + dy * dy + dz * dz <= limit * limit) return true;
      }
      return false;
    };
    const memo = new Map<ServerGhost, boolean>();
    const relevant = (g: ServerGhost): boolean => {
      let r = memo.get(g);
      if (r === undefined) {
        const parent = frame.above.get(g) ?? null;
        r = passes(g) && (!parent || relevant(parent));
        memo.set(g, r);
      }
      return r;
    };
    const out = new Set<number>();
    for (const g of this.ghosts.values()) if (relevant(g)) out.add(g.id);
    return out;
  }

  /** Find new ghosts and gone ones, and structure changes (ADR 0100). Returns the ids that despawned. */
  private updateGhosts(tick: number): number[] {
    const world = this.world;
    const despawned: number[] = [];
    for (const [rep, g] of this.ghosts) {
      if (rep._destroyed || !g.node.isValid) {
        this.ghosts.delete(rep);
        this.byId.delete(g.id);
        despawned.push(g.id);
      }
    }
    const fresh: Replicated[] = [];
    for (const rep of world._componentsOfType(Replicated)) {
      if (rep._destroyed || this.ghosts.has(rep) || this.unspawnable.has(rep) || !rep.node.isValid) continue;
      if (world.inEditMode(rep.node.entity)) continue;
      fresh.push(rep);
    }
    this.updateLayouts();
    // Ids first, so spawns can name their parent or root ghost whatever order they were found in.
    const ids = new Map<Replicated, number>();
    for (const rep of fresh) ids.set(rep, this.nextId++);
    const ghostOf = (node: GameObject): number => {
      const rep = node.getBehavior(Replicated);
      if (!rep) return 0;
      return this.ghosts.get(rep)?.id ?? ids.get(rep) ?? 0;
    };
    const after = this.siblingOrder(fresh, ghostOf);
    this.updateStructures(tick, ghostOf, after);
    if (fresh.length === 0) return despawned;
    for (const rep of fresh) {
      const node = rep.node;
      const spawn = spawnOf(world, node, ghostOf);
      if (typeof spawn === "string") {
        this.unspawnable.add(rep);
        console.warn(`[myco] World "${world.name}": ${node} has a Replicated component but can't be replicated: ${spawn}`);
        continue;
      }
      const id = ids.get(rep)!;
      rep._ghostId = id;
      const layout = layoutOf(specOf(world, node, rep));
      const parent = node.parent;
      // A prefab ghost spawns under its parent; a scene or nested one is found where it is until it moves.
      const prefab = spawn.kind === SPAWN_PREFAB;
      const ref: ParentRef | null = prefab ? (parentRefOf(world, parent, ghostOf) ?? { kind: PARENT_SCENE }) : null;
      const afterSeen = after.get(id) ?? 0;
      const structure: Structure = { version: 0, tick, active: node.active, parent: ref, after: prefab ? afterSeen : AFTER_UNSPECIFIED, disabled: disabledOf(node, layout) };
      const ghost: ServerGhost = {
        id, rep, node, layout, layoutVersion: 0, components: [...world._componentsOf(node.entity)], dataDefs: world._dataComponentsOf(node.entity), replicateTransform: rep.replicateTransform,
        afterSeen, spawn, type: "", state: [], structure, parentNode: parent, warnedParent: false,
      };
      (ghost as { type: string }).type = this.typeOf(ghost);
      this.ghosts.set(rep, ghost);
      this.byId.set(id, ghost);
    }
    return despawned;
  }

  /**
   * Work out a ghost's layout again when its components, data components or `replicateTransform`
   * changed (ADR 0121); a different layout bumps its `layoutVersion`.
   */
  private updateLayouts(): void {
    const world = this.world;
    for (const g of this.ghosts.values()) {
      const e = g.node.entity;
      const components = world._componentsOf(e);
      const dataDefs = world._dataComponentsOf(e);
      if (g.replicateTransform === g.rep.replicateTransform && sameList(components, g.components) && sameList(dataDefs, g.dataDefs)) continue;
      g.components = [...components];
      g.dataDefs = dataDefs;
      g.replicateTransform = g.rep.replicateTransform;
      const layout = layoutOf(specOf(world, g.node, g.rep));
      if (layout.key === g.layout.key) continue;
      g.layout = layout;
      g.layoutVersion++;
    }
  }

  /**
   * Each ghost's order among its sibling ghosts (ADR 0121): the id of the nearest ghost before it
   * under the same parent, or 0. Walks each ghost parent's children once.
   */
  private siblingOrder(fresh: readonly Replicated[], ghostOf: (node: GameObject) => number): Map<number, number> {
    const parents = new Set<GameObject>();
    for (const g of this.ghosts.values()) if (g.node.parent) parents.add(g.node.parent);
    for (const rep of fresh) if (rep.node.parent) parents.add(rep.node.parent);
    const after = new Map<number, number>();
    for (const parent of parents) {
      let previous = 0;
      for (const child of parent.children) {
        const id = ghostOf(child);
        if (!id) continue;
        after.set(id, previous);
        previous = id;
      }
    }
    return after;
  }

  /**
   * Bump the structure of every ghost whose node was activated, deactivated, reparented or
   * reordered, or whose replicated behaviors were enabled or disabled, since the last sent tick.
   */
  private updateStructures(tick: number, ghostOf: (node: GameObject) => number, afterOf: ReadonlyMap<number, number>): void {
    for (const g of this.ghosts.values()) {
      const node = g.node;
      const parent = node.parent;
      const active = node.active;
      const old = g.structure;
      const seen = afterOf.get(g.id) ?? 0;
      // A scene or nested ghost's order stays unspecified until it moves or differs from where it was found.
      const after = old.after === AFTER_UNSPECIFIED && seen === g.afterSeen && parent === g.parentNode ? AFTER_UNSPECIFIED : seen;
      const disabled = disabledOf(node, g.layout);
      const sameRest = sameOrderAndEnabled(old, { after, disabled });
      if (parent === g.parentNode && active === old.active && sameRest) continue;
      let ref = old.parent;
      if (parent !== g.parentNode) {
        g.parentNode = parent;
        const found = parentRefOf(this.world, parent, ghostOf);
        if (!found && !g.warnedParent) {
          g.warnedParent = true;
          console.warn(`[myco] World "${this.world.name}": ${node} (a ghost) was moved under ${parent}, which clients can't find (it isn't the World root, a ghost or inside one, or a scene-placed node); clients put it under their active scene.`);
        }
        ref = found ?? { kind: PARENT_SCENE };
      }
      if (sameParent(ref, old.parent) && active === old.active && sameRest) continue;
      g.structure = { version: old.version + 1, tick, active, parent: ref, after, disabled };
    }
  }

  /** A ghost's type (see `ServerGhost.type`); a nested ghost is named after its instance's prefab and its id path in it. */
  private typeOf(g: ServerGhost): string {
    const s = g.spawn;
    if (s.kind === SPAWN_PREFAB) return s.path;
    if (s.kind === SPAWN_SCENE) return `${s.source}#${s.ids.join("/")}`;
    let root: string | undefined;
    for (let n: GameObject | null = g.node; n && root === undefined; n = n.parent) root = _instantiatedPrefabOf(n);
    return `${root ?? "?"} › ${s.ids.join("/")}`;
  }

  /**
   * The client applied every lifecycle message up to `tick` (ADR 0402; they're reliable and in order,
   * so one tick says it all): their spawns are there, so snapshots may carry those ghosts' states,
   * and each spawn's and relayout's full state is a baseline the client has.
   */
  private lifecycleAcked(peer: NetPeer, tick: number): void {
    if (!(tick > 0 && tick <= this.session.tick)) return;
    const ps = this.peers.get(peer);
    if (!ps) return;
    for (const [t, record] of ps.lifecycle) {
      if (t > tick) break;
      ps.lifecycle.delete(t);
      for (const { id, layout, state, spawn } of record.states) {
        // Only for the ghost's current stay: one that left and came back since is spawned afresh.
        const pg = ps.known.get(id);
        if (!pg || t < pg.since) continue;
        if (spawn) pg.spawnAcked = true;
        if (layout > pg.layoutAcked) pg.layoutAcked = layout;
        if (!pg.baseline || t > pg.baselineTick) {
          pg.baseline = state;
          pg.baselineTick = t;
          pg.baselineLayout = layout;
        }
      }
    }
  }

  /**
   * The client read these parts of `tick` (ADR 0334): their states become baselines, once, where
   * they're newer than the ghost's baseline. The tick may be older than the newest acked: a part
   * that came late by the reliable path (ADR 0405), which the client kept whole. Records are kept
   * for `BASELINE_WINDOW` ticks (pruned when snapshots are written), each part's until it's acked.
   */
  private acked(peer: NetPeer, tick: number, parts: readonly number[]): void {
    if (!(tick > 0 && tick <= this.session.tick)) return;
    const ps = this.peers.get(peer);
    if (!ps) return;
    if (tick > peer.lastAckedTick) peer.lastAckedTick = tick;
    const records = ps.history.get(tick);
    for (const part of parts) {
      const sent = records?.[part];
      if (!sent) continue;
      records[part] = null;
      for (const [id, state] of sent.states) {
        // Only for the stay it was sent in: the ghost may have left and come back since.
        const pg = ps.known.get(id);
        if (pg && tick >= pg.since && tick > pg.baselineTick) {
          pg.baseline = state;
          pg.baselineTick = tick;
          pg.baselineLayout = sent.layouts.get(id) ?? -1;
        }
      }
    }
  }

  /**
   * Write and send one connection's lifecycle message for `tick` (ADR 0402; the layout at the top of
   * this file), if it has anything: this tick's despawns and leaves, the pending relayouts and
   * structure changes of ghosts whose spawn went, and spawns not sent yet, in id order, while the
   * snapshot budget lasts (at least one). Returns its size in bytes (0: none sent).
   */
  private lifecycleMessage(peer: NetPeer, ps: PeerState, tick: number, despawns: number[], leaves: number[]): number {
    const relayouts: ServerGhost[] = [];
    const changes: ServerGhost[] = [];
    const spawns: ServerGhost[] = [];
    for (const [id, pg] of ps.known) {
      const g = this.byId.get(id);
      if (!g) continue;
      if (!pg.spawnSent) spawns.push(g);
      else {
        if (pg.layoutSent < g.layoutVersion) relayouts.push(g);
        if (pg.structureSent < g.structure.version) changes.push(g);
      }
    }
    if (despawns.length + leaves.length + relayouts.length + changes.length + spawns.length === 0) return 0;
    const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
    despawns.sort((a, b) => a - b);
    leaves.sort((a, b) => a - b);
    relayouts.sort(byId);
    changes.sort(byId);
    spawns.sort(byId);
    const w = new BitWriterImpl(256);
    // Reliable and in order: a string is the client's as soon as it's written (`StringTableOut`).
    const defined: number[] = [];
    const tableWrite = ps.table.writer(defined);
    const str: WriteString = (bw, value) => {
      tableWrite(bw, value);
      if (defined.length > 0) {
        ps.table.acked(defined);
        defined.length = 0;
      }
    };
    const record: Lifecycle = { states: [] };
    writeIds(w, despawns);
    writeIds(w, leaves);
    w.writeVarUint(relayouts.length);
    let previous = 0;
    for (const g of relayouts) {
      w.writeVarUint(g.id - previous);
      previous = g.id;
      w.writeVarUint(g.layoutVersion);
      writeSpec(w, g.layout.spec, str);
      g.layout.codec.write(w, g.state as unknown as Record<string, number>);
      ps.known.get(g.id)!.layoutSent = g.layoutVersion;
      record.states.push({ id: g.id, layout: g.layoutVersion, state: g.state, spawn: false });
    }
    w.writeVarUint(changes.length);
    previous = 0;
    for (const g of changes) {
      w.writeVarUint(g.id - previous);
      previous = g.id;
      writeStructure(w, g.structure, tick, str);
      ps.known.get(g.id)!.structureSent = g.structure.version;
    }
    // Spawns last, each after a 1 bit (a 0 bit ends them), so they stop where the budget does: the
    // budget less room for an empty snapshot part, guessing the next spawn is the size of the last.
    const budget = (this.maxSnapshotBytes - PART_HEADER_BITS / 8) * 8;
    previous = 0;
    let last = 0;
    for (const g of spawns) {
      if (previous !== 0 && w.length + last > budget) break;
      const start = w.length;
      const pg = ps.known.get(g.id)!;
      w.writeBits(1, 1);
      w.writeVarUint(g.id - previous);
      previous = g.id;
      writeSpawn(w, g.spawn, g.layout.spec, str);
      w.writeVarUint(g.layoutVersion);
      writeStructure(w, g.structure, tick, str);
      g.layout.codec.write(w, g.state as unknown as Record<string, number>);
      last = w.length - start;
      pg.spawnSent = true;
      pg.layoutSent = g.layoutVersion;
      pg.structureSent = g.structure.version;
      record.states.push({ id: g.id, layout: g.layoutVersion, state: g.state, spawn: true });
      ps.typeBits.set(g.type, (ps.typeBits.get(g.type) ?? 0) + last);
    }
    w.writeBits(0, 1);
    if (record.states.length > 0) ps.lifecycle.set(tick, record);
    const bytes = w.finish();
    this.session.send(GHOSTS, peer, "reliable", bytes, tick);
    return bytes.byteLength;
  }

  /**
   * Write one connection's snapshot for `tick` (see the top of this file): the states of the ghosts
   * whose spawn and current layout the client acked (ADR 0402), within `budgetBytes`, in one part, or
   * several when they don't fit one datagram (ADR 0334). Remembers what each part carried.
   */
  private snapshot(peer: NetPeer, ps: PeerState, tick: number, budgetBytes: number): Uint8Array[] {
    const ack = peer.lastAckedTick;
    const base = ack > 0 && tick - ack <= BASELINE_WINDOW ? ack : 0;
    const all: ServerGhost[] = [];
    for (const [id, pg] of ps.known) {
      const g = this.ghostById(id);
      if (g && pg.spawnAcked && pg.layoutAcked >= g.layoutVersion) all.push(g);
    }
    all.sort((a, b) => a.id - b.id); // ghosts back in relevance were added out of order
    // A part fits one datagram while the connection has a datagram path (ADR 0333); a tick holds
    // at most the budget in all. Without one, a tick is one part of up to the budget.
    const datagram = peer.datagramBodyBytes;
    const partBits = Math.min(budgetBytes, datagram ?? Infinity) * 8;
    const maxParts = datagram === undefined ? 1 : Math.min(MAX_SNAPSHOT_PARTS, Math.max(1, Math.floor((budgetBytes * 8) / partBits)));

    let parts: Written[] | null = null;
    if (!(ps.lastFullBits > partBits && ps.lastCosts.size > 0)) {
      // Write it whole: the common case, one part. Its sizes plan the parts if it doesn't fit.
      const full = this.write(ps, tick, base, 0, all);
      ps.lastFullBits = full.bits;
      ps.lastCosts = new Map(full.costs);
      if (full.bits <= partBits) parts = [full];
    }
    if (!parts) {
      // Over a part last time too: plan from last tick's sizes (a ghost not measured then is costed
      // as the largest one, to stay safe), instead of writing everything to measure.
      const fallback = ps.lastCosts.size > 0 ? Math.max(...ps.lastCosts.values()) : 0;
      const plan = this.pack(ps, tick, all, fallback, partBits, maxParts);
      parts = plan.plans.map((p, i) => this.writeWithin(ps, tick, base, i, p, partBits, plan.rank));
      const placedAll = plan.placed === all.length && parts.every((part, i) => part.ghosts.length === plan.plans[i].length);
      for (const part of parts) for (const [id, bits] of part.costs) ps.lastCosts.set(id, bits);
      // Everything went: what it took is what a whole write would (about), so once it fits a part
      // again the next tick writes it whole, in one part.
      if (placedAll) ps.lastFullBits = parts.reduce((n, part) => n + part.bits, 0) - (parts.length - 1) * PART_HEADER_BITS;
    }
    for (const part of parts) {
      for (const id of part.sent.states.keys()) {
        ps.known.get(id)!.lastSentTick = tick;
        const g = this.byId.get(id);
        if (g) ps.typeBits.set(g.type, (ps.typeBits.get(g.type) ?? 0) + (part.costs.get(id) ?? 0));
      }
    }
    ps.history.set(tick, parts.map((part) => part.sent));
    for (const t of ps.history.keys()) if (t < tick - BASELINE_WINDOW) ps.history.delete(t);
    return parts.map((part) => part.bytes);
  }

  /**
   * Fill parts first-fit in priority order (ADR 0334): the ghosts unsent longest, times their
   * importance. Sizes come from `ps.lastCosts` (`fallback` for a ghost not in it).
   */
  private pack(ps: PeerState, tick: number, all: readonly ServerGhost[], fallback: number, partBits: number, maxParts: number) {
    const cap = partBits * 0.95;
    interface Bin {
      readonly ghosts: ServerGhost[];
      used: number;
    }
    const bins: Bin[] = [];
    const open = (): Bin | null => {
      if (bins.length >= maxParts) return null;
      const bin: Bin = { ghosts: [], used: PART_HEADER_BITS };
      bins.push(bin);
      return bin;
    };
    // First fit among the last few parts only: earlier ones are about full, and scanning them all
    // for every ghost is quadratic in the part count.
    const fit = (cost: number): Bin | null => {
      for (let i = Math.max(0, bins.length - FIT_LOOKBACK); i < bins.length; i++) if (bins[i].used + cost <= cap) return bins[i];
      const bin = open();
      return bin && bin.used + cost <= cap ? bin : null;
    };
    // Sort keys worked out once: staleness times importance.
    const keyed = all.map((g) => ({ g, score: (tick - ps.known.get(g.id)!.lastSentTick) * Math.max(0, g.rep.importance) }));
    keyed.sort((a, b) => b.score - a.score || a.g.id - b.g.id);
    const ranked = keyed.map((k) => k.g);
    const rank = new Map(ranked.map((g, i) => [g.id, i]));
    let placed = 0;
    for (const g of ranked) {
      const cost = (ps.lastCosts.get(g.id) ?? fallback) + ID_SLACK_BITS;
      let bin = fit(cost);
      // Always at least one ghost, even one bigger than a part (that message goes over the socket,
      // ADR 0333; if it arrives after the next tick's datagrams it's stale and dropped, ADR 0402).
      if (!bin && placed === 0) bin = bins.find((b) => b.used === PART_HEADER_BITS) ?? open() ?? bins[0];
      if (!bin) continue;
      bin.ghosts.push(g);
      bin.used += cost;
      placed++;
    }
    const plans: ServerGhost[][] = bins.filter((b) => b.ghosts.length > 0).map((b) => b.ghosts.sort((x, y) => x.id - y.id));
    if (plans.length === 0) plans.push([]); // a tick always sends one
    return { plans, rank, placed };
  }

  /**
   * Write part `part` with `ghosts`; one that comes out over `partBits` (the plan's sizes were off)
   * sheds its lowest-priority ghosts (`rank`) and is written again. A single ghost is kept, however big.
   */
  private writeWithin(ps: PeerState, tick: number, base: number, part: number, ghosts: readonly ServerGhost[], partBits: number, rank: ReadonlyMap<number, number>): Written {
    let written = this.write(ps, tick, base, part, ghosts);
    for (let tries = 0; written.bits > partBits && ghosts.length > 1 && tries < 3; tries++) {
      let excess = written.bits - partBits * 0.95;
      const keep = new Set(ghosts);
      for (const g of [...ghosts].sort((a, b) => rank.get(b.id)! - rank.get(a.id)!)) {
        if (excess <= 0 || keep.size <= 1) break;
        keep.delete(g);
        excess -= written.costs.get(g.id) ?? 0;
      }
      ghosts = ghosts.filter((g) => keep.has(g));
      written = this.write(ps, tick, base, part, ghosts);
    }
    return written;
  }

  private ghostById(id: number): ServerGhost | undefined {
    return this.byId.get(id);
  }

  /** Write one snapshot part (the layout at the top of this file): `ghosts`' states. Each ghost's bits are in `costs`. */
  private write(ps: PeerState, tick: number, base: number, part: number, ghosts: readonly ServerGhost[]): Written {
    const w = new BitWriterImpl(256);
    const sent: Sent = { states: new Map(), layouts: new Map() };
    const costs = new Map<number, number>();
    w.writeVarUint(part);
    w.writeVarUint(base ? tick - base : 0);
    w.writeVarUint(ghosts.length);
    let previous = 0;
    for (const g of ghosts) {
      const start = w.length;
      const pg = ps.known.get(g.id)!;
      w.writeVarUint(g.id - previous);
      previous = g.id;
      const baseline = pg.baseline && tick - pg.baselineTick <= BASELINE_WINDOW && pg.baselineLayout === g.layoutVersion ? pg.baseline : null;
      const values = g.state as unknown as Record<string, number>;
      if (baseline) {
        if (pg.baselineTick === base) {
          w.writeBits(1, 1);
        } else {
          w.writeBits(0, 1);
          w.writeBits(1, 1);
          w.writeVarUint(tick - pg.baselineTick);
        }
        const stateChanged = !sameState(g.layout, g.state, baseline);
        w.writeBool(stateChanged);
        if (stateChanged) g.layout.codec.write(w, values, baseline as unknown as Record<string, number>);
      } else {
        w.writeBits(0, 2);
        g.layout.codec.write(w, values);
      }
      costs.set(g.id, w.length - start);
      sent.states.set(g.id, g.state);
      sent.layouts.set(g.id, g.layoutVersion);
    }
    return { bytes: w.finish(), bits: w.length, costs, sent, ghosts };
  }
}

/** One written part: its bytes and bits, each ghost's bits, and what it carried. */
interface Written {
  readonly bytes: Uint8Array;
  readonly bits: number;
  readonly costs: Map<number, number>;
  readonly sent: Sent;
  readonly ghosts: readonly ServerGhost[];
}

/** What a part's header can take besides its states: the part index, the baseline gap and the count. */
const PART_HEADER_BITS = 12 * 8;
/** How many of the newest parts a planned item may go in. */
const FIT_LOOKBACK = 4;
/** Slack per ghost in a plan: its id gap in a part can be a byte longer than in the whole snapshot. */
const ID_SLACK_BITS = 8;

/** A relevant ghost stays relevant until it's this much beyond its `relevantDistance` (ADR 0121). */
export const LEAVE_HYSTERESIS = 1.1;

interface InterestFrame {
  /** Each ghost's nearest ghost above it, or null. */
  readonly above: Map<ServerGhost, ServerGhost | null>;
  /** World positions of distance-limited ghosts and owned root ghosts (viewpoints). */
  readonly positions: Map<ServerGhost, Float64Array>;
}

function worldPositionOf(world: World, node: GameObject): Float64Array {
  const m = world.worldMatrix(node.entity), o = node.entity * 16;
  return Float64Array.of(m[o + 12], m[o + 13], m[o + 14]);
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The layout's behaviors (components with replicated fields) that are disabled on `node` (ADR 0121). */
function disabledOf(node: GameObject, layout: Layout): ComponentRef[] {
  const out: ComponentRef[] = [];
  for (const b of layout.spec.behaviors) {
    const type = getComponentClass(b.id);
    const c = type ? (node.getBehaviors(type as abstract new () => Component)[b.index] as Component | undefined) : undefined;
    if (c && !c.enabled) out.push({ id: b.id, index: b.index });
  }
  return out;
}

function writeIds(w: BitWriterImpl, ids: readonly number[]): void {
  w.writeVarUint(ids.length);
  let previous = 0;
  for (const id of ids) {
    w.writeVarUint(id - previous);
    previous = id;
  }
}

/**
 * How clients find `node` (see the top of this file), or why they can't. `ghostOf` gives the
 * ghost id of a node's `Replicated` component (0: none).
 */
function spawnOf(world: World, node: GameObject, ghostOf: (node: GameObject) => number): SpawnInfo | string {
  // The nearest runtime prefab instance root, this node or an ancestor.
  const ids: string[] = [];
  for (let n: GameObject | null = node; n && n !== world.root; n = n.parent) {
    const path = _instantiatedPrefabOf(n);
    if (path !== undefined) {
      if (n === node) return { kind: SPAWN_PREFAB, path }; // its parent goes in its structure

      const owner = ghostOf(n);
      if (!owner) return `it's inside an instance of "${path}" whose root isn't replicated (give the root a Replicated component too).`;
      if (ids.includes("")) return `a node between it and its prefab instance's root has no id.`;
      return { kind: SPAWN_NESTED, owner, ids: ids.reverse() };
    }
    if (n.parent === world.root && n.isSceneNode) {
      const source = n.getBehavior(SceneInstance)?.source;
      if (!source) return "its scene node doesn't say which file it came from.";
      if (ids.length === 0) return "it's a scene node itself; put Replicated on a node inside the scene.";
      if (ids.includes("")) return "it, or a node above it in the scene, has no scene id (was it made at runtime?).";
      const occurrence = world.sceneNodes.filter((s) => s.getBehavior(SceneInstance)?.source === source).indexOf(n);
      return { kind: SPAWN_SCENE, source, occurrence: Math.max(0, occurrence), ids: ids.reverse() };
    }
    ids.push(world.ids[n.entity]);
  }
  return "it isn't from a prefab instantiated with GameObject.instantiate or from a scene, so clients can't make or find it.";
}

/**
 * Where clients find `parent` (ADR 0100), or null if they can't: the World root, a ghost's node
 * or a node with ids below one (a weapon under a player's "Hand"), or a scene-placed node (a
 * "Projectiles" container), so local transforms mean the same there.
 */
function parentRefOf(world: World, parent: GameObject | null, ghostOf: (node: GameObject) => number): ParentRef | null {
  if (!parent || parent === world.root) return { kind: PARENT_ROOT };
  const ids: string[] = [];
  for (let n: GameObject | null = parent; n && n !== world.root; n = n.parent) {
    const id = ghostOf(n);
    if (id) {
      if (!ids.includes("")) return { kind: PARENT_GHOST, id, ids: ids.reverse() };
      break;
    }
    ids.push(world.ids[n.entity]);
  }
  const path = scenePathOf(world, parent);
  return path ? { kind: PARENT_NODE, ...path } : null;
}

/** Where a node sits in a loaded scene (its scene's source and occurrence, and node ids below it), or null if it isn't in one. */
function scenePathOf(world: World, node: GameObject): { source: string; occurrence: number; ids: string[] } | null {
  const ids: string[] = [];
  for (let n: GameObject | null = node; n && n !== world.root; n = n.parent) {
    if (n.parent === world.root && n.isSceneNode) {
      const source = n.getBehavior(SceneInstance)?.source;
      if (!source || ids.includes("")) return null;
      const occurrence = world.sceneNodes.filter((s) => s.getBehavior(SceneInstance)?.source === source).indexOf(n);
      return { source, occurrence: Math.max(0, occurrence), ids: ids.reverse() };
    }
    ids.push(world.ids[n.entity]);
  }
  return null;
}

const servers = new WeakMap<World, ServerReplication>();

/** @internal A server World's replication, created on first use; null if the World isn't a network server. */
export function serverReplication(world: World): ServerReplication | null {
  const session = netSession(world);
  if (!session?.isServer) return null;
  let r = servers.get(world);
  if (!r || r.session !== session) servers.set(world, (r = new ServerReplication(world, session)));
  return r;
}

function applyReplicationOptions(r: ServerReplication, options: ReplicationOptions): void {
  if (options.sendRate !== undefined) r.sendRate = Math.max(1e-6, options.sendRate);
  if (options.maxSnapshotBytes !== undefined) r.maxSnapshotBytes = Math.max(64, options.maxSnapshotBytes);
}
