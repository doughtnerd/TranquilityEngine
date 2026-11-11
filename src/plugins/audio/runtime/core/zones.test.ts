// ADR 0162 C5: the zone manager against a fake core (ZONE_CONFIG applied as `zones.rs` does, STATUS slot states fed
// back) and the fake IR service: registry, weights and sends, ranking and hysteresis, both slot paths (OD2: standby
// on high and default, eviction on low), kernel LRU and proximity preload, the 5 s timeout, the shared return, replay,
// `debug()` and the fade warning. The real-wasm walk is `zonesWalk.test.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { AudioReverbZone } from "../AudioReverbZone";
import { makeFakeZoneIrService, type FakeZoneIrService } from "../testing";
import { readZoneConfig, ZoneSlotState, ZoneState, ZoneEvent, type ZoneConfigSlots } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { StatusMirror } from "./mirror";
import { ReplayBuilder } from "./replay";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "./spatial";
import type { VoiceFx } from "./voiceFx";
import { ZONE_IR_TIMEOUT_MS, ZoneManager } from "./zones";

beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
});

const CAP = 8;

/** The core's slot table as `zones.rs` keeps it, ticking once per frame, with STATUS into a fake mirror. */
function fakeCore(slots: number, ringFrames = 30, evictFrames = 9) {
  const st = { kernel: new Uint32Array(4), state: new Uint8Array(4), timer: new Uint16Array(4) };
  const resident = new Set<number>();
  const configs: { shared: number; slots: ZoneConfigSlots[] }[] = [];
  const events: [number, number][] = [];
  const mirror = {
    blocks: 0,
    zoneCount: slots,
    zoneKernel: new Uint32Array(4),
    zoneState: new Uint8Array(4),
    drainZoneEvents(sink: { event(a: number, b: number): void }) {
      for (const [s, c] of events.splice(0)) sink.event(s, c);
      return 0;
    },
  };
  const writer = {
    zoneConfig(shared: number, _ramp: number, recs: readonly ZoneConfigSlots[]) {
      configs.push({ shared, slots: recs.map((r) => ({ ...r })) });
      for (let k = 0; k < slots; k++) {
        const r = recs[k] ?? { kernelId: 0, state: 0 };
        const id = r.kernelId;
        const s = st.state[k]!;
        if (id === 0) {
          if (s === ZoneState.WaitingKernel) st.state[k] = ZoneState.Off;
          else if (s === ZoneState.FadingIn || s === ZoneState.Active) [st.state[k], st.timer[k]] = [ZoneState.Evicting, evictFrames];
          if (st.state[k] === ZoneState.Off) st.kernel[k] = 0;
          continue;
        }
        if (id !== st.kernel[k]) {
          if (s !== ZoneState.Off) {
            events.push([k, ZoneEvent.RefusedKernel]);
            continue;
          }
          if (r.state !== ZoneSlotState.Active) continue;
          st.kernel[k] = id;
          st.state[k] = ZoneState.WaitingKernel;
          continue;
        }
        if (r.state === ZoneSlotState.Active && (s === ZoneState.RingingOut || s === ZoneState.Evicting)) st.state[k] = ZoneState.Active;
        else if (r.state !== ZoneSlotState.Active && s === ZoneState.WaitingKernel) [st.state[k], st.kernel[k]] = [ZoneState.Off, 0];
        else if (r.state === ZoneSlotState.Release && (s === ZoneState.Active || s === ZoneState.FadingIn)) [st.state[k], st.timer[k]] = [ZoneState.RingingOut, ringFrames];
        else if (r.state === ZoneSlotState.Evict && s !== ZoneState.Off && s !== ZoneState.Evicting) [st.state[k], st.timer[k]] = [ZoneState.Evicting, evictFrames];
      }
    },
  };
  const tick = () => {
    for (let k = 0; k < slots; k++) {
      const s = st.state[k]!;
      if (s === ZoneState.WaitingKernel && resident.has(st.kernel[k]!)) st.state[k] = ZoneState.Active;
      else if ((s === ZoneState.RingingOut || s === ZoneState.Evicting) && --st.timer[k]! <= 0) [st.state[k], st.kernel[k]] = [ZoneState.Off, 0];
    }
    mirror.zoneKernel.set(st.kernel);
    mirror.zoneState.set(st.state);
    mirror.blocks++;
  };
  return { st, resident, configs, events, mirror, writer, tick };
}

