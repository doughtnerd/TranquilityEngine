// The meter pass (ADR 0157 task C1b; moved here and given a fuel mode by ADR 0352 §6 and 0358 §2): a post-link pass
// over a wasm binary that counts the instructions it executes, either up (the metered gate's `count` mode) or down
// against a budget that traps (`fuel` mode, the plugin effects' instruction budget). Plain JavaScript with no
// dependencies, so the audio build (`native/audio/build.mjs`, Node) and the engine (the plugin validator, in a browser)
// import the same file. Types: `meter.d.ts`.
//
// Segments. Every function body is cut into straight-line segments that end at a control instruction (loop, if, else,
// end, br, br_if, br_table, return, unreachable, the return calls). Branch targets (after `end`, after `loop`'s block
// type) and branch fall-throughs (after `br_if`, inside `if` and `else`) always start a segment, so the count is exact up
// to the one `end` of an `if` without an `else` taken on its false path. Every instruction weighs 1.
//
// - `count` (the default; the metered gate's, unchanged from `tools/audio-bench/meter.mjs`): one new mutable i64 global,
//   exported as `__metered_count`; each segment starts with `global.get c; i64.const n; i64.add; global.set c`.
// - `fuel` (0358 §2): one new mutable i32 global, initial 0, exported as `__fuel`; each segment starts with
//   `global.get f; i32.const n; i32.sub; global.set f`, so the fuel left after a call is the grant minus the exact count
//   the `count` mode reports. Function entries and loop headers then check, branch-free:
//   `global.get f; i32.const 31; i32.shr_s; i32.load8_u 0; drop` loads a byte from address 0 while fuel is ≥ 0 and from
//   0xFFFFFFFF once it is negative, which is out of bounds and traps. (The `if … unreachable` form cost +157% on a
//   tremolo in V8 12.4, B0 spike.) Every loop iteration and every call passes a check, so a runaway traps within one
//   loop body or one function's straight-line code of its budget. The load needs the module's own memory, capped below
//   4 GiB: the pass sets the memory's maximum to at most `maxPages` (default 65,535) and refuses imported, shared and
//   64-bit memories.
//
// The decoder reads the instruction set rustc emits for wasm32 with +simd128 (MVP, sign extension, saturating
// truncation, bulk memory, reference types, multi-value, SIMD and relaxed SIMD, tail calls) and throws on anything else
// (threads and atomics included), so a new instruction can't be skipped silently. `readModule` exposes what it decodes
// (types, imports, exports, memories, relaxed SIMD use) for the plugin validator. Custom sections are dropped.

/** Section ids (core spec order). */
const SEC = { custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6, export: 7, start: 8, element: 9, code: 10, data: 11, datacount: 12, tag: 13 };
/** Where a section sits in a module's required order (tag goes between memory and global). */
const ORDER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12, 11: 13 };
/** The counter's export name (`count` mode). */
export const COUNTER_EXPORT = "__metered_count";
/** The fuel global's export name (`fuel` mode). */
export const FUEL_EXPORT = "__fuel";
/** Bumped when the instrumentation's rules change (counts are only comparable within one version). */
export const METER_VERSION = 1;
/** The largest memory maximum the fuel check is sound for: 0xFFFFFFFF must stay out of bounds. */
const MAX_FUEL_PAGES = 65535;

/** Concatenates byte arrays (Uint8Array or number arrays) into one Uint8Array. */
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A cursor over `bytes`. */
class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }
  byte() {
    if (this.pos >= this.end) throw new Error(`meter: unexpected end of input at ${this.pos}`);
    return this.bytes[this.pos++];
  }
  /** An unsigned LEB128 (up to 32 bits used; longer encodings are read and their high bits ignored). */
  u32() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      if (shift < 32) result |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return result >>> 0;
    }
  }
  /** Skips any LEB128, signed or not. */
  skipLeb() {
    while (this.byte() & 0x80);
  }
  skip(n) {
    this.pos += n;
    if (this.pos > this.end) throw new Error("meter: unexpected end of input");
  }
  /** A wasm name (length-prefixed UTF-8). */
  name() {
    const n = this.u32();
    const start = this.pos;
    this.skip(n);
    return new TextDecoder().decode(this.bytes.subarray(start, start + n));
  }
}

/** Unsigned LEB128 of `n` (a non-negative integer below 2^53). */
function uleb(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return out;
}

