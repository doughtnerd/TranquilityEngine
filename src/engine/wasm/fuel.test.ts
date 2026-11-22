// ADR 0344 §2: fuel on real plugin kernels, through the meter's interface and the modules' own ABI exports. The
// tremolo (samples/fx-tremolo) is the kernel the B0 spike found a +157% cliff on when the check branched; it stays here
// as the guard. The structural check (no control flow added) is what keeps the check branch-free; the timings are
// reported, not asserted (a shared machine's wall time isn't a test).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COUNTER_EXPORT, FUEL_EXPORT, meter } from "./meter.js";

const read = (path: string) => new Uint8Array(readFileSync(new URL(`../../../${path}`, import.meta.url)));
const MAX = 128;

interface Kernel {
  label: string;
  bytes: Uint8Array<ArrayBuffer>;
  kind: number;
  /** p0 = p1: the parameters. */
  params: number[];
  /** The manifest's budget (instructions per frame). */
  budget: number;
}

const KERNELS: Kernel[] = [
  { label: "tremolo", bytes: read("samples/fx-tremolo/plugins/tremolo/dsp/tremolo.wasm"), kind: 0, params: [5, 50, 0], budget: 300 },
  { label: "biquad8", bytes: read("native/fx-sdk/wasm/test_fx.wasm"), kind: 1, params: [1000, 0.707], budget: 1000 },
];

/** An instance of `bytes` with one effect created, its I/O block, and `process()` for one 128-frame block. */
function instance(bytes: Uint8Array<ArrayBuffer>, k: Kernel) {
  const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as Record<string, unknown>;
  const fuel = x[FUEL_EXPORT] as WebAssembly.Global | undefined;
  const counter = x[COUNTER_EXPORT] as WebAssembly.Global | undefined;
  const grant = (n: number) => { if (fuel) fuel.value = n; };
  grant(1e8);
  const h = (x.myco_fx_create as (k: number, sr: number, max: number) => number)(k.kind, 48000, MAX);
  grant(1e8);
  const io = new Float32Array((x.memory as WebAssembly.Memory).buffer, (x.myco_fx_io as (k: number, s: number) => number)(k.kind, h), 2 * MAX + 32);
  io.set(k.params, 2 * MAX);
  io.set(k.params, 2 * MAX + 16);
  const proc = x.myco_fx_process as (k: number, s: number, f: number, flags: number) => number;
  const input = Float32Array.from({ length: 2 * MAX }, (_, i) => Math.sin(i * 0.05) * 0.5);
  return {
    fuel,
    counter,
    process(flags = 0) {
      io.set(input);
      grant(k.budget * MAX);
      return proc(k.kind, h, MAX, flags);
    },
  };
}

/** Median ns per block of `run` over interleaved rounds. */
function timeRounds(runs: Record<string, () => void>, rounds = 9, blocks = 2000): Record<string, number> {
  const samples: Record<string, number[]> = Object.fromEntries(Object.keys(runs).map((k) => [k, []]));
  for (const run of Object.values(runs)) for (let i = 0; i < 200; i++) run(); // warm up (tier up)
  for (let r = 0; r < rounds; r++) {
    for (const [k, run] of Object.entries(runs)) {
      const t0 = performance.now();
      for (let i = 0; i < blocks; i++) run();
      samples[k]!.push(((performance.now() - t0) * 1e6) / blocks);
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.sort((a, b) => a - b)[v.length >> 1]!]));
}

describe("fuel on real plugin kernels", () => {
  for (const k of KERNELS) {
    it(`${k.label}: branch-free (no control flow added), exact, and within its budget`, () => {
      const fuelled = meter(k.bytes, { mode: "fuel" });
      // Count-metering the fuelled module finds exactly the plain module's segments: the check added no branch.
      expect(meter(fuelled.bytes).stats.segments).toBe(meter(k.bytes).stats.segments);
      // Fuel used per block equals the count mode's executed instructions.
      const counted = instance(meter(k.bytes).bytes, k);
      const before = counted.counter!.value as bigint;
      counted.process(1);
      const instructions = Number((counted.counter!.value as bigint) - before);
      const f = instance(fuelled.bytes, k);
      f.process(1);
      expect(k.budget * MAX - (f.fuel!.value as number)).toBe(instructions);
      console.info(`[fuel] ${k.label}: ${(instructions / MAX).toFixed(1)} instructions per frame (budget ${k.budget}); ${fuelled.stats.checks} checks; ${k.bytes.length} → ${fuelled.bytes.length} bytes`);
      expect(instructions / MAX).toBeLessThan(k.budget);
    });
  }

  it("traps a block whose budget is too small, and runs the next one granted enough", () => {
    const k = KERNELS[0]!;
    const f = instance(meter(k.bytes, { mode: "fuel" }).bytes, { ...k, budget: 10 });
    expect(() => f.process()).toThrow(WebAssembly.RuntimeError);
    const ok = instance(meter(k.bytes, { mode: "fuel" }).bytes, k);
    expect(ok.process()).toBe(0);
  });

  it("reports the fuel overhead on the tremolo and the biquad cascade (no wall-clock assertion)", () => {
    const lines: string[] = [];
    for (const k of KERNELS) {
      const plain = instance(k.bytes, k);
      const counted = instance(meter(k.bytes).bytes, k);
      const fuelled = instance(meter(k.bytes, { mode: "fuel" }).bytes, k);
      const t = timeRounds({ plain: () => plain.process(), count: () => counted.process(), fuel: () => fuelled.process() });
      const pct = (v: number) => `${v >= t.plain! ? "+" : ""}${(((v - t.plain!) / t.plain!) * 100).toFixed(0)}%`;
      lines.push(`${k.label}: plain ${t.plain!.toFixed(0)} ns/block, count ${pct(t.count!)}, fuel ${pct(t.fuel!)}`);
      expect(t.fuel).toBeGreaterThan(0);
    }
    console.info(`[fuel] overhead (median of 9 interleaved rounds of 2,000 blocks):\n  ${lines.join("\n  ")}`);
  });
});
