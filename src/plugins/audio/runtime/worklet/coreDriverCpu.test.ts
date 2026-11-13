// 0171/0172 M5 Cp1 (architecture §4.3, R18; api-and-models §4.3): the shell's CPU counters in every STATUS, under a
// fake `Date.now` with the real wasm. `busyMsTotal` sums t1 − t0 around each `process()` call (t0 its `dateNow`, t1
// the clock read after it), `quantaTotal` counts the calls, `clockStepMs` is the smallest non-zero delta and
// `clockSteps` counts the clamped ones. All cumulative across cadence switches and skipped posts; a new driver (a
// restart) starts at 0. A STATUS carries the calls completed before the one that posts it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kind, readStatus, STATUS_EVERY_QUANTA, STATUS_IDLE_EVERY_QUANTA, writeBatchHeader, writeEnvelope, type StatusBlock } from "../wire.generated";
import { CoreDriver, CPU_DELTA_MAX_MS, instantiateCore, SHELL_FIELD, type CoreInstance, type CorePreset } from "./coreDriver";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio.wasm", import.meta.url)));
const RATE = 48_000;
const PRESET: CorePreset = { maxLogical: 64, maxMixed: 16, maxBuses: 4, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 1.5, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 };

/** One STATUS as posted, with the `process()` calls made before the one that posted it. */
interface Posted {
  readonly block: StatusBlock;
  readonly callsBefore: number;
}

/**
 * A driver under a fake wall clock. Each `step(busy, gap)` is one `process()` call: t0 = `now`, `Date.now()` (t1)
 * returns `now + busy`, then `now` moves on by `gap`. STATUS buffers go back to the pool unless `hold` is set.
 */
function rig(options: { core?: CoreInstance; now?: number } = {}) {
  const core = options.core ?? instantiateCore(WASM, PRESET, RATE);
  const state = { now: options.now ?? 1_000_000, t1: 0, frame: 0, calls: 0, hold: false };
  const posted: Posted[] = [];
  const held: ArrayBuffer[] = [];
  const driver: CoreDriver = new CoreDriver(
    core,
    (m) => {
      if (!(m instanceof ArrayBuffer) || new DataView(m).getUint16(6, true) !== Kind.STATUS) return;
      posted.push({ block: readStatus(m), callsBefore: state.calls });
      if (state.hold) held.push(m);
      else driver.pool.release(m);
    },
    state.now,
  );
  vi.spyOn(Date, "now").mockImplementation(() => state.t1);
  const step = (busy: number, gap: number) => {
    state.t1 = state.now + busy;
    driver.process(state.frame, state.now);
    state.calls++;
    state.frame += 128;
    state.now += gap;
  };
  const run = (n: number, busy = 1, gap = 3) => {
    for (let i = 0; i < n; i++) step(busy, gap);
  };
  const release = () => {
    for (const b of held.splice(0)) driver.pool.release(b);
  };
  return { core, state, driver, posted, step, run, release };
}

function batch(): ArrayBuffer {
  const buffer = new ArrayBuffer(64 * 1024);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.BATCH, seq: 0, bodyBytes: 16 });
  writeBatchHeader(view, 0, { firstFrame: 0, count: 0, flags: 0 });
  return buffer;
}

