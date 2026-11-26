/**
 * User-defined systems, the system catalog and the per-World scheduler (ADR 0011, 0017, 0032).
 */
import type { GameObject } from "../scene/GameObject";
import type { Transform } from "../scene/Transform";
import type { DataComponentDef } from "./data";
import { NO_ROWS, type Rows } from "./rows";
import type { TimeState, World } from "./World";
import { _isReplacingRegistrations, _recordRegistration } from "./registry";
import { DEFAULT_SYSTEM_WORLDS, worldsMatch, type WorldTag } from "./worlds";

export type Phase = "input" | "fixedUpdate" | "update" | "lateUpdate";

/** The phases in frame order (ADR 0011, 0335): `input` runs before `start()` and the fixed steps. */
export const PHASES: readonly Phase[] = ["input", "fixedUpdate", "update", "lateUpdate"];

/** A query term: the Transform facade or a data component. */
export type QueryTerm = typeof Transform | DataComponentDef;

/** One row of a system query. Properties are reused between rows: don't keep references to the row itself. */
export interface Row {
  node: GameObject;
  transform: Transform;
  [key: string]: unknown;
}

export interface SystemContext {
  readonly world: World;
  readonly time: TimeState;
  /** `fixedDeltaTime` in the fixedUpdate phase, `deltaTime` otherwise. */
  readonly dt: number;
  /** The view of the first node that has `def`, or null. Handy for singleton state. */
  single<V = Record<string, number>>(def: DataComponentDef): V | null;
}

export interface SystemDef {
  /** Unique name, e.g. `game.ScrollSystem`. Other systems can order against it. */
  readonly name: string;
  readonly phase: Phase;
  readonly after?: readonly string[];
  readonly before?: readonly string[];
  /** Rows include only nodes that are active in the hierarchy and have every term. */
  readonly query?: readonly QueryTerm[];
  /**
   * Tags of the Worlds this system is meant for (ADR 0032): it runs in Worlds with any of them
   * (`"*"`: every World). Default `["default", "local"]`. Adding it to a World by name works regardless.
   */
  readonly worlds?: readonly WorldTag[];
  /**
   * A predicted system (ADR 0033 §6, T13; Unity's `PredictedSimulationSystemGroup`): it moves the
   * state the owning client predicts. fixedUpdate only. Default false.
   *
   * On servers and in Worlds that aren't networked it runs like any other system. On a network
   * client it runs on the prediction timeline (`net/prediction.ts`):
   * - its rows are only the ghosts this client predicts (`Replicated.isPredictedLocally`), not
   *   their children or any other node;
   * - it runs once per predicted tick (`time.network.serverTick`), so a fixed step can run it
   *   more than once (catching up skipped ticks) or not at all (its tick was already simulated);
   * - when a snapshot corrects a prediction, it runs again for the ticks since that snapshot
   *   (re-simulation), with `Move.of(node)` returning each tick's input.
   * So keep it deterministic, and let it change only its rows' predicted values (the transform,
   * data fields listed in `replicate(def, { predicted })`, behavior fields declared
   * `{ predicted: true }`). On a client, predicted systems always run after `engine.PredictionTick`.
   */
  readonly predicted?: boolean;
  /** `rows` iterates row by row, and gives typed-array columns for hot loops (`rows.column`, ADR 0064). */
  run(rows: Rows, ctx: SystemContext): void;
}

/** @internal Built-in system: a named function in a phase, run against the World passed in. */
export interface BuiltinSystem {
  readonly name: string;
  readonly phase: Phase;
  readonly after?: readonly string[];
  readonly before?: readonly string[];
  /** Default `["*"]`: every World. */
  readonly worlds?: readonly WorldTag[];
  /**
   * fixedUpdate only: also run it, in order, when prediction re-simulates a tick (ADR 0337: the input
   * bridge restores each replayed tick's actions before the predicted systems read them).
   */
  readonly predicted?: boolean;
  run(world: World, dt: number): void;
}

const ALL_WORLDS: readonly WorldTag[] = ["*"];

