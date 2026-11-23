// The animation records a take holds besides `ANIM_FRAME` (ADR 0348, 0373; T73): `ANIM_TARGET`, `ANIM_KEY`, `ANIM_RAW`
// and `ANIM_SELECT` (types in `frameRecord.ts`). Pure codecs over record payloads, little-endian; strings are a u16 byte
// length then UTF-8. Decoding is untrusted input: every length is checked before use, counts and strings are capped, and
// a payload that doesn't read back is refused (`{ refused }`) rather than misread.
//
//   ANIM_SELECT  u16 target
//   ANIM_TARGET  u16 target, text label, text graph, u32 graphHash, u32 bones, u32 n, n bytes of JSON (the graph's tables)
//   ANIM_KEY     i32 index, u32 n, n bytes (the instance snapshot before frame `index` applied)
//   ANIM_RAW     i32 index, u8 before, then that many rows, then the frame's own row
//     row        u8 pass, f64 dt, f64 du, u8 flags (1 complete, 2 input same as the previous row, 4 blackboard same,
//                8 rig same), then each of input / blackboard / rig that isn't "same" (their strides), u32 n and u16 s,
//                then n bytes of commands and s u32 record starts
//
// A "same" row repeats the previous row written for the Animator (rows change rarely: a blackboard row only when a
// parameter was set), so a take of a long run stays small. The encoder and decoder each keep that previous row.
import type { CompiledAnimGraph } from "../../../../../engine/animation/graphCompile";
import { INPUT_STRIDE } from "../../wasm/wire/core";
import { BLACKBOARD_STRIDE } from "../../wasm/wire/graph";
import { RIG_INPUT_STRIDE } from "../../wasm/wire/rig";
import type { RawFrame } from "./recorder";

/** A string's cap, UTF-8 bytes. */
export const TAKE_TEXT_MAX_BYTES = 1024;
/** The graph tables' JSON cap, bytes (a record is at most 256 KB). */
export const TAKE_TABLES_MAX_BYTES = 192 * 1024;
/** Rows kept ahead of a frame (evaluates of the other pass it replays first); a frame with more isn't replayable. */
export const TAKE_MAX_BEFORE = 16;
/** One row's command bytes and record count caps. */
export const TAKE_MAX_COMMAND_BYTES = 16 * 1024;
export const TAKE_MAX_COMMANDS = 1024;
/** The most Animators one take records. */
export const TAKE_MAX_TARGETS = 16;

const FLAG_COMPLETE = 1;
const FLAG_INPUT_SAME = 2;
const FLAG_BLACKBOARD_SAME = 4;
const FLAG_RIG_SAME = 8;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Bad extends Error {}

class Out {
  private bytes = new Uint8Array(512);
  private view = new DataView(this.bytes.buffer);
  at = 0;
  private room(n: number): void {
    if (this.at + n <= this.bytes.byteLength) return;
    const grown = new Uint8Array(Math.max(this.bytes.byteLength * 2, this.at + n));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
  u8(n: number): void { this.room(1); this.view.setUint8(this.at, n); this.at += 1; }
  u16(n: number): void { this.room(2); this.view.setUint16(this.at, n, true); this.at += 2; }
  u32(n: number): void { this.room(4); this.view.setUint32(this.at, n >>> 0, true); this.at += 4; }
  i32(n: number): void { this.room(4); this.view.setInt32(this.at, n | 0, true); this.at += 4; }
  f64(x: number): void { this.room(8); this.view.setFloat64(this.at, x, true); this.at += 8; }
  raw(b: Uint8Array): void { this.room(b.byteLength); this.bytes.set(b, this.at); this.at += b.byteLength; }
  text(s: string): void {
    let b = enc.encode(s);
    if (b.byteLength > TAKE_TEXT_MAX_BYTES) {
      let end = TAKE_TEXT_MAX_BYTES;
      while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
      b = b.subarray(0, end);
    }
    this.u16(b.byteLength);
    this.raw(b);
  }
  done(): Uint8Array { return this.bytes.slice(0, this.at); }
}

class In {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get left(): number { return this.bytes.byteLength - this.at; }
  private need(n: number): void { if (this.at + n > this.bytes.byteLength) throw new Bad(`cut off at byte ${this.at}`); }
  u8(): number { this.need(1); return this.view.getUint8(this.at++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.at, true); this.at += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.at, true); this.at += 8; return v; }
  raw(n: number): Uint8Array { this.need(n); const b = this.bytes.subarray(this.at, this.at + n); this.at += n; return b; }
  text(): string {
    const n = this.u16();
    if (n > TAKE_TEXT_MAX_BYTES) throw new Bad(`a string of ${n} bytes`);
    try {
      return dec.decode(this.raw(n));
    } catch (err) {
      if (err instanceof Bad) throw err;
      throw new Bad("a string isn't UTF-8");
    }
  }
}

