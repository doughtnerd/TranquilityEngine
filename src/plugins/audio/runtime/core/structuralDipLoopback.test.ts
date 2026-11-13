// ADR 0171 amended by 0172 (Ma2; api-and-models §6.5, §4.2; architecture §3.3, §3.4, §4.7; R8, R9, R12): the structural
// dip on the real wasm (the loopback host, the test-hooks build so a trap can be simulated), timed on the audio clock. A
// constant 0.5 clip plays, so every step in the output is the mix's own: a move, a remove (its voice going to the root)
// and a mid-list effect insert each arrive as one sequence alone in one batch, change nothing before their stamped F0,
// reach silence before the `BUS_SLOT` applies, land on the end state, and never step more than the dip ramp's own slope
// (`maxStep`); the same change sent abruptly (one asap `BUS_SLOT`, no dip) steps by the full level difference. Two
// structural ops in a row queue; a rebuild mid-dip lands on the end state; a tombstone recycles after its tail.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { TOMBSTONE_TAIL_FRAMES } from "../../../../engine/audio/slotTable";
import { BUS_ROOT, Kind, Op, readBatchHeader, readBusRamp, readBusSlot, readEnvelope, readRecordHead, rampSequenceId } from "../wire.generated";
import { setAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { maxStep } from "../golden/maxStep";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { watchForTraps } from "./recovery";
import { dipFrames } from "./structuralDip";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const CLIP_FRAMES = 48_000;
/**
 * The core's ramp runs in f32 and its last sample absorbs the rounding (measured: the final step 0.43 % over the ideal
 * slope); the bound allows 1 %.
 */
const F32_ROUNDING = 1.01;
/**
 * A rewritten chain restarts its filters at gain 0 (architecture §3.3: "its filter and compressor state may reset"):
 * their step response rides the first samples of the dip-up (measured 2.01 x the slope for a constant input); the
 * bound allows 2.5 x, against more than 20 x for the same rewrite sent abruptly.
 */
const FILTER_RESTART = 2.5;
const LEVEL = 0.5;
const D = dipFrames(RATE); // 960

const PROJECT = {
  buses: [
    { name: "Master" },
    { name: "Music", parent: "Master", volume: 0.5 },
    { name: "SFX", parent: "Master", volume: 0.5, effects: [{ type: "lowpass", frequency: 8000, q: 0.7 }] },
    { name: "Voice", parent: "Master" },
  ],
};
const SLOT = { Master: 0, Music: 1, SFX: 2, Voice: 3 } as const;

const hosts: AudioHost[] = [];
afterEach(async () => {
  events()._reset();
  setAudioBackend(null);
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});

function fakeContext() {
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

interface Rec {
  op: number;
  seq: number;
  frame: number;
  view: DataView;
  off: number;
}

/** The real host and core backend on the loopback over the page's mixer, a constant 0.5 clip, no limiter look-ahead (output frames are core frames). */
async function rig() {
  const testing = await import("../testing");
  const settings = parseAudioSettings(PROJECT).settings;
  const preset = { ...presetFromSettings(settings), limiterLookaheadMs: 0 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ testHooks: true, preset });
  } catch {
    return null;
  }
  const context = fakeContext();
  const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({ context: context as unknown as AudioContext, node, link: loop.link, unlock, preset, respawn: () => loop.respawn() });
  hosts.push(host);
  const link = loop.link;
  // Every BATCH posted, decoded (a copy: the shell recycles the buffer), each record with its absolute frame (-1 asap).
  const batches: { frame: number; records: Rec[] }[] = [];
  const post = link.post.bind(link);
  link.post = ((buffer: ArrayBuffer, ...rest: unknown[]) => {
    const view = new DataView(buffer);
    if (readEnvelope(view, 0).kind === Kind.BATCH) {
      const header = readBatchHeader(view, 0);
      const copy = new DataView(buffer.slice(0));
      const records: Rec[] = [];
      let off = 32;
      for (let i = 0; i < header.count; i++) {
        const head = readRecordHead(view, off);
        const seq = head.opcode === Op.BUS_RAMP ? rampSequenceId(readBusRamp(view, off).shape) : head.opcode === Op.BUS_SLOT ? readBusSlot(view, off).sequenceId : 0;
        records.push({ op: head.opcode, seq, frame: head.frameOffset === 0xffffffff ? -1 : header.firstFrame + head.frameOffset, view: copy, off });
        off += head.words * 4;
      }
      batches.push({ frame: loop.frame, records });
    }
    return (post as (b: ArrayBuffer, ...r: unknown[]) => void)(buffer, ...rest);
  }) as typeof link.post;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder(() => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  mixer.configure(settings);
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  watchForTraps(host, { now: () => 0, warn: () => {} });
  events()._reset();
  setAudioBackend(backend);
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** Frames of 4 quanta: the rendered left samples, the core frame of the first, the batches posted meanwhile. */
  const step = async (n: number) => {
    const from = batches.length;
    const out: number[] = [];
    const start = loop.frame;
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      events().update(0.003);
      const { left } = loop.renderQuanta(4);
      out.push(...left);
      await settle();
    }
    return { start, out, last: out[out.length - 1]!, posted: batches.slice(from) };
  };
  return { loop, host, backend, step, settle, batches };
}