function fakeView() {
  const n = () => new Float32Array(CAP);
  const view = {
    capacity: CAP,
    slots: new Uint16Array(CAP),
    count: 0,
    gen: new Uint32Array(CAP),
    viewFlags: new Uint8Array(CAP),
    world: new Uint32Array(CAP),
    posX: n(), posY: n(), posZ: n(),
    minDist: n().fill(1), maxDist: n().fill(11),
    volume: n().fill(1), audibility0: n().fill(1), dopplerLevel: n(), reverbSend: n().fill(1), sendCurve: new Uint16Array(CAP),
    curves: new SendCurveTable(),
    setOcclusion() {},
    setDopplerRate() {},
  };
  const place = (i: number, x: number, z = 0) => {
    if (![...view.slots.subarray(0, view.count)].includes(i)) view.slots[view.count++] = i;
    view.viewFlags[i] = SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED | SpatialViewFlag.SENDS;
    view.posX[i] = x;
    view.posZ[i] = z;
  };
  return { view: view as SpatialVoiceView & typeof view, place };
}

function fakeFx() {
  const sends = new Float32Array(CAP * 4);
  return { send: (i: number, k: number) => sends[i * 4 + k]!, setSend: (i: number, k: number, l: number) => void (sends[i * 4 + k] = l > 0 ? l : 0), sends };
}

function rig(opts: { slots: number; maxActive: number; standby: number; wet?: Float32Array; ringFrames?: number }) {
  const core = fakeCore(opts.slots, opts.ringFrames);
  const irs = makeFakeZoneIrService();
  const fx = fakeFx();
  const warnings: string[] = [];
  let now = 0;
  const zm = new ZoneManager({
    writer: core.writer as unknown as CommandWriter,
    fx: fx as unknown as VoiceFx,
    irs,
    mirror: core.mirror as unknown as StatusMirror,
    maxZoneSlots: opts.slots,
    zoneMaxSeconds: 1,
    sampleRate: 48_000,
    wet: opts.wet,
    now: () => now,
    warn: (m) => warnings.push(m),
    url: (p) => `url:${p}`,
  });
  const settings: AudioSettings = defaultAudioSettings();
  settings.zones = { maxActive: opts.maxActive, standby: opts.standby, maxIrSeconds: 1 };
  const frame = new ListenerFrame();
  const { view, place } = fakeView();
  let world: World | null = null;
  const answered = new Set<number>();
  /** One frame: the IR service answers last frame's requests (making them resident), the manager runs, the core ticks. */
  const step = (n = 1, answer = true) => {
    for (let f = 0; f < n; f++) {
      if (answer) for (const r of irs.requests) if (!answered.has(r.token)) {
        answered.add(r.token);
        core.resident.add(r.kernelId);
        irs.prepared(r.token, { frames: 48_000 });
      }
      now += 16;
      frame.set(world, 0, null, null, 0.016);
      zm.run(frame, view, settings);
      core.tick();
    }
  };
  const zone = (name: string, x: number, fields: Partial<AudioReverbZone> = {}) => {
    const node = GameObject.create(name);
    node.transform!.position = [x, 0, 0];
    world = node.world;
    return node.addBehavior(AudioReverbZone, fields);
  };
  const listenAt = (x: number) => {
    frame.posX = x;
  };
  return { core, irs: irs as FakeZoneIrService, fx, zm, warnings, frame, view, place, step, zone, listenAt, settings, setNow: (t: number) => (now = t) };
}

const stateOf = (r: ReturnType<typeof rig>, name: string) => r.zm.debug()!.find((z) => z.node === name)!;

