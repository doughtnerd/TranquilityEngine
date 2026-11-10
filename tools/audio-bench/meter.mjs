// The audio core's metered build (ADR 0157 task C1b, architecture §6.5 "CI"): a post-link pass over a wasm binary
// that injects an instruction counter, so a benchmark counts deterministic work instead of wall time.
//
// `meter(bytes)` returns a copy of the module with one new mutable i64 global, exported as `__metered_count`, that
// grows by the number of wasm instructions executed. Every function body is cut into straight-line segments that end
// at a control instruction (loop, if, else, end, br, br_if, br_table, return, unreachable, the return calls); each
// segment starts with `global.get c; i64.const n; i64.add; global.set c`, where n is the segment's instruction count
// (its closing control instruction included). Branch targets (after `end`, after `loop`'s block type) and branch
// fall-throughs (after `br_if`, inside `if` and `else`) always start a segment, so the count is exact up to the one
// `end` of an `if` without an `else` taken on its false path. Every instruction weighs 1: a regression anywhere in the
// linked code (the core, the DSP, the allocator, memcpy) moves the count, not only where a counter was placed.
//
// The pass decodes the instruction set rustc emits for wasm32 with +simd128 (MVP, sign extension, saturating
// truncation, bulk memory, reference types, multi-value, SIMD, tail calls) and throws on anything else, so a new
// instruction can't be skipped silently. Custom sections (names, producers) are dropped. No dependencies.

/** Section ids (core spec order). */
const SEC = { custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6, export: 7, start: 8, element: 9, code: 10, data: 11, datacount: 12, tag: 13 };
/** Where a section sits in a module's required order (tag goes between memory and global). */
const ORDER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12, 11: 13 };
/** The counter's export name. */
export const COUNTER_EXPORT = "__metered_count";
/** Bumped when the instrumentation's rules change (counts are only comparable within one version). */
export const METER_VERSION = 1;

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
  const b = Buffer.from(s, "utf8");
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

/** `global.get g; i64.const n; i64.add; global.set g`. */
function increment(globalIndex, n) {
  const g = uleb(globalIndex);
  return [0x23, ...g, 0x42, ...sleb(n), 0x7c, 0x24, ...g];
}

/** One function body (without its size prefix) with the counter's increments; returns the new body. */
function meterBody(bytes, start, end, globalIndex, stats) {
  const r = new Reader(bytes, start, end);
  const groups = r.u32();
  for (let i = 0; i < groups; i++) {
    r.u32();
    r.skipLeb();
  }
  const out = [bytes.subarray(start, r.pos)];
  let segStart = r.pos;
  let count = 0;
  const flush = (at) => {
    if (count > 0) {
      out.push(Buffer.from(increment(globalIndex, count)));
      stats.segments++;
      stats.instructions += count;
    }
    out.push(bytes.subarray(segStart, at));
    segStart = at;
    count = 0;
  };
  while (r.pos < end) {
    const op = skipInstruction(r);
    count++;
    // The body's final `end` closes the function: the last segment ends there, with nothing after it.
    if (ENDS_SEGMENT.has(op) || r.pos === end) flush(r.pos);
  }
  if (r.pos !== end) throw new Error("meter: a function body overran its size");
  return Buffer.concat(out);
}

/** Splits a module into sections `{ id, header, start, end }` (where the section begins, and its payload's bounds). */
function sections(bytes) {
  if (bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) throw new Error("meter: not a wasm 1 module");
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
  return Buffer.concat([Buffer.from([id, ...uleb(payload.length)]), payload]);
}

/** Counts the imported globals (they come before the module's own in the global index space). */
function importedGlobals(bytes, s) {
  if (!s) return 0;
  const r = new Reader(bytes, s.start, s.end);
  const n = r.u32();
  let globals = 0;
  for (let i = 0; i < n; i++) {
    r.skip(r.u32()); // module
    r.skip(r.u32()); // field
    const kind = r.byte();
    if (kind === 0x00) r.u32(); // func: type index
    else if (kind === 0x01) {
      r.skipLeb(); // table: reftype
      const flags = r.u32();
      r.u32();
      if (flags & 1) r.u32();
    } else if (kind === 0x02) {
      const flags = r.u32();
      r.skipLeb();
      if (flags & 1) r.skipLeb();
    } else if (kind === 0x03) {
      r.skipLeb(); // valtype
      r.byte(); // mutability
      globals++;
    } else if (kind === 0x04) {
      r.byte();
      r.u32(); // tag
    } else throw new Error(`meter: unknown import kind ${kind}`);
  }
  return globals;
}

/**
 * Instruments `input` (a wasm module's bytes). Returns `{ bytes, stats }`: the metered module and
 * `{ functions, segments, instructions }` (static counts).
 */
export function meter(input) {
  const bytes = Buffer.from(input);
  const secs = sections(bytes);
  const find = (id) => secs.find((s) => s.id === id);
  if (secs.some((s) => s.id === SEC.export) === false) throw new Error("meter: the module has no export section");
  const globalSec = find(SEC.global);
  const ownGlobals = globalSec ? new Reader(bytes, globalSec.start, globalSec.end).u32() : 0;
  const counter = importedGlobals(bytes, find(SEC.import)) + ownGlobals;
  const stats = { functions: 0, segments: 0, instructions: 0 };

  // global: the existing entries plus `(mut i64) (i64.const 0)`.
  const newGlobal = Buffer.from([0x7e, 0x01, 0x42, 0x00, 0x0b]);
  let globalPayload;
  if (globalSec) {
    const r = new Reader(bytes, globalSec.start, globalSec.end);
    r.u32();
    globalPayload = Buffer.concat([Buffer.from(uleb(ownGlobals + 1)), bytes.subarray(r.pos, globalSec.end), newGlobal]);
  } else {
    globalPayload = Buffer.concat([Buffer.from(uleb(1)), newGlobal]);
  }

  // export: the existing entries plus the counter.
  const exportSec = find(SEC.export);
  const er = new Reader(bytes, exportSec.start, exportSec.end);
  const exports = er.u32();
  const exportPayload = Buffer.concat([
    Buffer.from(uleb(exports + 1)),
    bytes.subarray(er.pos, exportSec.end),
    Buffer.from([...name(COUNTER_EXPORT), 0x03, ...uleb(counter)]),
  ]);

  // code: every body metered.
  const codeSec = find(SEC.code);
  const cr = new Reader(bytes, codeSec.start, codeSec.end);
  const bodies = cr.u32();
  const codeParts = [Buffer.from(uleb(bodies))];
  for (let i = 0; i < bodies; i++) {
    const size = cr.u32();
    const body = meterBody(bytes, cr.pos, cr.pos + size, counter, stats);
    codeParts.push(Buffer.from(uleb(body.length)), body);
    cr.skip(size);
    stats.functions++;
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
    else if (s.id === SEC.code) out.push(section(SEC.code, Buffer.concat(codeParts)));
    else out.push(bytes.subarray(s.header, s.end));
  }
  if (!globalWritten) writeGlobal();
  const result = Buffer.concat(out);
  if (!WebAssembly.validate(result)) throw new Error("meter: the metered module doesn't validate");
  return { bytes: result, stats };
}
