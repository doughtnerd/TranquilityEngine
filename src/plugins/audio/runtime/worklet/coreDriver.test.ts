// The shell's logic in Node with the real myco_audio.wasm (ADR 0157; architecture §4.6), wired to the main side's
// CoreLink through a fake port that queues both ways, under a fake clock. No AudioContext, no rAF: "frames
// stopped" is the normal state here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CoreLink, type LinkPort } from "../core/context";
import { BATCH_POOL_BUFFERS } from "../core/bufferPool";
import {
  CLIP_BEGIN_FIXED_END,
  CLIP_CHUNK_FIXED_END,
  CLIP_UNLOAD_FIXED_END,
  ClipEvent,
  ClipFormat,
  Kind,
  readStatus,
  SCHEMA_HASH,
  STATUS_FLAGS_READY,
  writeBatchHeader,
  writeClipBegin,
  writeClipChunk,
  writeClipUnload,
  writeEnvelope,
  type StatusBlock,
} from "../wire.generated";
import {
  CLIP_BYTES_PER_QUANTUM,
  CoreDriver,
  CoreLoadError,
  FLAG_TRAP_CAUGHT,
  instantiateCore,
  MEMORY_INITIAL_PAGES,
  memoryMaximumPages,
  SHELL_FIELD,
  UnderrunProbe,
  type CoreInstance,
  type CorePreset,
} from "./coreDriver";

const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio.wasm", import.meta.url)));
const RATE = 48_000;
const QUANTUM_MS = (128 / RATE) * 1000;
const PRESET: CorePreset = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 1.5 };

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
    expect(first.abiVersion).toBe(0x103);
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

  it("a trap gives silence, counts, posts one trap event, and the driver never calls the core again (A3.4a)", () => {
    const real = instantiateCore(WASM, PRESET, RATE);
    let trap = false;
    const calls = { process: 0, status: 0, submit: 0 };
    const exports = {
      ...real.exports,
      myco_audio_process: (lo: number, hi: number) => {
        calls.process++;
        if (trap) throw new WebAssembly.RuntimeError("unreachable");
        return real.exports.myco_audio_process(lo, hi);
      },
      myco_audio_status_take: () => {
        calls.status++;
        return real.exports.myco_audio_status_take();
      },
      myco_audio_submit: (len: number) => {
        calls.submit++;
        return real.exports.myco_audio_submit(len);
      },
    };
    const r = rig({ core: { ...real, exports } });
    const events: string[] = [];
    r.link.onShellEvent((e) => events.push(e.type));
    r.run(12);
    const posted = r.driver.stats.posted;
    expect(posted).toBe(2);
    trap = true;
    r.driver.onControl({ type: "debugTone", hz: 440, gain: 0.5 });
    r.run(24);
    expect(r.driver.output.every((v) => v === 0)).toBe(true);
    expect(events).toEqual(["trap"]);
    expect(r.driver.traps).toBe(1);
    expect(r.driver.dead).toBe(true);
    // One process call trapped; after it nothing reaches the core: no render, no STATUS, no batch.
    expect(calls.process).toBe(13);
    const statusCalls = calls.status;
    expect(r.driver.stats.posted).toBe(posted);
    const batch = new ArrayBuffer(32);
    const view = new DataView(batch);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: 1, bodyBytes: 16 });
    writeBatchHeader(view, 0, { firstFrame: 0, count: 0, flags: 0 });
    const returned = r.driver.stats.returned;
    r.driver.onMessage(batch, 0, 0);
    expect(calls.submit).toBe(0);
    expect(r.driver.stats.returned).toBe(returned + 1); // the buffer still goes back to the host's pool
    r.run(48);
    expect(calls.status).toBe(statusCalls);
    expect(calls.process).toBe(13);
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

/** A CLIP_BEGIN, as A1.3a's registry writes it. */
function clipBegin(clipId: number, frames: number, channels: number, format: number): ArrayBuffer {
  const buffer = new ArrayBuffer(CLIP_BEGIN_FIXED_END);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.CLIP_BEGIN, seq: 0, bodyBytes: CLIP_BEGIN_FIXED_END - 16 });
  writeClipBegin(view, 0, { clipId, frames, channels, sampleRate: 44_100, format });
  return buffer;
}

/** A CLIP_CHUNK of interleaved `samples`, padded to 4 bytes as A1.3a's registry pads it. */
function clipChunk(clipId: number, frameOffset: number, frames: number, samples: Float32Array | Int16Array): ArrayBuffer {
  const total = CLIP_CHUNK_FIXED_END + ((samples.byteLength + 3) & ~3);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: 0, bodyBytes: total - 16 });
  writeClipChunk(view, 0, { clipId, frameOffset, frames, reserved: 0 });
  new Uint8Array(buffer, CLIP_CHUNK_FIXED_END, samples.byteLength).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return buffer;
}

function clipUnload(clipId: number): ArrayBuffer {
  const buffer = new ArrayBuffer(CLIP_UNLOAD_FIXED_END);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: 0, bodyBytes: CLIP_UNLOAD_FIXED_END - 16 });
  writeClipUnload(view, 0, { clipId });
  return buffer;
}