describe("zone weights and sends", () => {
  it("a voice in a zone sends into its slot: volume × reverbSend × curve × weight × wet", () => {
    const wet = new Float32Array(CAP).fill(1);
    const r = rig({ slots: 3, maxActive: 2, standby: 1, wet });
    r.zone("A", 0);
    r.place(0, 0);
    r.step(12);
    expect(stateOf(r, "A").slot).toBe(0);
    expect(r.core.st.state[0]).toBe(ZoneState.Active);
    // Voice at the listener (d 0, curve 1), weight 1, wet 1.
    expect(r.fx.send(0, 0)).toBeCloseTo(1, 6);
    // Half way out of the blend edge (box half-extent 5, blend 2: x 6 → weight 0.5) and wet 0.55; d 6 → curve 0.75.
    wet[0] = 0.55;
    r.place(0, 6);
    r.step(1);
    expect(r.fx.send(0, 0)).toBeCloseTo(0.5 * 0.75 * 0.55, 5);
    // Another World's voice, or one that doesn't send, sends nothing.
    r.view.world[0] = 7;
    r.step(1);
    expect(r.fx.send(0, 0)).toBe(0);
  });

  it("the shared reverb's return is 1 minus the listener's weight in active zones", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0);
    r.place(0, 0);
    r.listenAt(100);
    r.step(12);
    expect(r.core.configs.at(-1)!.shared).toBe(1);
    r.listenAt(6); // weight 0.5
    r.step(1);
    expect(r.core.configs.at(-1)!.shared).toBeCloseTo(0.5, 5);
    r.listenAt(0);
    r.step(1);
    expect(r.core.configs.at(-1)!.shared).toBe(0);
  });
});

/** Walks one voice (with the listener) from A to B to C, 30 units apart, recording every distinct core slot table. */
function walk(r: ReturnType<typeof rig>) {
  r.zone("A", 0, { preset: "room" });
  r.zone("B", 30, { preset: "hall" });
  r.zone("C", 60, { preset: "cave" });
  const tables: string[] = [];
  const record = () => {
    const t = [...r.core.st.state.subarray(0, r.core.mirror.zoneCount)].join("");
    if (tables.at(-1) !== t) tables.push(t);
  };
  for (const x of [0, 30, 60]) {
    r.place(0, x);
    r.listenAt(x);
    for (let f = 0; f < 60; f++) {
      r.step(1);
      record();
    }
  }
  return tables;
}

describe("slot paths (OD2)", () => {
  it("high and default: the incoming zone takes the standby slot while the outgoing one rings out", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1, ringFrames: 30 });
    const tables = walk(r);
    // A active; A ringing out beside B active; B ringing beside C; every slot off once tails end.
    expect(tables).toContain("430");
    expect(tables.some((t) => t.includes("4") && t.includes("3"))).toBe(true);
    expect(tables.every((t) => !t.includes("5"))).toBe(true); // nothing evicted
    expect(stateOf(r, "C").slot).toBeGreaterThanOrEqual(0);
    expect(stateOf(r, "A").slot).toBe(-1);
    // Ring-out tracking: the manager frees a slot only after STATUS reads it off, then reuses it.
    const kernels = r.core.configs.flatMap((c) => c.slots.map((s) => s.kernelId)).filter((k) => k !== 0);
    expect(new Set(kernels).size).toBe(3);
  });

  it("low: the outgoing zone is evicted with the fade and the incoming one waits for the slot and its kernel", () => {
    const r = rig({ slots: 1, maxActive: 1, standby: 0, ringFrames: 1000 });
    const tables = walk(r);
    // (The fake core starts a slot whose kernel is already resident in the same tick: no "waiting" table.)
    expect(tables).toEqual(["0", "3", "5", "0", "3", "5", "0", "3"]);
    // One kernel at a time: each is released before the next is asked for (budget 1).
    const order = r.irs.requests.map((q) => q.preset);
    expect(order).toEqual(["room", "hall", "cave"]);
    expect(r.irs.released.length).toBe(2);
  });
});

