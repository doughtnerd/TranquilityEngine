// The `ANIM_FRAME` record (ADR 0373, 0376): one `AnimatorDebugFrame` as a record payload in the capture and take framing
// (audio 0348), so the debug link's animation topic, and later animation takes (T73), carry the same bytes. A pure codec.
//
// Payload, little-endian (strings: u16 byte length then UTF-8; values: a tag byte, see `putValue`):
//
//   f64 t                  the frame's time (seconds on the recording's unscaled clock), first as in every take record
//   i32 index              the frame's index in its recording
//   u32 reportBytes        then the debug report in the core's own wire form (the `debug` family: a header and records)
//   u16 parameters         then each parameter's value (tag 0: null)
//   u16 inputs             then each input: u8 kind, then its fields
//   u8  root               then that many f64 (translation xyz, rotation xyzw)
//
// Decoding is untrusted input: every length is checked before it's used, counts and strings are capped, and a payload
// that doesn't read back is refused (null) rather than misread.
import { putRecord } from "../../core/records";
import { DEBUG_HEADER, DEBUG_MACHINE, DEBUG_NODE, DEBUG_REQUEST, DEBUG_TRANSITION } from "../../wasm/wire/debug";
import type { AnimatorDebugFrame, DebugInput, DebugParamValue } from "./frame";
import { readDebugReport, type DebugReport } from "./report";

/** The record type (below 0x80, after audio's request records 0x10–0x1f; T73's take records reuse it). */
export const ANIM_FRAME = 0x40;
/**
 * The animation records a take holds beside `ANIM_FRAME` (ADR 0348, 0373; T73; payloads in `takeRecords.ts`). They sit in
 * the range plugins may write into a take (`engine/audio/take/extensions.ts`, 0x40..0x7e); a reader that doesn't know them
 * passes over them by length. The records of one Animator are written in this order each frame, and the records
 * after an `ANIM_TARGET` or `ANIM_SELECT` belong to the Animator it names, until the next one:
 *
 * | Record        | Type | Content                                                                              |
 * |---------------|------|--------------------------------------------------------------------------------------|
 * | `ANIM_FRAME`  | 0x40 | one `AnimatorDebugFrame` (this file): inputs, report, parameters, root motion         |
 * | `ANIM_TARGET` | 0x41 | declares an Animator: id, label, graph path, graph hash, bones, the graph's tables    |
 * | `ANIM_KEY`    | 0x42 | the instance's snapshot before the frame applied (a keyframe: replay can start here)  |
 * | `ANIM_RAW`    | 0x43 | the rows and commands the core applied that frame, so it can be re-evaluated          |
 * | `ANIM_SELECT` | 0x44 | the Animator the records after it belong to                                          |
 */
export const ANIM_TARGET = 0x41;
export const ANIM_KEY = 0x42;
export const ANIM_RAW = 0x43;
export const ANIM_SELECT = 0x44;
/** A string's cap, UTF-8 bytes (longer ones are cut on encode). */
export const FRAME_TEXT_MAX_BYTES = 1024;
/** Parameters (the blackboard holds 64) and inputs per frame. */
export const FRAME_MAX_PARAMETERS = 256;
export const FRAME_MAX_INPUTS = 4096;
/** Root motion floats (7). */
export const FRAME_MAX_ROOT = 16;
/** A vector parameter's components. */
const MAX_VECTOR = 16;

const INPUT_KINDS = ["param", "request", "travel", "jump", "slotPlay", "slotStop", "link", "layerWeight", "ik", "other"] as const;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Out {
  private bytes = new Uint8Array(256);
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
    if (b.byteLength > FRAME_TEXT_MAX_BYTES) {
      let end = FRAME_TEXT_MAX_BYTES;
      while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
      b = b.subarray(0, end);
    }
    this.u16(b.byteLength);
    this.raw(b);
  }
  done(): Uint8Array { return this.bytes.slice(0, this.at); }
}

class Bad extends Error {}

class In {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  private need(n: number): void { if (this.at + n > this.bytes.byteLength) throw new Bad(`cut off at byte ${this.at}`); }
  u8(): number { this.need(1); return this.view.getUint8(this.at++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.at, true); this.at += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.at, true); this.at += 8; return v; }
  raw(n: number): Uint8Array { this.need(n); const b = this.bytes.subarray(this.at, this.at + n); this.at += n; return b; }
  text(): string {
    const n = this.u16();
    if (n > FRAME_TEXT_MAX_BYTES) throw new Bad(`a string of ${n} bytes`);
    try {
      return dec.decode(this.raw(n));
    } catch (err) {
      if (err instanceof Bad) throw err;
      throw new Bad("a string isn't UTF-8");
    }
  }
  get left(): number { return this.bytes.byteLength - this.at; }
}

/** A value: 0 null, 1 a number (f64), 2 false, 3 true, 4 a vector (u8 n, n f64). */
function putValue(o: Out, v: DebugParamValue | null): void {
  if (v === null) o.u8(0);
  else if (typeof v === "number") { o.u8(1); o.f64(v); }
  else if (typeof v === "boolean") o.u8(v ? 3 : 2);
  else {
    const n = Math.min(v.length, MAX_VECTOR);
    o.u8(4); o.u8(n);
    for (let i = 0; i < n; i++) o.f64(v[i]!);
  }
}