/** Signed LEB128 of `n` (a safe integer). */
function sleb(n) {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

/** A wasm name (length-prefixed UTF-8). */
function name(s) {
  const b = new TextEncoder().encode(s);
  return [...uleb(b.length), ...b];
}

/** Skips a memarg (align, with the multi-memory bit 6 meaning a memory index follows, then the offset). */
function skipMemarg(r) {
  const align = r.u32();
  if (align & 0x40) r.u32();
  r.skipLeb();
}

/** Ends a straight-line segment: control transfers and branch targets. */
const ENDS_SEGMENT = new Set([0x00, 0x03, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x12, 0x13]);
/** `loop`: the segment after it is a loop header (a branch target every iteration passes). */
const LOOP = 0x03;

/**
 * Reads one instruction at `r`'s position (its immediates included); returns its opcode, with prefixed ones as
 * `prefix << 16 | sub`. Throws on an opcode outside the supported set.
 */
function skipInstruction(r) {
  const op = r.byte();
  switch (op) {
    case 0x02: // block
    case 0x03: // loop
    case 0x04: // if: a block type, an s33 (0x40, a value type, or a type index)
      r.skipLeb();
      return op;
    case 0x0c: // br
    case 0x0d: // br_if
    case 0x10: // call
    case 0x12: // return_call
    case 0x20: // local.get
    case 0x21: // local.set
    case 0x22: // local.tee
    case 0x23: // global.get
    case 0x24: // global.set
    case 0x25: // table.get
    case 0x26: // table.set
    case 0xd2: // ref.func
      r.u32();
      return op;
    case 0x0e: {
      // br_table
      const n = r.u32();
      for (let i = 0; i <= n; i++) r.u32();
      return op;
    }
    case 0x11: // call_indirect type table
    case 0x13: // return_call_indirect
      r.u32();
      r.u32();
      return op;
    case 0x1c: {
      // select with types
      const n = r.u32();
      for (let i = 0; i < n; i++) r.skipLeb();
      return op;
    }
    case 0x3f: // memory.size
    case 0x40: // memory.grow
      r.u32();
      return op;
    case 0x41: // i32.const
    case 0x42: // i64.const
      r.skipLeb();
      return op;
    case 0x43: // f32.const
      r.skip(4);
      return op;
    case 0x44: // f64.const
      r.skip(8);
      return op;
    case 0xd0: // ref.null heaptype
      r.skipLeb();
      return op;
    case 0xfc:
      return 0xfc0000 | skipFc(r);
    case 0xfd:
      return 0xfd0000 | skipFd(r);
    default:
      break;
  }
  if (op >= 0x28 && op <= 0x3e) {
    skipMemarg(r);
    return op;
  }
  // No immediates: unreachable, nop, else, end, return, drop, select, the numeric ops, sign extension, ref.is_null.
  if (op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b) return op;
  if (op >= 0x45 && op <= 0xc4) return op;
  if (op === 0xd1) return op;
  throw new Error(`meter: unsupported opcode 0x${op.toString(16)} at byte ${r.pos - 1}`);
}

/** The 0xFC prefix: saturating truncation, bulk memory, tables. Returns the sub-opcode. */
function skipFc(r) {
  const sub = r.u32();
  if (sub <= 7) return sub; // trunc_sat
  switch (sub) {
    case 8: // memory.init data mem
    case 10: // memory.copy mem mem
    case 12: // table.init elem table
    case 14: // table.copy table table
      r.u32();
      r.u32();
      return sub;
    case 9: // data.drop
    case 11: // memory.fill mem
    case 13: // elem.drop
    case 15: // table.grow
    case 16: // table.size
    case 17: // table.fill
      r.u32();
      return sub;
    default:
      throw new Error(`meter: unsupported opcode 0xfc ${sub} at byte ${r.pos}`);
  }
}

/** The first relaxed SIMD sub-opcode (0x100..0x113; they have no immediates). */
const RELAXED_SIMD_FIRST = 0x100;

/** The 0xFD prefix: SIMD (relaxed SIMD too, which has no immediates). Returns the sub-opcode. */
function skipFd(r) {
  const sub = r.u32();
  if (sub <= 11 || sub === 92 || sub === 93) {
    skipMemarg(r); // loads, stores, load_zero
  } else if (sub === 12 || sub === 13) {
    r.skip(16); // v128.const, i8x16.shuffle
  } else if (sub >= 21 && sub <= 34) {
    r.skip(1); // extract_lane, replace_lane
  } else if (sub >= 84 && sub <= 91) {
    skipMemarg(r); // load_lane, store_lane
    r.skip(1);
  } else if (sub > 0x113) {
    throw new Error(`meter: unsupported opcode 0xfd ${sub} at byte ${r.pos}`);
  }
  return sub;
}

/** `count`: `global.get g; i64.const n; i64.add; global.set g`. */
function increment(globalIndex, n) {
  const g = uleb(globalIndex);
  return [0x23, ...g, 0x42, ...sleb(n), 0x7c, 0x24, ...g];
}

/** `fuel`: `global.get g; i32.const n; i32.sub; global.set g`, then with `check` the branch-free trap on negative fuel. */
function decrement(globalIndex, n, check) {
  const g = uleb(globalIndex);
  const sub = [0x23, ...g, 0x41, ...sleb(n), 0x6b, 0x24, ...g];
  // global.get g; i32.const 31; i32.shr_s; i32.load8_u align=0 offset=0; drop
  return check ? [...sub, 0x23, ...g, 0x41, 31, 0x75, 0x2d, 0x00, 0x00, 0x1a] : sub;
}

/** One function body (without its size prefix) with the mode's prefixes; returns the new body. */
function meterBody(bytes, start, end, globalIndex, stats, fuel) {
  const r = new Reader(bytes, start, end);
  const groups = r.u32();
  for (let i = 0; i < groups; i++) {
    r.u32();
    r.skipLeb();
  }
  const out = [bytes.subarray(start, r.pos)];
  let segStart = r.pos;
  let count = 0;
  let check = true; // the function's entry
  const flush = (at, nextIsLoopHeader) => {
    if (count > 0) {
      if (fuel) {
        out.push(decrement(globalIndex, count, check));
        if (check) stats.checks++;
      } else out.push(increment(globalIndex, count));
      stats.segments++;
      stats.instructions += count;
    }
    out.push(bytes.subarray(segStart, at));
    segStart = at;
    count = 0;
    check = nextIsLoopHeader;
  };
  while (r.pos < end) {
    const op = skipInstruction(r);
    count++;
    // The body's final `end` closes the function: the last segment ends there, with nothing after it.
    if (ENDS_SEGMENT.has(op) || r.pos === end) flush(r.pos, op === LOOP);
  }
  if (r.pos !== end) throw new Error("meter: a function body overran its size");
  return concat(out);
}

/** Splits a module into sections `{ id, header, start, end }` (where the section begins, and its payload's bounds). */
function sections(bytes) {
  const u32le = (at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  if (bytes.length < 8 || u32le(0) !== 0x6d736100 || u32le(4) !== 1) throw new Error("meter: not a wasm 1 module");
  const r = new Reader(bytes, 8);
  const out = [];
  while (r.pos < bytes.length) {
    const header = r.pos;
    const id = r.byte();
    const size = r.u32();
    out.push({ id, header, start: r.pos, end: r.pos + size });
    r.skip(size);
  }
  return out;
}

/** A section with its id and size prefix. */
function section(id, payload) {
  return concat([[id, ...uleb(payload.length)], payload]);
}

/** Reads memory or table limits: `{ min, max, shared, memory64 }` (`max` null when absent). */
function readLimits(r) {
  const flags = r.u32();
  const memory64 = (flags & 4) !== 0;
  const big = () => {
    if (!memory64) return r.u32();
    r.skipLeb();
    return Infinity;
  };
  const min = big();
  const max = flags & 1 ? big() : null;
  return { min, max, shared: (flags & 2) !== 0, memory64 };
}

/** The import section's entries `{ module, name, kind, memory? }` (kind: function, table, memory, global, tag). */
function readImports(bytes, s) {
  if (!s) return [];
  const r = new Reader(bytes, s.start, s.end);
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const module = r.name();
    const field = r.name();
    const kind = r.byte();
    if (kind === 0x00) {
      r.u32(); // func: type index
      out.push({ module, name: field, kind: "function" });
    } else if (kind === 0x01) {
      r.skipLeb(); // table: reftype
      readLimits(r);
      out.push({ module, name: field, kind: "table" });
    } else if (kind === 0x02) {
      out.push({ module, name: field, kind: "memory", memory: readLimits(r) });
    } else if (kind === 0x03) {
      r.skipLeb(); // valtype
      r.byte(); // mutability
      out.push({ module, name: field, kind: "global" });
    } else if (kind === 0x04) {
      r.byte();
      r.u32(); // tag
      out.push({ module, name: field, kind: "tag" });
    } else throw new Error(`meter: unknown import kind ${kind}`);
  }
  return out;
}

const VALTYPES = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" };
const EXPORT_KINDS = ["function", "table", "memory", "global", "tag"];

function valtype(r) {
  const b = r.byte();
  const t = VALTYPES[b];
  if (!t) throw new Error(`meter: unsupported value type 0x${b.toString(16)}`);
  return t;
}

/**
 * Decodes `input` (a wasm module's bytes) without changing it: every section's layout and every function body's
 * instructions (throwing on one the pass doesn't support, as `meter` does). Returns `{ types, imports, functions,
 * exports, memories, start, relaxedSimd }`; see `meter.d.ts`.
 */
export function readModule(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const secs = sections(bytes);
  const find = (id) => secs.find((s) => s.id === id);
  const types = [];
  const ts = find(SEC.type);
  if (ts) {
    const r = new Reader(bytes, ts.start, ts.end);
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const form = r.byte();
      if (form !== 0x60) throw new Error(`meter: unsupported type form 0x${form.toString(16)}`);
      const params = [];
      const results = [];
      for (let k = r.u32(); k > 0; k--) params.push(valtype(r));
      for (let k = r.u32(); k > 0; k--) results.push(valtype(r));
      types.push({ params, results });
    }
  }
  const imports = readImports(bytes, find(SEC.import));
  const importedFunctionTypes = [];
  {
    const s = find(SEC.import);
    if (s) {
      const r = new Reader(bytes, s.start, s.end);
      for (let n = r.u32(); n > 0; n--) {
        r.name();
        r.name();
        const kind = r.byte();
        if (kind === 0x00) importedFunctionTypes.push(r.u32());
        else if (kind === 0x01) {
          r.skipLeb();
          readLimits(r);
        } else if (kind === 0x02) readLimits(r);
        else if (kind === 0x03) {
          r.skipLeb();
          r.byte();
        } else {
          r.byte();
          r.u32();
        }
      }
    }
  }
  const ownFunctionTypes = [];
  const fs = find(SEC.function);
  if (fs) {
    const r = new Reader(bytes, fs.start, fs.end);
    for (let n = r.u32(); n > 0; n--) ownFunctionTypes.push(r.u32());
  }
  const functions = [...importedFunctionTypes, ...ownFunctionTypes].map((t) => {
    if (!types[t]) throw new Error(`meter: function type ${t} doesn't exist`);
    return types[t];
  });
  const memories = imports.filter((i) => i.kind === "memory").map((i) => ({ ...i.memory, imported: true }));
  const ms = find(SEC.memory);
  if (ms) {
    const r = new Reader(bytes, ms.start, ms.end);
    for (let n = r.u32(); n > 0; n--) memories.push({ ...readLimits(r), imported: false });
  }
  const exports = [];
  const es = find(SEC.export);
  if (es) {
    const r = new Reader(bytes, es.start, es.end);
    for (let n = r.u32(); n > 0; n--) {
      const exportName = r.name();
      const kind = r.byte();
      const index = r.u32();
      exports.push({ name: exportName, kind: EXPORT_KINDS[kind] ?? "unknown", index });
    }
  }
  let relaxedSimd = false;
  const cs = find(SEC.code);
  if (cs) {
    const r = new Reader(bytes, cs.start, cs.end);
    for (let n = r.u32(); n > 0; n--) {
      const size = r.u32();
      const end = r.pos + size;
      const body = new Reader(bytes, r.pos, end);
      for (let g = body.u32(); g > 0; g--) {
        body.u32();
        body.skipLeb();
      }
      while (body.pos < end) {
        const op = skipInstruction(body);
        if (op >= (0xfd0000 | RELAXED_SIMD_FIRST) && op <= 0xfdffff) relaxedSimd = true;
      }
      if (body.pos !== end) throw new Error("meter: a function body overran its size");
      r.skip(size);
    }
  }
  return { types, imports, functions, exports, memories, start: find(SEC.start) !== undefined, relaxedSimd };
}

