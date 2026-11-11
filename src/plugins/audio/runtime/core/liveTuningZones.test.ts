// ADR 0162 E7 (#158): live tuning of the AudioReverbZone fields and the `audio.zones.*` settings. Each field is edited on a
// zone that is already active in a playing World; the change must show in the zone manager's output (the sends staged
// for the voices, the slot table of ZONE_CONFIG, the kernels asked of the IR service) on the next frame, or at the
// documented point. The rig is the one of `zones.test.ts` (a fake core and the fake IR service).
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import type { World } from "../../../../engine/core/World";
import { Vector3 } from "../../../../engine/core/math";
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
  const zone = (name: string, x: number, fields: Record<string, unknown> = {}) => {
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
const lastSlot = (r: ReturnType<typeof rig>, k = 0) => r.core.configs.at(-1)!.slots[k]!;

/** A rig with zone "A" active at the origin and a voice 0 at the listener (so its send is the zone's weight). */
function active(fields: Record<string, unknown> = {}) {
  const wet = new Float32Array(CAP).fill(1);
  const r = rig({ slots: 3, maxActive: 2, standby: 1, wet });
  const a = r.zone("A", 0, fields);
  r.place(0, 0);
  r.step(12);
  expect(stateOf(r, "A").slot).toBe(0);
  return { r, a };
}
/** The send of voice 0 at x (the listener goes with it, so the distance curve is 1), after one frame. */
function sendAt(r: ReturnType<typeof rig>, x: number): number {
  r.place(0, x);
  r.listenAt(x);
  r.step(1);
  return r.fx.send(0, 0);
}

describe("zone volume fields apply next frame", () => {
  it("size (box): a wider box holds a voice that was outside", () => {
    const { r, a } = active();
    expect(sendAt(r, 6)).toBeCloseTo(0.5, 5); // half extent 5, blend 2
    a.size.x = 20;
    expect(sendAt(r, 6)).toBeCloseTo(1, 5);
    a.size = new Vector3(4, 4, 10); // replacing the vector counts too
    expect(sendAt(r, 6)).toBe(0);
  });

  it("center: moving the volume onto the voice", () => {
    const { r, a } = active();
    expect(sendAt(r, 20)).toBe(0);
    a.center.x = 20;
    expect(sendAt(r, 20)).toBeCloseTo(1, 5);
  });

  it("shape and radius: box to sphere and back", () => {
    const { r, a } = active();
    expect(sendAt(r, 3)).toBeCloseTo(1, 5); // inside the box
    a.shape = "sphere";
    a.radius = 1;
    expect(sendAt(r, 3)).toBe(0); // 2 outside a sphere of radius 1, blend 2 → 0
    a.radius = 10;
    expect(sendAt(r, 3)).toBeCloseTo(1, 5);
    a.shape = "box";
    expect(sendAt(r, 3)).toBeCloseTo(1, 5);
    a.shape = "sphere";
    a.radius = 2;
    expect(sendAt(r, 3)).toBeCloseTo(0.5, 5); // 1 outside, blend 2
  });

  it("blendDistance", () => {
    const { r, a } = active();
    expect(sendAt(r, 6)).toBeCloseTo(0.5, 5);
    a.blendDistance = 0;
    expect(sendAt(r, 6)).toBe(0);
    a.blendDistance = 4;
    expect(sendAt(r, 6)).toBeCloseTo(0.75, 5);
  });

  it("the node's position and scale (the world-matrix version)", () => {
    const { r, a } = active();
    expect(sendAt(r, 20)).toBe(0);
    a.node.transform!.position = [20, 0, 0];
    expect(sendAt(r, 20)).toBeCloseTo(1, 5);
    expect(sendAt(r, 27)).toBe(0); // 7 past a half extent of 5 with blend 2
    a.node.transform!.scale = [3, 1, 1]; // half extent 15
    expect(sendAt(r, 27)).toBeCloseTo(1, 5);
  });

  it("enabled: off releases the slot (the tail rings out), on takes one again", () => {
    const { r, a } = active();
    a.enabled = false;
    r.step(1);
    expect(r.zm.debug()!.some((z) => z.node === "A")).toBe(false);
    expect(r.fx.send(0, 0)).toBe(0);
    expect(lastSlot(r).state).toBe(2); // release
    r.step(40);
    expect(r.core.st.state[0]).toBe(ZoneState.Off);
    a.enabled = true;
    r.step(14);
    expect(stateOf(r, "A").slot).toBeGreaterThanOrEqual(0);
    expect(r.core.st.state[stateOf(r, "A").slot]).toBe(ZoneState.Active);
  });
});

describe("zone reverb fields apply next frame", () => {
  it("wet: reaches the slot in ZONE_CONFIG when it changes by more than 0.5 dB", () => {
    const { r, a } = active({ wet: 0.5 });
    expect(lastSlot(r).wet).toBeCloseTo(0.5, 6);
    a.wet = 1.5;
    r.step(1);
    expect(lastSlot(r).wet).toBeCloseTo(1.5, 6);
    a.wet = 3; // clamped to 2
    r.step(1);
    expect(lastSlot(r).wet).toBe(2);
    a.wet = 0; // wet 0: the zone is skipped with its reason (at the next replan)
    r.step(14);
    expect(stateOf(r, "A").why).toBe("wet 0");
  });

  it("wet: a change under 0.5 dB is held back by design (inaudible; the next larger change sends it)", () => {
    const { r, a } = active({ wet: 1 });
    const sent = r.core.configs.length;
    a.wet = 1.02;
    r.step(2);
    expect(r.core.configs.length).toBe(sent);
    a.wet = 1.2;
    r.step(1);
    expect(lastSlot(r).wet).toBeCloseTo(1.2, 6);
  });

  it("output: the return bus changes in place", () => {
    const { r, a } = active();
    r.settings.buses = [...r.settings.buses, { name: "ZoneReturn", parent: "Master", volume: 1, mute: false, effects: [] }];
    expect(lastSlot(r).returnBus).toBe(0);
    a.output = "ZoneReturn";
    r.step(1);
    expect(lastSlot(r).returnBus).toBe(r.settings.buses.length - 1);
    a.output = "";
    r.step(1);
    expect(lastSlot(r).returnBus).toBe(0);
    a.output = "Gone"; // an unknown bus returns to Master, with one warning
    r.step(2);
    expect(lastSlot(r).returnBus).toBe(0);
    expect(r.warnings.filter((w) => w.includes('"Gone"'))).toHaveLength(1);
  });

  it("preset: asks for the new kernel and the zone takes it", () => {
    const { r, a } = active({ preset: "hall" });
    const before = r.irs.requests.length;
    a.preset = "cave";
    r.step(1);
    expect(r.irs.requests.slice(before).map((q) => q.preset)).toEqual(["cave"]);
    r.step(14);
    const row = stateOf(r, "A");
    expect(row.ir).toBe("cave");
    expect(row.slot).toBeGreaterThanOrEqual(0);
    expect(r.core.st.state[row.slot]).toBe(ZoneState.Active);
    expect(r.core.st.kernel[row.slot]).toBe(r.irs.requests.at(-1)!.kernelId);
  });

  it("ir: an impulse response overrides the preset, and clearing it goes back", () => {
    const { r, a } = active({ preset: "hall" });
    a.ir = "ir/x.wav";
    r.step(1);
    expect(r.irs.requests.at(-1)).toMatchObject({ assetUrl: "url:ir/x.wav" });
    r.step(14);
    expect(stateOf(r, "A").ir).toBe("ir/x.wav");
    expect(r.core.st.state[stateOf(r, "A").slot]).toBe(ZoneState.Active);
    a.ir = "";
    r.step(14);
    expect(stateOf(r, "A").ir).toBe("hall");
    expect(r.core.st.state[stateOf(r, "A").slot]).toBe(ZoneState.Active);
  });

  it("priority: raising it wins a contested slot at the next replan", () => {
    const r = rig({ slots: 3, maxActive: 1, standby: 1 });
    r.zone("A", 0);
    const b = r.zone("B", 30);
    r.listenAt(15);
    r.place(0, 0);
    r.place(1, 30);
    r.step(20);
    expect(stateOf(r, "A").slot).toBeGreaterThanOrEqual(0);
    expect(stateOf(r, "B").slot).toBe(-1);
    b.priority = 10;
    r.step(14);
    expect(stateOf(r, "B").slot).toBeGreaterThanOrEqual(0);
    expect(stateOf(r, "A").slot).toBe(-1);
  });
});

describe("audio.zones settings", () => {
  it("maxActive is read each frame: fewer active zones releases the extra one; more takes it back; 0 is inert", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0);
    r.zone("B", 30);
    r.place(0, 0);
    r.place(1, 30);
    r.view.audibility0[1] = 0.5;
    r.step(30);
    expect(stateOf(r, "A").slot).toBeGreaterThanOrEqual(0);
    expect(stateOf(r, "B").slot).toBeGreaterThanOrEqual(0);
    r.settings.zones = { ...r.settings.zones, maxActive: 1 };
    r.step(30);
    expect(stateOf(r, "A").slot).toBeGreaterThanOrEqual(0);
    expect(stateOf(r, "B").slot).toBe(-1);
    r.settings.zones = { ...r.settings.zones, maxActive: 2 };
    r.step(30);
    expect(stateOf(r, "B").slot).toBeGreaterThanOrEqual(0);
    r.settings.zones = { ...r.settings.zones, maxActive: 0 };
    r.step(30);
    expect(stateOf(r, "A").slot).toBe(-1);
    expect(stateOf(r, "B").slot).toBe(-1);
  });

  it("standby and maxIrSeconds size the core's slots and IR memory at init: a new value waits for the next core rebuild (documented, not live)", () => {
    const r = rig({ slots: 3, maxActive: 2, standby: 1 });
    r.zone("A", 0);
    r.place(0, 0);
    r.step(12);
    expect(r.irs.requests.at(-1)!.maxFrames).toBe(48_000); // the rig's `zoneMaxSeconds: 1`
    r.settings.zones = { maxActive: 2, standby: 0, maxIrSeconds: 4 };
    r.zone("B", 30, { preset: "cave" });
    r.place(1, 30);
    r.step(12);
    expect(r.zm.slotCount).toBe(3);
    expect(r.irs.requests.at(-1)!.maxFrames).toBe(48_000);
  });
});
