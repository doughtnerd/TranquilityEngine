/**
 * Client prediction (ADR 0033 §6, T13): Unity's `PredictedSimulationSystemGroup`, in the data
 * layer only. The owning client simulates its `"predicted"` ghosts ahead of the server, so its
 * player answers input at once, and rolls them back and re-simulates them when a snapshot says
 * the prediction was wrong.
 *
 * ## What's predicted
 *
 * On a client, the ghosts with `Replicated.isPredictedLocally` (owned by this client, mode
 * `"predicted"`). Their predicted values (`predictedPlan` in `replication/layout.ts`): the
 * transform (if replicated), data-component fields listed in `replicate(def, { predicted })`, and
 * behavior fields declared `@field(Number | Boolean, { predicted: true })`. Replication leaves
 * those alone and gives the ghost's other values the newest received state.
 *
 * Systems defined with `predicted: true` (fixedUpdate only) move them. On a client they run on the
 * prediction timeline below, with the predicted ghosts as their only rows (`SystemDef.predicted`);
 * on the server, and in Worlds that aren't networked, they run like any other system, reading
 * each player's input with `Move.of(node)`. GameBehaviors aren't re-simulated: they run once per
 * fixed step as usual and see the reconciled values.
 *
 * ## The prediction timeline
 *
 * A client predicts tick `time.network.serverTick`, the tick its inputs are tagged with, so the
 * input written in a fixed step drives that step's prediction. `engine.PredictionTick` runs at the
 * start of each fixed step (after `engine.NetInputTick`, before the fixedUpdate scripts) and makes
 * every tick run exactly once:
 * - it records the predicted values the previous step's tick ended with (after that frame's
 *   update and lateUpdate too, as the server's snapshot of a tick is), per ghost and tick, for
 *   the last `HISTORY_TICKS` ticks;
 * - it reconciles with the newest snapshot (below);
 * - if serverTick skipped ticks since the last predicted one, it runs them first (catch-up), the
 *   newest `MAX_CATCH_UP_TICKS` at most; older ones are dropped and counted;
 * - then the step's pass runs the predicted systems for serverTick, unless that tick was already
 *   simulated (two fixed steps on one serverTick): then they skip this step.
 * Catch-up and re-simulated ticks replay each tick's input (`setInputReplayTick`): `Move.of(node)`
 * returns the input written for that tick, or the newest earlier one if it has none, as the
 * server would repeat it.
 *
 * ## Rollback and re-simulation
 *
 * When a ghost's newest received state is for a tick S it hasn't compared yet, the client compares
 * it with what it predicted for S (`predictionError`). Within tolerance (one quantization step for
 * quantized fields, 1e-5 relative for other floats, exact for integers) it just drops older
 * history. Otherwise it's a misprediction: the ghost is set to the server's state at S, every
 * other predicted ghost to its own prediction for S, and the predicted systems run again for
 * S+1 … the newest predicted tick, recording new predictions (one rollback). A ghost's first state
 * (it was just spawned, or just became predicted) syncs it the same way without counting as a
 * rollback. A ghost with no prediction for S sits the re-simulation out until its own state comes
 * up. If S is more than `MAX_ROLLBACK_TICKS` behind, or ahead of the prediction, the server's state
 * is taken as it is, without re-simulating.
 *
 * Restoring the server's state means taking its quantized values, so a corrected prediction can
 * differ from the server's by half a step; that's within the tolerance, so it doesn't cascade.
 *
 * ## Smoothing
 *
 * A correction doesn't pop: the rendered position (update, lateUpdate, rendering) blends from the
 * old prediction to the corrected one over `SMOOTHING_MS`, through an offset `engine.PredictionSmooth`
 * adds after replication's update pass and that's taken off again before the next fixed step, so
 * the simulation stays exact. Corrections longer than `SMOOTHING_MAX_DISTANCE` (a teleport) snap.
 * Position only; rotations and other values snap.
 *
 * ## Stats
 *
 * `predictionStats(world)` (internal, for the editor's network panel): mispredictions with the
 * last and largest error, rollbacks, re-simulated ticks, and the timeline's catch-ups and skips.
 */
