// ADR 0171 amended by 0172 (Ma1; api-and-models §6.1–§6.2, §6.6; architecture §3.2, §4.7): the live-edit path on the
// real wasm (the loopback host), timed on the audio clock. Every op class `opClass` names reaches the core in the BATCH of
// the frame it was applied in; a fader edit ramps over `DRAG_RAMP_MS` from the first quantum after that batch, with no
// step (`maxStep`); a script's runtime `volume` survives an authored-volume edit; an added bus plays at once on its new slot.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixer, DRAG_RAMP_MS } from "../../../../engine/audio/mixer";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import {
  BUS_SLOT_FLAGS_FRESH,
  BUS_SLOT_FLAGS_STRUCTURAL,
  Kind,
  LANE_AUTHORED,
  LANE_RUNTIME,
  LANE_SNAPSHOT,
  Op,
  readBatchHeader,
  readBusAutomate,
  readBusDuck,
  readBusRamp,
  readBusSlot,
  readEnvelope,
  readLoudConfig,
  readRecordHead,
} from "../wire.generated";
import { setAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { maxStep } from "../golden/maxStep";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const QUANTUM = 128;
const CLIP_FRAMES = 48_000;
const LEVEL = 0.5;
const DRAG_FRAMES = (DRAG_RAMP_MS * RATE) / 1000; // 480

const PROJECT = {
  buses: [
    { name: "Master" },
    { name: "Music", parent: "Master" },
    { name: "SFX", parent: "Master", effects: [{ type: "lowpass", frequency: 8000, q: 0.7 }, { type: "compressor", threshold: -12, knee: 6, ratio: 4, attack: 0.01, release: 0.2 }] },
    { name: "Voice", parent: "Master" },
  ],
  snapshots: [{ name: "Quiet", volumes: { Music: 0.5 } }],
  parameters: [{ name: "Level", min: 0, max: 1, default: 1, seekSpeed: 5 }],
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
  voiceId: number;
  view: DataView;
  off: number;
}

/** The real host and core backend on the loopback, over the page's mixer (the event runtime reads it), a constant 0.5 clip, no limiter look-ahead. */
async function rig() {
  const testing = await import("../testing");
  const settings = parseAudioSettings(PROJECT).settings;
  const preset = { ...presetFromSettings(settings), limiterLookaheadMs: 0 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset });
  } catch {
    return null;
  }
  const context = fakeContext();
  const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({ context: context as unknown as AudioContext, node, link: loop.link, unlock, preset, respawn: () => loop.respawn() });
  hosts.push(host);
  const link = loop.link;
  // Every BATCH posted, decoded before it is handed to the shell, with the core frame it arrived at.
  const batches: { frame: number; records: Rec[] }[] = [];
  const post = link.post.bind(link);
  link.post = ((buffer: ArrayBuffer, ...rest: unknown[]) => {
    const view = new DataView(buffer);
    if (readEnvelope(view, 0).kind === Kind.BATCH) {
      const header = readBatchHeader(view, 0);
      const records: Rec[] = [];
      const copy = new DataView(buffer.slice(0)); // the shell may recycle the buffer
      let off = 32;
      for (let i = 0; i < header.count; i++) {
        const head = readRecordHead(view, off);
        records.push({ op: head.opcode, voiceId: head.voiceId, view: copy, off });
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
  events()._reset();
  setAudioBackend(backend);
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** One frame of 4 quanta: the batches it posted, its rendered left samples and the core frame of the first. */
  const frame = async () => {
    const from = batches.length;
    mixer.update(0.003);
    backend.update(0.003);
    events().update(0.003);
    const start = loop.frame;
    const { left } = loop.renderQuanta(4);
    await settle();
    return { start, out: Array.from(left), records: batches.slice(from).flatMap((b) => b.records), posted: batches.slice(from) };
  };
  const step = async (n: number) => {
    const out: number[] = [];
    let start = -1;
    for (let f = 0; f < n; f++) {
      const r = await frame();
      if (start < 0) start = r.start;
      out.push(...r.out);
    }
    return { start, out, last: out[out.length - 1]! };
  };
  return { loop, backend, frame, step, batches };
}

const play = (backend: CoreBackend, bus: string) => backend.play({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });
const of = (records: Rec[], op: number) => records.filter((r) => r.op === op);

describe("the live-edit path on the loopback host (Ma1)", () => {
  it("each direct, smoothed and config op reaches the core in the batch of the frame it was applied in", { timeout: 60_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, frame } = r;
    play(backend, "SFX");
    play(backend, "Voice");
    await r.step(10);
    /** Applies `op` between frames and returns the records of the next frame's batch. */
    const applied = async (op: MixOp, cls: string) => {
      await frame(); // nothing pending before the edit
      const result = mixer.apply(op);
      expect(result, op.op).toEqual({ ok: true, class: cls });
      const f = await frame();
      expect(f.posted.length, `${op.op}: one frame's batch`).toBeGreaterThan(0);
      return f.records;
    };

    // direct: authored volume, BUS_RAMP on the authored lane of SFX's slot, asap over DRAG_RAMP_MS.
    let recs = await applied({ op: "setBus", bus: "SFX", key: "volume", value: 0.25 }, "direct");
    let ramps = of(recs, Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off));
    expect(ramps).toEqual([expect.objectContaining({ voiceId: SLOT.SFX, lane: LANE_AUTHORED, gain: 0.25, frames: DRAG_FRAMES })]);
    // direct: authored mute (a toggle, at least BUS_MIN_RAMP_MS).
    recs = await applied({ op: "setBus", bus: "SFX", key: "mute", value: true }, "direct");
    ramps = of(recs, Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off));
    expect(ramps).toEqual([expect.objectContaining({ voiceId: SLOT.SFX, lane: LANE_AUTHORED, gain: 0 })]);
    expect(ramps[0]!.frames).toBeGreaterThanOrEqual(240);
    await applied({ op: "setBus", bus: "SFX", key: "mute", value: false }, "direct");
    // direct: maxVoices is main's steal limit (the voice table), nothing on the wire.
    mixer.apply({ op: "setBus", bus: "Music", key: "maxVoices", value: 2 });
    expect(backend.table.busMax[SLOT.Music]).toBe(2);
    // direct: a meter on (LOUD_CONFIG, replace-all, with its slot).
    recs = await applied({ op: "setBus", bus: "Voice", key: "meter", value: "loudness" }, "direct");
    let loud = of(recs, Op.LOUD_CONFIG).map((x) => readLoudConfig(x.view, x.off));
    expect(loud).toHaveLength(1);
    expect(loud[0]!.meters.map((m) => m.slot)).toEqual([SLOT.Voice]);
    expect(loud[0]!.tpGateDbfs).toBe(-7); // console's -1 dBTP ceiling minus 6
    // direct: a filter parameter (BUS_SLOT of SFX's slot, both effects, the new frequency).
    recs = await applied({ op: "setEffect", bus: "SFX", index: 0, key: "frequency", value: 1200 }, "direct");
    let slots = of(recs, Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ slot: SLOT.SFX, parent: SLOT.Master, flags: 0 });
    expect(slots[0]!.effects.map((e) => [e.type, e.p[0]])).toEqual([[0, 1200], [2, -12]]);
    // smoothed: a compressor parameter, the same record (the core blends it).
    recs = await applied({ op: "setEffect", bus: "SFX", index: 1, key: "threshold", value: -18 }, "smoothed");
    slots = of(recs, Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
    expect(slots.map((s) => [s.slot, s.effects[1]!.p[0]])).toEqual([[SLOT.SFX, -18]]);
    // direct: an effect appended (a send on Music).
    recs = await applied({ op: "addEffect", bus: "Music", index: 0, effect: { type: "reverb", send: 0.3 } }, "direct");
    slots = of(recs, Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
    expect(slots.map((s) => [s.slot, s.effects.map((e) => e.type)])).toEqual([[SLOT.Music, [3]]]);
    // direct: a bus added mid-list takes the next slot (4), appended with BUS_SLOT (fresh, under Music), then its lanes.
    recs = await applied({ op: "addBus", name: "Amb", parent: "Music", index: 1 }, "direct");
    slots = of(recs, Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
    expect(slots).toEqual([expect.objectContaining({ slot: 4, parent: SLOT.Music, flags: BUS_SLOT_FLAGS_FRESH })]);
    const slotAt = recs.findIndex((x) => x.op === Op.BUS_SLOT);
    expect(recs.findIndex((x) => x.op === Op.BUS_RAMP && x.voiceId === 4), "its lanes after its BUS_SLOT").toBeGreaterThan(slotAt);
    expect(backend.buses.busIndexByName.get("Amb")).toBe(4);
    expect(mixer.busNames).toEqual(["Master", "Music", "SFX", "Voice", "Amb"]);
    // direct: snapshots. The active one's edit retargets its lane; renaming it keeps it active; removing it heads back to 1.
    mixer.snapshot("Quiet", 0);
    await r.step(2);
    expect(mixer.apply({ op: "addSnapshot", index: 1, name: "Loud" })).toEqual({ ok: true, class: "direct" });
    recs = await applied({ op: "setSnapshot", index: 0, bus: "Music", key: "volume", value: 0.25 }, "direct");
    ramps = of(recs, Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off));
    expect(ramps).toEqual([expect.objectContaining({ voiceId: SLOT.Music, lane: LANE_SNAPSHOT, gain: 0.25, frames: 960 })]);
    expect(mixer.apply({ op: "renameSnapshot", index: 0, name: "Hush" })).toEqual({ ok: true, class: "direct" });
    expect(mixer.currentSnapshot).toBe("Hush");
    recs = await applied({ op: "removeSnapshot", index: 0 }, "direct");
    ramps = of(recs, Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off));
    expect(ramps).toEqual([expect.objectContaining({ voiceId: SLOT.Music, lane: LANE_SNAPSHOT, gain: 1 })]);
    expect(mixer.currentSnapshot).toBeNull();
    // direct: a ducking rule (BUS_DUCK with the rule's slots, then the presence mask).
    recs = await applied({ op: "setDucking", index: 0, insert: true, rule: { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 } }, "direct");
    const ducks = of(recs, Op.BUS_DUCK).map((x) => readBusDuck(x.view, x.off));
    expect(ducks.map((d) => d.rules.map((x) => [x.target, x.trigger]))).toEqual([[[SLOT.Music, SLOT.Voice]]]);
    expect(of(recs, Op.BUS_PRESENCE)).toHaveLength(1);
    // direct: bus automation (the event runtime binds again: BUS_AUTOMATE on SFX's slot).
    recs = await applied({ op: "setAutomation", index: 0, insert: true, rule: { bus: "SFX", parameter: "Level", target: "volume", curve: [[0, 0], [1, 1]] } }, "direct");
    const autos = of(recs, Op.BUS_AUTOMATE).map((x) => readBusAutomate(x.view, x.off));
    expect(autos.map((a) => [a.voiceId, a.bindings.length])).toEqual([[SLOT.SFX, 1]]);
    // direct: a loudness target (LOUD_CONFIG with the new gate).
    recs = await applied({ op: "setTarget", index: 0, target: { name: "console", integrated: -23, tolerance: 1, truePeak: -2 } }, "direct");
    loud = of(recs, Op.LOUD_CONFIG).map((x) => readLoudConfig(x.view, x.off));
    expect(loud.map((l) => [l.tpGateDbfs, l.meters.map((m) => m.slot)])).toEqual([[-8, [SLOT.Voice]]]);

    // config: a rename keeps the slot and sends nothing: no configuration record and (Ma2: the lane writer keys what it
    // sent by slot) no lane record; the old name still reaches the bus.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await frame();
    expect(mixer.apply({ op: "renameBus", from: "SFX", to: "Effects" })).toEqual({ ok: true, class: "config" });
    let f = await frame();
    expect(f.records.filter((x) => x.op === Op.BUS_SLOT || x.op === Op.BUS_CONFIG || x.op === Op.BUS_RAMP)).toEqual([]);
    expect(backend.buses.busIndexByName.get("Effects")).toBe(SLOT.SFX);
    expect(backend.buses.busIndexByName.get("SFX")).toBe(SLOT.SFX);
    expect(mixer.bus("SFX").authoredVolume).toBe(0.25);
    // config: a bed setting and the reset option send no bus record either.
    expect(mixer.apply({ op: "setBus", bus: "Voice", key: "bed", value: "own" })).toEqual({ ok: true, class: "config" });
    expect(mixer.apply({ op: "setOption", key: "loudnessResetOnPlay", value: false })).toEqual({ ok: true, class: "config" });
    f = await frame();
    expect(f.records.filter((x) => x.op === Op.BUS_SLOT || x.op === Op.BUS_CONFIG || x.op === Op.BUS_RAMP)).toEqual([]);

    // dip: Ma2's stamped sequence (its records and sound: `structuralDipLoopback.test.ts`): one structural BUS_SLOT under a sequence id.
    expect(mixer.apply({ op: "moveBus", bus: "Voice", parent: "Music" })).toEqual({ ok: true, class: "dip" });
    f = await frame();
    slots = of(f.records, Op.BUS_SLOT).map((x) => readBusSlot(x.view, x.off));
    expect(slots).toEqual([expect.objectContaining({ slot: SLOT.Voice, parent: SLOT.Music, flags: BUS_SLOT_FLAGS_STRUCTURAL })]);
    expect(slots[0]!.sequenceId).toBeGreaterThan(0);
    backend.dispose();
  });

  it("a fader edit lands in the first quantum after its batch and ramps over DRAG_RAMP_MS with no step; a script's volume survives", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, frame } = r;
    play(backend, "Voice");
    await r.step(10);
    mixer.bus("Voice").volume = 0.5; // the script's multiplier
    await r.step(4);
    expect((await r.step(1)).last).toBeCloseTo(LEVEL * 0.5, 6);
    const pre = await frame();
    mixer.apply({ op: "setBus", bus: "Voice", key: "volume", value: 0.25 });
    backend.flushNow(); // the preview path: posted at once, before the frame
    const arrived = r.batches[r.batches.length - 1]!;
    expect(of(arrived.records, Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off).lane)).toEqual([LANE_AUTHORED]);
    const run = await r.step(8);
    const all = [...pre.out, ...run.out];
    const base = pre.start;
    const firstChanged = base + all.findIndex((v, i) => i >= pre.out.length && v !== LEVEL * 0.5);
    // On the audio clock: the first changed sample is at most two quanta after the core frame the batch was posted at
    // (measured: 128 frames, 2.7 ms; asap, no lookahead wait, against the fader gate's 50 ms).
    expect(firstChanged - arrived.frame).toBeGreaterThanOrEqual(0);
    expect(firstChanged - arrived.frame).toBeLessThanOrEqual(2 * QUANTUM);
    // The target (0.5 x script 0.5 x authored 0.25) is reached DRAG_FRAMES after the ramp starts, linearly.
    const at = (frame: number) => all[frame - base]!;
    expect(at(firstChanged + DRAG_FRAMES - 1)).toBeCloseTo(LEVEL * 0.5 * 0.25, 6);
    expect(at(firstChanged + DRAG_FRAMES / 2)).toBeGreaterThan(LEVEL * 0.5 * 0.25);
    expect(at(firstChanged + DRAG_FRAMES / 2)).toBeLessThan(LEVEL * 0.5);
    // No step: the largest neighbour difference is the ramp's own slope (0.1875 / 480 ≈ 3.9e-4), far below the 0.1875 jump.
    const slope = (LEVEL * 0.5 * (1 - 0.25)) / DRAG_FRAMES;
    const worst = maxStep(Float32Array.from(all));
    expect(worst).toBeLessThan(slope * 1.5);
    // The script's multiplier is untouched; the runtime lane sent nothing.
    expect(mixer.bus("Voice").volume).toBe(0.5);
    expect(mixer.bus("Voice").authoredVolume).toBe(0.25);
    expect(of(arrived.records, Op.BUS_RAMP).some((x) => readBusRamp(x.view, x.off).lane === LANE_RUNTIME)).toBe(false);
    expect(run.last).toBeCloseTo(LEVEL * 0.5 * 0.25, 6);
    backend.dispose();
  });

  it("a bus added while playing plays at once on its new slot, under its parent's gain", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend } = r;
    await r.step(4);
    mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    expect(mixer.apply({ op: "addBus", name: "Amb", parent: "Music", index: 1 })).toEqual({ ok: true, class: "direct" });
    const voice = play(backend, "Amb")!;
    expect(backend.table.bus[voice.id & 0xffff]).toBe(4);
    await r.step(12);
    expect((await r.step(1)).last).toBeCloseTo(LEVEL * 0.5, 6);
    mixer.apply({ op: "setBus", bus: "Amb", key: "volume", value: 0.5 });
    await r.step(4);
    expect((await r.step(1)).last).toBeCloseTo(LEVEL * 0.25, 6);
    backend.dispose();
  });
});
