// The shell's logic in Node with the real myco_audio.wasm (ADR 0157; architecture §4.6), wired to the main side's
// CoreLink through a fake port that queues both ways, under a fake clock. No AudioContext, no rAF: "frames
// stopped" is the normal state here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CoreLink, type LinkPort } from "../core/context";
import { BATCH_POOL_BUFFERS } from "../core/bufferPool";
import { Kind, readStatus, SCHEMA_HASH, STATUS_FLAGS_READY, writeBatchHeader, writeEnvelope, type StatusBlock } from "../wire.generated";
import { CoreDriver, CoreLoadError, FLAG_TRAP_CAUGHT, instantiateCore, MEMORY_INITIAL_PAGES, memoryMaximumPages, SHELL_FIELD, UnderrunProbe, type CoreInstance, type CorePreset } from "./coreDriver";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio.wasm", import.meta.url)));
const RATE = 48_000;
const QUANTUM_MS = (128 / RATE) * 1000;
const PRESET: CorePreset = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20 };

/** A driver and a link joined by queues; `recycle: false` makes main keep every STATUS buffer. */
function rig(options: { recycle?: boolean; core?: CoreInstance } = {}) {
  const clock = { frame: 0, now: 1_000_000 };
  const toMain: unknown[] = [];
  const toWorklet: unknown[] = [];
  const core = options.core ?? instantiateCore(WASM, PRESET, RATE);
  const driver = new CoreDriver(core, (m) => toMain.push(m), clock.now);
  const port: LinkPort = { onmessage: null, postMessage: (m) => toWorklet.push(m) };
  const link = new CoreLink(port);
  const blocks: StatusBlock[] = [];
  link.onStatus((s) => blocks.push(s));
  const statusBuffers = new Set<ArrayBuffer>();
  const flush = () => {
    while (toMain.length || toWorklet.length) {
      for (const m of toMain.splice(0)) {
        if (m instanceof ArrayBuffer && new DataView(m).getUint16(6, true) === Kind.STATUS) {
          statusBuffers.add(m);
          if (options.recycle === false) {
            blocks.push(readStatus(m));
            continue;
          }
        }
        port.onmessage?.({ data: m });
      }
      for (const m of toWorklet.splice(0)) {
        if (m instanceof ArrayBuffer) driver.onMessage(m, clock.frame, clock.now);
        else driver.onControl(m as never);
      }
    }
  };
  const run = (quanta: number) => {
    for (let i = 0; i < quanta; i++) {
      driver.process(clock.frame, clock.now);
      clock.frame += 128;
      clock.now += QUANTUM_MS;
      flush();
    }
  };
  return { clock, core, driver, link, blocks, statusBuffers, run, flush, toMain };
}

function batch(): ArrayBuffer {
  const buffer = new ArrayBuffer(64 * 1024);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.BATCH, seq: 0, bodyBytes: 16 });
  writeBatchHeader(view, 0, { firstFrame: 0, count: 0, flags: 0 });
  return buffer;
}

