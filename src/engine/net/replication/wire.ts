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
  /** Instantiate `path`, under the parent its structure names. */
  | { readonly kind: 0; readonly path: string }
  /** A scene-placed node: the `occurrence`-th loaded scene of `source` (0 = first), then node ids down from it. */
  | { readonly kind: 1; readonly source: string; readonly occurrence: number; readonly ids: readonly string[] }
  /** A node inside ghost `owner`'s prefab instance, by node ids down from it. */
  | { readonly kind: 2; readonly owner: number; readonly ids: readonly string[] };

export const SPAWN_PREFAB = 0;
export const SPAWN_SCENE = 1;
export const SPAWN_NESTED = 2;

/**
 * Where a ghost's node sits (ADR 0100): the parent clients put it under.
 * - `scene`: the client's active scene (the server's parent is nothing clients can find).
 * - `root`: the World root.
 * - `ghost`: the node at `ids` (node ids) below ghost `id`'s node; `[]` is that node itself.
 * - `node`: a scene-placed node that isn't a ghost (a "Projectiles" container), found like a scene ghost.
 */
export type ParentRef =
  | { readonly kind: 0 }
  | { readonly kind: 1 }
  | { readonly kind: 2; readonly id: number; readonly ids: readonly string[] }
  | { readonly kind: 3; readonly source: string; readonly occurrence: number; readonly ids: readonly string[] };

export const PARENT_SCENE = 0;
export const PARENT_ROOT = 1;
export const PARENT_GHOST = 2;
export const PARENT_NODE = 3;

/**
 * A ghost's structure (ADR 0100): its node's own active flag and its parent. `version` counts
 * changes on the server (0 at first sight); `parent` null means "where the client finds it" (a
 * scene or nested ghost that hasn't been reparented). `tick` is the server tick it changed at.
 */
export interface Structure {
  readonly version: number;
  readonly tick: number;
  readonly active: boolean;
  readonly parent: ParentRef | null;
  /**
   * Sibling order (ADR 0121): the id of the nearest ghost before it among its siblings, 0 when no
   * sibling ghost comes before it, or `AFTER_UNSPECIFIED` (where the client finds it: a scene or
   * nested ghost whose order hasn't changed).
   */
  readonly after: number;
  /** The layout's behaviors that are disabled (ADR 0121), by component id and index, sorted. */
  readonly disabled: readonly ComponentRef[];
}

/** A behavior on a ghost's node: its component id and which of the node's components of that class (0 = first). */
export interface ComponentRef {
  readonly id: string;
  readonly index: number;
}

/** `Structure.after` when the order isn't specified. */
export const AFTER_UNSPECIFIED = -1;

/** Whether two structures' sibling order and disabled lists are the same. */
export function sameOrderAndEnabled(a: Structure, b: { after: number; disabled: readonly ComponentRef[] }): boolean {
  return a.after === b.after && a.disabled.length === b.disabled.length && a.disabled.every((d, i) => d.id === b.disabled[i].id && d.index === b.disabled[i].index);
}

/** Strings in a spawn go through the connection's string table (ADR 0100): these write and read one. */
export type WriteString = (w: BitWriter, s: string) => void;
export type ReadString = (r: BitReader) => string;

/** A plain string, no table. */
export const plainWrite: WriteString = (w, s) => w.writeString(s);
export const plainRead: ReadString = (r) => r.readString();

export function writeSpawn(w: BitWriter, spawn: SpawnInfo, spec: LayoutSpec, str: WriteString): void {
  w.writeBits(spawn.kind, 2);
  if (spawn.kind === SPAWN_PREFAB) {
    str(w, spawn.path);
  } else if (spawn.kind === SPAWN_SCENE) {
    str(w, spawn.source);
    w.writeVarUint(spawn.occurrence);
    writeStrings(w, spawn.ids, str);
  } else {
    w.writeVarUint(spawn.owner);
    writeStrings(w, spawn.ids, str);
  }
  writeSpec(w, spec, str);
}

/** A layout spec (in spawns and relayouts, ADR 0121). */
export function writeSpec(w: BitWriter, spec: LayoutSpec, str: WriteString): void {
  w.writeBool(spec.transform);
  w.writeVarUint(spec.data.length);
  for (const d of spec.data) {
    str(w, d.id);
    writeShapes(w, d.fields);
  }
  w.writeVarUint(spec.behaviors.length);
  for (const b of spec.behaviors) {
    str(w, b.id);
    w.writeVarUint(b.index);
    writeShapes(w, b.fields);
  }
}

export function readSpawn(r: BitReader, str: ReadString): { spawn: SpawnInfo; spec: LayoutSpec } {
  const kind = r.readBits(2);
  let spawn: SpawnInfo;
  if (kind === SPAWN_PREFAB) spawn = { kind, path: str(r) };
  else if (kind === SPAWN_SCENE) spawn = { kind, source: str(r), occurrence: r.readVarUint(), ids: readStrings(r, str) };
  else if (kind === SPAWN_NESTED) spawn = { kind, owner: r.readVarUint(), ids: readStrings(r, str) };
  else throw new RangeError(`unknown spawn kind ${kind}`);
  return { spawn, spec: readSpec(r, str) };
}

export function readSpec(r: BitReader, str: ReadString): LayoutSpec {
  const transform = r.readBool();
  const dataCount = r.readVarUint();
  if (dataCount > 1024) throw new RangeError("too many replicated data components");
  const data: { id: string; fields: FieldShape[] }[] = [];
  for (let i = 0; i < dataCount; i++) data.push({ id: str(r), fields: readShapes(r) });
  const count = r.readVarUint();
  if (count > 1024) throw new RangeError("too many replicated behaviors");
  const behaviors: { id: string; index: number; fields: FieldShape[] }[] = [];
  for (let i = 0; i < count; i++) behaviors.push({ id: str(r), index: r.readVarUint(), fields: readShapes(r) });
  return { transform, data, behaviors };
}

