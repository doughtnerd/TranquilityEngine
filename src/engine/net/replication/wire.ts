/**
 * What replication's two message kinds carry (ADR 0033, T11), shared by the server and client
 * halves. The layout of a snapshot is at the top of `server.ts`.
 */
import type { BitReader, BitWriter } from "../codec";
import { registerNetMessage } from "../session";
import type { FieldShape, LayoutSpec } from "./layout";

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
  /**
   * Instantiate `path`. `parent`: 0 the active scene, 1 the World root, n + 2 ghost n's node.
   * `parentNode`: a scene-placed parent that isn't a ghost (a "Projectiles" container), found
   * like a scene ghost; it overrides `parent` when the client finds it.
   */
  | { readonly kind: 0; readonly path: string; readonly parent: number; readonly parentNode?: { readonly source: string; readonly occurrence: number; readonly ids: readonly string[] } }
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
    w.writeBool(!!spawn.parentNode);
    if (spawn.parentNode) {
      w.writeString(spawn.parentNode.source);
      w.writeVarUint(spawn.parentNode.occurrence);
      writeStrings(w, spawn.parentNode.ids);
    }
  } else if (spawn.kind === SPAWN_SCENE) {
    w.writeString(spawn.source);
    w.writeVarUint(spawn.occurrence);
    writeStrings(w, spawn.ids);
  } else {
    w.writeVarUint(spawn.owner);
    writeStrings(w, spawn.ids);
  }
  w.writeBool(spec.transform);
  w.writeVarUint(spec.data.length);
  for (const d of spec.data) {
    w.writeString(d.id);
    writeShapes(w, d.fields);
  }
  w.writeVarUint(spec.behaviors.length);
  for (const b of spec.behaviors) {
    w.writeString(b.id);
    w.writeVarUint(b.index);
    writeShapes(w, b.fields);
  }
}

export function readSpawn(r: BitReader): { spawn: SpawnInfo; spec: LayoutSpec } {
  const kind = r.readBits(2);
  let spawn: SpawnInfo;
  if (kind === SPAWN_PREFAB) {
    const path = r.readString();
    const parent = r.readVarUint();
    spawn = r.readBool() ? { kind, path, parent, parentNode: { source: r.readString(), occurrence: r.readVarUint(), ids: readStrings(r) } } : { kind, path, parent };
  }
  else if (kind === SPAWN_SCENE) spawn = { kind, source: r.readString(), occurrence: r.readVarUint(), ids: readStrings(r) };
  else if (kind === SPAWN_NESTED) spawn = { kind, owner: r.readVarUint(), ids: readStrings(r) };
  else throw new RangeError(`unknown spawn kind ${kind}`);
  const transform = r.readBool();
  const dataCount = r.readVarUint();
  if (dataCount > 1024) throw new RangeError("too many replicated data components");
  const data: { id: string; fields: FieldShape[] }[] = [];
  for (let i = 0; i < dataCount; i++) data.push({ id: r.readString(), fields: readShapes(r) });
  const count = r.readVarUint();
  if (count > 1024) throw new RangeError("too many replicated behaviors");
  const behaviors: { id: string; index: number; fields: FieldShape[] }[] = [];
  for (let i = 0; i < count; i++) behaviors.push({ id: r.readString(), index: r.readVarUint(), fields: readShapes(r) });
  return { spawn, spec: { transform, data, behaviors } };
}

const SHAPE_KINDS: readonly FieldShape["kind"][] = ["f32", "i32", "u8"];

/** Field shapes: a count, then per field 2 bits of type and a quantize step (a bit, then float32). */
function writeShapes(w: BitWriter, fields: readonly FieldShape[]): void {
  w.writeVarUint(fields.length);
  for (const f of fields) {
    w.writeBits(SHAPE_KINDS.indexOf(f.kind), 2);
    w.writeBool(f.quantize > 0);
    if (f.quantize > 0) w.writeFloat32(f.quantize);
  }
}

function readShapes(r: BitReader): FieldShape[] {
  const n = r.readVarUint();
  if (n > 1024) throw new RangeError("too many replicated fields");
  const out: FieldShape[] = [];
  for (let i = 0; i < n; i++) {
    const kind = SHAPE_KINDS[r.readBits(2)];
    if (!kind) throw new RangeError("unknown field type");
    const quantize = r.readBool() ? r.readFloat32() : 0;
    if (!(quantize >= 0 && Number.isFinite(quantize))) throw new RangeError("bad quantize step");
    out.push({ kind, quantize });
  }
  return out;
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
