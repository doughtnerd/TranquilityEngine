// Spike B0 (ADR 0352): synthetic modules for the compile-time measurements. Plain ES module (no Node APIs).
//
// `largeModule(targetBytes, seed)` emits a module with no imports, one memory, and as many functions as it takes to
// reach about `targetBytes`: each function runs a loop over a block of f32 multiply-adds and loads/stores (the shape
// of DSP code) and calls the next, so every function is reachable from the exported `run`.
// `uniquify(bytes, k)` appends a custom section holding `k`, so repeated compiles can't hit an engine's module cache.

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function f32(x) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return [...b];
}

function vec(items) {
  return [...uleb(items.length), ...items.flat()];
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

/** One function body: (param i32 n) (result f32), locals 4 × f32. */
function body(index, count, groups, seed) {
  const code = [];
  code.push(1, 4, 0x7d); // 4 locals of f32
  // loop: for groups: acc1 = acc1 + mem[i*4] * c; mem[i*4+4] = acc1 * c2; ...; n--; br_if n != 0
  code.push(0x03, 0x40); // loop
  for (let g = 0; g < groups; g++) {
    const c = 0.5 + ((index * 131 + g * 17 + seed) % 97) / 200;
    code.push(0x20, 1, 0x20, 0, 0x2a, 2, ...uleb((g * 4) & 0x3ff), 0x43, ...f32(c), 0x94, 0x92, 0x21, 1); // l1 += load(n + off) * c
    code.push(0x20, 0, 0x20, 1, 0x43, ...f32(1 - c), 0x94, 0x20, 2, 0x92, 0x38, 2, ...uleb(((g * 4) + 512) & 0x3ff)); // store(n + off2, l1*(1-c) + l2)
    code.push(0x20, 2, 0x20, 1, 0x93, 0x21, 2); // l2 = l2 - l1 ... (keeps values moving)
  }
  code.push(0x20, 0, 0x41, 1, 0x6b, 0x22, 0, 0x0d, 0, 0x0b); // n = n - 1; br_if 0 (n != 0); end loop
  if (index + 1 < count) code.push(0x20, 1, 0x41, 2, 0x10, ...uleb(index + 1), 0x92); // l1 + f(index+1)(2)
  else code.push(0x20, 1);
  code.push(0x0b);
  return [...uleb(code.length), ...code];
}

export function largeModule(targetBytes = 100_000, seed = 0) {
  const groups = 40;
  const perFunction = body(0, 2, groups, seed).length;
  const count = Math.max(1, Math.round(targetBytes / perFunction));
  const type = section(1, vec([[0x60, 1, 0x7f, 1, 0x7d]])); // (i32) -> f32
  const func = section(3, vec(Array.from({ length: count }, () => [0])));
  const mem = section(5, vec([[0x00, 1]])); // 1 page
  const exp = section(7, vec([[...uleb(3), ..."run".split("").map((c) => c.charCodeAt(0)), 0x00, 0]]));
  const code = section(10, vec(Array.from({ length: count }, (_, i) => body(i, count, groups, seed))));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0, ...type, ...func, ...mem, ...exp, ...code]);
}

const MAXF = 128; // the I/O block's stride: l[128], r[128], p0[16], p1[16]

function str(s) {
  return [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
}

/**
 * Code that ANDs `|x| <= 64` (false for NaN) over [local ptr, local end) of memory `mem` into v128 local `mask`,
 * with the limit splatted in v128 local `lim`. A compare and an AND carry the loop, not a NaN-propagating max
 * (several instructions in a loop-carried chain, measured 6 ns per 4 floats in V8).
 */
function amaxLoop(mem, ptr, end, mask, lim) {
  const memarg = mem === 0 ? [0x02, 0x00] : [0x42, ...uleb(mem), 0x00];
  return [
    0x02, 0x40, 0x03, 0x40,
    0x20, ptr, 0x20, end, 0x4f, 0x0d, 0x01, // br_if out when ptr >= end
    0x20, mask, 0x20, ptr, 0xfd, 0x00, ...memarg, 0xfd, 0xe0, 0x01, 0x20, lim, 0xfd, 0x45, 0xfd, 0x4e, 0x21, mask,
    0x20, ptr, 0x41, 0x10, 0x6a, 0x21, ptr,
    0x0c, 0x00, 0x0b, 0x0b,
  ];
}

/** mask = all ones; lim = splat(64). */
function initMask(mask, lim) {
  return [0xfd, 0x0c, ...new Array(16).fill(0xff), 0x21, mask, 0x43, ...f32(64), 0xfd, 0x13, 0x21, lim];
}

/** Every lane of `mask` set, as an i32. */
function accOk(mask) {
  return [0x20, mask, 0xfd, 0xa3, 0x01];
}

function fn(params, results, locals, code) {
  const decl = [...uleb(locals.length), ...locals.flatMap((t) => [1, t])];
  const b = [...decl, ...code, 0x0b];
  return { type: [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results], body: [...uleb(b.length), ...b] };
}

function assemble(imports, funcs, exportsList) {
  const type = section(1, vec(funcs.map((f) => f.type)));
  const imp = section(2, vec(imports));
  const func = section(3, vec(funcs.map((_, i) => uleb(i))));
  const exp = section(7, vec(exportsList.map(([n, i]) => [...str(n), 0x00, ...uleb(i)])));
  const code = section(10, vec(funcs.map((f) => f.body)));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0, ...type, ...imp, ...func, ...exp, ...code]);
}