/** A structure, in a snapshot for tick `tick`: version, the tick gap back to its change, active, its parent (a bit, then the ref), `after + 1`, then the disabled components (ADR 0121). */
export function writeStructure(w: BitWriter, s: Structure, tick: number, str: WriteString): void {
  w.writeVarUint(s.version);
  w.writeVarUint(Math.max(0, tick - s.tick));
  w.writeBool(s.active);
  w.writeBool(s.parent !== null);
  if (s.parent) writeParent(w, s.parent, str);
  w.writeVarUint(s.after + 1);
  w.writeVarUint(s.disabled.length);
  for (const d of s.disabled) {
    str(w, d.id);
    w.writeVarUint(d.index);
  }
}

export function readStructure(r: BitReader, tick: number, str: ReadString): Structure {
  const version = r.readVarUint();
  const at = tick - r.readVarUint();
  const active = r.readBool();
  const parent = r.readBool() ? readParent(r, str) : null;
  const after = r.readVarUint() - 1;
  const n = r.readVarUint();
  if (n > 1024) throw new RangeError("too many disabled components");
  const disabled: ComponentRef[] = [];
  for (let i = 0; i < n; i++) disabled.push({ id: str(r), index: r.readVarUint() });
  return { version, tick: at, active, parent, after, disabled };
}

function writeParent(w: BitWriter, p: ParentRef, str: WriteString): void {
  w.writeBits(p.kind, 2);
  if (p.kind === PARENT_GHOST) {
    w.writeVarUint(p.id);
    writeStrings(w, p.ids, str);
  } else if (p.kind === PARENT_NODE) {
    str(w, p.source);
    w.writeVarUint(p.occurrence);
    writeStrings(w, p.ids, str);
  }
}

function readParent(r: BitReader, str: ReadString): ParentRef {
  const kind = r.readBits(2);
  if (kind === PARENT_SCENE || kind === PARENT_ROOT) return { kind };
  if (kind === PARENT_GHOST) return { kind, id: r.readVarUint(), ids: readStrings(r, str) };
  return { kind: PARENT_NODE, source: str(r), occurrence: r.readVarUint(), ids: readStrings(r, str) };
}

/** Whether two parent refs name the same place. */
export function sameParent(a: ParentRef | null, b: ParentRef | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === PARENT_GHOST) return a.id === (b as typeof a).id && sameIds(a.ids, (b as typeof a).ids);
  if (a.kind === PARENT_NODE) {
    const o = b as typeof a;
    return a.source === o.source && a.occurrence === o.occurrence && sameIds(a.ids, o.ids);
  }
  return true;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// --- the per-connection string table (ADR 0100) --------------------------------------------------

/** Entries a connection's string table holds at most; later strings go inline every time. */
export const MAX_TABLE_STRINGS = 4096;

/**
 * The server's string table for one connection. A string is sent inline with an index the first
 * times (`2i + 1`, then the string), and as its index alone (`2i + 2`) once the client acked a
 * snapshot that defined it; `0` is an inline string with no index (the table is full).
 */
export class StringTableOut {
  private readonly entries = new Map<string, { index: number; acked: boolean }>();
  private readonly byIndex: string[] = [];

  /** A writer that records the indexes it defines in `defined`. */
  writer(defined: number[]): WriteString {
    return (w, s) => {
      let e = this.entries.get(s);
      if (!e && this.byIndex.length < MAX_TABLE_STRINGS) {
        e = { index: this.byIndex.length, acked: false };
        this.entries.set(s, e);
        this.byIndex.push(s);
      }
      if (!e) {
        w.writeVarUint(0);
        w.writeString(s);
      } else if (e.acked) {
        w.writeVarUint(2 * e.index + 2);
      } else {
        w.writeVarUint(2 * e.index + 1);
        w.writeString(s);
        defined.push(e.index);
      }
    };
  }

  /** The client read a snapshot that defined these indexes. */
  acked(indexes: readonly number[]): void {
    for (const i of indexes) {
      const s = this.byIndex[i];
      if (s !== undefined) this.entries.get(s)!.acked = true;
    }
  }

  /** @internal Tests: entries, and how many are acked. */
  get size(): { entries: number; acked: number } {
    let acked = 0;
    for (const e of this.entries.values()) if (e.acked) acked++;
    return { entries: this.entries.size, acked };
  }
}

/** The client's string table for its connection. */
export class StringTableIn {
  private readonly table: string[] = [];

  readonly read: ReadString = (r) => {
    const v = r.readVarUint();
    if (v === 0) return r.readString();
    const index = (v - 1) >> 1;
    if (index >= MAX_TABLE_STRINGS) throw new RangeError(`string table index ${index} is out of range`);
    if (v % 2 === 1) {
      const s = r.readString();
      this.table[index] = s;
      return s;
    }
    const s = this.table[index];
    if (s === undefined) throw new RangeError(`string table index ${index} was never defined`);
    return s;
  };

  clear(): void {
    this.table.length = 0;
  }
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

function writeStrings(w: BitWriter, list: readonly string[], str: WriteString): void {
  w.writeVarUint(list.length);
  for (const s of list) str(w, s);
}

function readStrings(r: BitReader, str: ReadString): string[] {
  const n = r.readVarUint();
  if (n > 1024) throw new RangeError("too many strings");
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(str(r));
  return out;
}