const refusal = (what: string, err: unknown): { refused: string } => {
  if (err instanceof Bad) return { refused: `an animation ${what} record doesn't read: ${err.message}` };
  throw err;
};

// --- ANIM_SELECT -------------------------------------------------------------------------------------------------------

export function encodeSelect(target: number): Uint8Array {
  const o = new Out();
  o.u16(target);
  return o.done();
}

export function decodeSelect(payload: Uint8Array): { target: number } | { refused: string } {
  try {
    return { target: new In(payload).u16() };
  } catch (err) {
    return refusal("select", err);
  }
}

// --- ANIM_TARGET -------------------------------------------------------------------------------------------------------

/** An Animator a take recorded. */
export interface TakeTargetInfo {
  readonly id: number;
  readonly label: string;
  /** The graph asset (project path). */
  readonly graph: string;
  /** A hash of the compiled graph's bytes when recording (`graphHash`), to tell whether the graph changed. */
  readonly graphHash: number;
  /** Bones of the skeleton it ran on. */
  readonly bones: number;
  /** The graph's compiled tables, without its bytes and problems. */
  readonly tables: CompiledAnimGraph;
}

/** 32-bit FNV-1a of `bytes` (a compiled graph's identity; null: 0). */
export function graphHash(bytes: Uint8Array | null): number {
  if (!bytes) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The tables as a take keeps them: no bytes, no problems. */
export function takeTables(tables: CompiledAnimGraph): CompiledAnimGraph {
  return { ...tables, bytes: null, problems: [] };
}

/** `info` as an `ANIM_TARGET` payload, or null when its tables are past the cap. */
export function encodeTarget(info: TakeTargetInfo): Uint8Array | null {
  const json = enc.encode(JSON.stringify(takeTables(info.tables)));
  if (json.byteLength > TAKE_TABLES_MAX_BYTES) return null;
  const o = new Out();
  o.u16(info.id);
  o.text(info.label);
  o.text(info.graph);
  o.u32(info.graphHash);
  o.u32(info.bones);
  o.u32(json.byteLength);
  o.raw(json);
  return o.done();
}

const STRING_LISTS = ["strings", "nodes", "parameters", "slots", "linked", "layers", "ikTargets", "transitions", "conditions"] as const;

/** Checks the shape of the tables a take holds (lists of strings, machines with state names) and fills what's missing. */
function readTables(value: unknown): CompiledAnimGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Bad("the tables aren't an object");
  const t = value as Record<string, unknown>;
  const out: Record<string, unknown> = { bytes: null, ok: true, problems: [], bindings: Array.isArray(t.bindings) ? t.bindings : [], rays: typeof t.rays === "number" ? t.rays : 0 };
  for (const k of STRING_LISTS) {
    const list = t[k];
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string")) throw new Bad(`tables.${k} isn't a list of strings`);
    out[k] = list;
  }
  const machines = t.machines;
  if (!Array.isArray(machines)) throw new Bad("tables.machines isn't a list");
  out.machines = machines.map((m) => {
    const r = m as { node?: unknown; states?: unknown };
    if (!r || typeof r.node !== "string" || !Array.isArray(r.states) || r.states.some((s) => typeof s !== "string")) throw new Bad("a machine in the tables doesn't read");
    return { node: r.node, states: r.states };
  });
  return out as unknown as CompiledAnimGraph;
}

export function decodeTarget(payload: Uint8Array): { target: TakeTargetInfo } | { refused: string } {
  const i = new In(payload);
  try {
    const id = i.u16();
    const label = i.text();
    const graph = i.text();
    const hash = i.u32();
    const bones = i.u32();
    const n = i.u32();
    if (n > TAKE_TABLES_MAX_BYTES || n > i.left) throw new Bad(`tables of ${n} bytes`);
    let json: unknown;
    try {
      json = JSON.parse(dec.decode(i.raw(n)));
    } catch {
      throw new Bad("the tables aren't JSON");
    }
    return { target: { id, label, graph, graphHash: hash, bones, tables: readTables(json) } };
  } catch (err) {
    return refusal("target", err);
  }
}

// --- ANIM_KEY ----------------------------------------------------------------------------------------------------------

export function encodeKey(index: number, snapshot: Uint8Array): Uint8Array {
  const o = new Out();
  o.i32(index);
  o.u32(snapshot.byteLength);
  o.raw(snapshot);
  return o.done();
}

export function decodeKey(payload: Uint8Array): { index: number; snapshot: Uint8Array } | { refused: string } {
  const i = new In(payload);
  try {
    const index = i.i32();
    const n = i.u32();
    if (n > i.left) throw new Bad(`a snapshot of ${n} bytes`);
    return { index, snapshot: i.raw(n).slice() };
  } catch (err) {
    return refusal("key", err);
  }
}

