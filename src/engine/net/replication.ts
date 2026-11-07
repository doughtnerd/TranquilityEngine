/**
 * Replication (ADR 0033): which nodes the server sends to clients, and how. T11 implements
 * snapshots, spawning and interpolation (`replication/`); T13 adds prediction.
 *
 * A node is replicated when it has a `net.Replicated` component (`Replicated.ts`). What's sent:
 * its transform (unless `replicateTransform` is off), its data components' fields (opted in per
 * data component with `replicate` below) and its own behaviors' fields declared with
 * `@field(Number | Boolean, { replicate: true })`. Spawning sends the prefab path; scene-placed
 * nodes match by their scene node ids. The wire format and the rules are at the top of
 * `replication/server.ts`.
 */
import type { DataComponentDef } from "../core/data";
import type { FieldEncoding } from "./codec";

/** How remote clients show a replicated node. */
export type ReplicationMode =
  /** Drawn slightly in the past, between received snapshots (the default for everything). */
  | "interpolated"
  /** On the owning client, simulated ahead and corrected by rollback (T13); interpolated elsewhere. */
  | "predicted";

/** The settings of the `net.Replicated` component (its declared fields). */
export interface ReplicatedSettings {
  /** Default `"interpolated"`. */
  mode: ReplicationMode;
  /**
   * The owning connection's id (`Connection.id`; 0: the server owns it). Owners can send inputs for
   * it. (Not `owner`: that's every component's owning node.)
   */
  ownerId: number;
  /** Relative send priority when a snapshot is full (1 = normal). */
  importance: number;
  /**
   * Replicate the node's local position, rotation and scale. Default true. (Not `transform`: that's
   * every component's Transform getter.)
   */
  replicateTransform: boolean;
  /** Interest management (ADR 0121): relevant only within this distance of a connection's viewpoint; 0: everywhere. */
  relevantDistance: number;
  /** Interest management (ADR 0121): relevant only to connections in this group (`Interest.join`); "": no group. */
  group: string;
}

/** Replicate a data component's fields on replicated nodes. */
export interface DataReplication {
  /** Fields to send. Default: all. */
  fields?: readonly string[];
  /** Fields the owning client predicts and rolls back (T13). */
  predicted?: readonly string[];
  /** Per-field encoding (quantization). */
  encoding?: Readonly<Record<string, FieldEncoding>>;
}

const replicatedData = new Map<DataComponentDef, DataReplication>();

/**
 * Mark a data component as replicated. Both ends must call it the same way (it's part of the
 * game's code, like the component itself).
 *
 * ```ts
 * export const Health = defineComponent("game.Health", { current: f32, max: f32 });
 * replicate(Health, { encoding: { current: { quantize: 0.1 } } });
 * ```
 */
export function replicate(def: DataComponentDef, options: DataReplication = {}): void {
  for (const f of options.fields ?? []) {
    if (!def.fields.includes(f)) throw new Error(`replicate(${def.id}): "${f}" isn't a field of it (fields: ${def.fields.join(", ")}).`);
  }
  replicatedData.set(def, options);
}

/** @internal How a data component replicates, or null if it doesn't. */
export function replicationOf(def: DataComponentDef): DataReplication | null {
  return replicatedData.get(def) ?? null;
}
