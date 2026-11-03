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
 *   spawns on clients by prefab path, under the client's active scene, its World root, or the
 *   node of the ghost that is its parent on the server.
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
 * A ghost's layout (what's sent, `layout.ts`) is fixed when it's first seen: components added
 * later aren't sent. When its node or `Replicated` component is destroyed, it despawns.
 *
 * ## Snapshots (unreliable, `net.snapshot`, tagged with the server tick)
 *
 * Once per tick that advanced since the last one (or at `sendRate`), each open connection gets
 * one snapshot:
 *
 * ```
 * varuint  baseline: server tick − the connection's newest acked tick (0: none, or too old)
 * varuint  despawn count, then ghost ids (ascending, each as the gap from the previous)
 * varuint  spawn count,   then per spawn: id gap, the spawn and layout spec (wire.ts)
 * varuint  state count,   then per ghost: id gap,
 *            1 bit   uses the snapshot's baseline; if not, 1 bit has a baseline, and if it
 *                    does, varuint server tick − its baseline tick
 *            with a baseline: 1 bit changed, and if so the codec's delta against it
 *            without one: the codec's full record
 * ```
 *
 * Despawns and spawns repeat in every snapshot until the connection acks one that carried them.
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
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { SceneInstance, _instantiatedPrefabOf } from "../../scene/SceneLoader";
import { BitWriterImpl } from "../bits";
import { Replicated } from "../Replicated";
import { netSession, type NetPeer, type NetSession } from "../session";
import { layoutOf, readState, sameState, specOf, type GhostState, type Layout } from "./layout";
import { ACK, BASELINE_WINDOW, DEFAULT_MAX_SNAPSHOT_BYTES, SNAPSHOT, SPAWN_NESTED, SPAWN_PREFAB, SPAWN_SCENE, writeSpawn, type SpawnInfo } from "./wire";

interface ServerGhost {
  readonly id: number;
  readonly rep: Replicated;
  readonly node: GameObject;
  readonly layout: Layout;
  readonly spawn: SpawnInfo;
  /** This tick's values (read once per sent tick, shared by every connection). */
  state: GhostState;
}

/** What one connection has been told about one ghost. */
interface PeerGhost {
  spawnAcked: boolean;
  /** The state in the newest acked snapshot that included this ghost, and that snapshot's tick. */
  baseline: GhostState | null;
  baselineTick: number;
  /** The last tick it was included in (for priority). */
  lastSentTick: number;
}

/** What one snapshot carried, kept until acked or too old. */
interface Sent {
  readonly spawns: number[];
  readonly despawns: number[];
  readonly states: Map<number, GhostState>;
}

interface PeerState {
  /** Ghosts this connection has been sent, by id, in id order. */
  readonly known: Map<number, PeerGhost>;
  /** Despawns not yet acked. */
  readonly despawns: Set<number>;
  readonly history: Map<number, Sent>;
  /** Bytes of the last snapshot sent (for tests and tools). */
  lastBytes: number;
  /** Bits each ghost took in the last snapshot written for this connection, to choose before writing when it's over budget. */
  lastCosts: Map<number, number>;
  /** Bits of the last snapshot written in full (before choosing), or 0. */
  lastFullBits: number;
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

  constructor(
    readonly world: World,
    readonly session: NetSession,
  ) {
    this.sendRate = session.tickRate;
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

    const despawned = this.updateGhosts();
    for (const g of this.ghosts.values()) g.state = readState(g.layout, g.node, g.rep);
    for (const peer of session.openPeers()) {
      let ps = this.peers.get(peer);
      if (!ps) this.peers.set(peer, (ps = { known: new Map(), despawns: new Set(), history: new Map(), lastBytes: 0, lastCosts: new Map(), lastFullBits: 0 }));
      for (const id of despawned) {
        if (ps.known.delete(id)) ps.despawns.add(id);
      }
      for (const g of this.ghosts.values()) {
        if (!ps.known.has(g.id)) ps.known.set(g.id, { spawnAcked: false, baseline: null, baselineTick: 0, lastSentTick: -1 });
      }
      const bytes = this.snapshot(peer, ps, tick);
      ps.lastBytes = bytes.byteLength;
      session.send(SNAPSHOT, peer, "unreliable", bytes, tick);
    }
  }

