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
 * Owned `"predicted"` ghosts (`Replicated.isPredictedLocally`) aren't interpolated: their
 * predicted values (`predictedPlan` in `layout.ts`) are simulated ahead and corrected by
 * `prediction.ts` (T13), which reads their received states; their other values take the newest
 * state. A ghost's first state is applied whole when its node is found or made.
 *
 * When the connection to the server goes (or a new one replaces it), ghosts the client
 * instantiated are destroyed and scene ghosts become ordinary nodes again.
 *
 * ## Relevancy, relayouts, order and enabled state (ADR 0121)
 *
 * A ghost that leaves this connection's relevancy is forgotten: a prefab ghost's node is destroyed,
 * a scene or nested ghost's node is deactivated (kept, since it can't be made again, until it comes
 * back or despawns). A relayout replaces a ghost's layout: components it adds are added, ones it
 * drops are removed, and its states start again. A structure's `after` puts the node right after
 * the named sibling ghost; its `disabled` list sets the layout's behaviors' `enabled`.
 */
import type { Component } from "../../core/Component";
import { getDataComponentDef } from "../../core/data";
import { getComponentClass, getComponentId, getComponentOptions, type ComponentClass } from "../../core/registry";
import type { World } from "../../core/World";
import { _componentAllowedIn, type GameObject } from "../../scene/GameObject";
import { SceneInstance } from "../../scene/SceneLoader";
import type { BitReader } from "../codec";
import { Replicated } from "../Replicated";
import { replicationOf } from "../replication";
import { netSession, type NetPeer, type NetSession } from "../session";
import { applyState, behaviorFields, bind, interpolate, layoutOf, type Binding, type GhostState, type Layout, type LayoutSpec } from "./layout";
import { ClientStrings, GHOST_STRINGS } from "./strings";
import {
  ACK,
  AFTER_UNSPECIFIED,
  BASELINE_WINDOW,
  MAX_ACK_TICKS,
  GHOSTS,
  PARENT_GHOST,
  PARENT_NODE,
  PARENT_ROOT,
  SNAPSHOT,
  SPAWN_NESTED,
  SPAWN_PREFAB,
  SPAWN_SCENE,
  StringTableIn,
  readSpawn,
  readSpec,
  readStructure,
  sameParent,
  type ParentRef,
  type SpawnInfo,
  type Structure,
} from "./wire";

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
  /** Replaced by a relayout (ADR 0121). */
  layout: Layout;
  /** The server's version of `layout`. */
  layoutVersion: number;
  /** The tick of the lifecycle message that gave it `layout` (its spawn or last relayout): states from before it are stale (ADR 0405). */
  layoutTick: number;
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
  /** The newest structure received (ADR 0100): active flag and parent. */
  structure: Structure;
  /** The structure its node shows (applied when the interpolation tick reaches a change's tick). */
  applied: Structure | null;
}

