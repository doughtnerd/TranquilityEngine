/**
 * Replication (ADR 0033): which nodes the server sends to clients, and how. Implemented by T11
 * (snapshots, spawning, interpolation) and T13 (prediction).
 *
 * A node is replicated when it has a `net.Replicated` component. What's sent: its data
 * components' fields (opted in per data component below) and its behaviors' fields declared with
 * `@field(type, { replicate: true })`. Spawning sends the prefab path; scene-placed nodes match
 * by their scene node id.
 */
import type { DataComponentDef } from "../core/data";
import type { FieldEncoding } from "./codec";

/** How remote clients show a replicated node. */
export type ReplicationMode =
  /** Drawn slightly in the past, between received snapshots (the default for everything). */
  | "interpolated"
  /** On the owning client, simulated ahead and corrected by rollback (T13); interpolated elsewhere. */
  | "predicted";

/**
 * The settings of the `net.Replicated` component, registered by T11. It isn't registered yet, so
 * the editor's Add Component list doesn't offer a component that does nothing.
 */
export interface ReplicatedSettings {
  /** Default `"interpolated"`. */
  mode: ReplicationMode;
  /** The owning connection's id on the server (0: the server owns it). Owners can send inputs for it. */
  owner: number;
  /** Relative send priority when bandwidth is short (1 = normal). */
  importance: number;
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
 * Mark a data component as replicated.
 *
 * ```ts
 * export const Health = defineComponent("game.Health", { current: f32, max: f32 });
 * replicate(Health, { encoding: { current: { quantize: 0.1 } } });
 * ```
 */
export function replicate(def: DataComponentDef, options: DataReplication = {}): void {
  replicatedData.set(def, options);
}

/** @internal How a data component replicates, or null if it doesn't. */
export function replicationOf(def: DataComponentDef): DataReplication | null {
  return replicatedData.get(def) ?? null;
}