// --- ANIM_RAW ----------------------------------------------------------------------------------------------------------

/** What the encoder and decoder compare each row with: the previous row of the Animator. */
interface Previous {
  input: Uint8Array | null;
  blackboard: Uint8Array | null;
  rig: Uint8Array | null;
}

const same = (a: Uint8Array | null, b: Uint8Array): boolean => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Writes the `ANIM_RAW` payloads of one Animator (it remembers the previous row). */
export class RawEncoder {
  private readonly prev: Previous = { input: null, blackboard: null, rig: null };

  /** The payload for frame `index`'s row `raw` and the rows `before` it, or null when a row doesn't fit the caps. */
  encode(index: number, raw: RawFrame, before: readonly RawFrame[]): Uint8Array | null {
    const rows = [...before, raw];
    for (const r of rows) {
      if (r.commands.byteLength > TAKE_MAX_COMMAND_BYTES || r.starts.length > TAKE_MAX_COMMANDS) return null;
    }
    // A frame with more rows ahead of it than the cap isn't replayable: its own row goes out marked incomplete.
    const ahead = before.length > TAKE_MAX_BEFORE ? [] : before;
    const o = new Out();
    o.i32(index);
    o.u8(ahead.length);
    for (const r of ahead) this.row(o, r, r.complete);
    this.row(o, raw, raw.complete && before.length <= TAKE_MAX_BEFORE);
    return o.done();
  }

  private row(o: Out, r: RawFrame, complete: boolean): void {
    const inputSame = same(this.prev.input, r.input);
    const blackboardSame = same(this.prev.blackboard, r.blackboard);
    const rigSame = same(this.prev.rig, r.rig);
    o.u8(r.pass);
    o.f64(r.dt);
    o.f64(r.du);
    o.u8((complete ? FLAG_COMPLETE : 0) | (inputSame ? FLAG_INPUT_SAME : 0) | (blackboardSame ? FLAG_BLACKBOARD_SAME : 0) | (rigSame ? FLAG_RIG_SAME : 0));
    if (!inputSame) o.raw(r.input);
    if (!blackboardSame) o.raw(r.blackboard);
    if (!rigSame) o.raw(r.rig);
    o.u32(r.commands.byteLength);
    o.u16(r.starts.length);
    o.raw(r.commands);
    for (const s of r.starts) o.u32(s);
    this.prev.input = r.input;
    this.prev.blackboard = r.blackboard;
    this.prev.rig = r.rig;
  }
}

/** Reads the `ANIM_RAW` payloads of one Animator in the order they were written. */
export class RawDecoder {
  private readonly prev: Previous = { input: null, blackboard: null, rig: null };

  decode(payload: Uint8Array): { index: number; raw: RawFrame; before: RawFrame[] } | { refused: string } {
    const i = new In(payload);
    try {
      const index = i.i32();
      const count = i.u8();
      if (count > TAKE_MAX_BEFORE) throw new Bad(`${count} rows ahead`);
      const before: RawFrame[] = [];
      for (let k = 0; k < count; k++) before.push(this.row(i));
      return { index, before, raw: this.row(i) };
    } catch (err) {
      return refusal("raw", err);
    }
  }

  private row(i: In): RawFrame {
    const pass = i.u8();
    const dt = i.f64();
    const du = i.f64();
    if (!Number.isFinite(dt) || !Number.isFinite(du)) throw new Bad("a time step isn't finite");
    const flags = i.u8();
    const take = (flag: number, prev: Uint8Array | null, stride: number): Uint8Array => {
      if (flags & flag) {
        if (!prev) throw new Bad("a row repeats a row that wasn't written");
        return prev;
      }
      return i.raw(stride).slice();
    };
    const input = take(FLAG_INPUT_SAME, this.prev.input, INPUT_STRIDE);
    const blackboard = take(FLAG_BLACKBOARD_SAME, this.prev.blackboard, BLACKBOARD_STRIDE);
    const rig = take(FLAG_RIG_SAME, this.prev.rig, RIG_INPUT_STRIDE);
    const n = i.u32();
    const s = i.u16();
    if (n > TAKE_MAX_COMMAND_BYTES || s > TAKE_MAX_COMMANDS) throw new Bad(`${n} command bytes, ${s} commands`);
    const commands = i.raw(n).slice();
    const starts: number[] = [];
    for (let k = 0; k < s; k++) {
      const at = i.u32();
      if (at + 4 > n) throw new Bad("a command starts outside the commands");
      starts.push(at);
    }
    this.prev.input = input;
    this.prev.blackboard = blackboard;
    this.prev.rig = rig;
    return { pass, dt, du, input, blackboard, rig, commands, starts, complete: (flags & FLAG_COMPLETE) !== 0 };
  }
}