import { World } from "../core/World";
import { _setPredictionDriver, defineBuiltinSystem, type PredictedRun } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { setInputReplayTick } from "./input";
import { clientReplication, type ClientGhost, type ClientReplication } from "./replication/client";
import { applyPredicted, pickPredicted, predictedPlan, predictionError, readPredicted, type Binding, type PredictedPlan } from "./replication/layout";
import { netSession, type NetPeer, type NetSession } from "./session";

/** Skipped ticks run at most this many at the start of a fixed step; older ones are dropped. */
export const MAX_CATCH_UP_TICKS = 8;
/** A correction this many ticks or more behind the prediction is taken as is, without re-simulating. */
export const MAX_ROLLBACK_TICKS = 100;
/** Predicted states kept per ghost, by tick, for comparing with snapshots. */
export const HISTORY_TICKS = 128;
/** How long a correction's rendered position takes to blend in. */
export const SMOOTHING_MS = 100;
/** Corrections moving a ghost further than this snap instead of blending (a teleport). */
export const SMOOTHING_MAX_DISTANCE = 2;

/** What a client World's prediction did (cumulative). */
export interface PredictionStats {
  /** Snapshot states that differed from the prediction beyond tolerance. */
  mispredictions: number;
  /** The last and largest such difference (the largest value's, in its units). */
  lastError: number;
  maxError: number;
  /** Re-simulations for corrections (not counting a ghost's first sync). */
  rollbacks: number;
  /** Ticks run again by re-simulations (syncs included). */
  resimulatedTicks: number;
  /** Ticks predicted for the first time (each step's own and catch-ups). */
  predictedTicks: number;
  /** Of those, ticks serverTick skipped that a later step ran first. */
  catchUpTicks: number;
  /** Ticks skipped beyond `MAX_CATCH_UP_TICKS`, never simulated. */
  droppedTicks: number;
  /** Fixed steps that didn't run predicted systems: their serverTick was already simulated. */
  skippedSteps: number;
}

const SKIP: PredictedRun = { run: false, includes: () => false };

interface Smoothing {
  /** The offset from the simulated position when the blend started. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly start: number;
}

/** A predicted ghost's prediction state. */
interface PredictedGhost {
  readonly ghost: ClientGhost;
  readonly binding: Binding;
  readonly plan: PredictedPlan;
  /** Predicted values by tick. */
  readonly history: Map<number, number[]>;
  /** The newest received tick compared or synced; -1: none yet. */
  reconciled: number;
  smoothing: Smoothing | null;
  /** While a smoothing offset is on the transform: the position written, and the simulated one. */
  shown: { readonly x: number; readonly y: number; readonly z: number; readonly sx: number; readonly sy: number; readonly sz: number } | null;
  /** For pruning ghosts that are gone. */
  seen: number;
}

interface Correction {
  readonly p: PredictedGhost;
  readonly tick: number;
  readonly values: number[];
  /** The ghost's first state (a sync, not a correction). */
  readonly first: boolean;
}

/** @internal A client World's prediction. */
export class ClientPrediction {
  readonly stats: PredictionStats = { mispredictions: 0, lastError: 0, maxError: 0, rollbacks: 0, resimulatedTicks: 0, predictedTicks: 0, catchUpTicks: 0, droppedTicks: 0, skippedSteps: 0 };
  /** How this fixed step's pass runs predicted systems. */
  pass: PredictedRun = SKIP;
  /** The newest tick predicted; -1: none yet. */
  lastSimulated = -1;
  /** The tick predicted systems are running for while prediction runs them itself (catch-up, re-simulation); null otherwise. */
  replaying: number | null = null;
  resimulating = false;
  private readonly ghosts = new Map<ClientGhost, PredictedGhost>();
  /** The predicted ghosts' nodes: predicted systems' rows. */
  private readonly nodes = new Set<GameObject>();
  private readonly includes = (node: GameObject) => this.nodes.has(node);
  private peer: NetPeer | null = null;
  /** The tick the last pass predicted, recorded at the start of the next step. */
  private recordTick = -1;
  private generation = 0;

