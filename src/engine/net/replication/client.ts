/**
 * The client half of replication (ADR 0033 §3 and §6, T11): reading snapshots, spawning and
 * matching ghosts, and interpolating them. The wire format and spawn rules are at the top of
 * `server.ts`.
 *
 * ## Interpolation
 *
 * Each ghost keeps the states it received, by server tick. Every frame the client shows it at
 * `time.network.interpolationTick + interpolationFraction`, which trails the newest snapshot by
 * the interpolation buffer: between the two states around that tick, numbers are lerped,
 * rotations slerped the short way, and integers, booleans, `owner` and `mode` snapped (to the
 * older state's value). When data is late (that tick is past the newest state), it extrapolates
 * from the last two states for up to `MAX_EXTRAPOLATION_MS`, then holds. A newly spawned or
 * matched ghost shows its first state at once.
 *
 * Owned `"predicted"` ghosts (`Replicated.isPredictedLocally`) show the newest state directly
 * for now; T13 replaces that with prediction and rollback.
 *
 * When the connection to the server goes (or a new one replaces it), ghosts the client
 * instantiated are destroyed and scene ghosts become ordinary nodes again.
 */
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { SceneInstance } from "../../scene/SceneLoader";
import type { BitReader } from "../codec";
import { Replicated } from "../Replicated";
import { netSession, type NetPeer, type NetSession } from "../session";
import { applyState, bind, interpolate, layoutOf, type Binding, type GhostState, type Layout } from "./layout";
import { ACK, BASELINE_WINDOW, SNAPSHOT, SPAWN_NESTED, SPAWN_PREFAB, SPAWN_SCENE, readSpawn, type SpawnInfo } from "./wire";

/** How far past the newest state a late ghost is extrapolated before it holds. */
export const MAX_EXTRAPOLATION_MS = 250;

/** Despawned ghost ids remembered, so a repeated spawn doesn't bring one back. */
const MAX_REMEMBERED_DESPAWNS = 4096;

interface ReceivedState {
  readonly tick: number;
  readonly values: GhostState;
}

/** @internal A ghost as a client sees it. */
export interface ClientGhost {
  readonly id: number;
  readonly layout: Layout;
  readonly spawn: SpawnInfo;
  /** Its node once found or made; null while waiting (a scene not loaded yet, a parent ghost not there yet). */
  node: GameObject | null;
  binding: Binding | null;
  /** Received states, oldest first. */
  readonly states: ReceivedState[];
  /** The newest baseline tick the server used for it: states from it on are kept. */
  baselineTick: number;
  /** This client instantiated its node (a prefab ghost), so it destroys it when the ghost goes. */
  instantiated: boolean;
  /** Why it can't be made (logged once); it isn't retried. */
  failed: string | null;
}

/** @internal A client World's replication state. */
export class ClientReplication {
  readonly ghosts = new Map<number, ClientGhost>();
  /** The newest snapshot tick read. */
  newestTick = -1;
  private peer: NetPeer | null = null;
  private readonly despawned = new Set<number>();
  private readonly scratch: number[] = [];
  private errorLogged = false;

  constructor(
    readonly world: World,
    readonly session: NetSession,
  ) {}

  /** `engine.ReplicationReceive`: read this frame's snapshots, find or make ghosts' nodes, ack. */
  receive(): void {
    const session = this.session;
    const peer = session.serverPeer;
    if (peer !== this.peer) {
      this.reset();
      this.peer = peer;
    }
    let received = false;
    for (const m of session.drain(SNAPSHOT)) {
      if (m.peer !== peer || m.tick <= this.newestTick) continue;
      try {
        this.read(m.tick, m.reader());
        this.newestTick = m.tick;
        received = true;
      } catch (err) {
        if (!this.errorLogged) {
          this.errorLogged = true;
          console.error(`[tranquility] World "${this.world.name}" can't read a snapshot from its server (do both run the same game code?): ${(err as Error).message}`);
        }
      }
    }
    this.resolve();
    if (received && peer?.state === "open") {
      const tick = this.newestTick;
      session.send(ACK, "server", "unreliable", (w) => w.writeVarUint(tick));
    }
  }

