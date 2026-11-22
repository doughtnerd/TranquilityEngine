// ADR 0338 §6 / 0344: the plugin effect module validator, through `validateEffectModule` alone. Hand-assembled modules
// cover each refusal; the SDK's own test plugin (native/fx-sdk, built by `npm run build:fx-examples`) and the tremolo
// sample cover the round trip: a Rust plugin built on myco-fx validates, instruments and runs through the ABI.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FUEL_EXPORT } from "../../../../engine/wasm/meter.js";
import { EFFECT_ABI, validateEffectModule } from "./validate";

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
};
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) return [...out, b];
    out.push(b | 0x80);
  }
};
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const str = (s: string) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];
const I32 = 0x7f;
const F32 = 0x7d;

interface Fn { name: string; params: number[]; results: number[]; body: number[] }

/** The ABI's exports with trivial bodies; `abi` is what `myco_fx_abi` returns. */
function abiFunctions(abi = 0x0100): Fn[] {
  const ret0 = [0x41, 0x00];
  return [
    { name: "myco_fx_abi", params: [], results: [I32], body: [0x41, ...sleb(abi)] },
    { name: "myco_fx_create", params: [I32, F32, I32], results: [I32], body: [0x41, 16] },
    { name: "myco_fx_destroy", params: [I32, I32], results: [], body: [] },
    { name: "myco_fx_reset", params: [I32, I32], results: [], body: [] },
    { name: "myco_fx_io", params: [I32, I32], results: [I32], body: ret0 },
    { name: "myco_fx_process", params: [I32, I32, I32, I32], results: [I32], body: ret0 },
    { name: "myco_fx_tail_frames", params: [I32, I32], results: [I32], body: ret0 },
  ];
}

interface Spec {
  fns?: Fn[];
  /** Memory limits bytes (flags, min[, max]); null for none. */
  memory?: number[] | null;
  exportMemory?: boolean;
  importFunction?: boolean;
  /** The function (by name) the start section runs. */
  start?: string;
}

/** A plugin-shaped module. Functions are exported under their names. */
function plugin(spec: Spec = {}): Uint8Array<ArrayBuffer> {
  const fns = spec.fns ?? abiFunctions();
  const memory = spec.memory === undefined ? [0x01, 1, 16] : spec.memory;
  const imported = spec.importFunction ? 1 : 0;
  const types = fns.map((f) => [0x60, f.params.length, ...f.params, f.results.length, ...f.results]);
  const exports = fns.map((f, i) => [...str(f.name), 0x00, ...uleb(i + imported)]);
  if (memory && spec.exportMemory !== false) exports.push([...str("memory"), 0x02, 0]);
  const bodies = fns.map((f) => {
    const b = [0x00, ...f.body, 0x0b];
    return [...uleb(b.length), ...b];
  });
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [types.length + imported, ...types.flat(), ...(imported ? [0x60, 0, 0] : [])]),
    ...(imported ? section(2, [1, ...str("env"), ...str("now"), 0x00, ...uleb(types.length)]) : []),
    ...section(3, [fns.length, ...fns.map((_, i) => i)]),
    ...(memory ? section(5, [1, ...memory]) : []),
    ...section(7, [exports.length, ...exports.flat()]),
    ...(spec.start ? section(8, uleb(imported + fns.findIndex((f) => f.name === spec.start))) : []),
    ...section(10, [bodies.length, ...bodies.flat()]),
  ]);
}

const refusal = async (bytes: Uint8Array, memoryMB?: number) => {
  const r = await validateEffectModule(bytes, memoryMB === undefined ? {} : { memoryMB });
  expect(r.ok, "expected a refusal").toBe(false);
  return r.ok ? [] : r.problems;
};

