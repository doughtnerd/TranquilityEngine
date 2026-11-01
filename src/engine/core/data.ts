/**
 * Data components and buffers (ADR 0017).
 *
 * Data components are plain data declared with a schema and stored struct-of-arrays in typed
 * arrays (ADR 0012). Buffers are per-frame queues of plain records: the data-oriented
 * replacement for events. Both can be used from user systems and from GameBehaviors.
 */
import { _isReplacingRegistrations } from "./registry";
import { World } from "./World";

export interface ScalarType {
  readonly kind: "f32" | "i32" | "u8";
  readonly array: Float32ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor;
}

/** 32-bit float field. */
export const f32: ScalarType = { kind: "f32", array: Float32Array };
/** 32-bit signed integer field. */
export const i32: ScalarType = { kind: "i32", array: Int32Array };
/** 8-bit unsigned field, also used for booleans (0/1). */
export const u8: ScalarType = { kind: "u8", array: Uint8Array };

export type Schema = Record<string, ScalarType>;

/** The object you get from `node.getData(Def)` or a system row: live accessors over storage. */
export type DataView<S extends Schema> = { [K in keyof S]: number };

export interface DataComponentDef<S extends Schema = Schema> {
  readonly id: string;
  /** Property name used for this component in system rows (`game.Scroller` → `scroller`). */
  readonly key: string;
  readonly schema: S;
  readonly fields: readonly string[];
  /** @internal */ readonly viewProto: object;
}

const dataById = new Map<string, DataComponentDef>();

/**
 * Declare a data component.
 *
 * ```ts
 * export const Velocity = defineComponent("game.Velocity", { x: f32, y: f32, z: f32 });
 * ```
 */
export function defineComponent<S extends Schema>(id: string, schema: S, options: { key?: string } = {}): DataComponentDef<S> {
  if (dataById.has(id) && !_isReplacingRegistrations()) throw new Error(`Data component "${id}" is already defined.`);
  const fields = Object.keys(schema) as (keyof S & string)[];
  const viewProto: Record<string, unknown> = {};
  for (const f of fields) {
    Object.defineProperty(viewProto, f, {
      enumerable: true,
      get(this: ViewInstance) {
        return this._s.arrays[f][this._e];
      },
      set(this: ViewInstance, v: number) {
        this._s.arrays[f][this._e] = v;
      },
    });
  }
  const shortName = id.slice(id.lastIndexOf(".") + 1);
  const def: DataComponentDef<S> = {
    id,
    key: options.key ?? shortName.charAt(0).toLowerCase() + shortName.slice(1),
    schema,
    fields,
    viewProto,
  };
  dataById.set(id, def as DataComponentDef);
  return def;
}

/** @internal Every defined data component id (for the editor's Add Component list). */
export function listDataComponentIds(): string[] {
  return [...dataById.keys()];
}

export function getDataComponentDef(id: string): DataComponentDef | undefined {
  return dataById.get(id);
}

interface ViewInstance {
  _s: DataStore;
  _e: number;
}

/** @internal Per-world storage for one data component. */
export class DataStore {
  arrays: Record<string, Float32Array | Int32Array | Uint8Array> = {};
  present: Uint8Array;
  dense: number[] = [];
  denseIndex: Int32Array;
  private views: (object | undefined)[] = [];

  constructor(readonly def: DataComponentDef, capacity: number) {
    for (const f of def.fields) this.arrays[f] = new def.schema[f].array(capacity);
    this.present = new Uint8Array(capacity);
    this.denseIndex = new Int32Array(capacity).fill(-1);
  }

  grow(capacity: number): void {
    for (const f of this.def.fields) {
      const next = new this.def.schema[f].array(capacity);
      next.set(this.arrays[f]);
      this.arrays[f] = next;
    }
    const present = new Uint8Array(capacity);
    present.set(this.present);
    this.present = present;
    const denseIndex = new Int32Array(capacity).fill(-1);
    denseIndex.set(this.denseIndex);
    this.denseIndex = denseIndex;
  }

  add(entity: number, init?: Record<string, number | boolean>): void {
    if (!this.present[entity]) {
      this.present[entity] = 1;
      this.denseIndex[entity] = this.dense.length;
      this.dense.push(entity);
    }
    for (const f of this.def.fields) {
      const v = init?.[f];
      this.arrays[f][entity] = v === undefined ? 0 : Number(v);
    }
  }

  remove(entity: number): void {
    if (!this.present[entity]) return;
    this.present[entity] = 0;
    const i = this.denseIndex[entity];
    const last = this.dense.pop()!;
    if (last !== entity) {
      this.dense[i] = last;
      this.denseIndex[last] = i;
    }
    this.denseIndex[entity] = -1;
    this.views[entity] = undefined;
  }

  view(entity: number): object {
    let v = this.views[entity];
    if (!v) {
      v = Object.create(this.def.viewProto) as ViewInstance;
      (v as ViewInstance)._s = this;
      (v as ViewInstance)._e = entity;
      this.views[entity] = v;
    }
    return v;
  }
}

export interface BufferDef<T> {
  readonly id: string;
  /** Append a record for this frame. */
  push(record: T): void;
  /** Records pushed so far this frame. Cleared at the end of the frame. */
  read(): readonly T[];
}

/**
 * Declare a per-frame buffer.
 *
 * ```ts
 * export const DamageEvents = defineBuffer<{ target: GameObject; amount: number }>("game.Damage");
 * DamageEvents.push({ target, amount: 5 });
 * for (const e of DamageEvents.read()) { ... }
 * ```
 */
export function defineBuffer<T>(id: string): BufferDef<T> {
  const def: BufferDef<T> = {
    id,
    push(record: T) {
      World.require()._buffer(def).push(record);
    },
    read() {
      return World.require()._buffer(def) as readonly T[];
    },
  };
  return def;
}
