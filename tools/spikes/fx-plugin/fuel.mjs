// Spike B0 (ADR 0338): a fuel mode for the metered gate's pass. A fork of the decoder and segmenting in
// tools/audio-bench/meter.mjs (which exports only `meter`), with the increment replaced by a fuel decrement.
//
// `fuel(bytes, { mode, width })` returns `{ bytes, stats }`: the module with one new mutable global (i32 or i64,
// initial 0) exported as `__fuel`. Every straight-line segment (the meter's rule: it ends at a control instruction)
// starts by subtracting its instruction count from the global. Then:
//
// - mode "segment": every segment checks `fuel < 0` and executes `unreachable` if so;
// - mode "loop": only function entries and loop headers check (wasmtime's and Parity's placement); the other
//   segments only subtract;
// - mode "count": the meter's own increment (`fuel += n`, no check), for comparison.
//
// The check is `global.get; i32.const 0; i32.lt_s; if; unreachable; end` (i64 forms for width 64), stack-neutral
// and self-contained, so it can open any segment. Because a segment's count is subtracted before it runs, the fuel
// left after a call is the budget minus the exact instruction count the meter would have reported.

const SEC = { custom: 0, type: 1, import: 2, function: 3, table: 4, memory: 5, global: 6, export: 7, start: 8, element: 9, code: 10, data: 11, datacount: 12, tag: 13 };
const ORDER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12, 11: 13 };
export const FUEL_EXPORT = "__fuel";

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }
  byte() {
    if (this.pos >= this.end) throw new Error(`fuel: unexpected end of input at ${this.pos}`);
    return this.bytes[this.pos++];
  }
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
  skipLeb() {
    while (this.byte() & 0x80);
  }
  skip(n) {
    this.pos += n;
    if (this.pos > this.end) throw new Error("fuel: unexpected end of input");
  }
}

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

function name(s) {
  const b = Buffer.from(s, "utf8");
  return [...uleb(b.length), ...b];
}

function skipMemarg(r) {
  const align = r.u32();
  if (align & 0x40) r.u32();
  r.skipLeb();
}

const ENDS_SEGMENT = new Set([0x00, 0x03, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x12, 0x13]);