describe("coreDriver clip routing with the real wasm", () => {
  const clipEvents = (blocks: StatusBlock[]) => blocks.flatMap((b) => b.clipEvents.map((e) => [e.clipId, e.code]));

  it("a clip loads in chunks, the last one makes it resident in STATUS, and its buffers aren't returned", () => {
    const r = rig();
    const send = (m: ArrayBuffer) => r.driver.onMessage(m, r.clock.frame, r.clock.now);
    send(clipBegin(7, 1_000, 2, ClipFormat.F32));
    send(clipChunk(7, 0, 600, new Float32Array(1_200).fill(0.25)));
    r.run(6);
    expect(clipEvents(r.blocks)).toEqual([]);
    send(clipChunk(7, 600, 400, new Float32Array(800).fill(0.5)));
    r.run(6);
    expect(clipEvents(r.blocks)).toEqual([[7, ClipEvent.Resident]]);
    expect(r.driver.stats.clipBytes).toBe(1_000 * 2 * 4);
    expect(r.link.lastStatus!.arenaUsedKB).toBe(8); // 8,000 bytes round up to the 8 KB class
    expect(r.driver.stats.returned).toBe(0);
  });

  it("an odd-sample int16 chunk copies only its samples, not the padding", () => {
    const r = rig();
    const send = (m: ArrayBuffer) => r.driver.onMessage(m, r.clock.frame, r.clock.now);
    send(clipBegin(9, 3, 1, ClipFormat.I16));
    const chunk = clipChunk(9, 0, 3, Int16Array.of(100, -200, 300));
    expect(chunk.byteLength - CLIP_CHUNK_FIXED_END).toBe(8); // 6 bytes of samples, 2 of padding
    new DataView(chunk).setInt16(chunk.byteLength - 2, 0x5555, true); // marked, so a copied pad would show
    send(chunk);
    r.run(6);
    expect(clipEvents(r.blocks)).toEqual([[9, ClipEvent.Resident]]);
    expect(r.driver.stats.clipBytes).toBe(6);
    // The clip's samples sit at its block's start; the bytes after them stay zero (the block is zeroed).
    const at = r.core.exports.myco_audio_clip_chunk_ptr(9, 0, 6);
    const arena = new DataView(r.core.memory.buffer, at, 8);
    expect([arena.getInt16(0, true), arena.getInt16(2, true), arena.getInt16(4, true), arena.getInt16(6, true)]).toEqual([100, -200, 300, 0]);
  });

  it("unload frees the clip: the arena empties and later chunks for it are dropped", () => {
    const r = rig();
    const send = (m: ArrayBuffer) => r.driver.onMessage(m, r.clock.frame, r.clock.now);
    send(clipBegin(3, 4_096, 1, ClipFormat.I16));
    send(clipChunk(3, 0, 4_096, new Int16Array(4_096)));
    r.run(6);
    expect(r.link.lastStatus!.arenaUsedKB).toBe(8);
    send(clipUnload(3));
    send(clipChunk(3, 0, 16, new Int16Array(16)));
    r.run(6);
    expect(r.link.lastStatus!.arenaUsedKB).toBe(0);
    expect(r.driver.stats.clipBytes).toBe(8_192);
    // The id can be loaded again after its unload.
    send(clipBegin(3, 2, 1, ClipFormat.I16));
    send(clipChunk(3, 0, 2, Int16Array.of(1, 2)));
    r.run(6);
    expect(clipEvents(r.blocks)).toEqual([
      [3, ClipEvent.Resident],
      [3, ClipEvent.Resident],
    ]);
  });

  it("copies at most 256 KB per quantum, keeping order, and grows memory past the initial arena", () => {
    const r = rig();
    const send = (m: ArrayBuffer) => r.driver.onMessage(m, r.clock.frame, r.clock.now);
    const before = r.core.memory.buffer.byteLength;
    const frames = CLIP_BYTES_PER_QUANTUM / 2; // one budget of mono int16 per chunk
    const chunks = 6; // 1.5 MB: past the 1 MB initial arena
    send(clipBegin(5, frames * chunks, 1, ClipFormat.I16));
    for (let k = 0; k < chunks; k++) send(clipChunk(5, k * frames, frames, new Int16Array(frames).fill(k)));
    expect(r.core.memory.buffer.byteLength).toBeGreaterThan(before);
    expect(r.driver.stats.clipBytes).toBe(CLIP_BYTES_PER_QUANTUM);
    expect(r.driver.pendingClipMessages).toBe(chunks - 1);
    r.run(chunks - 1);
    expect(r.driver.pendingClipMessages).toBe(0);
    expect(r.driver.stats.clipBytes).toBe(chunks * CLIP_BYTES_PER_QUANTUM);
    r.run(6);
    expect(clipEvents(r.blocks)).toEqual([[5, ClipEvent.Resident]]);
  });

  it("a load past the Memory's maximum is refused with a refusedGrow event", () => {
    const small: CorePreset = { ...PRESET, arenaInitialBytes: 0, clipCeilingBytes: 0 };
    const r = rig({ core: instantiateCore(WASM, small, RATE) });
    const send = (m: ArrayBuffer) => r.driver.onMessage(m, r.clock.frame, r.clock.now);
    send(clipBegin(11, 64 << 20, 1, ClipFormat.I16)); // 128 MB, far past the 16 MB headroom
    send(clipChunk(11, 0, 4, new Int16Array(4)));
    r.run(6);
    expect(clipEvents(r.blocks)).toEqual([[11, ClipEvent.RefusedGrow]]);
    expect(r.driver.stats.clipBytes).toBe(0);
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