/**
 * A trusted helper (ours, not the plugin's) that imports the plugin's memory as `p.memory` and exports
 * `scan(io, frames) -> i32`: 1 when every sample of io.l[0..frames] and io.r[0..frames] is finite and within ±64
 * (SIMD max of |x|; frames a multiple of 4).
 */
export function scanModule() {
  const I32 = 0x7f, V128 = 0x7b;
  // params: 0 io, 1 frames; locals: 2 ptr, 3 end, 4 mask, 5 lim
  const code = [
    ...initMask(4, 5),
    0x20, 0x00, 0x21, 0x02, 0x20, 0x00, 0x20, 0x01, 0x41, 0x02, 0x74, 0x6a, 0x21, 0x03,
    ...amaxLoop(0, 2, 3, 4, 5),
    0x20, 0x00, 0x41, ...sleb(MAXF * 4), 0x6a, 0x21, 0x02, 0x20, 0x02, 0x20, 0x01, 0x41, 0x02, 0x74, 0x6a, 0x21, 0x03,
    ...amaxLoop(0, 2, 3, 4, 5),
    ...accOk(4),
  ];
  const scan = fn([I32, I32], [I32], [I32, I32, V128, V128], code);
  return assemble([[...str("p"), ...str("memory"), 0x02, 0x00, 0x00]], [scan], [["scan", 0]]);
}

/**
 * The same helper with multi-memory: imports the host's memory (`h.memory`, index 0) and the plugin's (`p.memory`,
 * index 1) and moves the block with `memory.copy` between them:
 *   pre(l, r, p0, p1, io, frames): host l, r, p0, p1 → the plugin's I/O block;
 *   post(io, l, r, frames) -> i32: the scan, then (if it passed) io.l, io.r → host l, r; returns the scan's result.
 */
export function multiMemoryModule() {
  const I32 = 0x7f, V128 = 0x7b;
  const bytesOf = (frames) => [0x20, frames, 0x41, 0x02, 0x74];
  // pre: 0 l, 1 r, 2 p0, 3 p1, 4 io, 5 frames
  const pre = fn([I32, I32, I32, I32, I32, I32], [], [], [
    0x20, 0x04, 0x20, 0x00, ...bytesOf(5), 0xfc, 0x0a, 0x01, 0x00,
    0x20, 0x04, 0x41, ...sleb(MAXF * 4), 0x6a, 0x20, 0x01, ...bytesOf(5), 0xfc, 0x0a, 0x01, 0x00,
    0x20, 0x04, 0x41, ...sleb(MAXF * 8), 0x6a, 0x20, 0x02, 0x41, ...sleb(64), 0xfc, 0x0a, 0x01, 0x00,
    0x20, 0x04, 0x41, ...sleb(MAXF * 8 + 64), 0x6a, 0x20, 0x03, 0x41, ...sleb(64), 0xfc, 0x0a, 0x01, 0x00,
  ]);
  // post: 0 io, 1 l, 2 r, 3 frames; locals 4 ptr, 5 end, 6 mask, 7 lim
  const post = fn([I32, I32, I32, I32], [I32], [I32, I32, V128, V128], [
    ...initMask(6, 7),
    0x20, 0x00, 0x21, 0x04, 0x20, 0x00, ...bytesOf(3), 0x6a, 0x21, 0x05,
    ...amaxLoop(1, 4, 5, 6, 7),
    0x20, 0x00, 0x41, ...sleb(MAXF * 4), 0x6a, 0x21, 0x04, 0x20, 0x04, ...bytesOf(3), 0x6a, 0x21, 0x05,
    ...amaxLoop(1, 4, 5, 6, 7),
    ...accOk(6),
    0x04, 0x7f, // if (result i32)
    0x20, 0x01, 0x20, 0x00, ...bytesOf(3), 0xfc, 0x0a, 0x00, 0x01,
    0x20, 0x02, 0x20, 0x00, 0x41, ...sleb(MAXF * 4), 0x6a, ...bytesOf(3), 0xfc, 0x0a, 0x00, 0x01,
    0x41, 0x01,
    0x05, 0x41, 0x00, 0x0b,
  ]);
  return assemble(
    [
      [...str("h"), ...str("memory"), 0x02, 0x00, 0x00],
      [...str("p"), ...str("memory"), 0x02, 0x00, 0x00],
    ],
    [pre, post],
    [["pre", 0], ["post", 1]],
  );
}

function sleb(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

export function uniquify(bytes, k) {
  const nameBytes = [..."spike"].map((c) => c.charCodeAt(0));
  const payload = [...uleb(nameBytes.length), ...nameBytes, ...uleb(k >>> 0)];
  const out = new Uint8Array(bytes.length + 2 + payload.length + 4);
  out.set(bytes, 0);
  const sec = [0, ...uleb(payload.length), ...payload];
  out.set(sec, bytes.length);
  return out.subarray(0, bytes.length + sec.length);
}