  /** `engine.ReplicationInterpolate`: show every ghost at the interpolation tick. */
  interpolate(): void {
    const net = this.world.time.network;
    if (!net) return;
    const at = net.interpolationTick + net.interpolationFraction;
    const maxAhead = (MAX_EXTRAPOLATION_MS / 1000) * this.session.tickRate;
    for (const g of this.ghosts.values()) {
      const states = g.states;
      if (states.length === 0) continue;
      const binding = g.binding;
      // Destroyed on this side (its scene unloaded, say): find or make it again.
      if (binding && !binding.node.isValid) g.node = g.binding = null;
      else if (binding?.rep.isPredictedLocally) applyState(g.layout, binding, states[states.length - 1].values); // T13 predicts these
      else if (binding) applyState(g.layout, binding, this.sample(g, at, maxAhead));
      // Every ghost, shown or not: one waiting for its scene, or a predicted one, still gets a state each snapshot.
      this.prune(g, at);
    }
  }

  /** A ghost's values at tick `at` (see the top of this file). */
  private sample(g: ClientGhost, at: number, maxAhead: number): ArrayLike<number> {
    const s = g.states;
    const n = s.length;
    if (n === 1 || at <= s[0].tick) return s[0].values;
    let i = n - 1;
    while (i > 0 && s[i].tick > at) i--;
    if (i < n - 1) {
      const a = s[i], b = s[i + 1];
      return interpolate(g.layout, a.values, b.values, (at - a.tick) / (b.tick - a.tick), this.scratch);
    }
    const a = s[n - 2], b = s[n - 1];
    const ahead = Math.min(at - b.tick, maxAhead);
    return interpolate(g.layout, a.values, b.values, 1 + ahead / (b.tick - a.tick), this.scratch);
  }

  /** Drop states nothing needs: older than both the state before `at` and the server's newest baseline. */
  private prune(g: ClientGhost, at: number): void {
    const s = g.states;
    let i = s.length - 1;
    while (i > 0 && s[i].tick > at) i--;
    let keepFrom = Math.max(0, i - 1);
    const b = s.findIndex((e) => e.tick >= g.baselineTick);
    if (b >= 0) keepFrom = Math.min(keepFrom, b);
    const oldest = this.newestTick - 2 * BASELINE_WINDOW;
    while (keepFrom < s.length - 1 && s[keepFrom].tick < oldest) keepFrom++;
    if (keepFrom > 0) s.splice(0, keepFrom);
  }

  /** Read one snapshot (layout at the top of `server.ts`). */
  private read(tick: number, r: BitReader): void {
    const ackGap = r.readVarUint();
    const snapshotBaseline = ackGap ? tick - ackGap : -1;

    let count = r.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += r.readVarUint();
      this.despawn(id);
    }

    count = r.readVarUint();
    id = 0;
    for (let i = 0; i < count; i++) {
      id += r.readVarUint();
      const { spawn, spec } = readSpawn(r);
      if (this.ghosts.has(id) || this.despawned.has(id)) continue; // a repeat
      this.ghosts.set(id, { id, layout: layoutOf(spec), spawn, node: null, binding: null, states: [], baselineTick: 0, instantiated: false, failed: null });
    }

