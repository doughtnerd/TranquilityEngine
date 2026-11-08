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

export type Phase = "fixedUpdate" | "update" | "lateUpdate";

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

/** Decides how a World's predicted systems run in its fixed step; null: like any other system. */
type PredictionDriver = (world: World) => PredictedRun | null;

let predictionDriver: PredictionDriver | null = null;

/** @internal Prediction (T13) takes over predicted systems on network clients. */
export function _setPredictionDriver(driver: PredictionDriver | null): void {
  predictionDriver = driver;
}

const builtinSystems: BuiltinSystem[] = [];
const userSystems: SystemDef[] = [];
/** Bumped whenever the catalog changes, so schedulers recompute their members. */
let catalogVersion = 0;

/**
 * Register a user system in the catalog (ADR 0032). It runs in the Worlds whose tags its `worlds`
 * filter matches (by default, the default World) and in any World it's added to by name.
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
  catalogVersion++;
  return def;
}

/** @internal Add an engine built-in to the catalog, at module level. A module evaluated again (hot reload) replaces its entries. */
export function defineBuiltinSystem(system: BuiltinSystem): void {
  const existing = builtinSystems.findIndex((s) => s.name === system.name);
  if (existing >= 0) builtinSystems.splice(existing, 1, system);
  else builtinSystems.push(system);
  catalogVersion++;
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
  catalogVersion++;
}

/** @internal Remove an engine system a first-party plugin added (`registerEngineSystems`, ADR 0135). */
export function _undefineBuiltinSystem(system: BuiltinSystem): void {
  const at = builtinSystems.indexOf(system);
  if (at < 0) return;
  builtinSystems.splice(at, 1);
  catalogVersion++;
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
  private ordered: Record<Phase, Scheduled[]> = { fixedUpdate: [], update: [], lateUpdate: [] };

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
    return (["fixedUpdate", "update", "lateUpdate"] as Phase[]).flatMap((p) => this.order(p));
  }

  run(phase: Phase, dt: number): void {
    if (this.stale()) this.rebuild();
    // Asked when the first predicted system is reached, so after engine.PredictionTick has run.
    let predicted: PredictedRun | null | undefined;
    for (const s of this.ordered[phase]) {
      if (s.builtin) s.builtin.run(this.world, dt);
      else if (s.user?.predicted && predictionDriver) {
        if (predicted === undefined) predicted = predictionDriver(this.world);
        if (!predicted) this.runUser(s.user, dt);
        else if (predicted.run) this.runUser(s.user, dt, predicted.includes);
      } else if (s.user) this.runUser(s.user, dt);
    }
  }

  /** @internal Prediction (T13): run this World's predicted systems once, in order, on the rows `includes` accepts. */
  runPredicted(dt: number, includes: (node: GameObject) => boolean): void {
    if (this.stale()) this.rebuild();
    for (const s of this.ordered.fixedUpdate) if (s.user?.predicted) this.runUser(s.user, dt, includes);
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
    for (const phase of ["fixedUpdate", "update", "lateUpdate"] as Phase[]) {
      // Default order: built-ins in registration order, then user systems in definition order.
      const items: (Scheduled & { after: readonly string[]; before: readonly string[] })[] = [
        ...builtins.filter((b) => b.phase === phase).map((b) => ({ name: b.name, builtin: b, after: b.after ?? [], before: b.before ?? [] })),
        ...users.filter((u) => u.phase === phase).map((u) => ({ name: u.name, user: u, after: u.predicted ? [...(u.after ?? []), PREDICTION_SYSTEM] : (u.after ?? []), before: u.before ?? [] })),
      ];
      this.ordered[phase] = topoSort(items);
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

/** Stable topological sort honoring `after`/`before` constraints; unknown names are ignored. */
function topoSort<T extends { name: string; after: readonly string[]; before: readonly string[] }>(items: T[]): T[] {
  const index = new Map(items.map((it, i) => [it.name, i]));
  const deps: Set<number>[] = items.map(() => new Set());
  items.forEach((it, i) => {
    for (const a of it.after) if (index.has(a)) deps[i].add(index.get(a)!);
    for (const b of it.before) if (index.has(b)) deps[index.get(b)!].add(i);
  });
  // Implicit default: keep original order unless a constraint says otherwise.
  const result: T[] = [];
  const state = new Uint8Array(items.length); // 0 = new, 1 = visiting, 2 = done
  const visit = (i: number) => {
    if (state[i] === 2) return;
    if (state[i] === 1) throw new Error(`System ordering cycle involving "${items[i].name}".`);
    state[i] = 1;
    for (const d of [...deps[i]].sort((a, b) => a - b)) visit(d);
    state[i] = 2;
    result.push(items[i]);
  };
  items.forEach((_, i) => visit(i));
  return result;
}
