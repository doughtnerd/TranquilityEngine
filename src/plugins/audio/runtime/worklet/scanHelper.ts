// ADR 0344 §1 (amending 0338 §1): the trusted helper module that checks a plugin's output. One instance per plugin
// module instance: it imports that module's memory (`p.memory`) and exports `scan(l, r, frames) -> i32`, 1 when every
// sample of `l[0..frames]` and `r[0..frames]` is finite and within ±64 (`|x| <= 64`, which is false for NaN), else 0.
//
// It is a SIMD compare-and-mask (f32x4.abs, f32x4.le against a splat of 64, v128.and into a mask; i32x4.all_true at
// the end): the B0 spike measured 37 ns for 256 floats, against 280-340 ns for a JS loop and 380 ns for a
// NaN-propagating f32x4.max. Frames are rounded up to a multiple of 4: the I/O block is laid out for `max_frames` (128)
// and the parameters follow it, so the rounded tail stays inside the block. Hand-assembled (no toolchain), 160-odd
// bytes; ours, never the plugin's. Plain module with no DOM or Node APIs: it runs in the AudioWorkletGlobalScope.

/** @internal The output limit (+36 dBFS): a sample beyond it is a fault (0338 §6). */
export const SAMPLE_LIMIT = 64;

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, payload: number[]): number[] => [id, ...uleb(payload.length), ...payload];
const str = (s: string): number[] => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];

function f32(x: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return [...b];
}

const I32 = 0x7f;
const V128 = 0x7b;
// Params: 0 l, 1 r, 2 frames. Locals: 3 ptr, 4 end, 5 bytes, 6 mask (v128), 7 lim (v128).
const [L, R, FRAMES, PTR, END, BYTES, MASK, LIM] = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** mask &= (|x| <= 64) over [ptr, end) of memory 0, four floats a step. */
function maskLoop(): number[] {
  return [
    0x02, 0x40, 0x03, 0x40, // block, loop
    0x20, PTR, 0x20, END, 0x4f, 0x0d, 0x01, // br_if out when ptr >= end (unsigned)
    0x20, MASK, 0x20, PTR, 0xfd, 0x00, 0x02, 0x00, // mask, v128.load ptr
    0xfd, 0xe0, 0x01, 0x20, LIM, 0xfd, 0x45, 0xfd, 0x4e, 0x21, MASK, // f32x4.abs, f32x4.le lim, v128.and → mask
    0x20, PTR, 0x41, 0x10, 0x6a, 0x21, PTR, // ptr += 16
    0x0c, 0x00, 0x0b, 0x0b, // br loop; end; end
  ];
}

/** ptr = base; end = base + bytes. */
const range = (base: number): number[] => [0x20, base, 0x21, PTR, 0x20, base, 0x20, BYTES, 0x6a, 0x21, END];

/** @internal The helper's bytes. */
export function scanHelperBytes(): Uint8Array<ArrayBuffer> {
  const code = [
    // bytes = ((frames + 3) & ~3) * 4
    0x20, FRAMES, 0x41, 0x03, 0x6a, 0x41, 0x7c, 0x71, 0x41, 0x02, 0x74, 0x21, BYTES,
    // mask = all ones; lim = splat(64)
    0xfd, 0x0c, ...new Array<number>(16).fill(0xff), 0x21, MASK, 0x43, ...f32(SAMPLE_LIMIT), 0xfd, 0x13, 0x21, LIM,
    ...range(L), ...maskLoop(),
    ...range(R), ...maskLoop(),
    0x20, MASK, 0xfd, 0xa3, 0x01, // i32x4.all_true
  ];
  const locals = [[3, I32], [2, V128]];
  const body = [...uleb(locals.length), ...locals.flat(), ...code, 0x0b];
  const type = section(1, vec([[0x60, 3, I32, I32, I32, 1, I32]]));
  const imports = section(2, vec([[...str("p"), ...str("memory"), 0x02, 0x00, 0x00]]));
  const funcs = section(3, vec([[0]]));
  const exports = section(7, vec([[...str("scan"), 0x00, 0]]));
  const codeSec = section(10, vec([[...uleb(body.length), ...body]]));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...type, ...imports, ...funcs, ...exports, ...codeSec]);
}

/** @internal `scan(l, r, frames)` over one plugin memory. */
export type ScanFn = (l: number, r: number, frames: number) => number;

let compiled: WebAssembly.Module | null | undefined;

/**
 * @internal The scan over `memory`: the SIMD helper's, or (where the engine can't compile it: no SIMD) the same rule in
 * JS over a view of the memory. Compiled once per worklet; instantiated per plugin module instance.
 */
export function scanFor(memory: WebAssembly.Memory): ScanFn {
  if (compiled === undefined) {
    try {
      compiled = new WebAssembly.Module(scanHelperBytes());
    } catch {
      compiled = null;
    }
  }
  if (compiled) return (new WebAssembly.Instance(compiled, { p: { memory } }).exports as { scan: ScanFn }).scan;
  return (l, r, frames) => {
    const f = new Float32Array(memory.buffer);
    for (let i = 0; i < frames; i++) {
      const a = f[(l >>> 2) + i]!;
      const b = f[(r >>> 2) + i]!;
      if (!(a <= SAMPLE_LIMIT && a >= -SAMPLE_LIMIT && b <= SAMPLE_LIMIT && b >= -SAMPLE_LIMIT)) return 0;
    }
    return 1;
  };
}
