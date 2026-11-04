/**
 * A system query's rows (ADR 0017, 0064): iterable row by row (views over the data), and as
 * typed-array columns indexed by the matching rows' `indices`, for hot loops.
 */
import type { GameObject } from "../scene/GameObject";
import type { Transform } from "../scene/Transform";
import type { Columns, DataComponentDef, DataStore, Schema } from "./data";
import type { Row } from "./systems";

/** A system query's rows. Iterate it row by row, or read `column()`s at `indices` for speed. */
export interface Rows extends Iterable<Row> {
  /**
   * The rows matched when the run started, as indices into this run's columns (each is the node's
   * slot in the World). Valid during this run only: a slot is reused after its node is destroyed.
   */
  readonly indices: Int32Array;
  /** How many rows matched. */
  readonly count: number;
  /**
   * A data component's fields, as the typed arrays storing them, indexed by `indices`. Writes
   * change the components. `def` must be one of the query's terms. Valid during this run: adding
   * the component to more nodes, or creating nodes, can replace the arrays, so fetch it again after.
   */
  column<S extends Schema>(def: DataComponentDef<S>): Columns<S>;
  /** The node at an index. */
  node(index: number): GameObject;
  /** The node's Transform at an index (the query must include Transform, or the node have one). */
  transform(index: number): Transform;
}

/** What `QueryRows` needs from its World. */
export interface RowSource {
  handle(e: number): GameObject;
  transformOf(e: number): Transform | null;
  isRowAlive(e: number): boolean;
}

/**
 * @internal The rows of one system run, collected the first time they're read (a system that
 * returns early costs nothing). The row object is reused between rows.
 */
export class QueryRows implements Rows {
  private collected: Int32Array | null = null;

  constructor(
    private readonly world: RowSource,
    private readonly defs: readonly DataComponentDef[],
    private readonly stores: readonly DataStore[],
    private readonly collect: () => Int32Array,
  ) {}

  get indices(): Int32Array {
    return (this.collected ??= this.collect());
  }

  get count(): number {
    return this.indices.length;
  }

  column<S extends Schema>(def: DataComponentDef<S>): Columns<S> {
    const i = this.defs.indexOf(def as unknown as DataComponentDef);
    if (i < 0) throw new Error(`rows.column(${def.id}): the system's query doesn't include it.`);
    return this.stores[i].arrays as unknown as Columns<S>;
  }

  node(index: number): GameObject {
    return this.world.handle(index);
  }

  transform(index: number): Transform {
    const t = this.world.transformOf(index);
    if (!t) throw new Error(`rows.transform(${index}): that node has no Transform.`);
    return t;
  }

  [Symbol.iterator](): Iterator<Row> {
    const { world, defs, stores, indices } = this;
    let current = 0;
    let k = 0;
    // `node` and `transform` are looked up only when read; most systems read one or neither.
    const row = {
      get node() {
        return world.handle(current);
      },
      get transform() {
        return world.transformOf(current)!;
      },
    } as Row;
    const result = { value: row, done: false } as IteratorResult<Row>;
    const done = { value: undefined, done: true } as IteratorResult<Row>;
    return {
      next: () => {
        outer: while (k < indices.length) {
          const e = indices[k++];
          // Data removed, or the node destroyed, earlier in this run.
          if (!world.isRowAlive(e)) continue;
          for (const s of stores) if (!s.present[e]) continue outer;
          current = e;
          for (let i = 0; i < stores.length; i++) row[defs[i].key] = stores[i].view(e);
          return result;
        }
        return done;
      },
    };
  }
}

/** Rows for a system without a query. */
export const NO_ROWS: Rows = {
  indices: new Int32Array(0),
  count: 0,
  column(def) {
    throw new Error(`rows.column(${def.id}): the system has no query.`);
  },
  node() {
    throw new Error("rows.node: the system has no query.");
  },
  transform() {
    throw new Error("rows.transform: the system has no query.");
  },
  [Symbol.iterator]: () => [][Symbol.iterator](),
};
