// ADR 0171 amended by 0172 (Ma3; api-and-models §6.2-§6.3, architecture §4.7; R10): deferred live adds on the real wasm
// (the loopback host), timed on the audio clock. A bus added with no free core slot (a removed bus's slot is still a
// tombstone) answers `deferred`, stays queued and is finished at the recycle that frees a slot: the slot's `fresh`
// `BUS_SLOT` is posted, the mixer's model gains the bus, and a constant 0.5 clip played on it is heard at the full
// level. A fifth effect on a bus answers that it applies at the next Play.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { TOMBSTONE_TAIL_FRAMES } from "../../../../engine/audio/slotTable";
import { BUS_SLOT_FLAGS_FRESH, Kind, Op, readBatchHeader, readBusSlot, readEnvelope, readRecordHead } from "../wire.generated";
import { setAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { watchForTraps } from "./recovery";
import { FIFTH_EFFECT } from "./liveMix";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const CLIP_FRAMES = 48_000;
const LEVEL = 0.5;

/** Master and `n - 1` buses under it: `n` of the core's 32 slots in use. */
function project(n: number, extra: Record<string, unknown> = {}) {
  const buses: Record<string, unknown>[] = [{ name: "Master" }];
  for (let i = 1; i < n; i++) buses.push({ name: `B${i}`, parent: "Master", ...(i === 1 ? extra : {}) });
  return { buses };
}

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
  view: DataView;
  off: number;
}

/** The real host and core backend on the loopback over the page's mixer, a constant 0.5 clip, no limiter look-ahead (output frames are core frames). */
async function rig(settingsJson: unknown) {
  const testing = await import("../testing");
  const settings = parseAudioSettings(settingsJson).settings;
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
  // Every BATCH posted, decoded (a copy: the shell recycles the buffer), with the core frame it was posted at.
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
        records.push({ op: head.opcode, view: copy, off });
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
  /** Frames of 4 quanta: the last rendered left sample. */
  const step = async (n: number) => {
    let last = 0;
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      events().update(0.003);
      const { left } = loop.renderQuanta(4);
      last = left[left.length - 1]!;
      await settle();
    }
    return { last };
  };
  return { loop, host, backend, step, settle, batches };
}

type Rig = NonNullable<Awaited<ReturnType<typeof rig>>>;
const play = (backend: CoreBackend, bus: string) => backend.play({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });
/** The BUS_SLOT records posted for `slot`, with the core frame each batch was posted at. */
const slotRecords = (r: Rig, slot: number) =>
  r.batches
    .flatMap((b) => b.records.map((x) => ({ at: b.frame, body: x.op === Op.BUS_SLOT ? readBusSlot(x.view, x.off) : null })))
    .filter((e) => e.body !== null && e.body.slot === slot) as { at: number; body: ReturnType<typeof readBusSlot> }[];
const names = () => mixer.audioSettings.buses.map((b) => b.name);