/** The built-in that drives the prediction timeline (`net/prediction.ts`); predicted systems run after it. */
const PREDICTION_SYSTEM = "engine.PredictionTick";

/** @internal How a World's predicted systems run in this fixed step (T13, `net/prediction.ts`). */
export interface PredictedRun {
  /** Run them in this step's pass (false: this step's tick was already simulated). */
  readonly run: boolean;
  /** Their rows: only the nodes this accepts. */
  readonly includes: (node: GameObject) => boolean;
}

/**
 * @internal What the scheduler asks a networked World's session (`World._net`, set by
 * `net/session.ts`; ADR 0311). A World without one runs predicted systems like any other.
 */
export interface WorldNet {
  /** How the World's predicted systems run in this fixed step; null: like any other system. */
  predictedRun(): PredictedRun | null;
}

const builtinSystems: BuiltinSystem[] = [];
const userSystems: SystemDef[] = [];
/** Bumped whenever the catalog changes, so schedulers recompute their members. */
let catalogVersion = 0;
/** When each defined system was (re)defined: the latest constraint on a loop is the one broken (ADR 0397). */
const definedAt = new WeakMap<SystemDef, number>();
let definitions = 0;

/**
 * Register a user system in the catalog (ADR 0032). It runs in the Worlds whose tags its `worlds`
 * filter matches (by default, the default World) and in any World it's added to by name.
 *
 * If its `after`/`before` close an ordering loop, the loop is logged once and broken at the most
 * recently added constraint on it, so the game keeps running (ADR 0397).
 */
export function defineSystem(def: SystemDef): SystemDef {
  if (def.predicted && def.phase !== "fixedUpdate") throw new Error(`System "${def.name}": predicted systems run in fixedUpdate (got "${def.phase}").`);
  if (builtinSystems.some((s) => s.name === def.name)) throw new Error(`System "${def.name}" is an engine built-in.`);
  const existing = userSystems.findIndex((s) => s.name === def.name);
  if (existing >= 0 && !_isReplacingRegistrations()) throw new Error(`System "${def.name}" is already defined.`);
  if (_isReplacingRegistrations()) {
    _recordRegistration("systems", def.name);
    if (existing >= 0 && !scriptSystems.has(def.name)) buildSystems.set(def.name, userSystems[existing]);
    scriptSystems.add(def.name);
  }
  if (existing >= 0) userSystems.splice(existing, 1, def);
  else userSystems.push(def);
  definedAt.set(def, ++definitions);
  catalogChanged();
  return def;
}

/**
 * @internal Add an engine built-in to the catalog, at module level. A module evaluated again (hot reload) replaces its entries.
 * Throws, adding nothing, if its `after`/`before` close an ordering loop among the built-ins (ADR 0397).
 */
export function defineBuiltinSystem(system: BuiltinSystem): void {
  const existing = builtinSystems.findIndex((s) => s.name === system.name);
  const candidate = existing >= 0 ? builtinSystems.map((s, i) => (i === existing ? system : s)) : [...builtinSystems, system];
  const loop = findLoop(constraintEdges(candidate.filter((s) => s.phase === system.phase).map(builtinConstraints)));
  if (loop) throw new Error(`Engine system "${system.name}" closes a system ordering cycle (each runs before the next): ${loop.names.join(" → ")}.`);
  if (existing >= 0) builtinSystems.splice(existing, 1, system);
  else builtinSystems.push(system);
  catalogChanged();
}

/** Systems the editor build defined that a script's replaced, and names scripts defined. */
const buildSystems = new Map<string, SystemDef>();
const scriptSystems = new Set<string>();

/** @internal Editor (ADR 0030): forget a system a script defined, putting back the editor build's if it replaced one. */
export function _undefineSystem(name: string): void {
  const at = userSystems.findIndex((s) => s.name === name);
  const original = buildSystems.get(name);
  if (at >= 0) {
    if (original) userSystems.splice(at, 1, original);
    else userSystems.splice(at, 1);
  }
  buildSystems.delete(name);
  scriptSystems.delete(name);
  catalogChanged();
}