/** Every posted STATUS carries exactly the calls before it, `busyPerCall` ms each, and never goes down. */
function expectCumulative(posted: readonly Posted[], busyPerCall: number): void {
  let last = -1;
  for (const p of posted) {
    expect(p.block.quantaTotal).toBe(p.callsBefore);
    expect(p.block.busyMsTotal).toBe(p.callsBefore * busyPerCall);
    expect(p.block.quantaTotal).toBeGreaterThan(last);
    last = p.block.quantaTotal;
    expect(p.block.loadPermille).toBe(0);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coreDriver CPU counters (Cp1)", () => {
  it("land at 176, 184, 238 and 244, beside dateMs", () => {
    expect(SHELL_FIELD).toMatchObject({ dateMs: 24, busyMsTotal: 176, quantaTotal: 184, clockStepMs: 238, clockSteps: 244 });
    const r = rig();
    r.run(STATUS_EVERY_QUANTA, 2, 3);
    const s = r.posted.at(-1)!.block;
    expect(s.dateMs).toBe(1_000_000 + (STATUS_EVERY_QUANTA - 1) * 3);
    expect(s.quantaTotal).toBe(STATUS_EVERY_QUANTA - 1);
    expect(s.busyMsTotal).toBe(2 * (STATUS_EVERY_QUANTA - 1));
    expect(s.clockStepMs).toBe(2);
    expect(s.clockSteps).toBe(0);
    expect(s.loadPermille).toBe(0);
    expect(r.driver.quantaTotal).toBe(STATUS_EVERY_QUANTA);
  });

  it("are cumulative across a 6 → 48 cadence switch and back", () => {
    const r = rig();
    r.run(300); // 900 ms of fake time, no batch: the idle cadence after 250 ms
    const gaps = r.posted.slice(1).map((p, i) => p.callsBefore - r.posted[i]!.callsBefore);
    expect(gaps[0]).toBe(STATUS_EVERY_QUANTA);
    expect(gaps.at(-1)).toBe(STATUS_IDLE_EVERY_QUANTA);
    r.driver.onMessage(batch(), r.state.frame, r.state.now);
    const before = r.posted.length;
    r.run(48);
    expect(r.posted.length - before).toBeGreaterThanOrEqual(7);
    expect(r.posted.at(-1)!.callsBefore - r.posted.at(-2)!.callsBefore).toBe(STATUS_EVERY_QUANTA);
    expectCumulative(r.posted, 1);
    expect(r.driver.stats.skipped).toBe(0);
  });

  it("are cumulative across posts skipped for an empty pool", () => {
    const r = rig();
    // 2 ms between calls keeps the whole run under the idle cadence's 250 ms.
    r.run(12, 1, 2);
    r.state.hold = true;
    r.run(6 * 12, 1, 2); // eight buffers, then every post is skipped
    expect(r.driver.stats.skipped).toBeGreaterThan(0);
    const skipped = r.driver.stats.skipped;
    r.state.hold = false;
    r.release();
    r.run(6, 1, 2);
    expect(r.driver.stats.skipped).toBe(skipped);
    const last = r.posted.at(-1)!;
    expect(last.block.quantaTotal).toBe(12 + 72 + 5);
    expectCumulative(r.posted, 1);
  });

  it("are cumulative across an oversized block dropped", () => {
    const real = instantiateCore(WASM, PRESET, RATE);
    let oversize = false;
    const exports = {
      ...real.exports,
      myco_audio_status_take: () => {
        const n = real.exports.myco_audio_status_take();
        return oversize ? 1 << 30 : n;
      },
    };
    const r = rig({ core: { ...real, exports } });
    r.run(12);
    expect(r.posted.length).toBe(2);
    oversize = true;
    r.run(12);
    expect(r.posted.length).toBe(2);
    oversize = false;
    r.run(6);
    expect(r.posted.length).toBe(3);
    expect(r.posted.at(-1)!.block.quantaTotal).toBe(29);
    expectCumulative(r.posted, 1);
  });

  it("clamp a backwards step and a jump past 1 s to 0 busy, count them in clockSteps, and saturate", () => {
    const r = rig();
    r.run(6, 1, 3);
    r.step(-5, 3); // t1 before t0: the clock stepped back
    r.step(CPU_DELTA_MAX_MS + 1, 3); // past 1 s
    r.step(CPU_DELTA_MAX_MS, 3); // exactly 1 s counts
    r.run(9, 1, 3);
    const s = r.posted.at(-1)!.block;
    expect(s.quantaTotal).toBe(17);
    expect(s.busyMsTotal).toBe(6 + 0 + 0 + CPU_DELTA_MAX_MS + 8);
    expect(s.clockSteps).toBe(2);
    expect(s.clockStepMs).toBe(1);
    // t0 itself stepping back between calls clamps nothing: the busy deltas are whole.
    r.state.now -= 10_000;
    r.run(6, 1, 3);
    expect(r.posted.at(-1)!.block.clockSteps).toBe(2);
    r.driver.clockSteps = 0xfffe;
    r.step(-1, 3);
    r.step(-1, 3);
    r.run(6);
    expect(r.posted.at(-1)!.block.clockSteps).toBe(0xffff);
  });

  it("keep clockStepMs at the smallest non-zero delta, 0 until there is one", () => {
    const r = rig();
    r.run(6, 0, 0); // a clock that never moved: no step yet
    expect(r.posted.at(-1)!.block.clockStepMs).toBe(0);
    expect(r.posted.at(-1)!.block.busyMsTotal).toBe(0);
    r.run(12, 0, 2); // a 2 ms clock (Firefox resistFingerprinting)
    expect(r.posted.at(-1)!.block.clockStepMs).toBe(2);
    r.run(12, 2, 4);
    expect(r.posted.at(-1)!.block.clockStepMs).toBe(2);
    r.run(6, 1, 3);
    expect(r.posted.at(-1)!.block.clockStepMs).toBe(1);
  });

  it("start at 0 again after a restart (a new driver)", () => {
    const r = rig();
    r.run(30, 1, 3);
    r.step(-1, 3);
    expect(r.driver.quantaTotal).toBe(31);
    // The hard rebuild: a new node, so a new core and driver.
    const again = rig({ now: r.state.now });
    expect([again.driver.busyMsTotal, again.driver.quantaTotal, again.driver.clockStepMs, again.driver.clockSteps]).toEqual([0, 0, 0, 0]);
    again.run(6, 2, 3);
    const s = again.posted[0]!.block;
    expect([s.quantaTotal, s.busyMsTotal, s.clockSteps]).toEqual([5, 10, 0]);
  });
});
