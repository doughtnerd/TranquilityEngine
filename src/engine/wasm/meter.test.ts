// The meter pass (ADR 0157 C1b, 0338 §6, 0344 §2) through its module interface: `count` mode bit-identical to the
// pass the metered gate has always used, `fuel` mode's exact decrements and branch-free trap, and the decoder the
// plugin validator reads.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COUNTER_EXPORT, FUEL_EXPORT, METER_VERSION, meter, readModule } from "./meter.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

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
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const str = (s: string) => [...uleb(s.length), ...[...s].map((c) => c.charCodeAt(0))];

/**
 * Three `(param i32) (result i32)` functions:
 * - `run(n)`: counts to n in a loop (9n + 8 instructions);
 * - `spin`: `loop br 0 end`, forever;
 * - `rec(n)`: recursion n deep, no loop.
 * `memory`: "own" (exported, 1 page), "none", "imported", "shared".
 */
function testModule(memory: "own" | "none" | "imported" | "shared" = "own"): Uint8Array<ArrayBuffer> {
  const run = [0x01, 0x01, 0x7f, 0x02, 0x40, 0x03, 0x40, 0x20, 0x01, 0x20, 0x00, 0x4f, 0x0d, 0x01, 0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x0c, 0x00, 0x0b, 0x0b, 0x20, 0x01, 0x0b];
  const spin = [0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x00, 0x0b];
  const rec = [0x00, 0x20, 0x00, 0x45, 0x04, 0x7f, 0x41, 0x00, 0x05, 0x20, 0x00, 0x41, 0x01, 0x6b, 0x10, 0x02, 0x0b, 0x0b];
  const exports = [[...str("run"), 0x00, 0], [...str("spin"), 0x00, 1], [...str("rec"), 0x00, 2]];
  if (memory === "own" || memory === "shared") exports.push([...str("memory"), 0x02, 0]);
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...(memory === "imported" ? section(2, [1, ...str("env"), ...str("mem"), 0x02, 0x00, 1]) : []),
    ...section(3, [3, 0, 0, 0]),
    ...(memory === "own" ? section(5, [1, 0x00, 1]) : memory === "shared" ? section(5, [1, 0x03, 1, 1]) : []),
    ...section(7, [exports.length, ...exports.flat()]),
    ...section(10, [3, ...uleb(run.length), ...run, ...uleb(spin.length), ...spin, ...uleb(rec.length), ...rec]),
  ]);
}

type Fn = (n: number) => number;
function instantiate(bytes: Uint8Array<ArrayBuffer>, global: string) {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return { run: exports.run as Fn, spin: exports.spin as Fn, rec: exports.rec as Fn, g: exports[global] as WebAssembly.Global };
}

describe("count mode", () => {
  // Goldens: the SHA-256 of `meter()`'s output as `tools/audio-bench/meter.mjs` wrote it before the move (base 481ecc4),
  // for inputs that don't change. The spike's modules are frozen; the shipped core, decoder and navigation modules are
  // checked while their bytes are the ones the goldens were taken from (a rebuild changes the input, not the pass).
  const GOLDENS: { path: string; input: string; output: string; frozen: boolean }[] = [
    { path: "tools/spikes/fx-plugin/wasm/fx_plugin.wasm", input: "6ac376d77ff37181c80339621784074346864769443c3f81416dc3829537c89a", output: "b359358a1466a74f018934677a933f1fc97663e38f2929643e9f5e0424d9d39b", frozen: true },
    { path: "tools/spikes/fx-plugin/wasm/fx_host.wasm", input: "9bc80a319f04aa3ad8e0c748102a5202249277adfcaa21353b29e202aa81ab95", output: "67c9d4cecfe568f6ab6962ed3dec81b0ee4ba84135ba89d5cdd88889a9c7d15e", frozen: true },
    { path: "src/plugins/audio/runtime/wasm/myco_audio.wasm", input: "d6ad97b2ad4886a43d5f79933ff3fbf63b5442ee77a85384a5e8adddea791b78", output: "7c7d109b42973bc8eed6082600d77f5dd29b18f2e80f60db9c6cb4d2949edb3e", frozen: false },
    { path: "src/plugins/audio/runtime/wasm/myco_audio_decode.wasm", input: "a28d96511e1f629f865f8217c7e847d9c566494a66256989f7d291b1641857e0", output: "bb34b8f238b03ccd3a28d7f39d8150f0ef502c08b5c7667579d6bace1c8cd079", frozen: false },
    { path: "src/engine/nav/wasm/myco_nav_bg.wasm", input: "957e32843bd07d3d80032174905e2adb79c7c11c8df46e5fa46ccd52081459f3", output: "3d860800fc1d1d648ef629671580f9a5965cee2ec986d7b814fbaf450cb44849", frozen: false },
  ];

  for (const g of GOLDENS) {
    const bytes = existsSync(repo(g.path)) ? new Uint8Array(readFileSync(repo(g.path))) : null;
    const current = bytes !== null && sha(bytes) === g.input;
    it.skipIf(!g.frozen && !current)(`writes the same bytes as the gate's pass always has: ${g.path}`, () => {
      expect(bytes, `${g.path} is missing`).not.toBeNull();
      expect(sha(bytes!), "a frozen input changed").toBe(g.input);
      expect(sha(meter(bytes!).bytes)).toBe(g.output);
    });
  }

  it("reports the same static counts, and only them", () => {
    const { stats } = meter(new Uint8Array(readFileSync(repo("tools/spikes/fx-plugin/wasm/fx_plugin.wasm"))));
    expect(stats).toEqual({ functions: 12, segments: 273, instructions: 2615 });
    expect(METER_VERSION).toBe(1);
  });

  it("counts every executed instruction exactly, without changing results", () => {
    const { run, g } = instantiate(meter(testModule()).bytes, COUNTER_EXPORT);
    let before = g.value as bigint;
    for (const n of [0, 1, 10, 1000]) {
      expect(run(n)).toBe(n);
      expect((g.value as bigint) - before).toBe(BigInt(9 * n + 8));
      before = g.value as bigint;
    }
  });
});