describe("planning", () => {
  it("a full house fades the extra zone with its reason and one warning, however long it stays faded", () => {
    const r = rig({ slots: 1, maxActive: 1, standby: 0 });
    r.zone("A", 0);
    r.zone("B", 30);
    r.place(0, 0);
    r.place(1, 30);
    r.view.audibility0[1] = 0.5;
    r.step(200);
    expect(stateOf(r, "A").slot).toBe(0);
    expect(stateOf(r, "B").why).toBe("faded: preset has 1 reverb");
    expect(r.warnings.filter((w) => w.includes('"B" faded'))).toHaveLength(1);
    expect(r.zm.counters.zonesFaded).toBe(1);
    expect(stateOf(r, "A").why).toBe("");
  });

  it("a challenger needs 1.5× the energy for 500 ms; a higher priority wins at once", () => {
    const r = rig({ slots: 3, maxActive: 1, standby: 1 });
    r.zone("A", 0);
    const b = r.zone("B", 30);
    r.listenAt(15); // both voices 15 away: the same curve gain
    r.place(0, 0);
    r.step(12);
    r.place(1, 30);
    r.view.audibility0[1] = 1.1; // energy 1.21 < 1.5
    r.step(60);
    expect(stateOf(r, "A").slot).toBeGreaterThanOrEqual(0);
    r.view.audibility0[1] = 1.5; // energy 2.25 > 1.5
    r.step(20); // 320 ms
    expect(stateOf(r, "B").slot).toBe(-1);
    r.step(30);
    expect(stateOf(r, "B").slot).toBeGreaterThanOrEqual(0);
    expect(stateOf(r, "A").slot).toBe(-1);
    // A higher priority takes it back at the next replan.
    r.view.audibility0[1] = 1;
    r.zone("C", 60, { priority: 10 });
    r.place(2, 60);
    r.view.audibility0[2] = 0.1;
    r.step(8);
    expect(r.zm.debug()!.find((z) => z.node === "C")!.rank).toBe(1);
    r.step(4);
    expect(stateOf(r, "C").slot).toBeGreaterThanOrEqual(0);
    void b;
  });

  it("zones with wet 0, no sources or a failed IR say why", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0, { wet: 0 });
    r.zone("B", 30);
    r.zone("C", 60, { ir: "ir/x.wav" });
    r.place(0, 0);
    r.place(1, 60);
    r.step(1, false);
    const c = r.irs.requests.find((q) => q.assetUrl === "url:ir/x.wav")!;
    r.irs.failed(c.token, "HTTP 404");
    r.step(8);
    expect(stateOf(r, "A").why).toBe("wet 0");
    expect(stateOf(r, "B").why).toBe("no sources inside");
    expect(stateOf(r, "C").why).toBe("IR failed: HTTP 404");
    expect(r.zm.counters.irFailures).toBe(1);
  });
});

describe("kernels", () => {
  it("a kernel unanswered for 5 s fails the zone and is released", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0);
    r.place(0, 0);
    r.step(1, false);
    expect(r.irs.requests).toHaveLength(1);
    r.setNow(ZONE_IR_TIMEOUT_MS + 100);
    r.step(4, false);
    expect(stateOf(r, "A").why).toBe("IR failed: timed out after 5 s");
    expect(r.irs.released).toEqual([r.irs.requests[0]!.kernelId]);
  });

  it("preloads zones near the listener within the budget, shares a kernel between zones of one IR, and keeps LRU kernels resident", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0, { preset: "hall" });
    r.zone("A2", 12, { preset: "hall" }); // the same IR: one kernel
    r.zone("B", 20, { preset: "room" }); // 10 outside, within 2 + 20
    r.zone("Far", 200, { preset: "cave" });
    r.listenAt(0);
    r.step(2);
    expect(r.irs.requests.map((q) => q.preset).sort()).toEqual(["hall", "room"]);
    expect(stateOf(r, "B").state).toBe("prepared");
    // Walking to Far: its kernel fits the budget (3) without releasing the others.
    r.listenAt(200);
    r.place(0, 200);
    r.step(12);
    expect(r.irs.released).toEqual([]);
    expect(stateOf(r, "Far").slot).toBeGreaterThanOrEqual(0);
  });

  it("asks for a held kernel again when the context is replaced, and replays the active slots", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0);
    r.place(0, 0);
    r.step(12);
    r.zm.contextReplaced(44_100);
    expect(r.irs.reprepared).toEqual([44_100]);
    const b = new ReplayBuilder();
    r.zm.replay(b);
    expect(r.irs.reprepared).toEqual([44_100]); // not twice
    expect(b.count).toBe(1);
    const posted: ArrayBuffer[] = [];
    b.post({ post: (m: ArrayBuffer) => void posted.push(m), nextSeq: () => 1 }, 0, true);
    const view = new DataView(posted[0]!);
    // The REPLAY message's records start after its 32-byte prefix.
    const rec = readZoneConfig(view, 32);
    expect(rec.slots[0]).toMatchObject({ state: ZoneSlotState.Active });
    expect(rec.slots[0]!.kernelId).toBe(r.irs.requests[0]!.kernelId);
  });
});

describe("inert", () => {
  it("does nothing without zone slots", () => {
    const r = rig({ slots: 0, maxActive: 2, standby: 1 });
    r.zone("A", 0);
    r.place(0, 0);
    r.step(10);
    expect(r.core.configs).toHaveLength(0);
    expect(r.irs.requests).toHaveLength(0);
    expect(r.zm.debug()).toBeUndefined();
  });
});