describe("validateEffectModule: refusals", () => {
  it("accepts the hand-made module every refusal below starts from", async () => {
    const r = await validateEffectModule(plugin());
    expect(r).toMatchObject({ ok: true, abi: EFFECT_ABI, memory: { min: 1, max: 16 }, tailFrames: true });
  });

  it("refuses any import", async () => {
    expect(await refusal(plugin({ importFunction: true }))).toEqual(["it imports env.now; a plugin effect module may import nothing"]);
  });

  it("refuses threads and atomics (instructions the decoder doesn't know)", async () => {
    const fns = abiFunctions();
    fns[4]!.body = [0x41, 0x00, 0xfe, 0x10, 0x02, 0x00]; // i32.atomic.load
    expect(await refusal(plugin({ fns }))).toEqual([expect.stringMatching(/threads or atomics/)]);
  });

  it("refuses relaxed SIMD", async () => {
    const fns = abiFunctions();
    // v128.const 0 ×3; f32x4.relaxed_madd (0xfd 0x105); i32x4.extract_lane 0
    const v0 = [0xfd, 0x0c, ...Array(16).fill(0)];
    fns[4]!.body = [...v0, ...v0, ...v0, 0xfd, ...uleb(0x105), 0xfd, 0x1b, 0x00];
    expect(await refusal(plugin({ fns }))).toEqual([expect.stringMatching(/relaxed SIMD/)]);
  });

  it("refuses a shared memory", async () => {
    expect(await refusal(plugin({ memory: [0x03, 1, 16] }))).toEqual([expect.stringMatching(/shared memory/)]);
  });

  it("refuses a module without its own exported memory, or one too big for its budget", async () => {
    expect(await refusal(plugin({ memory: null }))).toEqual(["it has no memory of its own", `it doesn't export its memory as "memory"`]);
    expect(await refusal(plugin({ exportMemory: false }))).toEqual([`it doesn't export its memory as "memory"`]);
    expect(await refusal(plugin({ memory: [0x00, 32] }), 1)).toEqual([expect.stringMatching(/initial memory \(2048 KiB\) is above its budget of 1 MB/)]);
  });

  it("refuses a start function", async () => {
    const fns = [...abiFunctions(), { name: "init", params: [], results: [], body: [] }];
    expect(await refusal(plugin({ fns, start: "init" }))).toEqual([expect.stringMatching(/start function/)]);
  });

  it("refuses missing exports and wrong signatures, the optional tail included", async () => {
    const fns = abiFunctions().filter((f) => f.name !== "myco_fx_process");
    fns.find((f) => f.name === "myco_fx_create")!.params = [I32, I32, I32];
    fns.find((f) => f.name === "myco_fx_tail_frames")!.results = [];
    fns.find((f) => f.name === "myco_fx_tail_frames")!.body = [];
    expect(await refusal(plugin({ fns }))).toEqual([
      "its myco_fx_create is (i32, i32, i32) -> i32; the ABI's is (i32, f32, i32) -> i32",
      "it doesn't export myco_fx_process",
      "its myco_fx_tail_frames is (i32, i32) -> nothing; the ABI's is (i32, i32) -> i32",
    ]);
  });

  it("checks the ABI version the module reports", async () => {
    expect(await refusal(plugin({ fns: abiFunctions(0x0200) }))).toEqual([expect.stringMatching(/built for DSP ABI 2\.0.*runs 1\.x/)]);
    expect(await refusal(plugin({ fns: abiFunctions(0x0103) }))).toEqual(["it needs DSP ABI 1.3; this engine runs 1.0: update Myco"]);
    const looping = abiFunctions();
    looping[0]!.body = [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00]; // loop br 0 end; i32.const 0
    expect(await refusal(plugin({ fns: looping }))).toEqual([expect.stringMatching(/myco_fx_abi failed/)]); // fuel ran out
  });

  it("refuses bytes that aren't a module, and a bad memory budget", async () => {
    expect(await refusal(Uint8Array.from([1, 2, 3]))).toEqual([expect.stringMatching(/isn't a module/)]);
    expect(await refusal(plugin(), 65)).toEqual(["memoryMB must be a whole number from 1 to 64 (got 65)"]);
  });
});

/** A plugin module through the ABI: instantiate the instrumented bytes, grant fuel, and call its exports. */
async function load(bytes: Uint8Array<ArrayBuffer>) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports as Record<string, unknown>;
  const fuel = x[FUEL_EXPORT] as WebAssembly.Global;
  const call = <T extends unknown[]>(name: string, grant: number, ...args: T): number => {
    fuel.value = grant;
    return (x[name] as (...a: T) => number)(...args);
  };
  return { memory: x.memory as WebAssembly.Memory, fuel, call };
}

const MAX = 128;
const read = (path: string) => new Uint8Array(readFileSync(new URL(`../../../../../${path}`, import.meta.url)));

describe("the SDK round trip (myco-fx)", () => {
  it("the SDK's test plugin validates, instruments and processes through the ABI", async () => {
    const r = await validateEffectModule(read("native/fx-sdk/wasm/test_fx.wasm"));
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.abi).toEqual({ major: 1, minor: 0 });
    expect(r.memory.max).toBe(64);
    const m = await load(r.bytes);
    const h = m.call("myco_fx_create", 1e7, 0, 48000, MAX);
    expect(h).toBeGreaterThan(0);
    const io = m.call("myco_fx_io", 1000, 0, h);
    const block = new Float32Array(m.memory.buffer, io, 2 * MAX + 32);
    block.fill(0.8, 0, 2 * MAX);
    block[2 * MAX] = 0.5; // p0[0]: gain at the block's start
    block[2 * MAX + 16] = 0.5; // p1[0]: and at its end
    expect(m.call("myco_fx_process", 1000 * MAX, 0, h, MAX, 1)).toBe(0);
    expect([...block.subarray(0, 2 * MAX)].every((x) => Math.abs(x - 0.4) < 1e-6)).toBe(true);
    expect(m.call("myco_fx_create", 1e6, 99, 48000, MAX)).toBe(0); // no such kind
    m.call("myco_fx_destroy", 1e6, 0, h);
  });

  it("its allocator frees: destroying and re-creating an instance doesn't grow memory (0344 §5)", async () => {
    const r = await validateEffectModule(read("native/fx-sdk/wasm/test_fx.wasm"));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const m = await load(r.bytes);
    const HOG = 2; // allocates 256 KiB in new
    m.call("myco_fx_destroy", 1e7, HOG, m.call("myco_fx_create", 1e8, HOG, 48000, MAX));
    const after = m.memory.buffer.byteLength;
    for (let i = 0; i < 50; i++) m.call("myco_fx_destroy", 1e7, HOG, m.call("myco_fx_create", 1e8, HOG, 48000, MAX));
    expect(m.memory.buffer.byteLength).toBe(after);
  });

  it("the tremolo sample validates within its 1 MB budget and modulates", async () => {
    const r = await validateEffectModule(read("samples/fx-tremolo/plugins/tremolo/dsp/tremolo.wasm"), { memoryMB: 1 });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.memory).toEqual({ min: 2, max: 16 });
    const m = await load(r.bytes);
    const h = m.call("myco_fx_create", 1e7, 0, 48000, MAX);
    const io = m.call("myco_fx_io", 1000, 0, h);
    const block = new Float32Array(m.memory.buffer, io, 2 * MAX + 32);
    block.set([20, 100, 0], 2 * MAX); // rate 20 Hz, depth 100 %, sine
    block.set([20, 100, 0], 2 * MAX + 16);
    let lo = Infinity;
    let hi = -Infinity;
    for (let q = 0; q < 40; q++) {
      block.fill(1, 0, 2 * MAX);
      expect(m.call("myco_fx_process", 300 * MAX, 0, h, MAX, 0)).toBe(0); // the sample's budget: 300 a frame
      for (const x of block.subarray(0, MAX)) [lo, hi] = [Math.min(lo, x), Math.max(hi, x)];
    }
    expect(lo).toBeLessThan(0.01);
    expect(hi).toBeGreaterThan(0.99);
  });
});
