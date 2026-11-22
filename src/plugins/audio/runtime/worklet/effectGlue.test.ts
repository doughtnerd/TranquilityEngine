// ADR 0338 §1, §6 and 0344 §1, §4, §5: the worklet glue through the interface the core and the shell use (the
// `myco_ext` import object, `onControl`, `beginQuantum` and the posted events), over a memory standing in for the core's
// and the SDK's real test plugin (`native/fx-sdk/wasm/test_fx.wasm`, validated and instrumented as main does).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateEffectModule } from "../effectPlugins/validate";
import { FX_PLUGIN_FLAG_PARAMS, FX_PLUGIN_FLAG_RESET } from "../wire.generated";
import { EffectGlue, FX_STATUS, type FxEffectEntry, type FxShellEvent } from "./effectGlue";
import { scanHelperBytes } from "./scanHelper";

const TEST_FX = new URL("../../../../../native/fx-sdk/wasm/test_fx.wasm", import.meta.url);
const GAIN: FxEffectEntry = { e: 7, type: "test.fx.gain", kind: 0, budget: 100, maxInstances: 2, modes: 0 };
const TRAP: FxEffectEntry = { e: 9, type: "test.fx.trap", kind: 3, budget: 200, maxInstances: 1, modes: 1 << 16 };

/** Where the stand-in core keeps a block: l, r, p0, p1 and a handle list (byte offsets). */
const L = 1024;
const R = L + 512;
const P0 = R + 512;
const P1 = P0 + 64;
const LIST = P1 + 64;

async function rig() {
  const v = await validateEffectModule(new Uint8Array(readFileSync(TEST_FX)), { memoryMB: 4 });
  if (!v.ok) throw new Error(v.problems.join("; "));
  const memory = new WebAssembly.Memory({ initial: 1 });
  const f32 = new Float32Array(memory.buffer);
  const glue = new EffectGlue(48_000);
  glue.attach(memory);
  const events: FxShellEvent[] = [];
  glue.setPost((e) => events.push(e));
  const load = (effects: readonly FxEffectEntry[], id = 1) => glue.onControl({ type: "fxLoad", id, plugin: "test.fx", bytes: v.bytes.slice().buffer, effects });
  /** One block through the import: `fill` in, the parameters `p` at both edges; returns the status and the block. */
  const call = (handle: number, fill: number, p: number[], flags = 0, fuel = 128 * 1000) => {
    f32.fill(fill, L >> 2, (L >> 2) + 128);
    f32.fill(fill, R >> 2, (R >> 2) + 128);
    f32.fill(0, P0 >> 2, (P1 >> 2) + 16);
    f32.set(p, P0 >> 2);
    f32.set(p, P1 >> 2);
    const status = glue.imports.process(handle, L, R, 128, P0, P1, flags, fuel);
    return { status, l: f32.slice(L >> 2, (L >> 2) + 128), r: f32.slice(R >> 2, (R >> 2) + 128) };
  };
  const sweep = (handles: number[]) => {
    new Uint32Array(memory.buffer).set(handles, LIST >> 2);
    glue.imports.sweep(LIST, handles.length, 1);
  };
  return { glue, events, load, call, sweep };
}