  constructor(
    readonly world: World,
    readonly session: NetSession,
  ) {}

  /** `engine.PredictionTick`: record, reconcile, catch up, and set up this step's pass (see the top of this file). */
  tick(): void {
    const session = this.session;
    const peer = session.serverPeer;
    if (peer !== this.peer) {
      this.reset();
      this.peer = peer;
    }
    this.unsmooth();
    const replication = clientReplication(this.world);
    if (peer?.state !== "open" || !replication) {
      this.pass = SKIP;
      return;
    }
    const tick = session.time.serverTick;
    this.track(replication);
    if (this.recordTick >= 0) this.record(this.recordTick, this.nodes);
    this.recordTick = -1;
    this.reconcile();

    if (this.lastSimulated >= 0 && tick - 1 > this.lastSimulated) {
      const from = Math.max(this.lastSimulated + 1, tick - MAX_CATCH_UP_TICKS);
      this.stats.droppedTicks += from - this.lastSimulated - 1;
      for (let t = from; t < tick; t++) {
        this.simulate(t, this.nodes);
        this.record(t, this.nodes);
        this.stats.catchUpTicks++;
        this.stats.predictedTicks++;
      }
      this.lastSimulated = tick - 1;
    }
    if (tick > this.lastSimulated) {
      this.lastSimulated = this.recordTick = tick;
      this.stats.predictedTicks++;
      this.pass = { run: true, includes: this.includes };
    } else {
      this.stats.skippedSteps++;
      this.pass = SKIP;
    }
  }

  /** `engine.PredictionSmooth`: put this frame's smoothing offsets on corrected ghosts' transforms. */
  smooth(): void {
    this.unsmooth();
    const now = this.world.time.time;
    for (const p of this.ghosts.values()) {
      const s = p.smoothing;
      if (!s) continue;
      const k = 1 - (now - s.start) / (SMOOTHING_MS / 1000);
      if (k <= 0 || !p.binding.node.isValid) {
        p.smoothing = null;
        continue;
      }
      const world = this.world;
      const i = p.binding.node.entity * 3;
      const pos = world.tPos;
      const sx = pos[i], sy = pos[i + 1], sz = pos[i + 2];
      pos[i] = sx + s.x * k;
      pos[i + 1] = sy + s.y * k;
      pos[i + 2] = sz + s.z * k;
      p.shown = { x: pos[i], y: pos[i + 1], z: pos[i + 2], sx, sy, sz };
      world.markTransformDirty(p.binding.node.entity);
    }
  }

  /** Take smoothing offsets off again, unless game code has moved the node since. */
  private unsmooth(): void {
    for (const p of this.ghosts.values()) {
      const shown = p.shown;
      if (!shown) continue;
      p.shown = null;
      const node = p.binding.node;
      if (!node.isValid) continue;
      const pos = this.world.tPos;
      const i = node.entity * 3;
      if (pos[i] !== shown.x || pos[i + 1] !== shown.y || pos[i + 2] !== shown.z) continue;
      pos[i] = shown.sx;
      pos[i + 1] = shown.sy;
      pos[i + 2] = shown.sz;
      this.world.markTransformDirty(node.entity);
    }
  }

  /** Follow the ghosts this client predicts now. */
  private track(replication: ClientReplication): void {
    const generation = ++this.generation;
    this.nodes.clear();
    for (const g of replication.ghosts.values()) {
      const binding = g.binding;
      if (!binding || !binding.node.isValid || !binding.rep.isPredictedLocally) continue;
      let p = this.ghosts.get(g);
      if (!p || p.binding !== binding) {
        p = { ghost: g, binding, plan: predictedPlan(g.layout), history: new Map(), reconciled: -1, smoothing: null, shown: null, seen: 0 };
        this.ghosts.set(g, p);
      }
      p.seen = generation;
      this.nodes.add(binding.node);
    }
    for (const [g, p] of this.ghosts) if (p.seen !== generation) this.ghosts.delete(g);
  }