describe("fuel mode", () => {
  it("subtracts exactly what count mode counts, so the profiler's numbers are exact", () => {
    const counted = instantiate(meter(testModule()).bytes, COUNTER_EXPORT);
    const fuelled = instantiate(meter(testModule(), { mode: "fuel" }).bytes, FUEL_EXPORT);
    for (const [fn, n] of [["run", 0], ["run", 500], ["rec", 0], ["rec", 300]] as const) {
      const c0 = counted.g.value as bigint;
      counted[fn](n);
      const used = Number((counted.g.value as bigint) - c0);
      fuelled.g.value = 1_000_000;
      expect(fuelled[fn](n)).toBe(fn === "run" ? n : 0);
      expect(1_000_000 - (fuelled.g.value as number), `${fn}(${n})`).toBe(used);
    }
  });

  it("traps at the budget: in a loop, in an endless loop and in recursion without a loop", () => {
    const { run, spin, rec, g } = instantiate(meter(testModule(), { mode: "fuel" }).bytes, FUEL_EXPORT);
    g.value = 9 * 100 + 8;
    expect(run(100)).toBe(100); // exactly enough
    expect(g.value).toBe(0);
    g.value = 9 * 50; // half: traps at a loop header (an overrun past the last check is at most one segment)
    expect(() => run(100)).toThrow(WebAssembly.RuntimeError);
    g.value = 10_000;
    expect(() => spin(0)).toThrow(/out of bounds/);
    expect(g.value as number).toBeLessThan(0);
    g.value = 1000;
    expect(() => rec(1_000_000)).toThrow(/out of bounds/); // fuel, not a stack overflow
  });

  it("starts at zero: nothing runs until fuel is granted", () => {
    const { run } = instantiate(meter(testModule(), { mode: "fuel" }).bytes, FUEL_EXPORT);
    expect(() => run(0)).toThrow(WebAssembly.RuntimeError);
  });

  it("checks only at function entries and loop headers, branch-free (no control instruction added)", () => {
    const fuelled = meter(testModule(), { mode: "fuel" });
    expect(fuelled.stats.checks).toBe(5); // three function entries, the loop headers of run and spin
    // Count-metering the fuelled module finds the same segments as the plain one: the fuel code added no control flow.
    expect(meter(fuelled.bytes).stats.segments).toBe(meter(testModule()).stats.segments);
  });

  it("caps the memory below 4 GiB, so the check's load at 0xFFFFFFFF always traps", () => {
    expect(readModule(meter(testModule(), { mode: "fuel" }).bytes).memories[0]).toMatchObject({ min: 1, max: 65535 });
    expect(readModule(meter(testModule(), { mode: "fuel", maxPages: 16 }).bytes).memories[0]).toMatchObject({ max: 16 });
    expect(() => meter(testModule(), { mode: "fuel", maxPages: 0 })).toThrow(/minimum/);
    expect(() => meter(testModule(), { mode: "fuel", maxPages: 65536 })).toThrow(/maxPages/);
  });

  it("refuses modules its check can't guard", () => {
    expect(() => meter(testModule("none"), { mode: "fuel" })).toThrow(/needs a memory/);
    expect(() => meter(testModule("imported"), { mode: "fuel" })).toThrow(/own memory/);
    expect(() => meter(testModule("shared"), { mode: "fuel" })).toThrow(/shared memory/);
  });
});

describe("readModule", () => {
  it("lists types, imports, exports and memories", () => {
    const info = readModule(testModule("imported"));
    expect(info.imports).toEqual([{ module: "env", name: "mem", kind: "memory", memory: { min: 1, max: null, shared: false, memory64: false } }]);
    expect(info.exports.map((e) => `${e.name}:${e.kind}`)).toEqual(["run:function", "spin:function", "rec:function"]);
    expect(info.functions).toEqual(Array(3).fill({ params: ["i32"], results: ["i32"] }));
    expect(info.memories).toEqual([{ min: 1, max: null, shared: false, memory64: false, imported: true }]);
    expect(info.start).toBe(false);
    expect(info.relaxedSimd).toBe(false);
    expect(readModule(testModule("shared")).memories[0]).toMatchObject({ shared: true, max: 1 });
  });

  it("throws on an instruction it doesn't decode (atomics), as the pass does", () => {
    const bad = testModule();
    bad[bad.length - 2] = 0xfe; // rec's last `end` → the atomics prefix
    expect(() => readModule(bad)).toThrow(/unsupported opcode 0xfe/);
    expect(() => meter(bad)).toThrow(/unsupported opcode 0xfe/);
  });
});