const play = (backend: CoreBackend, bus: string) => backend.play({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });

/**
 * Applies a structural `op` between frames and renders `frames` frames: the samples from the frame before the op, the
 * one batch holding the sequence (checked to hold nothing else), and the sequence's frames.
 */
async function structural(r: NonNullable<Awaited<ReturnType<typeof rig>>>, op: MixOp, frames = 24) {
  const pre = await r.step(1);
  expect(mixer.apply(op), op.op).toEqual({ ok: true, class: "dip" });
  const run = await r.step(frames);
  const seqBatches = run.posted.filter((b) => b.records.some((x) => x.seq !== 0));
  expect(seqBatches, `${op.op}: one batch holds the sequence`).toHaveLength(1);
  const batch = seqBatches[0]!;
  expect(batch.records.every((x) => x.seq !== 0 && (x.op === Op.BUS_RAMP || x.op === Op.BUS_SLOT)), `${op.op}: nothing else in it`).toBe(true);
  expect(new Set(batch.records.map((x) => x.seq)).size, `${op.op}: one sequenceId`).toBe(1);
  const seq = r.backend.dip.last!;
  const out = Float32Array.from([...pre.out, ...run.out]);
  const at = (frame: number) => out[frame - pre.start]!;
  const firstChanged = pre.start + out.findIndex((v) => v !== out[0]);
  return { seq, out, at, firstChanged, arrivedAt: batch.frame, last: run.last };
}