describe("coreDriver with the real wasm", () => {
  it("instantiates on 64 initial pages and lands init on the same addresses each time", () => {
    const a = instantiateCore(WASM, PRESET, RATE);
    const b = instantiateCore(WASM, PRESET, RATE);
    const addresses = (c: CoreInstance) => [c.exports.myco_audio_inbox_ptr(), c.exports.myco_audio_status_ptr(), c.exports.myco_audio_process(0, 0), c.memory.buffer.byteLength];
    expect(addresses(a)).toEqual(addresses(b));
    expect(a.exports.myco_audio_process(0, 0)).toBeGreaterThanOrEqual(MEMORY_INITIAL_PAGES * 65_536);
    expect(memoryMaximumPages(PRESET)).toBe(64 + (16 << 20) / 65_536 + (16 << 20) / 65_536);
  });

  it("refuses a schema hash or ABI major mismatch with CoreLoadError", () => {
    expect(() => instantiateCore(WASM, PRESET, RATE, { schemaHash: "00".repeat(16), abiMajor: 1 })).toThrow(CoreLoadError);
    expect(() => instantiateCore(WASM, PRESET, RATE, { schemaHash: SCHEMA_HASH, abiMajor: 2 })).toThrow(/ABI/);
    expect(() => instantiateCore(WASM, { ...PRESET, maxMixed: 0 }, RATE)).toThrow(/init refused/);
  });

  it("posts a STATUS every 6 quanta that readStatus reads, ready flag and ABI version in the first block", async () => {
    const r = rig();
    r.run(5);
    expect(r.blocks).toHaveLength(0);
    r.run(1);
    expect(r.blocks).toHaveLength(1);
    const first = r.blocks[0]!;
    expect(first.flags & STATUS_FLAGS_READY).toBeTruthy();
    expect(first.abiVersion).toBe(0x100);
    expect(first.currentFrame).toBe(6 * 128);
    await expect(r.link.ready).resolves.toBeUndefined();
    r.run(6);
    expect(r.blocks[1]!.abiVersion).toBe(0);
    expect(r.blocks[1]!.currentFrame).toBe(12 * 128);
  });

  it("echoes a TIME_PING's pingSeq and frame in the next STATUS", () => {
    const r = rig();
    r.run(3);
    const seq = r.link.ping();
    r.flush();
    r.run(3);
    const s = r.link.lastStatus!;
    expect(s.pingSeq).toBe(seq);
    expect(s.pingFrameLo).toBe(3 * 128);
  });

  it("RECYCLE returns buffers to the pool: 8 buffers circulate for 10,000 quanta with none skipped", () => {
    const r = rig();
    r.run(10_000);
    expect(r.driver.stats.skipped).toBe(0);
    expect(r.driver.stats.recycled).toBe(r.driver.stats.posted);
    expect(r.driver.pool.available).toBe(8);
    expect(r.statusBuffers.size).toBeLessThanOrEqual(8);
  });

  it("without RECYCLE the pool runs dry after 8 posts and later posts are skipped", () => {
    const r = rig({ recycle: false });
    r.run(6 * 20);
    expect(r.driver.stats.posted).toBe(8);
    expect(r.driver.stats.skipped).toBeGreaterThan(0);
    expect(r.driver.pool.available).toBe(0);
  });

  it("frames stopped: no batches, STATUS slows to every 48 quanta after 250 ms and keeps flowing", () => {
    const r = rig();
    const idleAt = Math.ceil(250 / QUANTUM_MS); // 94 quanta
    r.run(idleAt + 2);
    const before = r.link.statusCount;
    expect(before).toBe(Math.floor(idleAt / 6));
    r.run(48 * 100);
    expect(r.link.statusCount - before).toBeGreaterThanOrEqual(99);
    expect(r.link.statusCount - before).toBeLessThanOrEqual(101);
    expect(r.link.lastStatus!.currentFrame).toBeGreaterThan(r.clock.frame - 49 * 128);
    expect(r.driver.stats.skipped).toBe(0);
  });

  it("a batch brings the 6-quantum cadence back, and its buffer returns to the host's pool", () => {
    const r = rig();
    r.run(48 * 10);
    const taken = r.link.batchPool.acquire()!;
    expect(r.link.batchPool.available).toBe(BATCH_POOL_BUFFERS - 1);
    void taken;
    r.driver.onMessage(batch(), r.clock.frame, r.clock.now);
    r.flush();
    expect(r.link.batchPool.available).toBe(BATCH_POOL_BUFFERS);
    const before = r.link.statusCount;
    r.run(48);
    expect(r.link.statusCount - before).toBeGreaterThanOrEqual(7);
  });

  it("shell fields (dateMs, ping, underruns, traps) land where readStatus reads them", () => {
    const r = rig();
    r.driver.probe.underruns = 3;
    r.driver.probe.underrunFrames = 99;
    r.driver.traps = 2;
    r.run(6);
    const s = r.link.lastStatus!;
    expect(s.dateMs).toBeCloseTo(1_000_000 + 5 * QUANTUM_MS, 6);
    expect(s.underruns).toBe(3);
    expect(s.underrunFrames).toBe(99);
    expect(s.traps).toBe(2);
    expect(s.flags & FLAG_TRAP_CAUGHT).toBeTruthy();
    expect(SHELL_FIELD).toEqual({ dateMs: 24, pingSeq: 32, pingFrameLo: 36, underruns: 40, flags: 60, traps: 82, underrunFrames: 88 });
  });

  it("a trap gives silence, counts, flags and posts a trap event", () => {
    const real = instantiateCore(WASM, PRESET, RATE);
    const exports = {
      ...real.exports,
      myco_audio_process: () => {
        throw new WebAssembly.RuntimeError("unreachable");
      },
    };
    const r = rig({ core: { ...real, exports } });
    const events: string[] = [];
    r.link.onShellEvent((e) => events.push(e.type));
    r.driver.onControl({ type: "debugTone", hz: 440, gain: 0 });
    r.run(6);
    expect(r.driver.output.every((v) => v === 0)).toBe(true);
    expect(events).toEqual(["trap", "trap", "trap", "trap", "trap", "trap"]);
    expect(r.link.lastStatus!.traps).toBe(6);
    expect(r.link.lastStatus!.flags & FLAG_TRAP_CAUGHT).toBeTruthy();
  });

  it("the debug tone is a sine on both channels; off is silence", () => {
    const r = rig();
    r.driver.onControl({ type: "debugTone", hz: 440, gain: 0.5 });
    r.run(1);
    const peak = Math.max(...r.driver.left.map(Math.abs));
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThanOrEqual(0.5);
    expect(Array.from(r.driver.left)).toEqual(Array.from(r.driver.right));
    r.driver.onControl({ type: "debugTone", hz: 0, gain: 0.5 });
    r.run(1);
    expect(r.driver.output.every((v) => v === 0)).toBe(true);
  });
});