/** @internal A client World's replication state. */
export class ClientReplication {
  readonly ghosts = new Map<number, ClientGhost>();
  /** The newest snapshot tick read. */
  newestTick = -1;
  /** The tick of the newest lifecycle message applied (ADR 0402); a snapshot part older than it is late, and may be stale for its ghosts (ADR 0405). */
  private lifecycleTick = -1;
  /**
   * The parts read of each recent snapshot tick (ADR 0334, 0405): the newest, and older ones whose
   * parts came late (a part too big for a datagram goes by the slower reliable path). Kept for
   * `BASELINE_WINDOW` ticks, the server's history.
   */
  private readonly partsRead = new Map<number, Set<number>>();
  /** Older ticks that got a part lately, newest last, with how many more acks repeat them (ADR 0405). */
  private readonly lateAcks = new Map<number, number>();
  private peer: NetPeer | null = null;
  private readonly despawned = new Set<number>();
  /** Scene and nested ghosts out of relevancy (ADR 0121): deactivated nodes, destroyed if they despawn. */
  private readonly dormant = new Map<number, GameObject>();
  /** Parents whose ghost children got a new order this frame (ADR 0121), with each ghost's `after`. */
  private readonly reorder = new Map<GameObject, Map<number, number>>();
  /** Each ghost's `after` as last shown. */
  private readonly afterShown = new Map<number, number>();
  private readonly scratch: number[] = [];
  private errorLogged = false;
  /** String behavior fields (ADR 0068). */
  private readonly strings = new ClientStrings();
  /** Strings in spawns and structures (ADR 0100). */
  private readonly table = new StringTableIn();

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
    // Lifecycle messages first (ADR 0402): reliable and in order, so every spawn comes before the
    // states of its ghost, which the server sends only once the client acked the spawn.
    for (const m of session.drain(GHOSTS)) {
      if (m.peer !== peer) continue;
      try {
        this.readLifecycle(m.tick, m.reader());
      } catch (err) {
        console.error(`[myco] World "${this.world.name}" can't read ghost spawns from its server (do both run the same game code?): ${(err as Error).message}`);
      }
      this.lifecycleTick = Math.max(this.lifecycleTick, m.tick);
      received = true;
    }
    for (const m of session.drain(SNAPSHOT)) {
      // Each part once (ADR 0334), a late one too (ADR 0405): a part older than the newest tick read
      // (it came by the slower reliable path, being too big for a datagram) is read while the server
      // still keeps that tick's record, its states filed in tick order. Whether it's stale is decided
      // ghost by ghost (`read`); a stale part is dropped whole and not acked.
      if (m.peer !== peer || m.tick < this.newestTick - BASELINE_WINDOW) continue;
      try {
        const r = m.reader();
        const part = r.readVarUint();
        if (this.partsRead.get(m.tick)?.has(part)) continue;
        if (!this.read(m.tick, r)) continue;
        const late = m.tick < this.newestTick;
        if (m.tick > this.newestTick) this.newestTick = m.tick;
        let parts = this.partsRead.get(m.tick);
        if (!parts) this.partsRead.set(m.tick, (parts = new Set()));
        parts.add(part);
        if (late) {
          this.lateAcks.delete(m.tick);
          this.lateAcks.set(m.tick, LATE_ACK_REPEATS);
        }
        received = true;
      } catch (err) {
        if (!this.errorLogged) {
          this.errorLogged = true;
          console.error(`[myco] World "${this.world.name}" can't read a snapshot from its server (do both run the same game code?): ${(err as Error).message}`);
        }
      }
    }
    for (const m of session.drain(GHOST_STRINGS)) {
      if (m.peer !== peer) continue;
      try {
        this.strings.read(m.reader(), this.despawned);
      } catch (err) {
        console.error(`[myco] World "${this.world.name}" can't read replicated strings from its server: ${(err as Error).message}`);
      }
    }
    this.resolve();
    this.applyOrder();
    this.strings.apply(this.world, (id) => this.ghosts.get(id)?.node ?? null);
    for (const t of this.partsRead.keys()) if (t < this.newestTick - BASELINE_WINDOW) this.partsRead.delete(t);
    if (received && peer?.state === "open") {
      // The newest lifecycle tick applied, then the newest snapshot tick and every part of it read so
      // far, then older ticks that got a late part (ADR 0405), each repeated by the next few acks so a
      // lost ack is made good (a tick of 0: none yet).
      const lifecycle = Math.max(0, this.lifecycleTick);
      const ticks = this.newestTick > 0 ? [this.newestTick] : [];
      for (const [t, left] of [...this.lateAcks].reverse()) {
        if (ticks.length >= MAX_ACK_TICKS) break;
        if (this.partsRead.has(t) && t !== this.newestTick) ticks.push(t);
        if (left <= 1) this.lateAcks.delete(t);
        else this.lateAcks.set(t, left - 1);
      }
      session.send(ACK, "server", "unreliable", (w) => {
        w.writeVarUint(lifecycle);
        w.writeVarUint(ticks.length);
        ticks.forEach((t, i) => {
          // The newest tick, then each older one as the gap back from the one before.
          w.writeVarUint(i === 0 ? t : ticks[i - 1] - t);
          const parts = [...this.partsRead.get(t)!].sort((a, b) => a - b);
          w.writeVarUint(parts.length);
          parts.forEach((part, j) => w.writeVarUint(j === 0 ? part : part - parts[j - 1]));
        });
      });
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
      // A structure change (ADR 0100) shows when the interpolation tick reaches it; owned predicted ghosts are shown now.
      if (g.binding?.node.isValid && g.applied !== g.structure && (at >= g.structure.tick || g.binding.rep.isPredictedLocally)) this.applyStructure(g);
      const binding = g.binding;
      // Destroyed on this side (its scene unloaded, say): find or make it again.
      if (binding && !binding.node.isValid) g.node = g.binding = null;
      // Predicted values belong to prediction (T13, `prediction.ts`); the rest take the newest state.
      else if (binding?.rep.isPredictedLocally) applyState(g.layout, binding, states[states.length - 1].values, true);
      else if (binding) applyState(g.layout, binding, this.sample(g, at, maxAhead));
      // Every ghost, shown or not: one waiting for its scene, or a predicted one, still gets a state each snapshot.
      this.prune(g, at);
    }
    this.applyOrder();
  }

  /** A ghost's values at tick `at` (see the top of this file). */
  private sample(g: ClientGhost, at: number, maxAhead: number): ArrayLike<number> {
    let s = g.states;
    // A move not shown yet: states from its tick on are local to the new parent, so hold the last one before it.
    if (g.applied && g.applied !== g.structure && !sameParent(g.applied.parent, g.structure.parent)) {
      const before = s.filter((e) => e.tick < g.structure.tick);
      if (before.length > 0) s = before;
    }
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

  /**
   * Read one lifecycle message (ADR 0402; layout at the top of `server.ts`): despawns, leaves,
   * relayouts and structure changes, then spawns. A spawn's and a relayout's full state is the
   * ghost's first state in that layout, and the baseline the server delta-codes against once this
   * message is acked.
   */
  private readLifecycle(tick: number, r: BitReader): void {
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
      this.leave(id);
    }

    count = r.readVarUint();
    id = 0;
    for (let i = 0; i < count; i++) {
      id += r.readVarUint();
      const version = r.readVarUint();
      const spec = readSpec(r, this.table.read);
      const g = this.ghosts.get(id);
      if (g && version > g.layoutVersion) {
        this.relayout(g, spec, version);
        g.layoutTick = tick;
        g.states.push({ tick, values: toState(g.layout, g.layout.codec.read(r)) });
      } else {
        layoutOf(spec).codec.read(r); // a ghost this client doesn't have (it failed to spawn, say)
      }
    }

    count = r.readVarUint();
    id = 0;
    for (let i = 0; i < count; i++) {
      id += r.readVarUint();
      const structure = readStructure(r, tick, this.table.read);
      const g = this.ghosts.get(id);
      if (g) this.restructure(g, structure);
    }

    id = 0;
    while (r.readBits(1)) {
      id += r.readVarUint();
      const { spawn, spec } = readSpawn(r, this.table.read);
      const layoutVersion = r.readVarUint();
      const structure = readStructure(r, tick, this.table.read);
      const known = this.ghosts.get(id);
      const layout = known && layoutVersion <= known.layoutVersion ? known.layout : layoutOf(spec);
      const values = toState(layout, layout.codec.read(r));
      if (known) {
        // Spawned again without a leave between (not something the server does): take what's newer.
        if (layoutVersion > known.layoutVersion) {
          this.relayout(known, spec, layoutVersion);
          known.layoutTick = tick;
          known.states.push({ tick, values });
        }
        this.restructure(known, structure);
        continue;
      }
      if (this.despawned.has(id)) continue;
      this.ghosts.set(id, { id, layout, layoutVersion, layoutTick: tick, spawn, node: null, binding: null, states: [{ tick, values }], baselineTick: 0, instantiated: false, failed: null, structure, applied: null });
    }
  }

  /**
   * Read one snapshot part after its index (layout at the top of `server.ts`): ghost states. The
   * part is taken whole or not at all (ADR 0405), so everything an ack names is kept: it returns
   * false, keeping nothing, when the part is stale for one of its ghosts (gone, spawned or
   * relayouted again, or restructured, after the part's tick: it came late) or names a baseline
   * already dropped (a late part's). A part that can't be stale (not older than the newest
   * lifecycle message) and is still wrong throws.
   */
  private read(tick: number, r: BitReader): boolean {
    const late = tick < this.lifecycleTick || tick < this.newestTick;
    const ackGap = r.readVarUint();
    const snapshotBaseline = ackGap ? tick - ackGap : -1;
    const count = r.readVarUint();
    const read: { g: ClientGhost; values: GhostState; baselineTick: number }[] = [];
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += r.readVarUint();
      const g = this.ghosts.get(id);
      // The server sends a ghost's state only once this client acked its spawn (ADR 0402); a late part
      // may name one that has gone since, or come back in another layout or place.
      if (!g || tick < g.layoutTick || tick < g.structure.tick) {
        if (late) return false;
        if (!g) throw new Error(`state for ghost ${id}, which was never spawned`);
        return false; // a structure or layout newer than this part (it can't be decoded or shown after it)
      }
      let baselineTick = -1;
      if (r.readBits(1)) baselineTick = snapshotBaseline;
      else if (r.readBits(1)) baselineTick = tick - r.readVarUint();
      let values: GhostState;
      if (baselineTick >= 0) {
        const base = g.states.find((s) => s.tick === baselineTick)?.values;
        if (!base) {
          if (late) return false;
          throw new Error(`ghost ${id}'s baseline (tick ${baselineTick}) is gone`);
        }
        const changed = r.readBits(1) === 1;
        values = changed ? toState(g.layout, g.layout.codec.read(r, base as unknown as Record<string, number>)) : base;
      } else {
        values = toState(g.layout, g.layout.codec.read(r));
      }
      read.push({ g, values, baselineTick });
    }
    for (const { g, values, baselineTick } of read) {
      if (baselineTick >= 0) g.baselineTick = Math.max(g.baselineTick, baselineTick);
      fileState(g.states, tick, values);
    }
    return true;
  }

  /** Take a received structure if it's newer than the ghost's. */
  private restructure(g: ClientGhost, structure: Structure): void {
    if (structure.version > g.structure.version) g.structure = structure;
  }

  /**
   * Show a ghost's newest structure (ADR 0100): its active flag, and its parent if that changed
   * and can be found (else it waits, keeping the old parent). States from before a move are dropped,
   * so it isn't interpolated across parents.
   */
  private applyStructure(g: ClientGhost): void {
    const node = g.binding!.node;
    const s = g.structure;
    if (!g.applied || !sameParent(g.applied.parent, s.parent)) {
      if (s.parent) {
        const parent = this.findParent(s.parent);
        if (parent === undefined) return; // not there yet
        if (parent !== node.parent) this.world._setParent(node.entity, parent.entity, !g.layout.spec.transform);
      }
      if (g.applied) {
        const from = g.states.findIndex((e) => e.tick >= s.tick);
        if (from > 0) g.states.splice(0, from);
      }
    }
    if (node.active !== s.active) node.setActive(s.active);
    this.applyOrderAndEnabled(g, node, s);
    g.applied = s;
  }

  /**
   * ADR 0121: put the node right after the sibling ghost `s.after` names (or before the first
   * sibling ghost for 0), and set its layout's behaviors' `enabled` from `s.disabled`.
   */
  private applyOrderAndEnabled(g: ClientGhost, node: GameObject, s: Structure): void {
    const parent = node.parent;
    if (s.after !== AFTER_UNSPECIFIED && parent) this.reorder.set(parent, (this.reorder.get(parent) ?? new Map()).set(g.id, s.after));
    const disabled = new Set(s.disabled.map((d) => `${d.id}#${d.index}`));
    for (const b of g.layout.spec.behaviors) {
      const type = getComponentClass(b.id);
      const c = type ? (node.getBehaviors(type as abstract new () => Component)[b.index] as Component | undefined) : undefined;
      const enabled = !disabled.has(`${b.id}#${b.index}`);
      if (c && c.enabled !== enabled) c.enabled = enabled;
    }
  }

  /**
   * Put the ghost children of each parent whose order changed in the order their `after`s say
   * (ADR 0121), in the places ghost children already take, so non-ghost siblings stay put. Done
   * once all of a frame's structures are applied, so the result doesn't depend on which ghost's
   * change was applied first.
   */
  private applyOrder(): void {
    if (this.reorder.size === 0) return;
    const world = this.world;
    for (const [parent, changes] of this.reorder) {
      for (const [id, after] of changes) this.afterShown.set(id, after);
      if (!parent.isValid) continue;
      const children = parent.children;
      const slots: number[] = [];
      const kids: { node: GameObject; id: number; after: number }[] = [];
      children.forEach((c, i) => {
        const rep = c.getBehavior(Replicated);
        if (!rep?._isGhost || this.ghosts.get(rep._ghostId)?.node !== c) return;
        slots.push(i);
        // Unspecified: stays after the ghost child before it now.
        const after = this.afterShown.get(rep._ghostId) ?? AFTER_UNSPECIFIED;
        kids.push({ node: c, id: rep._ghostId, after: after === AFTER_UNSPECIFIED ? (kids.at(-1)?.id ?? 0) : after });
      });
      const present = new Set(kids.map((k) => k.id));
      const followers = new Map<number, typeof kids>();
      for (const k of kids) {
        const key = present.has(k.after) ? k.after : 0;
        followers.set(key, [...(followers.get(key) ?? []), k]);
      }
      const ordered: GameObject[] = [];
      const seen = new Set<number>();
      const visit = (id: number) => {
        for (const k of followers.get(id) ?? []) {
          if (seen.has(k.id)) continue;
          seen.add(k.id);
          ordered.push(k.node);
          visit(k.id);
        }
      };
      visit(0);
      for (const k of kids) if (!seen.has(k.id)) ordered.push(k.node); // a cycle: keep the rest as they are
      ordered.forEach((node, i) => {
        if (parent.children.indexOf(node) !== slots[i]) world._setSiblingIndex(node.entity, slots[i]);
      });
    }
    this.reorder.clear();
  }

  /**
   * A ghost's layout changed (ADR 0121): add the components the new one has and the node lacks,
   * remove the ones only the old one had, rebind, and start its states again (no interpolation
   * across it; prediction starts afresh with the new binding).
   */
  private relayout(g: ClientGhost, spec: LayoutSpec, version: number): void {
    const old = g.layout.spec;
    g.layout = layoutOf(spec);
    g.layoutVersion = version;
    g.states.length = 0;
    g.baselineTick = 0;
    const binding = g.binding;
    if (!binding?.node.isValid) return;
    matchComponents(binding.node, spec, old);
    g.binding = bind(g.layout, binding.node, binding.rep);
    // Enabled flags refer to the layout's behaviors: apply them to the new ones.
    if (g.applied) this.applyOrderAndEnabled(g, binding.node, { ...g.applied, after: AFTER_UNSPECIFIED });
  }

  /**
   * A ghost isn't relevant to this connection any more (ADR 0121): destroy the node of a prefab
   * ghost, deactivate a scene or nested one's (it can't be made again), and forget its states.
   * Its strings are kept: the server resends them all when it comes back.
   */
  private leave(id: number): void {
    this.afterShown.delete(id);
    const g = this.ghosts.get(id);
    if (!g) return;
    this.ghosts.delete(id);
    const node = g.node;
    if (!node?.isValid) return;
    if (g.instantiated) this.world._destroyNode(node.entity);
    else {
      node.setActive(false);
      this.dormant.set(id, node);
    }
  }

  /** The node a parent ref names, or undefined if it isn't there (yet). */
  private findParent(ref: ParentRef): GameObject | undefined {
    const world = this.world;
    if (ref.kind === PARENT_ROOT) return world.root;
    if (ref.kind === PARENT_GHOST) {
      const owner = this.ghosts.get(ref.id)?.node;
      return (owner?.isValid && descend(world, owner, ref.ids)) || undefined;
    }
    if (ref.kind === PARENT_NODE) {
      const scene = world.sceneNodes.filter((s) => s.getBehavior(SceneInstance)?.source === ref.source)[ref.occurrence];
      return (scene && descend(world, scene, ref.ids)) || undefined;
    }
    return world.activeScene ?? world.root;
  }

  private despawn(id: number): void {
    this.afterShown.delete(id);
    const g = this.ghosts.get(id);
    if (g) {
      if (g.node?.isValid) this.world._destroyNode(g.node.entity);
      this.ghosts.delete(id);
    }
    const dormant = this.dormant.get(id);
    if (dormant) {
      this.dormant.delete(id);
      if (dormant.isValid) this.world._destroyNode(dormant.entity);
    }
    this.strings.forget(id);
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
      // Under the parent its newest structure names: a ghost or scene node not there yet, wait.
      const ref = g.structure.parent;
      const parent = ref ? this.findParent(ref) : undefined;
      if (ref && ref.kind !== 0 && !parent) return false;
      try {
        node = world._instantiatePrefab(spawn.path, { parent });
      } catch (err) {
        g.failed = (err as Error).message;
        console.error(`[myco] World "${world.name}" can't spawn ghost ${g.id} from "${spawn.path}": ${g.failed}`);
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
      console.error(`[myco] World "${world.name}": ghost ${g.id} ${g.failed}.`);
      return false;
    }
    rep._ghostId = g.id;
    rep._isGhost = true;
    this.dormant.delete(g.id);
    g.node = node;
    // Components added or removed on the server before this client saw the ghost (ADR 0121).
    matchComponents(node, g.layout.spec, null);
    g.binding = bind(g.layout, node, rep);
    const newest = g.states[g.states.length - 1];
    if (newest) applyState(g.layout, g.binding, newest.values);
    // Its newest structure at once (a scene or nested ghost moved before this client found it, say).
    const s = g.structure;
    let placedUnder = true;
    if (s.parent) {
      const parent = this.findParent(s.parent);
      if (parent && parent !== node.parent) world._setParent(node.entity, parent.entity, !g.layout.spec.transform);
      placedUnder = !!parent;
    }
    if (node.active !== s.active) node.setActive(s.active);
    this.applyOrderAndEnabled(g, node, s);
    // A parent not there yet: `interpolate` keeps trying.
    g.applied = placedUnder ? s : { ...s, parent: null };
    this.strings.placed(g.id);
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
    for (const node of this.dormant.values()) {
      const rep = node.isValid ? node.getBehavior(Replicated) : null;
      if (rep) {
        rep._isGhost = false;
        rep._ghostId = 0;
      }
    }
    this.dormant.clear();
    this.reorder.clear();
    this.afterShown.clear();
    this.ghosts.clear();
    this.despawned.clear();
    this.strings.clear();
    this.table.clear();
    this.newestTick = -1;
    this.lifecycleTick = -1;
    this.partsRead.clear();
    this.lateAcks.clear();
    this.errorLogged = false;
  }
}