/** @internal Remove an engine system a first-party plugin added (`registerEngineSystems`, ADR 0135). */
export function _undefineBuiltinSystem(system: BuiltinSystem): void {
  const at = builtinSystems.indexOf(system);
  if (at < 0) return;
  builtinSystems.splice(at, 1);
  catalogChanged();
}

/** A system in the catalog: what can be added to a World (ADR 0032). */
export interface SystemCatalogEntry {
  readonly name: string;
  readonly phase: Phase;
  /** Its `worlds` filter, with the default filled in. */
  readonly worlds: readonly WorldTag[];
  /** An engine built-in (scripts, physics, transforms) rather than a defined system. */
  readonly builtin: boolean;
}

/** Every system that can be added to a World, in catalog order: engine built-ins, then defined systems in definition order. */
export function listSystemCatalog(): readonly SystemCatalogEntry[] {
  return [
    ...builtinSystems.map((s) => ({ name: s.name, phase: s.phase, worlds: s.worlds ?? ALL_WORLDS, builtin: true })),
    ...userSystems.map((s) => ({ name: s.name, phase: s.phase, worlds: s.worlds ?? DEFAULT_SYSTEM_WORLDS, builtin: false })),
  ];
}

type Scheduled = { name: string; builtin?: BuiltinSystem; user?: SystemDef };

/**
 * @internal A World's systems (ADR 0032): the catalog entries whose `worlds` filter matches the
 * World's tags, plus those added by name, minus those removed. Membership follows the catalog, so
 * systems defined later join the Worlds they match.
 */
export class Scheduler {
  private readonly added = new Set<string>();
  private readonly removed = new Set<string>();
  private membershipVersion = 0;
  private builtMembershipVersion = -1;
  private builtCatalogVersion = -1;
  private ordered: Record<Phase, Scheduled[]> = { input: [], fixedUpdate: [], update: [], lateUpdate: [] };

  constructor(private readonly world: World) {}

  /** Add a catalog system to this World by name, even if its `worlds` filter doesn't match. Throws for unknown names. */
  addSystem(name: string): void {
    if (!builtinSystems.some((s) => s.name === name) && !userSystems.some((s) => s.name === name)) {
      throw new Error(`Unknown system "${name}": it isn't in the system catalog (define it with defineSystem() first).`);
    }
    this.removed.delete(name);
    this.added.add(name);
    this.membershipVersion++;
  }

  /** Take a system out of this World, even if its `worlds` filter matches. */
  removeSystem(name: string): void {
    this.added.delete(name);
    this.removed.add(name);
    this.membershipVersion++;
  }

  /** Every system this World runs, by name, phase by phase in execution order. */
  names(): string[] {
    return PHASES.flatMap((p) => this.order(p));
  }

  run(phase: Phase, dt: number): void {
    if (this.stale()) this.rebuild();
    // Asked when the first predicted system is reached, so after engine.PredictionTick has run.
    let predicted: PredictedRun | null | undefined;
    for (const s of this.ordered[phase]) {
      if (s.builtin) s.builtin.run(this.world, dt);
      else if (s.user?.predicted && this.world._net) {
        if (predicted === undefined) predicted = this.world._net.predictedRun();
        if (!predicted) this.runUser(s.user, dt);
        else if (predicted.run) this.runUser(s.user, dt, predicted.includes);
      } else if (s.user) this.runUser(s.user, dt);
    }
  }

  /** @internal Prediction (T13): run this World's predicted systems once, in order, on the rows `includes` accepts. */
  runPredicted(dt: number, includes: (node: GameObject) => boolean): void {
    if (this.stale()) this.rebuild();
    for (const s of this.ordered.fixedUpdate) {
      if (s.builtin?.predicted) s.builtin.run(this.world, dt);
      else if (s.user?.predicted) this.runUser(s.user, dt, includes);
    }
  }

  /** Names in execution order, for debugging and tests. */
  order(phase: Phase): string[] {
    if (this.stale()) this.rebuild();
    return this.ordered[phase].map((s) => s.name);
  }