  /** Store the predicted values of the ghosts in `nodes` under `tick`. */
  private record(tick: number, nodes: ReadonlySet<GameObject>): void {
    for (const p of this.ghosts.values()) {
      if (!nodes.has(p.binding.node)) continue;
      p.history.set(tick, readPredicted(p.plan, p.binding));
      for (const t of p.history.keys()) {
        if (t > tick - HISTORY_TICKS) break; // in insertion order, oldest first
        p.history.delete(t);
      }
    }
  }

  /** Run the predicted systems for `tick`, on the ghosts in `nodes`, with that tick's input. */
  private simulate(tick: number, nodes: ReadonlySet<GameObject>): void {
    const world = this.world;
    this.replaying = tick;
    setInputReplayTick(world, tick);
    try {
      world.scheduler.runPredicted(world.time.fixedDeltaTime, (node) => nodes.has(node));
    } finally {
      setInputReplayTick(world, null);
      this.replaying = null;
    }
  }

  /** Compare new snapshot states with the predictions for their ticks; roll back and re-simulate on a difference. */
  private reconcile(): void {
    const corrections: Correction[] = [];
    let counted = false;
    for (const p of this.ghosts.values()) {
      const states = p.ghost.states;
      const newest = states[states.length - 1];
      if (!newest || newest.tick <= p.reconciled) continue;
      const tick = newest.tick;
      const first = p.reconciled < 0;
      p.reconciled = tick;
      const authoritative = pickPredicted(p.plan, newest.values);
      const predicted = p.history.get(tick);
      if (predicted) {
        const error = predictionError(p.plan, predicted, authoritative);
        if (error === 0) continue;
        this.stats.mispredictions++;
        this.stats.lastError = error;
        this.stats.maxError = Math.max(this.stats.maxError, error);
        counted = true;
      } else if (!first) {
        counted = true; // its prediction for that tick is gone (it sat a re-simulation out, or the history's too short)
      }
      corrections.push({ p, tick, values: authoritative, first });
    }

    if (corrections.length > 0) {
      if (counted) this.stats.rollbacks++;
      const before = new Map<PredictedGhost, number[]>();
      for (const c of corrections) if (c.p.plan.transformAt >= 0 && !c.first) before.set(c.p, this.position(c.p));
      const from = Math.min(...corrections.map((c) => c.tick));
      if (from > this.lastSimulated || this.lastSimulated - from >= MAX_ROLLBACK_TICKS) {
        // Ahead of the prediction (the timeline is just starting), or too far behind: take the server's state.
        for (const c of corrections) {
          applyPredicted(c.p.plan, c.p.binding, c.values);
          c.p.history.set(c.tick, c.values);
        }
        this.lastSimulated = Math.max(this.lastSimulated, ...corrections.map((c) => c.tick));
      } else {
        this.resimulate(from, corrections);
      }
      for (const c of corrections) {
        const old = before.get(c.p);
        if (old) this.startSmoothing(c.p, old);
      }
    }
    for (const p of this.ghosts.values()) {
      for (const t of p.history.keys()) if (t < p.reconciled) p.history.delete(t);
    }
  }

  /** Restore every predicted ghost at `from` and run the predicted systems again up to the newest predicted tick. */
  private resimulate(from: number, corrections: readonly Correction[]): void {
    const at = new Map<number, Correction[]>();
    for (const c of corrections) {
      const list = at.get(c.tick);
      if (list) list.push(c);
      else at.set(c.tick, [c]);
    }
    const nodes = new Set<GameObject>();
    const correct = (tick: number) => {
      for (const c of at.get(tick) ?? []) {
        applyPredicted(c.p.plan, c.p.binding, c.values);
        nodes.add(c.p.binding.node);
      }
    };
    // At `from`: the server's state where it corrects a ghost, else the ghost's own prediction.
    for (const p of this.ghosts.values()) {
      const own = p.history.get(from);
      if (own && !at.get(from)?.some((c) => c.p === p)) {
        applyPredicted(p.plan, p.binding, own);
        nodes.add(p.binding.node);
      }
    }
    correct(from);
    this.record(from, nodes);
    this.resimulating = true;
    try {
      for (let t = from + 1; t <= this.lastSimulated; t++) {
        this.simulate(t, nodes);
        correct(t); // a ghost whose newer state corrects it at t
        this.record(t, nodes);
        this.stats.resimulatedTicks++;
      }
    } finally {
      this.resimulating = false;
    }
  }

