/**
 * User-defined systems and the per-phase scheduler (ADR 0011, 0017).
 */
import type { GameObject } from "../scene/GameObject";
import type { Transform } from "../scene/Transform";
import type { DataComponentDef } from "./data";
import type { TimeState, World } from "./World";
import { _isReplacingRegistrations } from "./registry";

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
  run(rows: Iterable<Row>, ctx: SystemContext): void;
}

const userSystems: SystemDef[] = [];
let userSystemsVersion = 0;

/** Register a user system. It runs in every world, in the given phase. */
export function defineSystem(def: SystemDef): SystemDef {
  const existing = userSystems.findIndex((s) => s.name === def.name);
  if (existing >= 0 && !_isReplacingRegistrations()) throw new Error(`System "${def.name}" is already defined.`);
  if (existing >= 0) userSystems.splice(existing, 1, def);
  else userSystems.push(def);
  userSystemsVersion++;
  return def;
}

/** @internal Built-in system: a named function in a phase. */
export interface BuiltinSystem {
  readonly name: string;
  readonly phase: Phase;
  readonly after?: readonly string[];
  readonly before?: readonly string[];
  run(world: World, dt: number): void;
}

type Scheduled = { name: string; builtin?: BuiltinSystem; user?: SystemDef };

/** @internal */
export class Scheduler {
  private builtins: BuiltinSystem[] = [];
  private builtVersion = -1;
  private builtinVersion = 0;
  private lastBuiltinVersion = -1;
  private ordered: Record<Phase, Scheduled[]> = { fixedUpdate: [], update: [], lateUpdate: [] };

  constructor(private readonly world: World) {}

  addBuiltin(system: BuiltinSystem): void {
    if (this.builtins.some((s) => s.name === system.name)) return;
    this.builtins.push(system);
    this.builtinVersion++;
  }

  run(phase: Phase, dt: number): void {
    if (this.builtVersion !== userSystemsVersion || this.lastBuiltinVersion !== this.builtinVersion) this.rebuild();
    for (const s of this.ordered[phase]) {
      if (s.builtin) s.builtin.run(this.world, dt);
      else if (s.user) this.runUser(s.user, dt);
    }
  }

  /** Names in execution order, for debugging and tests. */
  order(phase: Phase): string[] {
    if (this.builtVersion !== userSystemsVersion || this.lastBuiltinVersion !== this.builtinVersion) this.rebuild();
    return this.ordered[phase].map((s) => s.name);
  }

  private rebuild(): void {
    for (const phase of ["fixedUpdate", "update", "lateUpdate"] as Phase[]) {
      // Default order: built-ins in registration order, then user systems in definition order.
      const items: (Scheduled & { after: readonly string[]; before: readonly string[] })[] = [
        ...this.builtins.filter((b) => b.phase === phase).map((b) => ({ name: b.name, builtin: b, after: b.after ?? [], before: b.before ?? [] })),
        ...userSystems.filter((u) => u.phase === phase).map((u) => ({ name: u.name, user: u, after: u.after ?? [], before: u.before ?? [] })),
      ];
      this.ordered[phase] = topoSort(items);
    }
    this.builtVersion = userSystemsVersion;
    this.lastBuiltinVersion = this.builtinVersion;
  }

  private runUser(def: SystemDef, dt: number): void {
    const world = this.world;
    const ctx: SystemContext = {
      world,
      time: world.time,
      dt,
      single: <V>(d: DataComponentDef) => world._singleData(d) as V | null,
    };
    try {
      def.run(def.query ? world._query(def.query) : [], ctx);
    } catch (err) {
      console.error(`[tranquility] System "${def.name}" threw:`, err);
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
