// ADR 0157 task C1b: the metered build. `tools/audio-bench/meter.mjs` injects an instruction counter into a wasm
// binary; CI's cost gate (`tools/audio-bench/metered-gate.mjs`) runs audio-bench's scenes through the metered bench
// and fails on a +10% count. These tests check the pass counts exactly on a hand-written module, and that the
// committed metered build matches the mixer's sources (else the gate would measure stale code).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COUNTER_EXPORT, METER_VERSION, meter } from "../../../../../tools/audio-bench/meter.mjs";

const REBUILD = "run `npm run build:audio`";
const meteredDir = new URL("../../../../../tools/audio-bench/metered/", import.meta.url);

/**
 * `(func (export "run") (param $n i32) (result i32) (local $i i32)
 *    block loop  local.get $i local.get $n i32.ge_u br_if 1  local.get $i i32.const 1 i32.add local.set $i br 0  end end
 *    local.get $i)`
 * Executes 9n + 8 instructions: block and loop, 9 per iteration, 4 on the exit test, then local.get and the final end.
 */
const LOOP_MODULE = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
  0x0a, 0x1e, 0x01, 0x1c, 0x01, 0x01, 0x7f,
  0x02, 0x40, 0x03, 0x40, 0x20, 0x01, 0x20, 0x00, 0x4f, 0x0d, 0x01,
  0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x0c, 0x00, 0x0b, 0x0b,
  0x20, 0x01, 0x0b,
]);

function instantiate(bytes: Uint8Array<ArrayBuffer>) {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  return { run: exports.run as (n: number) => number, counter: exports[COUNTER_EXPORT] as WebAssembly.Global };
}

describe("meter (the metered build's pass)", () => {
  it("counts every executed instruction of a loop exactly, without changing its result", () => {
    const { bytes, stats } = meter(LOOP_MODULE);
    expect(stats.functions).toBe(1);
    const { run, counter } = instantiate(bytes);
    let before = counter.value as bigint;
    for (const n of [0, 1, 10, 1000]) {
      expect(run(n)).toBe(n);
      const after = counter.value as bigint;
      expect(after - before, `n = ${n}`).toBe(BigInt(9 * n + 8));
      before = after;
    }
  });

  it("refuses an instruction it can't decode instead of skipping it", () => {
    const bad = Uint8Array.from(LOOP_MODULE);
    bad[bad.length - 3] = 0xfe; // local.get $i → an atomics prefix
    expect(() => meter(bad)).toThrow(/unsupported opcode 0xfe/);
  });
});

describe.skipIf(!existsSync(meteredDir))("the committed metered build", () => {
  it("was built from the mixer's sources by this meter version (else: run `npm run build:audio`)", () => {
    const meta = JSON.parse(readFileSync(new URL("metered.json", meteredDir), "utf8")) as { sourceHash: string; meterVersion: number; bytes: number };
    const hash = JSON.parse(readFileSync(new URL("./hash.json", import.meta.url), "utf8")) as { sourceHash: string };
    expect(meta.sourceHash, `the metered wasm is stale: ${REBUILD}`).toBe(hash.sourceHash);
    expect(meta.meterVersion).toBe(METER_VERSION);
    const wasm = readFileSync(new URL("audio_bench.metered.wasm", meteredDir));
    expect(wasm.length).toBe(meta.bytes);
    const module = new WebAssembly.Module(wasm);
    expect(WebAssembly.Module.exports(module)).toContainEqual({ name: COUNTER_EXPORT, kind: "global" });
  });
});