describe("UnderrunProbe", () => {
  /** Steps the probe through `quanta` calls at the real rate, with `stallAt` adding a gap of `stallMs`. */
  function drive(probe: UnderrunProbe, quanta: number, stallAt = -1, stallMs = 0, start = { frame: 0, now: 5_000 }) {
    let { frame, now } = start;
    for (let i = 0; i < quanta; i++) {
      if (i === stallAt) now += stallMs;
      probe.step(frame, now);
      frame += 128;
      now += QUANTUM_MS;
    }
    return { frame, now };
  }

  it("steady rendering counts no underrun", () => {
    const probe = new UnderrunProbe(RATE);
    drive(probe, 20_000);
    expect(probe.underruns).toBe(0);
  });

  it("a 50 ms stall after warm-up counts one underrun of about 50 ms", () => {
    const probe = new UnderrunProbe(RATE);
    drive(probe, 2_000, 1_000, 50);
    expect(probe.underruns).toBe(1);
    expect(probe.underrunFrames).toBeGreaterThanOrEqual(2_400 - 2);
    expect(probe.underrunFrames).toBeLessThanOrEqual(2_400 + 2);
  });

  it("a gap over 500 ms or a clock going back re-anchors without counting", () => {
    const probe = new UnderrunProbe(RATE);
    const at = drive(probe, 1_000, 600, 800);
    drive(probe, 1_000, -1, 0, { frame: at.frame, now: at.now - 10_000 });
    expect(probe.underruns).toBe(0);
  });

  it("nothing counts during the 1 s warm-up; a lag still in the window counts once it ends (§4.7)", () => {
    const probe = new UnderrunProbe(RATE);
    const at = drive(probe, 300, 100, 100); // 300 quanta ≈ 0.9 s, inside the warm-up
    expect(probe.underruns).toBe(0);
    drive(probe, 200, -1, 0, at);
    expect(probe.underruns).toBe(1);
  });
});