  private stale(): boolean {
    return this.builtCatalogVersion !== catalogVersion || this.builtMembershipVersion !== this.membershipVersion;
  }

  private isMember(name: string, worlds: readonly WorldTag[]): boolean {
    return !this.removed.has(name) && (this.added.has(name) || worldsMatch(worlds, this.world.worldTags));
  }

  private rebuild(): void {
    const builtins = builtinSystems.filter((b) => this.isMember(b.name, b.worlds ?? ALL_WORLDS));
    const users = userSystems.filter((u) => this.isMember(u.name, u.worlds ?? DEFAULT_SYSTEM_WORLDS));
    for (const phase of PHASES) {
      // Default order: built-ins in registration order, then user systems in definition order.
      const items: (Scheduled & { after: readonly string[]; before: readonly string[] })[] = [
        ...builtins.filter((b) => b.phase === phase).map((b) => ({ ...builtinConstraints(b), builtin: b })),
        ...users.filter((u) => u.phase === phase).map((u) => ({ ...userConstraints(u), user: u })),
      ];
      this.ordered[phase] = topoSort(items, brokenEdges);
    }
    this.builtCatalogVersion = catalogVersion;
    this.builtMembershipVersion = this.membershipVersion;
  }

  private runUser(def: SystemDef, dt: number, includes?: (node: GameObject) => boolean): void {
    const world = this.world;
    const ctx: SystemContext = {
      world,
      time: world.time,
      dt,
      single: <V>(d: DataComponentDef) => world._singleData(d) as V | null,
    };
    try {
      def.run(def.query ? world._query(def.query, includes) : NO_ROWS, ctx);
    } catch (err) {
      console.error(`[myco] System "${def.name}" threw:`, err);
    }
  }
}

// --- Ordering loops (ADR 0397) ------------------------------------------------------------------

/** A system and its ordering constraints; `owner` is the defined system that declared them (none: a built-in). */
type Constrained = { name: string; after: readonly string[]; before: readonly string[]; owner?: SystemDef };

const builtinConstraints = (b: BuiltinSystem): Constrained => ({ name: b.name, after: b.after ?? [], before: b.before ?? [] });

/** A defined system's constraints; predicted systems also run after the prediction tick. */
const userConstraints = (u: SystemDef): Constrained => ({
  name: u.name,
  after: u.predicted ? [...(u.after ?? []), PREDICTION_SYSTEM] : (u.after ?? []),
  before: u.before ?? [],
  owner: u,
});

/** The key of the edge "`first` runs before `then`". */
const edgeKey = (first: string, then: string) => `${first}\u0000${then}`;

/** An edge "`first` runs before `then`", and who declared it. */
interface Edge {
  readonly first: string;
  readonly then: string;
  /** Declared by an engine built-in: never broken. */
  builtin: boolean;
  /** The latest definition (`definedAt`) of a defined system that declared it. */
  latest: number;
  /** That system's name. */
  by: string;
}

/** The edges among `items` (one phase), keyed by `edgeKey`; names outside `items` are ignored. */
function constraintEdges(items: readonly Constrained[]): Map<string, Edge> {
  const names = new Set(items.map((it) => it.name));
  const edges = new Map<string, Edge>();
  const add = (first: string, then: string, it: Constrained) => {
    if (!names.has(first) || !names.has(then)) return;
    const key = edgeKey(first, then);
    const edge = edges.get(key) ?? { first, then, builtin: false, latest: -1, by: it.name };
    const at = it.owner ? (definedAt.get(it.owner) ?? 0) : -1;
    if (!it.owner) edge.builtin = true;
    else if (at > edge.latest) {
      edge.latest = at;
      edge.by = it.name;
    }
    edges.set(key, edge);
  };
  for (const it of items) {
    for (const a of it.after) add(a, it.name, it);
    for (const b of it.before) add(it.name, b, it);
  }
  return edges;
}