function getValue(i: In): DebugParamValue | null {
  const tag = i.u8();
  if (tag === 0) return null;
  if (tag === 1) return i.f64();
  if (tag === 2 || tag === 3) return tag === 3;
  if (tag === 4) {
    const n = i.u8();
    if (n > MAX_VECTOR) throw new Bad(`a vector of ${n}`);
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(i.f64());
    return out;
  }
  throw new Bad(`value tag ${tag}`);
}

/** The report in the core's wire form (what `readDebugReport` reads). */
function reportBytes(r: DebugReport): Uint8Array {
  const recordBytes = r.nodes.length * DEBUG_NODE.stride + r.machines.length * DEBUG_MACHINE.stride + r.transitions.length * DEBUG_TRANSITION.stride + r.requests.length * DEBUG_REQUEST.stride;
  const out = new Uint8Array(DEBUG_HEADER.stride + recordBytes);
  const view = new DataView(out.buffer);
  let at = putRecord(view, 0, DEBUG_HEADER, { instance: r.instance, nodes: r.nodes.length, machines: r.machines.length, transitions: r.transitions.length, requests: r.requests.length, recordBytes, dropped: r.dropped });
  for (const n of r.nodes) at += putRecord(view, at, DEBUG_NODE, n);
  for (const m of r.machines) at += putRecord(view, at, DEBUG_MACHINE, m);
  for (const t of r.transitions) at += putRecord(view, at, DEBUG_TRANSITION, t);
  for (const q of r.requests) at += putRecord(view, at, DEBUG_REQUEST, q);
  return out;
}

/** `frame` as an `ANIM_FRAME` payload. */
export function encodeFrameRecord(frame: AnimatorDebugFrame): Uint8Array {
  const o = new Out();
  o.f64(frame.time);
  o.i32(frame.index);
  const report = reportBytes(frame.report);
  o.u32(report.byteLength);
  o.raw(report);
  const params = frame.parameters.slice(0, FRAME_MAX_PARAMETERS);
  o.u16(params.length);
  for (const p of params) putValue(o, p);
  const inputs = frame.inputs.slice(0, FRAME_MAX_INPUTS);
  o.u16(inputs.length);
  for (const input of inputs) {
    o.u8(INPUT_KINDS.indexOf(input.kind));
    switch (input.kind) {
      case "param": o.text(input.name); putValue(o, input.value); break;
      case "request": o.text(input.name); o.f64(input.lifetime); break;
      case "travel": case "jump": o.text(input.machine); o.text(input.state); break;
      case "slotPlay": o.text(input.slot); o.text(input.clip); break;
      case "slotStop": o.text(input.slot); break;
      case "link": o.text(input.linked); break;
      case "layerWeight": o.text(input.layer); o.f64(input.weight); break;
      case "ik": break;
      case "other": o.text(input.what); break;
    }
  }
  const root = frame.root.slice(0, FRAME_MAX_ROOT);
  o.u8(root.length);
  for (const x of root) o.f64(x);
  return o.done();
}

/** An `ANIM_FRAME` payload read back, or why it can't be. */
export function decodeFrameRecord(payload: Uint8Array): { frame: AnimatorDebugFrame } | { refused: string } {
  const i = new In(payload);
  try {
    const time = i.f64();
    if (!Number.isFinite(time)) throw new Bad("the time isn't finite");
    const index = i.i32();
    const n = i.u32();
    if (n > i.left) throw new Bad(`a report of ${n} bytes`);
    const raw = i.raw(n);
    const report = readDebugReport(new DataView(raw.buffer, raw.byteOffset, raw.byteLength), 0);
    const pc = i.u16();
    if (pc > FRAME_MAX_PARAMETERS) throw new Bad(`${pc} parameters`);
    const parameters: (DebugParamValue | null)[] = [];
    for (let k = 0; k < pc; k++) parameters.push(getValue(i));
    const ic = i.u16();
    if (ic > FRAME_MAX_INPUTS) throw new Bad(`${ic} inputs`);
    const inputs: DebugInput[] = [];
    for (let k = 0; k < ic; k++) {
      const kind = INPUT_KINDS[i.u8()];
      switch (kind) {
        case "param": inputs.push({ kind, name: i.text(), value: getValue(i) }); break;
        case "request": inputs.push({ kind, name: i.text(), lifetime: i.f64() }); break;
        case "travel": case "jump": inputs.push({ kind, machine: i.text(), state: i.text() }); break;
        case "slotPlay": inputs.push({ kind, slot: i.text(), clip: i.text() }); break;
        case "slotStop": inputs.push({ kind, slot: i.text() }); break;
        case "link": inputs.push({ kind, linked: i.text() }); break;
        case "layerWeight": inputs.push({ kind, layer: i.text(), weight: i.f64() }); break;
        case "ik": inputs.push({ kind }); break;
        case "other": inputs.push({ kind, what: i.text() }); break;
        default: throw new Bad("an unknown input kind");
      }
    }
    const rc = i.u8();
    if (rc > FRAME_MAX_ROOT) throw new Bad(`${rc} root floats`);
    const root: number[] = [];
    for (let k = 0; k < rc; k++) root.push(i.f64());
    return { frame: { index, time, report, parameters, inputs, root } };
  } catch (err) {
    if (err instanceof Bad) return { refused: `an animation frame record doesn't read: ${err.message}` };
    throw err;
  }
}