describe("the plugin effect glue (ADR 0338, 0344)", () => {
  it("compiles, warms each effect up and pre-creates its instances before any goes live", async () => {
    const { glue, events, load } = await rig();
    const loading = load([GAIN, TRAP]);
    expect(glue.imports.acquire(GAIN.e), "not live while it compiles").toBe(0);
    await loading;
    expect(events).toEqual([{ type: "fxLoaded", id: 1, ok: true, warmUps: 2, instances: 3, memoryBytes: expect.any(Number) }]);
    expect(glue.imports.describe(GAIN.e, 1)).toBe(100);
    expect(glue.imports.describe(TRAP.e, 0)).toBe(1 << 16);
    const a = glue.imports.acquire(GAIN.e);
    const b = glue.imports.acquire(GAIN.e);
    expect([a > 0, b > 0, a !== b]).toEqual([true, true, true]);
    expect(glue.imports.acquire(GAIN.e), "maxInstances 2: the pool is empty").toBe(0);
  });

  it("copies the block in and out, grants the fuel and returns the instructions used", async () => {
    const { glue, load, call } = await rig();
    await load([GAIN]);
    const h = glue.imports.acquire(GAIN.e);
    const { status, l, r } = call(h, 0.5, [0.25], FX_PLUGIN_FLAG_PARAMS | FX_PLUGIN_FLAG_RESET);
    expect(l.every((x) => x === 0.125) && r.every((x) => x === 0.125)).toBe(true);
    expect(status).toBeGreaterThan(0);
    expect(status & 1, "not silent").toBe(0);
    const used = status >> 1;
    expect(used).toBeGreaterThan(30 * 128 * 0.5);
    expect(used).toBeLessThanOrEqual(128 * 1000);
    // No fuel: the glue passes the block without calling the plugin.
    expect(call(h, 0.5, [0.25], 0, 0)).toMatchObject({ status: FX_STATUS.pass, l: new Float32Array(128).fill(0.5) });
  });

  it("a fault leaves the block dry, and the next quantum re-instantiates the module (instances and handles kept)", async () => {
    const { glue, events, load, call } = await rig();
    await load([TRAP]);
    const h = glue.imports.acquire(TRAP.e);
    expect(call(h, 1, [0], FX_PLUGIN_FLAG_PARAMS).l[0]).toBe(0.5);
    const trapped = call(h, 1, [1], FX_PLUGIN_FLAG_PARAMS);
    expect(trapped.status).toBe(FX_STATUS.fault);
    expect(trapped.l.every((x) => x === 1), "dry").toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "pluginFault", e: TRAP.e, instance: h, reason: "trap", disabled: false });
    expect(call(h, 1, [0]).status, "broken until the next quantum").toBe(FX_STATUS.pass);
    glue.beginQuantum(128);
    expect(call(h, 1, [0]).l[0], "re-instantiated, same handle").toBe(0.5);
    // Memory growth in `process` is a module fault too.
    expect(call(h, 1, [3], FX_PLUGIN_FLAG_PARAMS).status).toBe(FX_STATUS.fault);
    expect(events.at(-1)).toMatchObject({ reason: "grow" });
    glue.beginQuantum(256);
    expect(call(h, 1, [0]).l[0]).toBe(0.5);
  });

  it("three faults of an effect within a second turn it off until it is reset", async () => {
    const { glue, events, load, call } = await rig();
    await load([TRAP]);
    const h = glue.imports.acquire(TRAP.e);
    for (let k = 0; k < 3; k++) {
      glue.beginQuantum(k * 4_800);
      call(h, 1, [1], FX_PLUGIN_FLAG_PARAMS);
    }
    expect(events.filter((e) => e.type === "pluginFault").map((e) => (e as { disabled: boolean }).disabled)).toEqual([false, false, true]);
    glue.beginQuantum(20_000);
    expect(call(h, 1, [0]).status, "off").toBe(FX_STATUS.pass);
    glue.onControl({ type: "fxReset", e: [TRAP.e] });
    expect(call(h, 1, [0]).l[0]).toBe(0.5);
    expect(events.at(-1)).toMatchObject({ type: "fxStats", rows: [{ e: TRAP.e, state: "live", faults: { trap: 3 } }] });
  });

  it("faults a second apart never turn it off", async () => {
    const { glue, events, load, call } = await rig();
    await load([TRAP]);
    const h = glue.imports.acquire(TRAP.e);
    for (let k = 0; k < 4; k++) {
      glue.beginQuantum(k * 48_000);
      call(h, 1, [1], FX_PLUGIN_FLAG_PARAMS);
    }
    expect(events.filter((e) => e.type === "pluginFault" && e.disabled)).toEqual([]);
  });

  it("the core's sweep releases the instances it no longer lists; an unloaded module's handles answer STALE", async () => {
    const { glue, load, call, sweep } = await rig();
    await load([GAIN]);
    const a = glue.imports.acquire(GAIN.e);
    const b = glue.imports.acquire(GAIN.e);
    sweep([b]);
    expect(glue.imports.acquire(GAIN.e), "a went back to the pool").toBe(a);
    glue.onControl({ type: "fxUnload", id: 1 });
    expect(call(b, 1, [1]).status).toBe(FX_STATUS.stale);
    expect(glue.imports.acquire(GAIN.e)).toBe(0);
  });

  it("refuses a module that faults in its warm-up, and says so", async () => {
    const { glue, events, load } = await rig();
    // Kind 99 doesn't exist: create refuses it.
    await load([{ ...GAIN, kind: 99 }]);
    expect(events[0]).toMatchObject({ type: "fxLoaded", ok: false });
    expect(glue.imports.acquire(GAIN.e)).toBe(0);
  });

  it("the scan helper is a small module that checks |x| <= 64 and finiteness", () => {
    const bytes = scanHelperBytes();
    expect(bytes.length).toBeLessThan(256);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const scan = (new WebAssembly.Instance(new WebAssembly.Module(bytes), { p: { memory } }).exports as { scan: (l: number, r: number, n: number) => number }).scan;
    const f = new Float32Array(memory.buffer);
    f.fill(64, 0, 256);
    expect(scan(0, 512, 128)).toBe(1);
    for (const bad of [64.001, -65, Number.NaN, Number.POSITIVE_INFINITY]) {
      f[130] = bad;
      expect(scan(0, 512, 128), String(bad)).toBe(0);
      f[130] = 0;
    }
    f[127 + 128] = Number.NaN;
    expect(scan(0, 512, 128), "the last sample of r").toBe(0);
  });
});