    count = r.readVarUint();
    id = 0;
    for (let i = 0; i < count; i++) {
      id += r.readVarUint();
      const g = this.ghosts.get(id);
      if (!g) throw new Error(`state for ghost ${id}, which was never spawned`);
      let baselineTick = -1;
      if (r.readBits(1)) baselineTick = snapshotBaseline;
      else if (r.readBits(1)) baselineTick = tick - r.readVarUint();
      let values: GhostState;
      if (baselineTick >= 0) {
        const base = g.states.find((s) => s.tick === baselineTick)?.values;
        if (!base) throw new Error(`ghost ${id}'s baseline (tick ${baselineTick}) is gone`);
        const changed = r.readBits(1) === 1;
        values = changed ? toState(g.layout, g.layout.codec.read(r, base as unknown as Record<string, number>)) : base;
        g.baselineTick = Math.max(g.baselineTick, baselineTick);
      } else {
        values = toState(g.layout, g.layout.codec.read(r));
      }
      const last = g.states[g.states.length - 1];
      if (!last || last.tick < tick) g.states.push({ tick, values });
    }
  }

  private despawn(id: number): void {
    const g = this.ghosts.get(id);
    if (g) {
      if (g.node?.isValid) this.world._destroyNode(g.node.entity);
      this.ghosts.delete(id);
    }
    this.despawned.add(id);
    if (this.despawned.size > MAX_REMEMBERED_DESPAWNS) this.despawned.delete(this.despawned.values().next().value!);
  }

  /** Find or make the nodes of ghosts that don't have one yet; a parent or root ghost first. */
  private resolve(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const g of this.ghosts.values()) {
        if (g.binding && !g.binding.node.isValid) g.node = g.binding = null;
        if (!g.node && !g.failed && this.place(g)) progress = true;
      }
    }
  }

  private place(g: ClientGhost): boolean {
    const world = this.world;
    const spawn = g.spawn;
    let node: GameObject | null = null;
    if (spawn.kind === SPAWN_PREFAB) {
      let parent: GameObject | undefined;
      if (spawn.parentNode) {
        const p = spawn.parentNode;
        const scene = world.sceneNodes.filter((s) => s.getBehavior(SceneInstance)?.source === p.source)[p.occurrence];
        const found = scene ? descend(world, scene, p.ids) : null;
        if (!found) return false; // its scene isn't loaded yet
        parent = found;
      } else if (spawn.parent === 1) parent = world.root;
      else if (spawn.parent >= 2) {
        const owner = this.ghosts.get(spawn.parent - 2)?.node;
        if (!owner) return false;
        parent = owner;
      }
      try {
        node = world._instantiatePrefab(spawn.path, { parent });
      } catch (err) {
        g.failed = (err as Error).message;
        console.error(`[tranquility] World "${world.name}" can't spawn ghost ${g.id} from "${spawn.path}": ${g.failed}`);
        return false;
      }
      g.instantiated = true;
    } else if (spawn.kind === SPAWN_SCENE) {
      const scene = world.sceneNodes.filter((s) => s.getBehavior(SceneInstance)?.source === spawn.source)[spawn.occurrence];
      if (!scene) return false;
      node = descend(world, scene, spawn.ids);
    } else if (spawn.kind === SPAWN_NESTED) {
      const owner = this.ghosts.get(spawn.owner)?.node;
      if (!owner) return false;
      node = descend(world, owner, spawn.ids);
    }
    if (!node) return false;

    const rep = node.getBehavior(Replicated) ?? node.addBehavior(Replicated);
    if (rep._isGhost && rep._ghostId !== g.id && this.ghosts.get(rep._ghostId)?.node === node) {
      g.failed = `its node ${node} is already ghost ${rep._ghostId}`;
      console.error(`[tranquility] World "${world.name}": ghost ${g.id} ${g.failed}.`);
      return false;
    }
    rep._ghostId = g.id;
    rep._isGhost = true;
    g.node = node;
    g.binding = bind(g.layout, node, rep);
    const newest = g.states[g.states.length - 1];
    if (newest) applyState(g.layout, g.binding, newest.values);
    return true;
  }

  /** The connection changed or closed: forget every ghost. */
  private reset(): void {
    for (const g of this.ghosts.values()) {
      if (!g.node?.isValid) continue;
      if (g.instantiated) this.world._destroyNode(g.node.entity);
      else if (g.binding) {
        g.binding.rep._isGhost = false;
        g.binding.rep._ghostId = 0;
      }
    }
    this.ghosts.clear();
    this.despawned.clear();
    this.newestTick = -1;
    this.errorLogged = false;
  }
}

/** The node at an id path below `from`, or null. */
function descend(world: World, from: GameObject, ids: readonly string[]): GameObject | null {
  let node: GameObject | null = from;
  for (const id of ids) {
    node = node.children.find((c) => world.ids[c.entity] === id) ?? null;
    if (!node) return null;
  }
  return node;
}

function toState(layout: Layout, record: Record<string, number>): GhostState {
  const out = new Array<number>(layout.size);
  for (let i = 0; i < layout.size; i++) out[i] = record[i];
  return out;
}

const clients = new WeakMap<World, ClientReplication>();

/** @internal A client World's replication, created on first use; null if the World isn't a network client. */
export function clientReplication(world: World): ClientReplication | null {
  const session = netSession(world);
  if (!session?.isClient) return null;
  let r = clients.get(world);
  if (!r || r.session !== session) clients.set(world, (r = new ClientReplication(world, session)));
  return r;
}