describe("the structural dip on the loopback host (Ma2)", () => {
  it("a move: silent at its BUS_SLOT, on the end state after, never steeper than the dip ramp; abrupt, it steps by the whole change", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    play(r.backend, "SFX");
    await r.step(12);
    const before = (await r.step(1)).last;
    expect(before).toBeCloseTo(LEVEL * 0.5, 6);
    const late = r.backend.mirror.lateCommands;
    const m = await structural(r, { op: "moveBus", bus: "SFX", parent: "Music" });
    // On the audio clock: arrived before F0, the first changed sample at F0, silence from F0 + D through B, the end level.
    expect(m.arrivedAt).toBeLessThan(m.seq.f0);
    expect(m.firstChanged).toBe(m.seq.f0);
    // The ramp reaches 0 on its D-th sample (F0 + D - 1) and holds it until B, where the change applies.
    for (let f = m.seq.f0 + D - 1; f < m.seq.b; f++) expect(m.at(f)).toBe(0);
    expect(m.at(m.seq.end)).toBeCloseTo(LEVEL * 0.25, 6);
    expect(m.last).toBeCloseTo(LEVEL * 0.25, 6);
    expect(r.backend.mirror.lateCommands, "on time: no shift").toBe(late);
    // The click test: the largest neighbour step is the dip-down's slope (0.25 / 960 = 2.6e-4).
    const slope = before / D;
    const worst = maxStep(m.out);
    console.info(`[Ma2] move: maxStep ${worst.toExponential(3)} against the dip slope ${slope.toExponential(3)}`);
    expect(worst).toBeLessThanOrEqual(slope * F32_ROUNDING);
    // The same re-parent sent abruptly (one asap BUS_SLOT back under Master, no dip): a step of the whole change.
    r.backend.writer.busSlot({ slot: SLOT.SFX, parent: SLOT.Master, effects: [{ type: 0, p: [8000, 0.7, 0, 0, 0, 0, 0] }] });
    const abrupt = await r.step(4);
    const jump = maxStep(Float32Array.from(abrupt.out));
    console.info(`[Ma2] move sent abruptly: maxStep ${jump.toExponential(3)}`);
    expect(jump).toBeGreaterThan(LEVEL * 0.2);
    r.backend.dispose();
  });

  it("a remove: the bus dips out, its voice moves to the root at B and fades in there; never steeper than the dip ramp", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const v = play(r.backend, "SFX")!;
    await r.step(12);
    const before = (await r.step(1)).last;
    expect(before).toBeCloseTo(LEVEL * 0.5, 6);
    const recycles = vi.spyOn(r.backend.buses, "recycle");
    const m = await structural(r, { op: "removeBus", bus: "SFX" });
    const i = v.id & 0xffff;
    expect(r.backend.table.bus[i]).toBe(SLOT.Master);
    expect(r.backend.table.busLive[SLOT.SFX]).toBe(0);
    expect(m.seq.tombstones).toEqual([SLOT.SFX]);
    expect(m.seq.voices).toBe(1);
    expect(m.firstChanged).toBe(m.seq.f0);
    for (let f = m.seq.f0 + D - 1; f < m.seq.b; f++) expect(m.at(f)).toBe(0);
    // On Master now (gain 1): the full level once the voice's fade-in ends.
    expect(m.at(m.seq.end)).toBeCloseTo(LEVEL, 6);
    expect(m.last).toBeCloseTo(LEVEL, 6);
    const slope = Math.max(before, LEVEL) / D;
    const worst = maxStep(m.out);
    console.info(`[Ma2] remove: maxStep ${worst.toExponential(3)} against the dip slope ${slope.toExponential(3)}`);
    expect(worst).toBeLessThanOrEqual(slope * F32_ROUNDING);
    // The tombstone recycles once its tail has passed with no voice on it: the backend's per-frame `dip.update` (Ck1)
    // frees it at the first frame whose F_now is at or past end + TOMBSTONE_TAIL_FRAMES, never before.
    const due = m.seq.end + TOMBSTONE_TAIL_FRAMES;
    const calls = recycles.mock.calls.map((c, k) => ({ frame: c[0], freed: recycles.mock.results[k]!.value as number[] }));
    const freedAt = calls.find((c) => c.freed.includes(SLOT.SFX));
    expect(freedAt, "recycled by the per-frame update").toBeDefined();
    expect(freedAt!.frame).toBeGreaterThanOrEqual(due);
    expect(calls.filter((c) => c.frame >= due && c.frame < freedAt!.frame)).toEqual([]);
    expect(r.backend.buses.slots.slots[SLOT.SFX]!.state).toBe("free");
    r.backend.dispose();
  });

  it("a mid-list effect insert: the bus's chain is rewritten at 0 and the dip brings it back; never steeper than the dip ramp", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    play(r.backend, "SFX");
    await r.step(12);
    const before = (await r.step(1)).last;
    const m = await structural(r, { op: "addEffect", bus: "SFX", index: 0, effect: { type: "lowpass", frequency: 12000, q: 0.7 } });
    const wire = r.backend.busConfigWire()[SLOT.SFX]!;
    expect(wire.effects.map((e) => [e.type, e.p[0]])).toEqual([[0, 12000], [0, 8000]]);
    expect(m.firstChanged).toBe(m.seq.f0);
    for (let f = m.seq.f0 + D - 1; f < m.seq.b; f++) expect(m.at(f)).toBe(0);
    expect(m.last).toBeCloseTo(before, 4);
    const slope = before / D;
    const worst = maxStep(m.out);
    console.info(`[Ma2] mid-list insert: maxStep ${worst.toExponential(3)} against the dip slope ${slope.toExponential(3)}`);
    expect(worst).toBeLessThanOrEqual(slope * FILTER_RESTART);
    // Abruptly (one asap BUS_SLOT with a high-pass first, no dip), the rewrite of a playing chain steps.
    r.backend.writer.busSlot({ slot: SLOT.SFX, parent: SLOT.Master, effects: [{ type: 1, p: [2000, 0.7, 0, 0, 0, 0, 0] }, { type: 0, p: [8000, 0.7, 0, 0, 0, 0, 0] }] });
    const abrupt = await r.step(2);
    const jump = maxStep(Float32Array.from([before, ...abrupt.out]));
    console.info(`[Ma2] insert sent abruptly: maxStep ${jump.toExponential(3)}`);
    expect(jump).toBeGreaterThan(slope * 20);
    r.backend.dispose();
  });

  it("two structural ops in a row queue: the second dips only after the first has come all the way back up", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    play(r.backend, "SFX");
    await r.step(12);
    const pre = await r.step(1);
    mixer.apply({ op: "moveBus", bus: "SFX", parent: "Music" });
    const one = await r.step(1);
    const first = r.backend.dip.last!;
    expect(r.backend.dip.inFlight).toBe(true);
    mixer.apply({ op: "moveBus", bus: "SFX", parent: "Voice" });
    const rest = await r.step(24);
    const second = r.backend.dip.last!;
    expect(second.id).not.toBe(first.id);
    expect(second.f0).toBeGreaterThanOrEqual(first.end);
    const out = Float32Array.from([...pre.out, ...one.out, ...rest.out]);
    const at = (frame: number) => out[frame - pre.start]!;
    // Up on the first end state (under Music, 0.25 x 0.5 ... = 0.125) from the first's end to the second's F0.
    for (let f = first.end; f < second.f0; f++) expect(at(f)).toBeCloseTo(LEVEL * 0.25, 6);
    expect(at(second.f0 + D - 1)).toBe(0);
    expect(rest.last).toBeCloseTo(LEVEL * 0.5, 6); // under Voice (1)
    const worst = maxStep(out);
    console.info(`[Ma2] two queued moves: maxStep ${worst.toExponential(3)} against the dip slope ${(LEVEL * 0.5 / D).toExponential(3)}`);
    expect(worst).toBeLessThanOrEqual(((LEVEL * 0.5) / D) * F32_ROUNDING);
    r.backend.dispose();
  });

  for (const [when, into, replayCall] of [
    ["before F0", -1, true],
    ["in the dip-down", D / 2, true],
    ["in the dip-down, without replayEndState", D / 2, false],
  ] as const) {
    it(`a rebuild mid-dip (${when}) lands on the end state: the replay carries the new tree and the dip lane at its end`, { timeout: 60_000 }, async (ctx) => {
      const r = await rig();
      if (!r) return ctx.skip();
      play(r.backend, "SFX");
      play(r.backend, "Voice");
      await r.step(12);
      expect((await r.step(1)).last).toBeCloseTo(LEVEL * 0.5 + LEVEL, 6);
      // A move and a remove in one task: one sequence, posted.
      mixer.apply({ op: "moveBus", bus: "Voice", parent: "Music" });
      mixer.apply({ op: "removeBus", bus: "SFX" });
      await r.settle();
      const seq = r.backend.dip.last!;
      expect(seq.roots).toEqual([SLOT.Voice]);
      expect(seq.tombstones).toEqual([SLOT.SFX]);
      // Render up to the trap point, then the core traps.
      if (into >= 0) while (r.loop.frame < seq.f0 + into) await r.step(1);
      const trappedAt = r.loop.frame;
      r.loop.trapNext();
      let resumed = -1;
      for (let f = 0; f < 80 && resumed < 0; f++) {
        const s = await r.step(1);
        if (s.last !== 0) resumed = s.last;
      }
      expect(r.host.health.recoveries).toBe(1);
      expect(resumed).toBeGreaterThan(0);
      expect(trappedAt).toBeLessThan(seq.b);
      if (replayCall) r.backend.dip.replayEndState();
      // No sequence after the rebuild: the replay already holds the end state.
      const slots = vi.spyOn(r.backend.writer, "busSlot");
      const settled = await r.step(16);
      expect(slots).not.toHaveBeenCalled();
      // Both voices on their end-state buses: SFX's voice on Master (1), Voice's under Music (0.5).
      expect(settled.last).toBeCloseTo(LEVEL + LEVEL * 0.5, 6);
      expect(Math.min(...settled.out)).toBeCloseTo(LEVEL + LEVEL * 0.5, 6);
      expect(r.backend.busConfigWire().slice(0, 4).map((b) => b.parent)).toEqual([BUS_ROOT, SLOT.Master, BUS_ROOT, SLOT.Music]);
      expect(r.backend.table.bus.slice(0, 2).includes(SLOT.SFX)).toBe(false);
      r.backend.dispose();
    });
  }
});