  /** Find new ghosts and gone ones. Returns the ids that despawned. */
  private updateGhosts(): number[] {
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
    if (fresh.length === 0) return despawned;
    // Ids first, so spawns can name their parent or root ghost whatever order they were found in.
    const ids = new Map<Replicated, number>();
    for (const rep of fresh) ids.set(rep, this.nextId++);
    const ghostOf = (node: GameObject): number => {
      const rep = node.getBehavior(Replicated);
      if (!rep) return 0;
      return this.ghosts.get(rep)?.id ?? ids.get(rep) ?? 0;
    };
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
      const ghost: ServerGhost = { id, rep, node, layout, spawn, state: [] };
      this.ghosts.set(rep, ghost);
      this.byId.set(id, ghost);
    }
    return despawned;
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
      for (const [id, state] of sent.states) {
        const pg = ps.known.get(id);
        if (pg && tick > pg.baselineTick) {
          pg.baseline = state;
          pg.baselineTick = tick;
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
    for (const id of attempt.sent.states.keys()) ps.known.get(id)!.lastSentTick = tick;
    ps.history.set(tick, attempt.sent);
    for (const t of ps.history.keys()) if (t < tick - BASELINE_WINDOW) ps.history.delete(t);
    return attempt.bytes;
  }

  private ghostById(id: number): ServerGhost | undefined {
    return this.byId.get(id);
  }

  private write(ps: PeerState, tick: number, base: number, ghosts: readonly ServerGhost[]) {
    const w = new BitWriterImpl(256);
    const sent: Sent = { spawns: [], despawns: [...ps.despawns].sort((a, b) => a - b), states: new Map() };
    const costs = new Map<number, number>();
    w.writeVarUint(base ? tick - base : 0);
    writeIds(w, sent.despawns);
    const spawning = ghosts.filter((g) => !ps.known.get(g.id)!.spawnAcked);
    w.writeVarUint(spawning.length);
    let previous = 0;
    for (const g of spawning) {
      const start = w.length;
      w.writeVarUint(g.id - previous);
      previous = g.id;
      writeSpawn(w, g.spawn, g.layout.spec);
      costs.set(g.id, w.length - start);
      sent.spawns.push(g.id);
    }
    w.writeVarUint(ghosts.length);
    const headerBits = w.length - [...costs.values()].reduce((n, c) => n + c, 0);
    previous = 0;
    for (const g of ghosts) {
      const start = w.length;
      const pg = ps.known.get(g.id)!;
      w.writeVarUint(g.id - previous);
      previous = g.id;
      const baseline = pg.baseline && tick - pg.baselineTick <= BASELINE_WINDOW ? pg.baseline : null;
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
    }
    return { bytes: w.finish(), bits: w.length, headerBits, costs, sent };
  }
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
      if (n === node) {
        const parent = node.parent;
        const parentGhost = parent ? ghostOf(parent) : 0;
        const code = parent === world.root ? 1 : parentGhost ? parentGhost + 2 : 0;
        // A plain scene node as parent (a "Projectiles" container): clients find it by its scene
        // path, so local transforms mean the same there.
        const parentNode = code === 0 && parent ? scenePathOf(world, parent) : null;
        return parentNode ? { kind: SPAWN_PREFAB, path, parent: code, parentNode } : { kind: SPAWN_PREFAB, path, parent: code };
      }
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

/** @internal Change a server World's replication settings (tests, tools). */
export function configureReplication(world: World, options: ReplicationOptions): void {
  const r = serverReplication(world);
  if (!r) throw new Error(`World "${world.name}" isn't a network server.`);
  if (options.sendRate !== undefined) r.sendRate = Math.max(1e-6, options.sendRate);
  if (options.maxSnapshotBytes !== undefined) r.maxSnapshotBytes = Math.max(64, options.maxSnapshotBytes);
}