describe("deferred live adds on the loopback host (Ma3)", () => {
  it("a bus removed and two added in one task applies both: the second waits for the recycled slot, then plays at full level", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(31)); // slots 0..30 live, 31 free
    if (!r) return ctx.skip();
    await r.step(4);
    const refused = r.backend.liveMix.refused;
    expect(mixer.apply({ op: "removeBus", bus: "B30" })).toEqual({ ok: true, class: "dip" });
    expect(mixer.apply({ op: "addBus", name: "A", parent: "Master" })).toEqual({ ok: true, class: "direct" });
    const second = mixer.apply({ op: "addBus", name: "B", parent: "Master" });
    expect(second.ok).toBe(true);
    expect(second.class).toBe("direct");
    expect(second.deferred).toMatch(/waits for a free bus slot/);
    expect(second.restartRequired).toBeUndefined();
    // Kept, queued, counted; the mixer's running model does not hold it yet; nothing was refused.
    expect(r.backend.deferredAdds.pending).toBe(1);
    expect(r.backend.deferredAdds.count).toBe(1);
    expect(r.backend.liveMix.refused).toBe(refused);
    expect(r.backend.buses.slots.slotOf("A")).toBe(31);
    expect(r.backend.buses.slots.slotOf("B")).toBe(-1);
    expect(names()).not.toContain("B");
    // Render until it applies: on the audio clock, past the tombstone's tail.
    for (let f = 0; f < 60 && r.backend.deferredAdds.pending > 0; f++) await r.step(1);
    expect(r.backend.deferredAdds.pending, "applied within 60 frames").toBe(0);
    const seq = r.backend.dip.last!;
    expect(seq.tombstones).toEqual([30]);
    expect(r.backend.buses.slots.slotOf("B")).toBe(30); // the recycled slot
    expect(r.backend.buses.slots.slots[30]!.gen).toBe(1);
    expect(names()).toContain("B");
    expect(r.backend.buses.names[30]).toBe("B");
    // Its fresh BUS_SLOT went out only after the tombstone's end + tail (a batch posted before would have raced the dip).
    const fresh = slotRecords(r, 30).filter((e) => (e.body.flags & BUS_SLOT_FLAGS_FRESH) !== 0);
    expect(fresh).toHaveLength(1);
    const clock = r.loop.frame;
    expect(clock).toBeGreaterThanOrEqual(seq.end + TOMBSTONE_TAIL_FRAMES);
    console.info(`[Ma3] second add applied at core frame <= ${clock} (dip end ${seq.end} + tail ${TOMBSTONE_TAIL_FRAMES}); fresh BUS_SLOT posted at ${fresh[0]!.at}`);
    // Heard: a clip on B reaches the output at the full level through the recycled slot.
    play(r.backend, "B");
    expect((await r.step(12)).last).toBeCloseTo(LEVEL, 6);
    expect(r.backend.deferredAdds.count).toBe(1);
    r.backend.dispose();
  });

  it("with no free slot at all: retried at each recycle, one add per freed slot, in the order asked", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(32)); // every slot live
    if (!r) return ctx.skip();
    await r.step(4);
    mixer.apply({ op: "removeBus", bus: "B31" });
    const a = mixer.apply({ op: "addBus", name: "A", parent: "Master" });
    const b = mixer.apply({ op: "addBus", name: "B", parent: "Master" });
    expect(a).toMatchObject({ ok: true, class: "direct" });
    expect(a.deferred).toBeTruthy();
    expect(b.deferred).toBeTruthy();
    expect(r.backend.deferredAdds.pending).toBe(2);
    expect(r.backend.deferredAdds.count).toBe(2);
    // The first recycle frees one slot: A (the older) takes it, B still waits.
    for (let f = 0; f < 60 && r.backend.deferredAdds.pending === 2; f++) await r.step(1);
    expect(r.backend.deferredAdds.pending).toBe(1);
    expect(r.backend.buses.slots.slotOf("A")).toBe(31);
    expect(r.backend.buses.slots.slotOf("B")).toBe(-1);
    expect(names()).toContain("A");
    expect(names()).not.toContain("B");
    // Frames later nothing has changed (no spurious retry applies it); a second removal frees B's slot.
    await r.step(8);
    expect(r.backend.deferredAdds.pending).toBe(1);
    mixer.apply({ op: "removeBus", bus: "B30" });
    for (let f = 0; f < 60 && r.backend.deferredAdds.pending > 0; f++) await r.step(1);
    expect(r.backend.deferredAdds.pending).toBe(0);
    expect(r.backend.buses.slots.slotOf("B")).toBe(30);
    expect(names()).toContain("B");
    expect(r.backend.deferredAdds.count).toBe(2);
    play(r.backend, "B");
    expect((await r.step(12)).last).toBeCloseTo(LEVEL, 6);
    r.backend.dispose();
  });

  it("two waiting adds into two slots freed by one removal of a parent and its child: both apply, in the order asked", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(32));
    if (!r) return ctx.skip();
    await r.step(4);
    mixer.apply({ op: "removeBus", bus: "B31" });
    mixer.apply({ op: "removeBus", bus: "B30" });
    mixer.apply({ op: "addBus", name: "P", parent: "Master" }); // deferred
    mixer.apply({ op: "addBus", name: "Kid", parent: "Master" }); // deferred
    expect(r.backend.deferredAdds.pending).toBe(2);
    for (let f = 0; f < 80 && r.backend.deferredAdds.pending > 0; f++) await r.step(1);
    expect(r.backend.deferredAdds.pending).toBe(0);
    expect(names().slice(-2)).toEqual(["P", "Kid"]);
    expect(r.backend.buses.slots.slotOf("P")).toBeLessThan(r.backend.buses.slots.slotOf("Kid"));
    play(r.backend, "Kid");
    expect((await r.step(12)).last).toBeCloseTo(LEVEL, 6);
    r.backend.dispose();
  });

  it("the fifth effect on a bus answers that it applies at the next Play, and is not queued", { timeout: 60_000 }, async (ctx) => {
    const fx = (i: number) => ({ type: "lowpass", frequency: 4000 + i * 100, q: 0.7 });
    const r = await rig(project(4, { effects: [fx(0), fx(1), fx(2), fx(3)] }));
    if (!r) return ctx.skip();
    await r.step(4);
    expect(mixer.audioSettings.buses[1]!.effects).toHaveLength(4);
    const res = mixer.apply({ op: "addEffect", bus: "B1", index: 4, effect: { type: "lowpass", frequency: 9000, q: 0.7 } });
    expect(res.ok).toBe(false);
    expect(res.deferred).toBeUndefined();
    expect(res.restartRequired).toBe(FIFTH_EFFECT);
    expect(res.restartRequired).toMatch(/next Play/);
    expect(mixer.audioSettings.buses[1]!.effects).toHaveLength(4);
    expect(r.backend.deferredAdds.pending).toBe(0);
    expect(r.backend.deferredAdds.count).toBe(0);
    r.backend.dispose();
  });

  it("clear() (Stop) forgets the queue: the freed slot is not given to a forgotten add", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(32));
    if (!r) return ctx.skip();
    await r.step(4);
    mixer.apply({ op: "removeBus", bus: "B31" });
    mixer.apply({ op: "addBus", name: "A", parent: "Master" });
    expect(r.backend.deferredAdds.pending).toBe(1);
    r.backend.deferredAdds.clear();
    const posted = r.backend.liveMix.posts;
    for (let f = 0; f < 60; f++) await r.step(1);
    expect(names()).not.toContain("A");
    expect(slotRecords(r, 31).filter((e) => (e.body.flags & BUS_SLOT_FLAGS_FRESH) !== 0)).toEqual([]);
    expect(r.backend.deferredAdds.pending).toBe(0);
    expect(r.backend.deferredAdds.count).toBe(1);
    expect(r.backend.liveMix.posts).toBe(posted);
    r.backend.dispose();
  });
});