function skipInstruction(r) {
  const op = r.byte();
  switch (op) {
    case 0x02:
    case 0x03:
    case 0x04:
      r.skipLeb();
      return op;
    case 0x0c:
    case 0x0d:
    case 0x10:
    case 0x12:
    case 0x20:
    case 0x21:
    case 0x22:
    case 0x23:
    case 0x24:
    case 0x25:
    case 0x26:
    case 0xd2:
      r.u32();
      return op;
    case 0x0e: {
      const n = r.u32();
      for (let i = 0; i <= n; i++) r.u32();
      return op;
    }
    case 0x11:
    case 0x13:
      r.u32();
      r.u32();
      return op;
    case 0x1c: {
      const n = r.u32();
      for (let i = 0; i < n; i++) r.skipLeb();
      return op;
    }
    case 0x3f:
    case 0x40:
      r.u32();
      return op;
    case 0x41:
    case 0x42:
      r.skipLeb();
      return op;
    case 0x43:
      r.skip(4);
      return op;
    case 0x44:
      r.skip(8);
      return op;
    case 0xd0:
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
  if (op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b) return op;
  if (op >= 0x45 && op <= 0xc4) return op;
  if (op === 0xd1) return op;
  throw new Error(`fuel: unsupported opcode 0x${op.toString(16)} at byte ${r.pos - 1}`);
}

function skipFc(r) {
  const sub = r.u32();
  if (sub <= 7) return sub;
  switch (sub) {
    case 8:
    case 10:
    case 12:
    case 14:
      r.u32();
      r.u32();
      return sub;
    case 9:
    case 11:
    case 13:
    case 15:
    case 16:
    case 17:
      r.u32();
      return sub;
    default:
      throw new Error(`fuel: unsupported opcode 0xfc ${sub} at byte ${r.pos}`);
  }
}

function skipFd(r) {
  const sub = r.u32();
  if (sub <= 11 || sub === 92 || sub === 93) skipMemarg(r);
  else if (sub === 12 || sub === 13) r.skip(16);
  else if (sub >= 21 && sub <= 34) r.skip(1);
  else if (sub >= 84 && sub <= 91) {
    skipMemarg(r);
    r.skip(1);
  } else if (sub > 0x113) throw new Error(`fuel: unsupported opcode 0xfd ${sub} at byte ${r.pos}`);
  return sub;
}

function meterBody(bytes, start, end, g, stats, mode, width, how) {
  const r = new Reader(bytes, start, end);
  const groups = r.u32();
  for (let i = 0; i < groups; i++) {
    r.u32();
    r.skipLeb();
  }
  const out = [bytes.subarray(start, r.pos)];
  let segStart = r.pos;
  let count = 0;
  let checkNext = true; // function entry
  const gi = uleb(g);
  const c = width === 64 ? 0x42 : 0x41;
  const sub = width === 64 ? 0x7d : 0x6b;
  const ltS = width === 64 ? 0x53 : 0x48;
  const flush = (at, nextIsLoopHeader) => {
    if (count > 0) {
      const check = mode === "segment" || (mode === "loop" && checkNext);
      let p;
      if (mode === "count") p = [0x23, ...gi, c, ...sleb(count), width === 64 ? 0x7c : 0x6a, 0x24, ...gi];
      else if (!check) p = [0x23, ...gi, c, ...sleb(count), sub, 0x24, ...gi];
      else if (how === "load") {
        // Branch-free: shift the sign into an address (0 or 0xFFFFFFFF) and load a byte there; out of bounds traps.
        const sign = width === 64 ? [0x42, 63, 0x87, 0xa7] : [0x41, 31, 0x75];
        p = [0x23, ...gi, c, ...sleb(count), sub, 0x24, ...gi, 0x23, ...gi, ...sign, 0x2d, 0x00, 0x00, 0x1a];
      } else p = [0x23, ...gi, c, ...sleb(count), sub, 0x24, ...gi, 0x23, ...gi, c, 0, ltS, 0x04, 0x40, 0x00, 0x0b];
      out.push(Buffer.from(p));
      stats.segments++;
      if (check) stats.checks++;
      stats.instructions += count;
    }
    out.push(bytes.subarray(segStart, at));
    segStart = at;
    count = 0;
    checkNext = nextIsLoopHeader;
  };
  while (r.pos < end) {
    const op = skipInstruction(r);
    count++;
    if (ENDS_SEGMENT.has(op) || r.pos === end) flush(r.pos, op === 0x03);
  }
  if (r.pos !== end) throw new Error("fuel: a function body overran its size");
  return Buffer.concat(out);
}

function sections(bytes) {
  if (bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) throw new Error("fuel: not a wasm 1 module");
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

function section(id, payload) {
  return Buffer.concat([Buffer.from([id, ...uleb(payload.length)]), payload]);
}

function importedGlobals(bytes, s) {
  if (!s) return 0;
  const r = new Reader(bytes, s.start, s.end);
  const n = r.u32();
  let globals = 0;
  for (let i = 0; i < n; i++) {
    r.skip(r.u32());
    r.skip(r.u32());
    const kind = r.byte();
    if (kind === 0x00) r.u32();
    else if (kind === 0x01) {
      r.skipLeb();
      const flags = r.u32();
      r.u32();
      if (flags & 1) r.u32();
    } else if (kind === 0x02) {
      const flags = r.u32();
      r.skipLeb();
      if (flags & 1) r.skipLeb();
    } else if (kind === 0x03) {
      r.skipLeb();
      r.byte();
      globals++;
    } else if (kind === 0x04) {
      r.byte();
      r.u32();
    } else throw new Error(`fuel: unknown import kind ${kind}`);
  }
  return globals;
}

/**
 * Instruments `input`. `mode`: "segment" | "loop" | "count"; `width`: 32 | 64; `check`: "if" (`if unreachable`)
 * or "load" (a byte load from address `fuel >> 31`, out of bounds once fuel is negative: no branch; needs the
 * module to have a memory smaller than 4 GiB).
 */
export function fuel(input, { mode = "segment", width = 32, check: how = "if" } = {}) {
  const bytes = Buffer.from(input);
  const secs = sections(bytes);
  const find = (id) => secs.find((s) => s.id === id);
  const globalSec = find(SEC.global);
  const ownGlobals = globalSec ? new Reader(bytes, globalSec.start, globalSec.end).u32() : 0;
  const g = importedGlobals(bytes, find(SEC.import)) + ownGlobals;
  const stats = { functions: 0, segments: 0, checks: 0, instructions: 0 };

  const newGlobal = Buffer.from(width === 64 ? [0x7e, 0x01, 0x42, 0x00, 0x0b] : [0x7f, 0x01, 0x41, 0x00, 0x0b]);
  let globalPayload;
  if (globalSec) {
    const r = new Reader(bytes, globalSec.start, globalSec.end);
    r.u32();
    globalPayload = Buffer.concat([Buffer.from(uleb(ownGlobals + 1)), bytes.subarray(r.pos, globalSec.end), newGlobal]);
  } else globalPayload = Buffer.concat([Buffer.from(uleb(1)), newGlobal]);

  const exportSec = find(SEC.export);
  if (!exportSec) throw new Error("fuel: the module has no export section");
  const er = new Reader(bytes, exportSec.start, exportSec.end);
  const exports = er.u32();
  const exportPayload = Buffer.concat([
    Buffer.from(uleb(exports + 1)),
    bytes.subarray(er.pos, exportSec.end),
    Buffer.from([...name(FUEL_EXPORT), 0x03, ...uleb(g)]),
  ]);

  const codeSec = find(SEC.code);
  const cr = new Reader(bytes, codeSec.start, codeSec.end);
  const bodies = cr.u32();
  const codeParts = [Buffer.from(uleb(bodies))];
  for (let i = 0; i < bodies; i++) {
    const size = cr.u32();
    const body = meterBody(bytes, cr.pos, cr.pos + size, g, stats, mode, width, how);
    codeParts.push(Buffer.from(uleb(body.length)), body);
    cr.skip(size);
    stats.functions++;
  }

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
  if (!WebAssembly.validate(result)) throw new Error("fuel: the instrumented module doesn't validate");
  return { bytes: result, stats };
}