  private position(p: PredictedGhost): number[] {
    const i = p.binding.node.entity * 3;
    const pos = this.world.tPos;
    return [pos[i], pos[i + 1], pos[i + 2]];
  }

  /** Blend a corrected ghost's rendered position from where it was drawn (`old`) to the corrected one. */
  private startSmoothing(p: PredictedGhost, old: number[]): void {
    const now = this.world.time.time;
    let x = old[0], y = old[1], z = old[2];
    // Still blending an earlier correction: start from where it's drawn.
    const s = p.smoothing;
    if (s) {
      const k = Math.max(0, 1 - (now - s.start) / (SMOOTHING_MS / 1000));
      x += s.x * k;
      y += s.y * k;
      z += s.z * k;
    }
    const [nx, ny, nz] = this.position(p);
    const dx = x - nx, dy = y - ny, dz = z - nz;
    const distance = Math.hypot(dx, dy, dz);
    p.smoothing = distance > 0 && distance <= SMOOTHING_MAX_DISTANCE ? { x: dx, y: dy, z: dz, start: now } : null;
  }

  /** The connection changed or closed: start over. */
  private reset(): void {
    this.unsmooth();
    this.ghosts.clear();
    this.nodes.clear();
    this.lastSimulated = this.recordTick = -1;
    this.pass = SKIP;
  }
}

const predictions = new WeakMap<World, ClientPrediction>();

/** @internal A client World's prediction, created on first use; null if the World isn't a network client. */
export function clientPrediction(world: World): ClientPrediction | null {
  const session = netSession(world);
  if (!session?.isClient) return null;
  let p = predictions.get(world);
  if (!p || p.session !== session) predictions.set(world, (p = new ClientPrediction(world, session)));
  return p;
}

/** @internal For the editor's network panel (T15): what a client World's prediction did; null if it isn't a network client. */
export function predictionStats(world: World): PredictionStats | null {
  const p = clientPrediction(world);
  return p ? { ...p.stats } : null;
}

/**
 * The tick predicted systems are simulating: on a network client, the replayed tick while they
 * catch up or re-simulate, else `time.network.serverTick`; on a server, its tick. -1 in a World
 * that isn't networked.
 */
export function predictedTick(world: World = World.require()): number {
  return predictions.get(world)?.replaying ?? world.time.network?.serverTick ?? -1;
}

/**
 * True while a client re-simulates ticks it already predicted, after a correction. Predicted
 * systems can skip one-off effects (sounds, particles) then.
 */
export function isResimulating(world: World = World.require()): boolean {
  return predictions.get(world)?.resimulating ?? false;
}

// Predicted systems on network clients run as the prediction says; elsewhere, like any other.
_setPredictionDriver((world) => (netSession(world)?.isClient ? (clientPrediction(world)?.pass ?? SKIP) : null));

defineBuiltinSystem({
  name: "engine.PredictionTick",
  phase: "fixedUpdate",
  after: ["engine.NetInputTick"],
  before: ["engine.FixedUpdateScripts"],
  run: (world) => clientPrediction(world)?.tick(),
});
defineBuiltinSystem({
  name: "engine.PredictionSmooth",
  phase: "update",
  after: ["engine.ReplicationInterpolate"],
  before: ["engine.UpdateScripts"],
  run: (world) => predictions.get(world)?.smooth(),
});
