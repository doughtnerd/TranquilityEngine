/**
 * What replication's two message kinds carry (ADR 0033, T11), shared by the server and client
 * halves. The layout of a snapshot is at the top of `server.ts`.
 */
import type { BitReader, BitWriter } from "../codec";
import { registerNetMessage } from "../session";
import type { LayoutSpec } from "./layout";

/** Server → client, unreliable: one per peer per sent tick. */
export const SNAPSHOT = registerNetMessage("net.snapshot");
/** Client → server, unreliable: the newest snapshot tick received. */
export const ACK = registerNetMessage("net.snapshotAck");

/**
 * Baselines older than this many ticks aren't used (the ghost is sent whole instead), so both
 * ends keep a bounded history.
 */
export const BASELINE_WINDOW = 256;

/** Default snapshot budget in bytes; ghosts that don't fit go in a later snapshot. */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024;

/** How a client finds or makes a ghost's node. */
export type SpawnInfo =
  /** Instantiate `path`. `parent`: 0 the active scene, 1 the World root, n + 2 ghost n's node. */
  | { readonly kind: 0; readonly path: string; readonly parent: number }
  /** A scene-placed node: the `occurrence`-th loaded scene of `source` (0 = first), then node ids down from it. */
  | { readonly kind: 1; readonly source: string; readonly occurrence: number; readonly ids: readonly string[] }
  /** A node inside ghost `owner`'s prefab instance, by node ids down from it. */
  | { readonly kind: 2; readonly owner: number; readonly ids: readonly string[] };

export const SPAWN_PREFAB = 0;
export const SPAWN_SCENE = 1;
export const SPAWN_NESTED = 2;

export function writeSpawn(w: BitWriter, spawn: SpawnInfo, spec: LayoutSpec): void {
  w.writeBits(spawn.kind, 2);
  if (spawn.kind === SPAWN_PREFAB) {
    w.writeString(spawn.path);
    w.writeVarUint(spawn.parent);
  } else if (spawn.kind === SPAWN_SCENE) {
    w.writeString(spawn.source);
    w.writeVarUint(spawn.occurrence);
    writeStrings(w, spawn.ids);
  } else {
    w.writeVarUint(spawn.owner);
    writeStrings(w, spawn.ids);
  }
  w.writeBool(spec.transform);
  writeStrings(w, spec.data);
  w.writeVarUint(spec.behaviors.length);
  for (const b of spec.behaviors) {
    w.writeString(b.id);
    w.writeVarUint(b.index);
  }
}

export function readSpawn(r: BitReader): { spawn: SpawnInfo; spec: LayoutSpec } {
  const kind = r.readBits(2);
  let spawn: SpawnInfo;
  if (kind === SPAWN_PREFAB) spawn = { kind, path: r.readString(), parent: r.readVarUint() };
  else if (kind === SPAWN_SCENE) spawn = { kind, source: r.readString(), occurrence: r.readVarUint(), ids: readStrings(r) };
  else if (kind === SPAWN_NESTED) spawn = { kind, owner: r.readVarUint(), ids: readStrings(r) };
  else throw new RangeError(`unknown spawn kind ${kind}`);
  const transform = r.readBool();
  const data = readStrings(r);
  const count = r.readVarUint();
  if (count > 1024) throw new RangeError("too many replicated behaviors");
  const behaviors: { id: string; index: number }[] = [];
  for (let i = 0; i < count; i++) behaviors.push({ id: r.readString(), index: r.readVarUint() });
  return { spawn, spec: { transform, data, behaviors } };
}

function writeStrings(w: BitWriter, list: readonly string[]): void {
  w.writeVarUint(list.length);
  for (const s of list) w.writeString(s);
}

function readStrings(r: BitReader): string[] {
  const n = r.readVarUint();
  if (n > 1024) throw new RangeError("too many strings");
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(r.readString());
  return out;
}
