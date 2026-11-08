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
 * above it pass. A ghost that stops being relevant goes in the leaves section until acked (clients
 * destroy prefab ghosts and deactivate scene and nested ones); one that becomes relevant again is
 * spawned afresh.
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
 * current parent); later changes go in a structure section, repeated until a snapshot carrying
 * them is acked. Clients show a change when their interpolation tick reaches its tick (owned
 * predicted ghosts at once) and don't interpolate across a move.
 *
 * ## The string table (ADR 0100)
 *
 * Strings in spawns and structures (prefab paths, scene files, node ids, component ids) go through
 * a per-connection table (`StringTableOut` in `wire.ts`): inline with an index until the client
 * acks a snapshot that carried it, then the index alone (a byte or two).
 *
 * ## Snapshots (unreliable, `net.snapshot`, tagged with the server tick)
 *
 * Once per tick that advanced since the last one (or at `sendRate`), each open connection gets
 * one snapshot:
 *
 * ```
 * varuint  baseline: server tick − the connection's newest acked tick (0: none, or too old)
 * varuint  despawn count, then ghost ids (ascending, each as the gap from the previous)
 * varuint  leave count,   then ghost ids (ADR 0121: no longer relevant to this connection)
 * varuint  spawn count,   then per spawn: id gap, the spawn and layout spec, layout version, its structure (wire.ts)
 * varuint  relayout count, then per ghost: id gap, layout version, layout spec (ADR 0121)
 * varuint  structure change count, then per ghost: id gap, its structure
 * varuint  state count,   then per ghost: id gap,
 *            1 bit   uses the snapshot's baseline; if not, 1 bit has a baseline, and if it
 *                    does, varuint server tick − its baseline tick
 *            with a baseline: 1 bit changed, and if so the codec's delta against it
 *            without one: the codec's full record
 * ```
 *
 * Despawns, leaves, spawns and relayouts repeat in every snapshot until the connection acks one
 * that carried them. A baseline is only used while it has the ghost's current layout.
 * A ghost's baseline is the state sent in the newest snapshot the connection acked that included
 * it: both ends keep what was sent per tick (the server for `BASELINE_WINDOW` ticks), so an
 * unchanged ghost costs its id gap and two bits, about a byte. A snapshot over the budget
 * (`maxSnapshotBytes`, 64 KiB) carries the unacked spawns first, then the ghosts longest unsent
 * (times their `importance`); the rest go next tick.
 *
 * ## Acks (unreliable, `net.snapshotAck`)
 *
 * A client that received snapshots in a frame sends the newest one's tick at the end of it. The
 * server sets the connection's `lastAckedTick` (which shows on its `Connection` node), makes that
 * snapshot's states the baselines and stops repeating its spawns and despawns.
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
import { _interestOf, _pruneInterest, _setRelevanceQuery } from "../interest";
import { layoutOf, readState, sameState, specOf, type GhostState, type Layout } from "./layout";
import { ServerStrings } from "./strings";
import {
  ACK,
  AFTER_UNSPECIFIED,
  BASELINE_WINDOW,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  PARENT_GHOST,
  PARENT_NODE,
  PARENT_ROOT,
  PARENT_SCENE,
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
  spawnAcked: boolean;
  /** The state in the newest acked snapshot that included this ghost, and that snapshot's tick. */
  baseline: GhostState | null;
  baselineTick: number;
  /** The last tick it was included in (for priority). */
  lastSentTick: number;
  /** The newest structure version the connection acked (ADR 0100); -1: none. */
  structureAcked: number;
  /** The layout version of `baseline` (ADR 0121): a baseline in an older layout isn't used. */
  baselineLayout: number;
  /** The newest layout version the connection acked (in a spawn or relayout); -1: none. */
  layoutAcked: number;
}

/** What one snapshot carried, kept until acked or too old. */
interface Sent {
  readonly spawns: number[];
  readonly despawns: number[];
  /** Ghosts no longer relevant (ADR 0121). */
  readonly leaves: number[];
  readonly states: Map<number, GhostState>;
  /** The layout version of each state. */
  readonly layouts: Map<number, number>;
  /** Layouts carried (in spawns or relayouts): ghost id and layout version. */
  readonly relayouts: [number, number][];
  /** Structures carried (in spawns or changes): ghost id and version. */
  readonly structures: [number, number][];
  /** String table indexes it defined. */
  readonly strings: number[];
}