/**
 * The memory section with every memory's maximum capped at `maxPages` (fuel mode). Throws on a shared or 64-bit memory,
 * or one whose minimum is above the cap.
 */
function cappedMemorySection(bytes, s, maxPages) {
  const r = new Reader(bytes, s.start, s.end);
  const n = r.u32();
  const parts = [uleb(n)];
  for (let i = 0; i < n; i++) {
    const { min, max, shared, memory64 } = readLimits(r);
    if (shared) throw new Error("meter: fuel mode refuses a shared memory");
    if (memory64) throw new Error("meter: fuel mode refuses a 64-bit memory");
    if (min > maxPages) throw new Error(`meter: the memory's minimum (${min} pages) is above the cap of ${maxPages} pages`);
    parts.push([0x01, ...uleb(min), ...uleb(Math.min(max ?? maxPages, maxPages))]);
  }
  return section(SEC.memory, concat(parts));
}

/**
 * Instruments `input` (a wasm module's bytes). Returns `{ bytes, stats }`: the instrumented module and static counts,
 * `{ functions, segments, instructions }` (plus `checks` in fuel mode). `options.mode` is "count" (default) or "fuel";
 * `options.maxPages` caps the memory in fuel mode.
 */
export function meter(input, options = {}) {
  const mode = options.mode ?? "count";
  if (mode !== "count" && mode !== "fuel") throw new Error(`meter: unknown mode ${JSON.stringify(mode)}`);
  const fuel = mode === "fuel";
  const maxPages = options.maxPages ?? MAX_FUEL_PAGES;
  if (fuel && !(Number.isInteger(maxPages) && maxPages >= 0 && maxPages <= MAX_FUEL_PAGES)) throw new Error(`meter: maxPages must be an integer from 0 to ${MAX_FUEL_PAGES}`);
  const bytes = Uint8Array.from(input);
  const secs = sections(bytes);
  const find = (id) => secs.find((s) => s.id === id);
  if (secs.some((s) => s.id === SEC.export) === false) throw new Error("meter: the module has no export section");
  const imports = readImports(bytes, find(SEC.import));
  if (fuel) {
    if (imports.some((i) => i.kind === "memory")) throw new Error("meter: fuel mode needs the module's own memory, not an imported one");
    if (!find(SEC.memory)) throw new Error("meter: fuel mode needs a memory (its check is a load)");
  }
  const globalSec = find(SEC.global);
  const ownGlobals = globalSec ? new Reader(bytes, globalSec.start, globalSec.end).u32() : 0;
  const counter = imports.filter((i) => i.kind === "global").length + ownGlobals;
  const stats = fuel ? { functions: 0, segments: 0, instructions: 0, checks: 0 } : { functions: 0, segments: 0, instructions: 0 };

  // global: the existing entries plus `(mut i64) (i64.const 0)` (count) or `(mut i32) (i32.const 0)` (fuel).
  const newGlobal = fuel ? [0x7f, 0x01, 0x41, 0x00, 0x0b] : [0x7e, 0x01, 0x42, 0x00, 0x0b];
  let globalPayload;
  if (globalSec) {
    const r = new Reader(bytes, globalSec.start, globalSec.end);
    r.u32();
    globalPayload = concat([uleb(ownGlobals + 1), bytes.subarray(r.pos, globalSec.end), newGlobal]);
  } else {
    globalPayload = concat([uleb(1), newGlobal]);
  }

  // export: the existing entries plus the counter.
  const exportSec = find(SEC.export);
  const er = new Reader(bytes, exportSec.start, exportSec.end);
  const exports = er.u32();
  const exportPayload = concat([uleb(exports + 1), bytes.subarray(er.pos, exportSec.end), [...name(fuel ? FUEL_EXPORT : COUNTER_EXPORT), 0x03, ...uleb(counter)]]);

  // code: every body metered.
  const codeSec = find(SEC.code);
  const codeParts = [];
  if (codeSec) {
    const cr = new Reader(bytes, codeSec.start, codeSec.end);
    const bodies = cr.u32();
    codeParts.push(uleb(bodies));
    for (let i = 0; i < bodies; i++) {
      const size = cr.u32();
      const body = meterBody(bytes, cr.pos, cr.pos + size, counter, stats, fuel);
      codeParts.push(uleb(body.length), body);
      cr.skip(size);
      stats.functions++;
    }
  }

  // Reassemble in order, dropping custom sections and placing a new global section where it belongs.
  const out = [bytes.subarray(0, 8)];
  let globalWritten = false;
  const writeGlobal = () => {
    out.push(section(SEC.global, globalPayload));
    globalWritten = true;
  };
  for (const s of secs) {
    if (s.id === SEC.custom) continue;
    if (!globalWritten && ORDER[s.id] > ORDER[SEC.global]) writeGlobal();
    if (s.id === SEC.global) writeGlobal();
    else if (s.id === SEC.export) out.push(section(SEC.export, exportPayload));
    else if (s.id === SEC.code) out.push(section(SEC.code, concat(codeParts)));
    else if (s.id === SEC.memory && fuel) out.push(cappedMemorySection(bytes, s, maxPages));
    else out.push(bytes.subarray(s.header, s.end));
  }
  if (!globalWritten) writeGlobal();
  const result = concat(out);
  if (!WebAssembly.validate(result)) throw new Error(`meter: the ${fuel ? "fuelled" : "metered"} module doesn't validate`);
  return { bytes: result, stats };
}
