// ADR 0171 amended by 0172 (Ma3; api-and-models §6.2-§6.3, architecture §4.7; R10): deferred live adds on the real wasm
// (the loopback host), timed on the audio clock. A bus added with no free core slot (a removed bus's slot is still a
// tombstone) answers `deferred`, stays queued and is finished at the recycle that frees a slot: the slot's `fresh`
// `BUS_SLOT` is posted, the mixer's model gains the bus, and a constant 0.5 clip played on it is heard at the full
// level. A fifth effect on a bus answers that it applies at the next Play.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { TOMBSTONE_TAIL_FRAMES } from "../../../../engine/audio/slotTable";
import { BUS_ROOT, BUS_SLOT_FLAGS_FRESH, Kind, Op, readBusSlot } from "../wire.generated";
import { type BatchRecord } from "./batchRecords";
import { presetFromSettings } from "./context";
import { type CoreBackend } from "./coreBackend";
import { loopbackAudio, closeLoopbackAudio } from "../testing";

const RATE = 48_000;
const CLIP_FRAMES = 48_000;
const LEVEL = 0.5;

/** Master and `n - 1` buses under it: `n` of the core's 32 slots in use. */
function project(n: number, extra: Record<string, unknown> = {}) {
  const buses: Record<string, unknown>[] = [{ name: "Master" }];
  for (let i = 1; i < n; i++) buses.push({ name: `B${i}`, parent: "Master", ...(i === 1 ? extra : {}) });
  return { buses };
}

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

/** The real host and core backend on the loopback over the page's mixer, a constant 0.5 clip, no limiter look-ahead (output frames are core frames). */
async function rig(settingsJson: unknown) {
  const settings = parseAudioSettings(settingsJson).settings;
  // ADR 0221: the production assembly on the loopback, on the page's mixer, registered; no limiter look-ahead.
  const audio = await loopbackAudio({
    settings,
    preset: { ...presetFromSettings(settings), limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] }),
    recovery: { now: () => 0, warn: () => {} },
    dt: 0.003,
  });
  if (!audio) return null;
  const { host, backend } = audio;
  // Every BATCH the core received, decoded, with the core frame it arrived at.
  const batches: { frame: number; records: BatchRecord[] }[] = [];
  const watch = audio.watch();
  const collect = () => {
    for (const { frame, batch } of watch.takeReceived()) if (batch.kind === Kind.BATCH) batches.push({ frame, records: batch.records });
  };
  const settle = async () => {
    await audio.settle();
    collect();
  };
  /** Frames of 4 quanta: the last rendered left sample. */
  const step = async (n: number) => {
    let last = 0;
    for (let f = 0; f < n; f++) last = (await audio.step()).left.at(-1)!;
    collect();
    return { last };
  };
  return {
    loop: audio,
    host,
    backend,
    step,
    settle,
    get batches() {
      collect();
      return batches;
    },
  };
}

type Rig = NonNullable<Awaited<ReturnType<typeof rig>>>;
const play = (backend: CoreBackend, bus: string) => backend.play({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });
/** The BUS_SLOT records posted for `slot`, with the core frame each batch was posted at. */
const slotRecords = (r: Rig, slot: number) =>
  r.batches
    .flatMap((b) => b.records.map((x) => ({ at: b.frame, frame: x.frame, body: x.opcode === Op.BUS_SLOT ? readBusSlot(x.view, x.off) : null })))
    .filter((e) => e.body !== null && e.body.slot === slot) as { at: number; frame: number; body: ReturnType<typeof readBusSlot> }[];
/** The live-edit counts `Audio.debug().mix` reports: refused, adds deferred so far, adds still waiting. */
const live = (r: Rig) => {
  const m = r.backend.debug().mix!;
  return { refused: m.liveRefused, count: m.liveDeferred, pending: m.liveDeferredPending };
};
const names = () => mixer.audioSettings.buses.map((b) => b.name);