interface PeerState {
  /** Ghosts this connection has been sent, by id, in id order. */
  readonly known: Map<number, PeerGhost>;
  /** Despawns not yet acked. */
  readonly despawns: Set<number>;
  /** Leaves (ADR 0121) not yet acked. */
  readonly leaves: Set<number>;
  /** Scene and nested ghosts that left: clients keep them deactivated, so a despawn is still sent. */
  readonly dormant: Set<number>;
  readonly history: Map<number, Sent>;
  /** Bytes of the last snapshot sent (for tests and tools). */
  lastBytes: number;
  /** Bits each ghost took in the last snapshot written for this connection, to choose before writing when it's over budget. */
  lastCosts: Map<number, number>;
  /** Bits of the last snapshot written in full (before choosing), or 0. */
  lastFullBits: number;
  /**
   * Bits sent on this connection per ghost type (`ServerGhost.type`) since it opened: each ghost's
   * spawn and state in the snapshots actually sent (tools: bandwidth per ghost type).
   */
  readonly typeBits: Map<string, number>;
  /** Strings in spawns and structures, by index once the client has them (ADR 0100). */
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
    const engine = world._engine as { _worldConfig?(name: string): { replication?: ReplicationOptions } | null } | null;
    const settings = engine?._worldConfig?.(world.name)?.replication;
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
        this.acked(m.peer, m.reader().readVarUint());
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
    const interest = this.interestFrame(peers);
    for (const peer of peers) {
      let ps = this.peers.get(peer);
      if (!ps) this.peers.set(peer, (ps = { known: new Map(), despawns: new Set(), leaves: new Set(), dormant: new Set(), history: new Map(), lastBytes: 0, lastCosts: new Map(), lastFullBits: 0, typeBits: new Map(), table: new StringTableOut() }));
      for (const id of despawned) {
        if (ps.known.delete(id) || ps.dormant.delete(id)) ps.despawns.add(id);
        ps.leaves.delete(id);
      }
      const relevant = interest ? this.relevantTo(peer, ps, interest) : null;
      if (relevant) {
        for (const id of [...ps.known.keys()]) {
          if (relevant.has(id)) continue;
          ps.known.delete(id);
          ps.leaves.add(id);
          if (this.byId.get(id)?.spawn.kind !== SPAWN_PREFAB) ps.dormant.add(id);
        }
      }
      for (const g of this.ghosts.values()) {
        if (ps.known.has(g.id) || (relevant && !relevant.has(g.id))) continue;
        ps.known.set(g.id, { spawnAcked: false, baseline: null, baselineTick: 0, lastSentTick: -1, structureAcked: -1, baselineLayout: -1, layoutAcked: -1 });
        // Back before its leave was acked: cancel it (a client that read it spawns it again from this spawn).
        ps.leaves.delete(g.id);
        ps.dormant.delete(g.id);
      }
      const bytes = this.snapshot(peer, ps, tick);
      ps.lastBytes = bytes.byteLength;
      session.send(SNAPSHOT, peer, "unreliable", bytes, tick);
    }
    this.strings.send(session, this.ghosts.values(), despawned, (peer, id) => this.peers.get(peer)?.known.has(id) ?? false);
  }

  /** @internal Whether ghost `node` is in the connection `id`'s snapshots (`Interest.isRelevant`). */
  isRelevantTo(id: number, node: GameObject): boolean {
    const rep = node.isValid ? node.getBehavior(Replicated) : null;
    const g = rep ? this.ghosts.get(rep) : undefined;
    const peer = this.session.openPeers().find((p) => p.id === id);
    const ps = peer && this.peers.get(peer);
    return !!g && !!ps && ps.known.has(g.id);
  }

  /**
   * What relevancy needs this sent tick (ADR 0121): each ghost's nearest ghost above it, and the
   * world positions of distance-limited ghosts and owned root ghosts (viewpoints). Null when no
   * ghost has a distance or a group (everything is relevant to everyone).
   */
  private interestFrame(peers: readonly NetPeer[]): InterestFrame | null {
    _pruneInterest(this.world, new Set(peers.map((p) => p.id)));
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
    const interest = _interestOf(this.world, peer.id);
    const viewpoints: Float64Array[] = [];
    const viewer = interest?.viewer;
    if (viewer?.isValid && viewer.world === this.world) viewpoints.push(worldPositionOf(this.world, viewer));
    else {
      for (const [g, parent] of frame.above) {
        if (!parent && g.rep.ownerId !== 0 && g.rep.ownerId === peer.id) viewpoints.push(frame.positions.get(g)!);
      }
    }
    const passes = (g: ServerGhost): boolean => {
      const rep = g.rep;
      if (rep.ownerId !== 0 && rep.ownerId === peer.id) return true;
      if (rep.group && !interest?.groups.has(rep.group)) return false;
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

  private acked(peer: NetPeer, tick: number): void {
    if (!(tick > peer.lastAckedTick && tick <= this.session.tick)) return;
    const ps = this.peers.get(peer);
    if (!ps) return;
    peer.lastAckedTick = tick;
    const sent = ps.history.get(tick);
    if (sent) {
      for (const id of sent.spawns) {
        const pg = ps.known.get(id);
        if (pg) pg.spawnAcked = true;
      }
      for (const id of sent.despawns) ps.despawns.delete(id);
      for (const id of sent.leaves) ps.leaves.delete(id);
      for (const [id, version] of sent.relayouts) {
        const pg = ps.known.get(id);
        if (pg && version > pg.layoutAcked) pg.layoutAcked = version;
      }
      for (const [id, version] of sent.structures) {
        const pg = ps.known.get(id);
        if (pg && version > pg.structureAcked) pg.structureAcked = version;
      }
      ps.table.acked(sent.strings);
      for (const [id, state] of sent.states) {
        const pg = ps.known.get(id);
        if (pg && tick > pg.baselineTick) {
          pg.baseline = state;
          pg.baselineTick = tick;
          pg.baselineLayout = sent.layouts.get(id) ?? -1;
        }
      }
    }
    for (const t of ps.history.keys()) if (t <= tick) ps.history.delete(t);
  }

  /** Write one connection's snapshot for `tick` (see the top of this file) and remember what it carried. */
  private snapshot(peer: NetPeer, ps: PeerState, tick: number): Uint8Array {
    const ack = peer.lastAckedTick;
    const base = ack > 0 && tick - ack <= BASELINE_WINDOW ? ack : 0;
    const all: ServerGhost[] = [];
    for (const id of ps.known.keys()) {
      const g = this.ghostById(id);
      if (g) all.push(g);
    }
    all.sort((a, b) => a.id - b.id); // ghosts back in relevance were added out of order
    const budget = this.maxSnapshotBytes * 8;
    // Too big: unacked spawns first (oldest first), then the ghosts longest unsent, by importance.
    const choose = (costs: Map<number, number>, headerBits: number, fallbackCost: number) => {
      const ranked = [...all].sort((a, b) => {
        const pa = ps.known.get(a.id)!, pb = ps.known.get(b.id)!;
        if (pa.spawnAcked !== pb.spawnAcked) return pa.spawnAcked ? 1 : -1;
        if (!pa.spawnAcked) return a.id - b.id;
        return (tick - pb.lastSentTick) * Math.max(0, b.rep.importance) - (tick - pa.lastSentTick) * Math.max(0, a.rep.importance);
      });
      let used = headerBits;
      const chosen: ServerGhost[] = [];
      for (const g of ranked) {
        const cost = costs.get(g.id) ?? fallbackCost;
        if (used + cost > budget * 0.95 && chosen.length > 0) continue;
        chosen.push(g);
        used += cost;
      }
      return chosen.sort((a, b) => a.id - b.id);
    };
    let attempt;
    if (ps.lastFullBits > budget && ps.lastCosts.size > 0) {
      // Over budget last time too: choose from last tick's sizes and write once (a ghost not sent
      // then is costed as the largest one, to stay safe), instead of writing everything to measure.
      const largest = Math.max(...ps.lastCosts.values());
      attempt = this.write(ps, tick, base, choose(ps.lastCosts, 0, largest));
      if (attempt.bits > budget) attempt = this.write(ps, tick, base, choose(attempt.costs, attempt.headerBits, largest));
      for (const [id, bits] of attempt.costs) ps.lastCosts.set(id, bits);
    } else {
      attempt = this.write(ps, tick, base, all);
      ps.lastFullBits = attempt.bits;
      ps.lastCosts = attempt.costs;
      if (attempt.bits > budget) attempt = this.write(ps, tick, base, choose(attempt.costs, attempt.headerBits, 0));
    }
    for (const id of attempt.sent.states.keys()) {
      ps.known.get(id)!.lastSentTick = tick;
      const g = this.byId.get(id);
      if (g) ps.typeBits.set(g.type, (ps.typeBits.get(g.type) ?? 0) + (attempt.costs.get(id) ?? 0));
    }
    ps.history.set(tick, attempt.sent);
    for (const t of ps.history.keys()) if (t < tick - BASELINE_WINDOW) ps.history.delete(t);
    return attempt.bytes;
  }

  private ghostById(id: number): ServerGhost | undefined {
    return this.byId.get(id);
  }

  private write(ps: PeerState, tick: number, base: number, ghosts: readonly ServerGhost[]) {
    const w = new BitWriterImpl(256);
    const sent: Sent = {
      spawns: [], despawns: [...ps.despawns].sort((a, b) => a - b), leaves: [...ps.leaves].sort((a, b) => a - b),
      states: new Map(), layouts: new Map(), relayouts: [], structures: [], strings: [],
    };
    const str = ps.table.writer(sent.strings);
    const costs = new Map<number, number>();
    w.writeVarUint(base ? tick - base : 0);
    writeIds(w, sent.despawns);
    writeIds(w, sent.leaves);
    const spawning = ghosts.filter((g) => !ps.known.get(g.id)!.spawnAcked);
    w.writeVarUint(spawning.length);
    let previous = 0;
    for (const g of spawning) {
      const start = w.length;
      w.writeVarUint(g.id - previous);
      previous = g.id;
      writeSpawn(w, g.spawn, g.layout.spec, str);
      w.writeVarUint(g.layoutVersion);
      writeStructure(w, g.structure, tick, str);
      costs.set(g.id, w.length - start);
      sent.spawns.push(g.id);
      sent.relayouts.push([g.id, g.layoutVersion]);
      sent.structures.push([g.id, g.structure.version]);
    }
    // Layouts that changed (ADR 0121) of spawned ghosts, repeated until acked, before any state in them.
    const known = [...ps.known].sort((a, b) => a[0] - b[0]);
    const relayout: ServerGhost[] = [];
    for (const [id, pg] of known) {
      const g = this.byId.get(id);
      if (g && pg.spawnAcked && pg.layoutAcked < g.layoutVersion) relayout.push(g);
    }
    w.writeVarUint(relayout.length);
    previous = 0;
    for (const g of relayout) {
      w.writeVarUint(g.id - previous);
      previous = g.id;
      w.writeVarUint(g.layoutVersion);
      writeSpec(w, g.layout.spec, str);
      sent.relayouts.push([g.id, g.layoutVersion]);
    }
    // Structure changes (ADR 0100) of spawned ghosts, repeated until acked, whether or not their state fits.
    const changed: ServerGhost[] = [];
    for (const [id, pg] of known) {
      const g = this.byId.get(id);
      if (g && pg.spawnAcked && pg.structureAcked < g.structure.version) changed.push(g);
    }
    w.writeVarUint(changed.length);
    previous = 0;
    for (const g of changed) {
      w.writeVarUint(g.id - previous);
      previous = g.id;
      writeStructure(w, g.structure, tick, str);
      sent.structures.push([g.id, g.structure.version]);
    }
    w.writeVarUint(ghosts.length);
    const headerBits = w.length - [...costs.values()].reduce((n, c) => n + c, 0);
    previous = 0;
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
        const changed = !sameState(g.layout, g.state, baseline);
        w.writeBool(changed);
        if (changed) g.layout.codec.write(w, values, baseline as unknown as Record<string, number>);
      } else {
        w.writeBits(0, 2);
        g.layout.codec.write(w, values);
      }
      costs.set(g.id, (costs.get(g.id) ?? 0) + w.length - start);
      sent.states.set(g.id, g.state);
      sent.layouts.set(g.id, g.layoutVersion);
    }
    return { bytes: w.finish(), bits: w.length, headerBits, costs, sent };
  }
}

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

_setRelevanceQuery((world, id, node) => servers.get(world)?.isRelevantTo(id, node) ?? false);

/** @internal A server World's replication, created on first use; null if the World isn't a network server. */
export function serverReplication(world: World): ServerReplication | null {
  const session = netSession(world);
  if (!session?.isServer) return null;
  let r = servers.get(world);
  if (!r || r.session !== session) servers.set(world, (r = new ServerReplication(world, session)));
  return r;
}

/** @internal Change a server World's replication settings (tests, tools). */
export function configureReplication(world: World, options: ReplicationOptions): void {
  const r = serverReplication(world);
  if (!r) throw new Error(`World "${world.name}" isn't a network server.`);
  applyReplicationOptions(r, options);
}

function applyReplicationOptions(r: ServerReplication, options: ReplicationOptions): void {
  if (options.sendRate !== undefined) r.sendRate = Math.max(1e-6, options.sendRate);
  if (options.maxSnapshotBytes !== undefined) r.maxSnapshotBytes = Math.max(64, options.maxSnapshotBytes);
}