/** A loop in `edges`: the names in run order with the first repeated at the end, and its edges; null if there's none. */
function findLoop(edges: ReadonlyMap<string, Edge>): { names: string[]; edges: Edge[] } | null {
  const next = new Map<string, Edge[]>();
  for (const e of edges.values()) {
    const out = next.get(e.first);
    if (out) out.push(e);
    else next.set(e.first, [e]);
  }
  const state = new Map<string, 1 | 2>(); // 1 = on the path, 2 = done
  const path: Edge[] = [];
  const visit = (name: string): { names: string[]; edges: Edge[] } | null => {
    state.set(name, 1);
    for (const e of next.get(name) ?? []) {
      const s = state.get(e.then);
      if (s === 2) continue;
      path.push(e);
      if (s === 1) {
        const loop = path.slice(path.findIndex((p) => p.first === e.then));
        return { names: [...loop.map((p) => p.first), e.then], edges: loop };
      }
      const found = visit(e.then);
      if (found) return found;
      path.pop();
    }
    state.set(name, 2);
    return null;
  };
  for (const name of next.keys()) {
    if (state.has(name)) continue;
    const found = visit(name);
    if (found) return found;
  }
  return null;
}

/** Constraints left out of every World's order to break loops that defined systems closed (keys from `edgeKey`). */
let brokenEdges = new Set<string>();
/** The loops broken and logged, so each is logged once while it stands. */
let loggedLoops = new Set<string>();

/**
 * The catalog changed: schedulers rebuild, and loops are broken again, each at its most recently
 * added constraint (ADR 0397). Built-in loops never get here (`defineBuiltinSystem` refuses them).
 */
function catalogChanged(): void {
  catalogVersion++;
  const broken = new Set<string>();
  const logged = new Set<string>();
  for (const phase of PHASES) {
    const edges = constraintEdges([
      ...builtinSystems.filter((b) => b.phase === phase).map(builtinConstraints),
      ...userSystems.filter((u) => u.phase === phase).map(userConstraints),
    ]);
    for (let loop = findLoop(edges); loop; loop = findLoop(edges)) {
      const breakable = loop.edges.filter((e) => !e.builtin);
      const cut = breakable.length ? breakable.reduce((a, b) => (b.latest > a.latest ? b : a)) : loop.edges[loop.edges.length - 1];
      const key = edgeKey(cut.first, cut.then);
      edges.delete(key);
      broken.add(key);
      const text = loop.names.join(" → ");
      logged.add(text);
      if (!loggedLoops.has(text)) {
        console.error(
          `[myco] System ordering cycle (each runs before the next): ${text}. Ignoring "${cut.first}" before "${cut.then}" (from system "${cut.by}", the most recently added constraint) so the game keeps running.`,
        );
      }
    }
  }
  brokenEdges = broken;
  loggedLoops = logged;
}

/**
 * Stable topological sort honoring `after`/`before` constraints except the `broken` ones (`edgeKey`); unknown
 * names are ignored. Never throws: a loop left over (there should be none) is cut where the walk meets it.
 */
function topoSort<T extends { name: string; after: readonly string[]; before: readonly string[] }>(items: T[], broken: ReadonlySet<string>): T[] {
  const index = new Map(items.map((it, i) => [it.name, i]));
  const deps: Set<number>[] = items.map(() => new Set());
  items.forEach((it, i) => {
    for (const a of it.after) if (index.has(a) && !broken.has(edgeKey(a, it.name))) deps[i].add(index.get(a)!);
    for (const b of it.before) if (index.has(b) && !broken.has(edgeKey(it.name, b))) deps[index.get(b)!].add(i);
  });
  // Implicit default: keep original order unless a constraint says otherwise.
  const result: T[] = [];
  const state = new Uint8Array(items.length); // 0 = new, 1 = visiting, 2 = done
  const visit = (i: number) => {
    if (state[i] === 2) return;
    if (state[i] === 1) return;
    state[i] = 1;
    for (const d of [...deps[i]].sort((a, b) => a - b)) visit(d);
    state[i] = 2;
    result.push(items[i]);
  };
  items.forEach((_, i) => visit(i));
  return result;
}