describe("deferred live adds on the loopback host (Ma3)", () => {
  it("a bus removed and two added in one task applies both: the second waits for the recycled slot, then plays at full level", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(31)); // slots 0..30 live, 31 free
    if (!r) return ctx.skip();
    await r.step(4);
    const refused = live(r).refused;
    expect(mixer.apply({ op: "removeBus", bus: "B30" })).toEqual({ ok: true, class: "dip" });
    expect(mixer.apply({ op: "addBus", name: "A", parent: "Master" })).toEqual({ ok: true, class: "direct" });
    const second = mixer.apply({ op: "addBus", name: "B", parent: "Master" });
    expect(second.ok).toBe(true);
    expect(second.class).toBe("direct");
    expect(second).toEqual({ ok: true, class: "direct", reason: "waitsForSlot" });
    // Kept, queued, counted; the mixer's running model does not hold it yet; nothing was refused.
    expect(live(r).pending).toBe(1);
    expect(live(r).count).toBe(1);
    // Debug shows both: `liveDeferred` is the adds deferred so far, `liveDeferredPending` those still waiting.
    expect(r.backend.debug().mix).toMatchObject({ liveDeferred: 1, liveDeferredPending: 1 });
    expect(live(r).refused).toBe(refused);
    expect(r.backend.buses.slots.slotOf("A")).toBe(31);
    expect(r.backend.buses.slots.slotOf("B")).toBe(-1);
    expect(names()).not.toContain("B");
    // Render until it applies: on the audio clock, past the tombstone's tail.
    for (let f = 0; f < 60 && live(r).pending > 0; f++) await r.step(1);
    expect(live(r).pending, "applied within 60 frames").toBe(0);
    expect(r.backend.debug().mix).toMatchObject({ liveDeferred: 1, liveDeferredPending: 0 });
    // The removal's sequence made slot 30 a silent root at B; its dip ends DIP_FRAMES later.
    const tomb = slotRecords(r, 30).filter((e) => e.body.sequenceId > 0);
    expect(tomb.map((e) => e.body.parent)).toEqual([BUS_ROOT]);
    const seq = { end: tomb[0]!.frame + Math.round(0.02 * RATE) };
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
    expect(live(r).count).toBe(1);
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
    expect(a.reason).toBe("waitsForSlot");
    expect(b.reason).toBe("waitsForSlot");
    expect(live(r).pending).toBe(2);
    expect(live(r).count).toBe(2);
    // The first recycle frees one slot: A (the older) takes it, B still waits.
    for (let f = 0; f < 60 && live(r).pending === 2; f++) await r.step(1);
    expect(live(r).pending).toBe(1);
    expect(r.backend.buses.slots.slotOf("A")).toBe(31);
    expect(r.backend.buses.slots.slotOf("B")).toBe(-1);
    expect(names()).toContain("A");
    expect(names()).not.toContain("B");
    // Frames later nothing has changed (no spurious retry applies it); a second removal frees B's slot.
    await r.step(8);
    expect(live(r).pending).toBe(1);
    mixer.apply({ op: "removeBus", bus: "B30" });
    for (let f = 0; f < 60 && live(r).pending > 0; f++) await r.step(1);
    expect(live(r).pending).toBe(0);
    expect(r.backend.buses.slots.slotOf("B")).toBe(30);
    expect(names()).toContain("B");
    expect(live(r).count).toBe(2);
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
    expect(live(r).pending).toBe(2);
    for (let f = 0; f < 80 && live(r).pending > 0; f++) await r.step(1);
    expect(live(r).pending).toBe(0);
    expect(names().slice(-2)).toEqual(["P", "Kid"]);
    expect(r.backend.buses.slots.slotOf("P")).toBeLessThan(r.backend.buses.slots.slotOf("Kid"));
    play(r.backend, "Kid");
    expect((await r.step(12)).last).toBeCloseTo(LEVEL, 6);
    r.backend.dispose();
  });

  it("a child naming a waiting parent queues behind it: both apply in order, the child under the parent's real slot (FU3)", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(32));
    if (!r) return ctx.skip();
    await r.step(4);
    mixer.apply({ op: "removeBus", bus: "B31" });
    mixer.apply({ op: "removeBus", bus: "B30" });
    expect(mixer.apply({ op: "addBus", name: "P", parent: "Master" }).reason).toBe("waitsForSlot");
    // P is not in the mixer's running model yet; the child still names it, not Master.
    const kid = mixer.apply({ op: "addBus", name: "Kid", parent: "P" });
    expect(kid.reason).toBe("waitsForSlot");
    expect(live(r).pending).toBe(2);
    expect(r.backend.buses.slots.deferred.map((q) => [q.name, q.parent])).toEqual([["P", "Master"], ["Kid", "P"]]);
    for (let f = 0; f < 80 && live(r).pending > 0; f++) await r.step(1);
    expect(live(r).pending).toBe(0);
    expect(names().slice(-2)).toEqual(["P", "Kid"]);
    expect(mixer.audioSettings.buses.find((b) => b.name === "Kid")!.parent).toBe("P");
    const table = r.backend.buses.slots;
    expect(table.slots[table.slotOf("Kid")]!.parent).toBe(table.slotOf("P"));
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
    expect(res).toMatchObject({ ok: false, reason: "effectsPerBus" });
    expect(mixer.audioSettings.buses[1]!.effects).toHaveLength(4);
    expect(live(r).pending).toBe(0);
    expect(live(r).count).toBe(0);
    r.backend.dispose();
  });

  it("a configure (Stop) forgets the queue: the freed slot is not given to a forgotten add", { timeout: 60_000 }, async (ctx) => {
    const r = await rig(project(32));
    if (!r) return ctx.skip();
    await r.step(4);
    mixer.apply({ op: "removeBus", bus: "B31" });
    mixer.apply({ op: "addBus", name: "A", parent: "Master" });
    expect(live(r).pending).toBe(1);
    // Stop: the next Play's configure (the host's remap) starts from the settings, where the add never was.
    r.backend.configureBuses(mixer);
    for (let f = 0; f < 60; f++) await r.step(1);
    expect(names()).not.toContain("A");
    expect(slotRecords(r, 31).filter((e) => (e.body.flags & BUS_SLOT_FLAGS_FRESH) !== 0)).toEqual([]);
    expect(live(r).pending).toBe(0);
    expect(live(r).count).toBe(1);
    r.backend.dispose();
  });
});