/**
 * Make a ghost node's replicated components match `spec` (ADR 0121): behaviors with replicated
 * fields and replicated data components it lacks are added; ones it has beyond the spec are
 * removed (behaviors from the last of their class). With `old` (a relayout), only components the
 * old spec had are removed; without it (a ghost first placed), only components registered for
 * every World, so a component the server's World never had isn't taken off.
 */
function matchComponents(node: GameObject, spec: LayoutSpec, old: LayoutSpec | null): void {
  const world = node.world;
  const count = (s: LayoutSpec | null, id: string) => (s ? s.behaviors.filter((b) => b.id === id).length : 0);
  const ids = new Set(spec.behaviors.map((b) => b.id));
  for (const b of old?.behaviors ?? []) ids.add(b.id);
  if (!old) {
    for (const c of world._componentsOf(node.entity)) {
      const type = c.constructor as ComponentClass;
      const id = getComponentId(type);
      if (id && !(c instanceof Replicated) && behaviorFields(type).length > 0 && getComponentOptions(type).worlds === undefined) ids.add(id);
    }
  }
  for (const id of ids) {
    const type = getComponentClass(id) as (ComponentClass & (new () => Component)) | undefined;
    if (!type || type === (Replicated as unknown) || !_componentAllowedIn(world, type)) continue;
    const want = count(spec, id);
    const list = () => node.getBehaviors(type as abstract new () => Component) as Component[];
    for (let tries = want - list().length; tries > 0 && list().length < want; tries--) node.addBehavior(type);
    // Removal happens at the end of the frame, so count from one snapshot of the list.
    const have = list().filter((c) => !c._destroyed);
    const extra = Math.min(old ? count(old, id) - want : Infinity, have.length - want);
    for (let i = 0; i < extra; i++) node.removeBehavior(have[have.length - 1 - i]);
  }
  const wanted = new Set(spec.data.map((d) => d.id));
  const candidates = old ? old.data.map((d) => d.id) : world._dataComponentsOf(node.entity).filter((def) => replicationOf(def)).map((def) => def.id);
  for (const id of candidates) {
    if (wanted.has(id)) continue;
    const def = getDataComponentDef(id);
    if (def && node.getData(def)) node.removeData(def);
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

/** How many acks repeat an older tick that got a late part (ADR 0405), so one lost ack doesn't lose it. */
const LATE_ACK_REPEATS = 4;

/** File a state in a ghost's states, kept oldest first (ADR 0405: a late part's goes before newer ones); a tick already there is kept. */
function fileState(states: ReceivedState[], tick: number, values: GhostState): void {
  let i = states.length;
  while (i > 0 && states[i - 1].tick > tick) i--;
  if (i > 0 && states[i - 1].tick === tick) return;
  states.splice(i, 0, { tick, values });
}
