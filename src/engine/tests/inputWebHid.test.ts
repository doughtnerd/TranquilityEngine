import { afterEach, describe, expect, it, vi } from "vitest";
import { Input } from "../input/Input";
import type { DeviceEventSink, GamepadInfo, GamepadOutput } from "../input/devices";
import { loadInputMapping } from "../input/mapping";
import { webGamepads } from "../input/webGamepads";
import { crc32 } from "../input/webHid/crc32";
import type { HidPadDriver, HidPadFactory, HidPadLink } from "../input/webHid/driver";
import { dualSense } from "../input/webHid/dualSense";
import { dualShock4 } from "../input/webHid/dualShock4";
import { JOYCON_LEFT, JOYCON_RIGHT, joyCons } from "../input/webHid/joyCon";
import type { Hid, HidCollectionInfo, HidConnectionEvent, HidDevice, HidDeviceFilter, HidInputReportEvent } from "../input/webHid/hidTypes";
import { switchPro } from "../input/webHid/switchPro";
import { webHidGamepads } from "../input/webHid/webHidGamepads";

// WebHID gamepads (ADR 0335 build notes): each family's driver through its own interface, and the
// adapter through its, with fake HID devices that emit constructed reports and record output.

const G = 9.80665;
const RAD = Math.PI / 180;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = (reportId: number, data: Uint8Array, device: FakeDevice) => void;

class FakeDevice implements HidDevice {
  opened = false;
  failOpen = false;
  readonly sent: { id: number; data: Uint8Array }[] = [];
  private readonly listeners = new Set<(e: HidInputReportEvent) => void>();

  constructor(
    readonly vendorId: number,
    readonly productId: number,
    outputs: number[],
    private readonly features: Record<number, number[]> = {},
    private readonly reply?: Reply,
    readonly productName = "Fake pad",
  ) {
    this.collections = [{ outputReports: outputs.map((reportId) => ({ reportId })) }];
  }

  readonly collections: HidCollectionInfo[];

  async open() {
    if (this.failOpen) throw new Error("NotAllowedError");
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(reportId: number, data: BufferSource) {
    const bytes = new Uint8Array((data as Uint8Array).slice());
    this.sent.push({ id: reportId, data: bytes });
    this.reply?.(reportId, bytes, this);
  }
  async sendFeatureReport() {}
  async receiveFeatureReport(reportId: number) {
    const f = this.features[reportId];
    if (!f) throw new Error("no such feature report");
    return new DataView(Uint8Array.from(f).buffer);
  }
  addEventListener(_type: "inputreport", l: (e: HidInputReportEvent) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_type: "inputreport", l: (e: HidInputReportEvent) => void) {
    this.listeners.delete(l);
  }
  emit(reportId: number, bytes: Uint8Array) {
    for (const l of [...this.listeners]) l({ device: this, reportId, data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  }
  last(id: number): Uint8Array {
    const all = this.sent.filter((s) => s.id === id);
    return all[all.length - 1].data;
  }
}

/** What reached the snapshot: the latest value of each control, sensors, and a log. */
function recorder() {
  const log: unknown[][] = [];
  const buttons = new Map<string, number>();
  const axes = new Map<string, number>();
  const sensors = new Map<string, number[]>();
  const touches = new Map<string, [boolean, number, number]>();
  const batteries = new Map<number, [number, boolean]>();
  const infos: GamepadInfo[] = [];
  const sink: DeviceEventSink = {
    keyDown: () => {},
    keyUp: () => {},
    buttonDown: () => {},
    buttonUp: () => {},
    pointerAt: () => {},
    move: () => {},
    scroll: () => {},
    releaseAll: () => {},
    touchStart: () => {},
    touchMove: () => {},
    touchEnd: () => {},
    penAt: () => {},
    penButtonDown: () => {},
    penButtonUp: () => {},
    penLeave: () => {},
    gamepadConnected: (info) => (infos.push(info), log.push(["connect", info.id, info.family])),
    gamepadDisconnected: (id) => log.push(["disconnect", id]),
    gamepadButton: (id, i, v) => (buttons.set(`${id}:${i}`, v), log.push(["button", id, i, v])),
    gamepadAxis: (id, i, v) => (axes.set(`${id}:${i}`, v), log.push(["axis", id, i, v])),
    gamepadSensor: (id, kind, x, y, z) => (sensors.set(`${id}:${kind}`, [x, y, z]), log.push(["sensor", id, kind])),
    gamepadTouch: (id, finger, down, x, y) => (touches.set(`${id}:${finger}`, [down, x, y]), log.push(["touch", id, finger, down, x, y])),
    gamepadBattery: (id, level, charging) => (batteries.set(id, [level, charging]), log.push(["battery", id, level, charging])),
  };
  return { sink, log, buttons, axes, sensors, touches, batteries, infos };
}

/** Start a family's driver on `device` with a link that reports to a recorder as pad 1. */
async function startDriver(factory: HidPadFactory, device: FakeDevice, slot = 0) {
  const rec = recorder();
  let present = false;
  const link: HidPadLink = {
    id: 1,
    sink: rec.sink,
    slot,
    connected: (info) => ((present = true), rec.sink.gamepadConnected({ ...info, id: 1 })),
    disconnected: () => ((present = false), rec.sink.gamepadDisconnected(1)),
    joined: () => {},
  };
  const driver: HidPadDriver = factory(device, link);
  device.addEventListener("inputreport", (e) => driver.report(e.reportId, e.data));
  await driver.start();
  return { driver, ...rec, present: () => present };
}

function bytes(length: number, at: Record<number, number> = {}): Uint8Array {
  const b = new Uint8Array(length);
  for (const [i, v] of Object.entries(at)) b[Number(i)] = v;
  return b;
}

function put16(b: Uint8Array | number[], at: number, v: number) {
  b[at] = v & 0xff;
  b[at + 1] = (v >> 8) & 0xff;
}

const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A Sony calibration report body: gyro 100 deg/s per 1700 steps from bias, accelerometer 1 g per 8200 steps from -200. */
function sonyCalibration(layout: "interleaved" | "grouped"): number[] {
  const b = new Array<number>(40).fill(0);
  const bias = [10, -5, 0];
  bias.forEach((v, i) => put16(b, i * 2, v));
  for (let axis = 0; axis < 3; axis++) {
    const plus = bias[axis] + 8500;
    const minus = bias[axis] - 8500;
    if (layout === "interleaved") {
      put16(b, 6 + axis * 4, plus);
      put16(b, 8 + axis * 4, minus);
    } else {
      put16(b, 6 + axis * 2, plus);
      put16(b, 12 + axis * 2, minus);
    }
    put16(b, 22 + axis * 4, 8000);
    put16(b, 24 + axis * 4, -8400);
  }
  put16(b, 18, 500);
  put16(b, 20, 500);
  return b;
}

/** With its report id first, as some browsers return feature reports. */
const withId = (id: number, body: number[], fullLength: number) => [id, ...body, ...new Array(Math.max(0, fullLength - 1 - body.length)).fill(0)].slice(0, fullLength);

/** Write a Bluetooth input report's CRC (header 0xA1). */
function sealInput(reportId: number, b: Uint8Array): Uint8Array {
  const crc = crc32(b.subarray(0, b.length - 4), crc32([0xa1, reportId]));
  b[b.length - 4] = crc & 0xff;
  b[b.length - 3] = (crc >>> 8) & 0xff;
  b[b.length - 2] = (crc >>> 16) & 0xff;
  b[b.length - 1] = (crc >>> 24) & 0xff;
  return b;
}

/** An output report's CRC is right (header 0xA2). */
function outputCrcOk(reportId: number, b: Uint8Array): boolean {
  return le32(b, b.length - 4) === crc32(b.subarray(0, b.length - 4), crc32([0xa2, reportId]));
}

describe("crc32", () => {
  it("is zlib's CRC-32, continued across pieces", () => {
    const digits = Array.from("123456789", (c) => c.charCodeAt(0));
    expect(crc32(digits)).toBe(0xcbf43926);
    expect(crc32(digits.slice(4), crc32(digits.slice(0, 4)))).toBe(0xcbf43926);
    expect(crc32([])).toBe(0);
  });
});

/** A DualSense state block (sticks, triggers, buttons, motion) at `o` in `b`. */
function dualSenseState(b: Uint8Array, o: number, s: { gyro?: number[]; accel?: number[]; time?: number } = {}) {
  b.set([0, 255, 128, 128], o); // left stick hard left and down; right centred
  b[o + 4] = 0; // L2 analog 0, but its digital bit is set below
  b[o + 5] = 255;
  b[o + 7] = 0x20 | 2; // cross, hat right
  b[o + 8] = 0x01 | 0x04 | 0x20; // L1, L2 digital, options
  b[o + 9] = 0x02 | 0x04 | 0x40; // touchpad click, mute, Edge left paddle
  (s.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 15 + i * 2, v));
  (s.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 21 + i * 2, v));
  const t = s.time ?? 0;
  b[o + 27] = t & 0xff;
  b[o + 28] = (t >>> 8) & 0xff;
  b[o + 29] = (t >>> 16) & 0xff;
  b[o + 30] = (t >>> 24) & 0xff;
  return b;
}

describe("DualSense (dualSense.ts)", () => {
  it("USB: reports sticks, buttons, the hat, triggers and extras on the wire indices", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02], { 0x05: withId(0x05, sonyCalibration("interleaved"), 41) });
    const pad = await startDriver(dualSense, device);
    expect(pad.infos[0]).toMatchObject({ id: 1, family: "playstation", vendor: 0x054c, product: 0x0ce6, sensors: true, triggerRumble: true, led: true });
    device.emit(0x01, dualSenseState(bytes(63), 0));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([pad.axes.get("1:0"), pad.axes.get("1:1"), pad.axes.get("1:2") ?? 0]).toEqual([-1, 1, 0]);
    expect([b(0), b(1), b(4), b(6), b(7), b(9)]).toEqual([1, 0, 1, 1, 1, 1]); // L2 at 0 with its digital bit: fully pulled
    expect([b(12), b(13), b(14), b(15)]).toEqual([0, 0, 0, 1]);
    expect([b(22), b(17), b(19), b(16)]).toEqual([1, 1, 1, 0]); // touchpadPress, misc1 (mute), leftPaddle1
    // Only changes are reported.
    pad.log.length = 0;
    device.emit(0x01, dualSenseState(bytes(63), 0));
    expect(pad.log).toEqual([]);
  });

  it("USB: scales gyro and accelerometer through the factory calibration, only while sensors are on", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02], { 0x05: withId(0x05, sonyCalibration("interleaved"), 41) });
    const pad = await startDriver(dualSense, device);
    const state = dualSenseState(bytes(63), 0, { gyro: [10 + 1700, -5 - 1700, 0], accel: [-200 + 8200, -200, -200 - 8200] });
    device.emit(0x01, state);
    expect(pad.sensors.size).toBe(0);
    pad.driver.output.setSensors(true);
    device.emit(0x01, state);
    const gyro = pad.sensors.get("1:gyro")!;
    const accel = pad.sensors.get("1:accel")!;
    [100 * RAD, -100 * RAD, 0].forEach((v, i) => expect(gyro[i]).toBeCloseTo(v, 4));
    [G, 0, -G].forEach((v, i) => expect(accel[i]).toBeCloseTo(v, 4));
  });

  it("USB output: lights at start, then rumble, adaptive triggers and trigger rumble in report 0x02", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const pad = await startDriver(dualSense, device, 1);
    const first = device.last(0x02);
    expect(first.length).toBe(47);
    expect(first[1] & 0x14).toBe(0x14); // light bar and player lights
    expect([...first.subarray(43, 47)]).toEqual([0x0a | 0x20, 0x40, 0x00, 0x00]); // second slot: two lights, red
    pad.driver.output.rumble(0.5, 1, 10);
    let e = device.last(0x02);
    expect([e[0] & 0x03, e[2], e[3]]).toEqual([0x03, 127, 64]); // right (high) and left (low) motors, halved as SDL does
    await sleep(30);
    e = device.last(0x02);
    expect([e[2], e[3]]).toEqual([0, 0]);
    pad.driver.output.setLed!(255, 128, 0);
    expect([...device.last(0x02).subarray(44, 47)]).toEqual([255, 128, 0]);
    pad.driver.output.triggerEffect!("right", { mode: "weapon", start: 0.3, end: 0.6, strength: 1 });
    e = device.last(0x02);
    expect(e[0] & 0x0c).toBe(0x04);
    expect([...e.subarray(10, 21)]).toEqual([0x25, 0x28, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    pad.driver.output.triggerEffect!("left", { mode: "resistance", start: 0, strength: 0.5 });
    e = device.last(0x02);
    expect([...e.subarray(21, 28)]).toEqual([0x21, 0xff, 0x03, 0xdb, 0xb6, 0x6d, 0x1b]); // force 3 (strength 4 of 8) in all ten zones
    pad.driver.output.triggerRumble!(0, 1, 10);
    e = device.last(0x02);
    expect([...e.subarray(10, 21)]).toEqual([0x26, 0xff, 0x03, 0xff, 0xff, 0xff, 0x3f, 0, 0, 50, 0]);
    expect(e[21]).toBe(0x21); // the left trigger keeps its effect
    await sleep(30);
    expect(device.last(0x02)[10]).toBe(0x25); // trigger rumble over: the game's weapon effect is back
    pad.driver.stop();
    e = device.last(0x02);
    expect([e[10], e[21]]).toEqual([0x05, 0x05]); // triggers freed
  });

  it("Bluetooth: report 0x31 with its CRC; output 0x31 sealed; lights wait for the connection to settle", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x31], { 0x05: withId(0x05, sonyCalibration("interleaved"), 41) });
    const pad = await startDriver(dualSense, device);
    const first = device.last(0x31);
    expect(first.length).toBe(77);
    expect(first[1]).toBe(0x10);
    expect(first[2 + 1]).toBe(0); // no light changes yet
    expect(outputCrcOk(0x31, first)).toBe(true);
    device.emit(0x31, sealInput(0x31, dualSenseState(bytes(77), 1, { time: 1000 })));
    expect(pad.buttons.get("1:0")).toBe(1);
    expect(pad.axes.get("1:0")).toBe(-1);
    const before = device.sent.length;
    device.emit(0x31, sealInput(0x31, dualSenseState(bytes(77), 1, { time: 10200000 })));
    const [reset, lights] = device.sent.slice(before).map((s) => s.data);
    expect(reset[2 + 1] & 0x08).toBe(0x08);
    expect(lights[2 + 1] & 0x0c).toBe(0x04);
    expect([lights[2 + 44], lights[2 + 45], lights[2 + 46]]).toEqual([0, 0, 0x40]);
    expect(outputCrcOk(0x31, reset) && outputCrcOk(0x31, lights)).toBe(true);
    expect(reset[0] >> 4).not.toBe(lights[0] >> 4); // sequence numbers advance
    // Once three good reports have arrived, one with a bad CRC is dropped.
    device.emit(0x31, sealInput(0x31, dualSenseState(bytes(77), 1, { time: 10250000 })));
    pad.log.length = 0;
    const bad = sealInput(0x31, dualSenseState(bytes(77), 1, { time: 10300000 }));
    bad[1] = 128; // left stick centred, CRC now wrong
    device.emit(0x31, bad);
    expect(pad.log).toEqual([]);
  });

  it("Bluetooth simple mode: reads report 0x01's nine bytes and switches the pad to full reports", async () => {
    const device = new FakeDevice(0x054c, 0x0df2, []); // no descriptor: transport learned from the reports
    const pad = await startDriver(dualSense, device);
    expect(pad.infos[0].name).toContain("Edge");
    device.emit(0x01, bytes(9, { 0: 128, 1: 0, 2: 128, 3: 128, 4: 0x80 | 8, 5: 0x02, 6: 0x01, 7: 51, 8: 0 }));
    expect([pad.axes.get("1:1"), pad.buttons.get("1:3"), pad.buttons.get("1:5"), pad.buttons.get("1:16"), pad.buttons.get("1:6")]).toEqual([-1, 1, 1, 1, 0.2]);
    const switched = device.last(0x31);
    expect(switched.length).toBe(77);
    expect(outputCrcOk(0x31, switched)).toBe(true);
  });
});

/** A DualShock 4 state block at `o`. */
function dualShock4State(b: Uint8Array, o: number, s: { gyro?: number[]; accel?: number[] } = {}) {
  b.set([255, 128, 128, 0], o);
  b[o + 4] = 0x80 | 0x40 | 6; // triangle, circle, hat left
  b[o + 5] = 0x02 | 0x10 | 0x80; // R1, share, R3
  b[o + 6] = 0x01 | 0x02 | 0xfc; // PS, touchpad, counter bits
  b[o + 7] = 255;
  b[o + 8] = 0;
  (s.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 12 + i * 2, v));
  (s.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 18 + i * 2, v));
  return b;
}

describe("DualShock 4 (dualShock4.ts)", () => {
  it("USB: buttons, hat, triggers, calibrated motion, and output report 0x05", async () => {
    const device = new FakeDevice(0x054c, 0x09cc, [0x05], { 0x02: withId(0x02, sonyCalibration("interleaved"), 37) });
    const pad = await startDriver(dualShock4, device);
    expect(pad.infos[0]).toMatchObject({ family: "playstation", led: true, triggerRumble: false });
    pad.driver.output.setSensors(true);
    device.emit(0x01, dualShock4State(bytes(63), 0, { gyro: [10 + 1700, 0, 0], accel: [0, -200 + 8200, 0] }));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([pad.axes.get("1:0"), pad.axes.get("1:3")]).toEqual([1, -1]);
    expect([b(1), b(3), b(5), b(8), b(11), b(16), b(22), b(14), b(6)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(b(17)).toBe(0); // the counter bits aren't buttons
    expect(pad.sensors.get("1:gyro")![0]).toBeCloseTo(100 * RAD, 4);
    expect(pad.sensors.get("1:accel")![1]).toBeCloseTo(G, 4);
    const start = device.last(0x05);
    expect([start.length, start[0], start[5], start[6], start[7]]).toEqual([31, 0x03, 0, 0, 0x40]);
    pad.driver.output.rumble(1, 0.5, 100);
    pad.driver.output.setLed!(255, 0, 128);
    expect([...device.last(0x05).subarray(3, 8)]).toEqual([128, 255, 255, 0, 128]);
    pad.driver.stop();
    expect([...device.last(0x05).subarray(3, 5)]).toEqual([0, 0]);
  });

  it("without calibration, uses Sony's nominal scales", async () => {
    const device = new FakeDevice(0x054c, 0x05c4, [0x05]);
    const pad = await startDriver(dualShock4, device);
    pad.driver.output.setSensors(true);
    device.emit(0x01, dualShock4State(bytes(63), 0, { gyro: [160, 0, -16], accel: [8192, 0, 0] }));
    const gyro = pad.sensors.get("1:gyro")!;
    expect(gyro[0]).toBeCloseTo(10 * RAD, 5);
    expect(gyro[2]).toBeCloseTo(-1 * RAD, 5);
    expect(pad.sensors.get("1:accel")![0]).toBeCloseTo(G, 5);
  });

  it("Bluetooth: report 0x11 (grouped calibration), output 0x11 with its CRC", async () => {
    const device = new FakeDevice(0x054c, 0x05c4, [0x11], { 0x05: withId(0x05, sonyCalibration("grouped"), 41) });
    const pad = await startDriver(dualShock4, device);
    pad.driver.output.setSensors(true);
    const report = dualShock4State(bytes(77), 2, { gyro: [0, -5 + 1700, 0] });
    report[0] = 0xc0;
    device.emit(0x11, sealInput(0x11, report));
    expect(pad.buttons.get("1:3")).toBe(1);
    expect(pad.sensors.get("1:gyro")![1]).toBeCloseTo(100 * RAD, 4);
    pad.driver.output.rumble(0.25, 0, 50);
    const out = device.last(0x11);
    expect([out.length, out[0], out[2], out[5], out[6], out[9]]).toEqual([77, 0xc4, 0x03, 0, 64, 0x40]);
    expect(outputCrcOk(0x11, out)).toBe(true);
  });

  it("the wireless adapter: reports a pad only while a controller is paired with it", async () => {
    const device = new FakeDevice(0x054c, 0x0ba0, [0x05]);
    const pad = await startDriver(dualShock4, device);
    expect(pad.present()).toBe(false);
    const absent = dualShock4State(bytes(63), 0);
    absent[30] = 0x04;
    device.emit(0x01, absent);
    expect(pad.log).toEqual([]);
    device.emit(0x01, dualShock4State(bytes(63), 0));
    expect(pad.present()).toBe(true);
    expect(pad.buttons.get("1:3")).toBe(1);
    device.emit(0x01, absent);
    expect(pad.log[pad.log.length - 1]).toEqual(["disconnect", 1]);
  });
});

/** A touch point at `at`: down or lifted, 12-bit x and y. */
function putTouch(b: Uint8Array, at: number, down: boolean, x: number, y: number) {
  b.set([down ? 0x01 : 0x81, x & 0xff, ((x >> 8) & 0x0f) | ((y & 0x0f) << 4), y >> 4], at);
}

describe("touchpad points and battery (dualSense.ts, dualShock4.ts)", () => {
  it("DualSense USB: two fingers normalized by 1920 × 1070, reported on change; the battery byte", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const pad = await startDriver(dualSense, device);
    const report = (f0: [boolean, number, number], f1: [boolean, number, number], battery: number) => {
      const b = dualSenseState(bytes(63), 0);
      putTouch(b, 32, ...f0);
      putTouch(b, 36, ...f1);
      b[52] = battery;
      return b;
    };
    device.emit(0x01, report([true, 960, 535], [false, 0, 0], 0x14));
    expect(pad.touches.get("1:0")).toEqual([true, 0.5, 0.5]);
    expect(pad.touches.get("1:1")).toBeUndefined(); // never down: nothing to report
    expect(pad.batteries.get(1)).toEqual([0.45, true]); // charging, level 4
    pad.log.length = 0;
    device.emit(0x01, report([true, 960, 535], [false, 5, 5], 0x14)); // a lifted finger's position doesn't matter
    expect(pad.log).toEqual([]);
    device.emit(0x01, report([true, 1920, 1070], [true, 0, 0], 0x09));
    device.emit(0x01, report([false, 1920, 1070], [true, 0, 0], 0x22));
    device.emit(0x01, report([false, 1920, 1070], [true, 0, 0], 0x0c | 0x30));
    expect(pad.log).toEqual([
      ["touch", 1, 0, true, 1, 1],
      ["touch", 1, 1, true, 0, 0],
      ["battery", 1, 0.95, false],
      ["touch", 1, 0, false, 1, 1],
      ["battery", 1, 1, false], // full
      ["battery", 1, -1, false], // unknown status
    ]);
  });

  it("DualSense Bluetooth: the same, one byte in", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x31]);
    const pad = await startDriver(dualSense, device);
    const b = dualSenseState(bytes(77), 1, { time: 1000 });
    putTouch(b, 33, false, 0, 0);
    putTouch(b, 37, true, 480, 107);
    b[53] = 0x02;
    device.emit(0x31, sealInput(0x31, b));
    expect(pad.touches.get("1:1")).toEqual([true, 0.25, 0.1]);
    expect(pad.batteries.get(1)).toEqual([0.25, false]);
  });

  it("DualShock 4 USB and Bluetooth: touch normalized by 1920 × 920 (clamped), battery with the cable bit", async () => {
    const usb = new FakeDevice(0x054c, 0x09cc, [0x05]);
    const pad = await startDriver(dualShock4, usb);
    const b = dualShock4State(bytes(63), 0);
    putTouch(b, 34, true, 960, 460);
    putTouch(b, 38, true, 1920, 943);
    b[29] = 0x08; // on battery, level 8
    usb.emit(0x01, b);
    expect(pad.touches.get("1:0")).toEqual([true, 0.5, 0.5]);
    expect(pad.touches.get("1:1")).toEqual([true, 1, 1]);
    expect(pad.batteries.get(1)).toEqual([0.85, false]);
    b[29] = 0x10 | 0x03; // on the cable, charging
    usb.emit(0x01, b);
    expect(pad.batteries.get(1)).toEqual([0.35, true]);
    b[29] = 0x10 | 0x0b; // on the cable, full
    usb.emit(0x01, b);
    expect(pad.batteries.get(1)).toEqual([1, false]);

    const bt = new FakeDevice(0x054c, 0x05c4, [0x11]);
    const pad2 = await startDriver(dualShock4, bt);
    const r = dualShock4State(bytes(77), 2);
    r[0] = 0xc0;
    putTouch(r, 36, true, 192, 92);
    putTouch(r, 40, false, 0, 0);
    r[31] = 0x05;
    bt.emit(0x11, sealInput(0x11, r));
    expect(pad2.touches.get("1:0")).toEqual([true, 0.1, 0.1]);
    expect(pad2.batteries.get(1)).toEqual([0.55, false]);
  });
});

/** Six 12-bit values packed into nine bytes, as the Switch's SPI calibration stores them. */
function pack12(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i += 2) {
    const [a, c] = [values[i], values[i + 1]];
    out.push(a & 0xff, ((a >> 8) & 0x0f) | ((c & 0x0f) << 4), c >> 4);
  }
  return out;
}

/** A Switch Pro controller that answers the handshake and subcommands, with SPI flash contents. */
function fakeSwitch(usb: boolean, product = 0x2009) {
  const spi = new Map<number, number>();
  const write = (address: number, data: number[]) => data.forEach((v, i) => spi.set(address + i, v));
  // Factory sticks: left (max above, centre, min below), right (centre, min, max).
  write(0x603d, [...pack12([1500, 1500, 2000, 2100, 1400, 1400]), ...pack12([2048, 2048, 1500, 1500, 1500, 1500])]);
  // Factory IMU: accelerometer origin 0 and coefficient 16384; gyro origin 10, 20, 30 with coefficients 13371 above.
  const imu: number[] = [];
  [0, 0, 0, 16384, 16384, 16384, 10, 20, 30, 13381, 13391, 13401].forEach((v, i) => put16(imu, i * 2, v));
  write(0x6020, imu);
  const reply: Reply = (id, data, device) => {
    if (id === 0x80 && data[0] !== 0x04) {
      queueMicrotask(() => device.emit(0x81, bytes(63, { 0: data[0] })));
    } else if (id === 0x01) {
      const r = bytes(48, { 12: 0x80, 13: data[9] });
      if (data[9] === 0x10) {
        const address = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
        r.set(data.subarray(10, 15), 14);
        for (let i = 0; i < data[14]; i++) r[19 + i] = spi.get(address + i) ?? 0xff;
      }
      queueMicrotask(() => device.emit(0x21, r));
    }
  };
  return new FakeDevice(0x057e, product, usb ? [0x01, 0x10, 0x80] : [0x01, 0x10], {}, reply, "Pro Controller");
}

/** A Switch full report (0x30): A, capture, d-pad up, ZL; sticks raw; IMU sample 0. */
function switchState(left: [number, number], right: [number, number], imu: { accel?: number[]; gyro?: number[] } = {}) {
  const b = bytes(48, { 2: 0x08, 3: 0x20, 4: 0x02 | 0x80 });
  const stick = (o: number, [x, y]: [number, number]) => b.set([x & 0xff, ((x >> 8) & 0x0f) | ((y & 0x0f) << 4), y >> 4], o);
  stick(5, left);
  stick(8, right);
  (imu.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, 12 + i * 2, v));
  (imu.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, 18 + i * 2, v));
  return b;
}

describe("Switch Pro Controller (switchPro.ts)", () => {
  it("USB: the handshake, calibration reads, vibration, full reports and player lights, in order", async () => {
    const device = fakeSwitch(true);
    const pad = await startDriver(switchPro, device, 2);
    expect(pad.infos[0]).toMatchObject({ name: "Pro Controller", family: "switch", sensors: true, rumble: true, led: false });
    const steps = device.sent.map((s) => (s.id === 0x80 ? `usb ${s.data[0]}` : s.id === 0x01 ? `sub ${s.data[9].toString(16)}` : `report ${s.id}`));
    expect(steps).toEqual(["usb 2", "usb 3", "usb 2", "usb 4", "sub 10", "sub 10", "sub 10", "sub 10", "sub 48", "sub 3", "sub 30", "usb 4"]);
    const subs = device.sent.filter((s) => s.id === 0x01);
    expect(subs[0].data.length).toBe(63);
    expect([...subs[0].data.subarray(10, 15)]).toEqual([0x3d, 0x60, 0, 0, 18]); // SPI read: address, size
    expect([...subs[0].data.subarray(1, 9)]).toEqual([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]); // neutral rumble
    expect(subs.map((s) => s.data[0])).toEqual([0, 1, 2, 3, 4, 5, 6]); // packet counter
    expect(subs[5].data[10]).toBe(0x30);
    expect(subs[6].data[10]).toBe(0x7); // third slot: three lights
  });

  it("reports buttons by position, calibrated sticks (+Y down on the wire) and the IMU in SDL's axes", async () => {
    const device = fakeSwitch(true);
    const pad = await startDriver(switchPro, device);
    device.emit(0x30, switchState([3500, 1400], [2048, 2048]));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([b(1), b(0), b(17), b(12), b(6), b(7)]).toEqual([1, 0, 1, 1, 1, 0]); // A is buttonEast; capture is misc1
    expect(pad.axes.get("1:0")).toBe(1);
    expect(pad.axes.get("1:1")).toBeCloseTo(0.5, 5); // 700 below a 2100 centre with a 1400 range: half down
    expect(pad.axes.get("1:2") ?? 0).toBe(0);
    expect(pad.sensors.size).toBe(0);
    pad.driver.output.setSensors(true);
    await tick();
    const enable = device.sent.filter((s) => s.id === 0x01).pop()!.data;
    expect([enable[9], enable[10]]).toEqual([0x40, 1]);
    device.emit(0x30, switchState([2000, 2100], [2048, 2048], { accel: [0, 0, 4096], gyro: [10 + 1337, 20, 30 - 1337] }));
    const accel = pad.sensors.get("1:accel")!;
    [0, 0, 0].forEach((_, i) => expect(accel[i]).toBeCloseTo([0, G, 0][i], 4)); // z up on the pad is +Y
    const gyro = pad.sensors.get("1:gyro")!;
    const dps = (1337 * 936) / 13371;
    expect(gyro[0]).toBeCloseTo(0, 6);
    expect(gyro[1]).toBeCloseTo(-dps * RAD, 4);
    expect(gyro[2]).toBeCloseTo(-dps * RAD, 4);
  });

  it("Bluetooth: no handshake, 48-byte reports; reports the battery on change", async () => {
    const device = fakeSwitch(false);
    const pad = await startDriver(switchPro, device);
    expect(device.sent.some((s) => s.id === 0x80)).toBe(false);
    expect(device.sent[0].data.length).toBe(48);
    const report = switchState([2000, 2100], [2048, 2048]);
    report[1] = 0x60; // level 6 of 8, on battery
    device.emit(0x30, report);
    expect(pad.batteries.get(1)).toEqual([0.75, false]);
    pad.log.length = 0;
    device.emit(0x30, report);
    expect(pad.log).toEqual([]);
    report[1] = 0x50; // level 4, charging
    device.emit(0x30, report);
    report[1] = 0x90; // level 8 on the charger: full, not charging
    device.emit(0x30, report);
    expect(pad.log).toEqual([
      ["battery", 1, 0.5, true],
      ["battery", 1, 1, false],
    ]);
  });
});

describe("Switch HD rumble (nintendo.ts, through switchPro.ts)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const rumbles = (device: FakeDevice) => device.sent.filter((s) => s.id === 0x10).map((s) => [...s.data.subarray(1, 9)]);
  const both = (block: number[]) => [...block, ...block];
  const NEUTRAL = [0x00, 0x01, 0x40, 0x40];

  it("encodes strengths through SDL's amplitude table at SDL's band frequencies (0x74 high, 0x3d low)", async () => {
    const device = fakeSwitch(false);
    const pad = await startDriver(switchPro, device);
    vi.useFakeTimers();
    pad.driver.output.rumble(1, 1, 1000);
    vi.advanceTimersByTime(30);
    pad.driver.output.rumble(0, 0.5, 1000); // 32768: step 68 of 100 (up to 32861): high band 0x88
    vi.advanceTimersByTime(30);
    pad.driver.output.rumble(0.5, 0, 1000); // low band: 0x40 + 68 / 2
    vi.advanceTimersByTime(30);
    pad.driver.output.rumble(0.0078, 0, 1000); // 511: step 1 (up to 514), odd so bit 15: 0x8040
    expect(rumbles(device)).toEqual([both([0x74, 0xc8, 0x3d, 0x72]), both([0x74, 0x88, 0x3d, 0x40]), both([0x74, 0x00, 0x3d, 0x62]), both([0x74, 0x00, 0xbd, 0x40])]);
    pad.driver.stop();
  });

  it("writes at most once per 30 ms (the strongest request in between wins, a stop follows), re-sends every 50 ms while playing, and stops", async () => {
    const device = fakeSwitch(false);
    const pad = await startDriver(switchPro, device);
    vi.useFakeTimers();
    const out = pad.driver.output;
    out.rumble(0, 0.25, 1000);
    out.rumble(0, 1, 1000); // within 30 ms: waits
    out.rumble(0, 0.5, 1000); // weaker than the one waiting
    out.rumble(0, 0, 0); // and then a stop
    expect(rumbles(device).length).toBe(1);
    vi.advanceTimersByTime(29);
    expect(rumbles(device).length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(rumbles(device)[1]).toEqual(both([0x74, 0xc8, 0x3d, 0x40]));
    vi.advanceTimersByTime(30);
    expect(rumbles(device)[2]).toEqual(both(NEUTRAL));
    vi.advanceTimersByTime(500);
    expect(rumbles(device).length).toBe(3); // stopped: no refresh

    // A long rumble is re-sent every 50 ms until its duration ends.
    out.rumble(1, 0, 120);
    vi.advanceTimersByTime(110);
    expect(rumbles(device).length).toBe(3 + 3); // at 0, 50, 100
    vi.advanceTimersByTime(10);
    expect(rumbles(device).length).toBe(6); // over, but the refresh at 100 holds the stop back to 130
    vi.advanceTimersByTime(10);
    expect(rumbles(device).at(-1)).toEqual(both(NEUTRAL));
    vi.advanceTimersByTime(500);
    expect(rumbles(device).length).toBe(7);

    // Stopping the driver silences the pad and leaves no timers.
    out.rumble(1, 1, 10_000);
    vi.advanceTimersByTime(60);
    pad.driver.stop();
    expect(rumbles(device).at(-1)).toEqual(both(NEUTRAL));
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A Joy-Con full report (0x30): button bytes, its stick raw, the battery byte, IMU sample 0. */
function joyConState(side: "left" | "right", s: { right?: number; shared?: number; left?: number; stick?: [number, number]; battery?: number; accel?: number[]; gyro?: number[] } = {}) {
  const b = bytes(48, { 1: s.battery ?? 0x80, 2: s.right ?? 0, 3: s.shared ?? 0, 4: s.left ?? 0 });
  const [x, y] = s.stick ?? (side === "left" ? [2000, 2100] : [2048, 2048]);
  b.set([x & 0xff, ((x >> 8) & 0x0f) | ((y & 0x0f) << 4), y >> 4], side === "left" ? 5 : 8);
  (s.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, 12 + i * 2, v));
  (s.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, 18 + i * 2, v));
  return b;
}

/** Degrees per second of a 1337-step gyro reading through the fake's calibration. */
const DPS = (1337 * 936) / 13371;

describe("Joy-Cons (joyCon.ts)", () => {
  it("one left Joy-Con is a sideways mini pad: buttons by position, the stick and motion turned", async () => {
    const device = fakeSwitch(false, JOYCON_LEFT);
    const pad = await startDriver(joyCons(), device);
    expect(pad.infos[0]).toMatchObject({ name: "Joy-Con (L)", family: "switch", product: JOYCON_LEFT, sensors: true, rumble: true });
    expect(device.sent.filter((s) => s.id === 0x01).map((s) => s.data[9])).toEqual([0x10, 0x10, 0x10, 0x10, 0x48, 0x03, 0x30]); // the Pro's setup
    // D-pad left (south when held sideways), SL (left shoulder), L (paddle), capture (home); stick pushed along its +X.
    device.emit(0x30, joyConState("left", { left: 0x08 | 0x20 | 0x40, shared: 0x20, stick: [3500, 2100], battery: 0x46 }));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([b(0), b(1), b(4), b(5), b(19), b(16), b(12)]).toEqual([1, 0, 1, 0, 1, 1, 0]);
    expect(pad.axes.get("1:0") ?? 0).toBeCloseTo(0, 6);
    expect(pad.axes.get("1:1")).toBe(-1); // the stick's +X points up when held sideways
    expect(pad.batteries.get(1)).toEqual([0.5, false]);
    pad.driver.output.setSensors(true);
    await tick();
    device.emit(0x30, joyConState("left", { accel: [0, 0, 4096], gyro: [10 + 1337, 20, 30] }));
    const gyro = pad.sensors.get("1:gyro")!.map((v) => v / RAD);
    expect(gyro[0]).toBeCloseTo(-DPS, 3);
    expect(gyro[1]).toBeCloseTo(0, 6);
    expect(gyro[2]).toBeCloseTo(0, 6);
    expect(pad.sensors.get("1:accel")![1]).toBeCloseTo(G, 4);
  });

  it("one right Joy-Con: A south, SR right shoulder, R/ZR paddles, the stick turned the other way", async () => {
    const device = fakeSwitch(false, JOYCON_RIGHT);
    const pad = await startDriver(joyCons(), device);
    expect(pad.infos[0]).toMatchObject({ name: "Joy-Con (R)", product: JOYCON_RIGHT });
    device.emit(0x30, joyConState("right", { right: 0x08 | 0x10 | 0x80, shared: 0x02 | 0x10, stick: [2048 + 1500, 2048] }));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([b(0), b(5), b(20), b(9), b(16), b(4)]).toEqual([1, 1, 1, 1, 1, 0]);
    expect(pad.axes.get("1:1")).toBe(1);
    pad.driver.output.setSensors(true);
    await tick();
    device.emit(0x30, joyConState("right", { accel: [0, 0, 4096], gyro: [10 + 1337, 20, 30] }));
    expect(pad.sensors.get("1:gyro")![0]).toBeCloseTo(DPS * RAD, 4);
    expect(pad.sensors.get("1:accel")![1]).toBeCloseTo(-G, 4); // the right Joy-Con's sensor is turned round
    pad.driver.output.rumble(0.5, 1, 100);
    expect([...device.last(0x10).subarray(1, 5)]).toEqual([0x74, 0xc8, 0x3d, 0x62]); // alone, it plays both bands
    pad.driver.stop();
  });
});
/** A fake `navigator.hid` with granted devices and a chooser that picks `chooser`. */
function fakeHid(granted: FakeDevice[], chooser: FakeDevice[] | Error = []) {
  const listeners = { connect: new Set<(e: HidConnectionEvent) => void>(), disconnect: new Set<(e: HidConnectionEvent) => void>() };
  const filters: HidDeviceFilter[][] = [];
  const hid: Hid = {
    getDevices: async () => granted,
    requestDevice: async ({ filters: f }) => {
      filters.push(f);
      if (chooser instanceof Error) throw chooser;
      return chooser;
    },
    addEventListener: (type, l) => listeners[type].add(l),
    removeEventListener: (type, l) => listeners[type].delete(l),
  };
  const fire = (type: "connect" | "disconnect", device: FakeDevice) => listeners[type].forEach((l) => l({ device }));
  return { hid, fire, filters, listeners };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const sonyPad = (index: number) =>
  ({ index, id: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", mapping: "standard", connected: true, buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })), axes: [0, 0, 0, 0], timestamp: 0 }) as unknown as Gamepad;
const xboxPad = (index: number) =>
  ({ index, id: "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)", mapping: "standard", connected: true, buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })), axes: [0, 0, 0, 0], timestamp: 0 }) as unknown as Gamepad;

describe("the WebHID adapter (webHidGamepads.ts)", () => {
  it("doesn't exist without navigator.hid; Input.requestHidGamepads resolves 0 there", async () => {
    expect(webHidGamepads(recorder().sink, { getGamepads: () => [] } as unknown as Navigator)).toBeNull();
    await expect(Input.requestHidGamepads()).resolves.toBe(0);
  });

  it("reopens granted devices, reports them under its own ids, and the Gamepad API skips them until they go", async () => {
    const ds = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const other = new FakeDevice(0x1234, 0x5678, []); // granted but not a controller it knows
    const { hid, fire } = fakeHid([ds, other]);
    const rec = recorder();
    const pads = [sonyPad(0), xboxPad(1)];
    const nav = { hid, getGamepads: () => pads, userAgent: "Linux" } as unknown as Navigator;
    const adapter = webHidGamepads(rec.sink, nav)!;
    await settle();
    expect(ds.opened && !other.opened).toBe(true);
    const id = rec.infos[0].id;
    expect(id).toBeGreaterThanOrEqual(0x4000);
    expect(rec.infos[0].family).toBe("playstation");
    ds.emit(0x01, dualSenseState(bytes(63), 0));
    expect(rec.buttons.get(`${id}:0`)).toBe(1);

    // The Gamepad API adapter, skipping what WebHID owns: only the Xbox pad.
    const web = webGamepads(rec.sink, nav, (p) => adapter.owns(p))!;
    web.poll();
    await loadInputMapping();
    await tick();
    rec.log.length = 0;
    web.poll();
    expect(rec.log.filter((e) => e[0] === "connect")).toEqual([["connect", 1, "xbox"]]);

    // Unplugged from WebHID (or failed): the Gamepad API reports the DualSense again.
    rec.log.length = 0;
    fire("disconnect", ds);
    web.poll();
    expect(rec.log).toEqual([["disconnect", id], ["connect", 0, "playstation"]]);
    web.stop();
    adapter.stop();
  });

  it("with two identical pads and one opened over WebHID, the Gamepad API skips only the first", async () => {
    const ds = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const { hid } = fakeHid([ds]);
    const pads = [sonyPad(0), sonyPad(1)];
    const adapter = webHidGamepads(recorder().sink, { hid, getGamepads: () => pads } as unknown as Navigator)!;
    await settle();
    expect([adapter.owns(pads[0]), adapter.owns(pads[1]), adapter.owns(xboxPad(2))]).toEqual([true, false, false]);
    adapter.stop();
  });

  it("routes output: its pads' to their drivers, others' to the Gamepad API's", async () => {
    const ds4 = new FakeDevice(0x054c, 0x05c4, [0x05]);
    const { hid } = fakeHid([ds4]);
    const rec = recorder();
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => [] } as unknown as Navigator)!;
    await settle();
    const id = rec.infos[0].id;
    const calls: unknown[][] = [];
    const fallback: GamepadOutput = {
      rumble: (...a) => calls.push(["rumble", ...a]),
      setLed: (...a) => calls.push(["led", ...a]),
      triggerEffect: (...a) => calls.push(["effect", ...a]),
    };
    const output = adapter.output(fallback);
    output.setLed!(id, 1, 2, 3);
    expect([...ds4.last(0x05).subarray(5, 8)]).toEqual([1, 2, 3]);
    output.rumble(0, 1, 1, 100);
    output.setLed!(0, 9, 9, 9);
    output.triggerEffect!(0, "left", { mode: "off" });
    output.triggerEffect!(id, "left", { mode: "off" }); // a DualShock 4 has no adaptive triggers: nothing happens
    expect(calls).toEqual([["rumble", 0, 1, 1, 100], ["led", 0, 9, 9, 9], ["effect", 0, "left", { mode: "off" }]]);
    adapter.stop();
  });

  it("request(): the chooser lists the supported controllers; picked ones open; a refusal resolves 0", async () => {
    const pro = fakeSwitch(false);
    const { hid, filters } = fakeHid([], [pro]);
    const rec = recorder();
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => [] } as unknown as Navigator)!;
    await expect(adapter.request()).resolves.toBe(1);
    expect(filters[0]).toEqual([
      { vendorId: 0x054c, productId: 0x0ce6 },
      { vendorId: 0x054c, productId: 0x0df2 },
      { vendorId: 0x054c, productId: 0x05c4 },
      { vendorId: 0x054c, productId: 0x09cc },
      { vendorId: 0x054c, productId: 0x0ba0 },
      { vendorId: 0x057e, productId: 0x2009 },
      { vendorId: 0x057e, productId: 0x2006 },
      { vendorId: 0x057e, productId: 0x2007 },
    ]);
    expect(rec.infos.map((i) => i.family)).toEqual(["switch"]);
    adapter.stop();
    expect(pro.opened).toBe(false);
    expect(rec.log[rec.log.length - 1]).toEqual(["disconnect", rec.infos[0].id]);

    const refused = fakeHid([], new Error("SecurityError: no user gesture"));
    const again = webHidGamepads(rec.sink, { hid: refused.hid, getGamepads: () => [] } as unknown as Navigator)!;
    await expect(again.request()).resolves.toBe(0);
    again.stop();
  });

  it("adopts a granted device plugged in later; one that won't open stays with the Gamepad API", async () => {
    const { hid, fire } = fakeHid([]);
    const rec = recorder();
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => [sonyPad(0)] } as unknown as Navigator)!;
    const locked = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    locked.failOpen = true;
    const warn = console.warn;
    console.warn = () => {};
    fire("connect", locked);
    await settle();
    console.warn = warn;
    expect(rec.infos).toEqual([]);
    expect(adapter.owns(sonyPad(0))).toBe(false);
    const ds = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    fire("connect", ds);
    await settle();
    expect(rec.infos.length).toBe(1);
    expect(adapter.owns(sonyPad(0))).toBe(true);
    adapter.stop();
  });
});

const joyConPad = (index: number, product: number) =>
  ({ index, id: `Joy-Con (Vendor: 057e Product: ${product.toString(16)})`, mapping: "", connected: true, buttons: [], axes: [], timestamp: 0 }) as unknown as Gamepad;

describe("Joy-Con pairs (joyCon.ts, through webHidGamepads.ts)", () => {
  /** Open a left and a right Joy-Con through the chooser. */
  async function pairUp() {
    const left = fakeSwitch(false, JOYCON_LEFT);
    const right = fakeSwitch(false, JOYCON_RIGHT);
    const { hid, fire } = fakeHid([], [left, right]);
    const rec = recorder();
    const pads = [joyConPad(0, JOYCON_LEFT), joyConPad(1, JOYCON_RIGHT), joyConPad(2, 0x2008)];
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => pads } as unknown as Navigator)!;
    await expect(adapter.request()).resolves.toBe(2);
    return { left, right, fire, rec, pads, adapter };
  }

  /** The pads connected now, from the log. */
  const connectedNow = (log: unknown[][]) => {
    const now = new Set<unknown>();
    for (const e of log) {
      if (e[0] === "connect") now.add(e[1]);
      if (e[0] === "disconnect") now.delete(e[1]);
    }
    return [...now];
  };

  it("a left and a right open together join into one pad under the left's id", async () => {
    const { left, right, rec, pads, adapter } = await pairUp();
    const pair = rec.infos.at(-1)!;
    expect(pair).toMatchObject({ name: "Joy-Con (L/R)", vendor: 0x057e, product: 0x2008, family: "switch" });
    expect(connectedNow(rec.log)).toEqual([pair.id]);
    // Both halves' player lights show the pair's slot.
    const lights = (d: FakeDevice) => d.sent.filter((s) => s.id === 0x01 && s.data[9] === 0x30).at(-1)!.data[10];
    expect([lights(left), lights(right)]).toEqual([0x1, 0x1]);
    // The Gamepad API skips both halves (and Chrome's own L+R pad).
    expect(pads.map((p) => adapter.owns(p))).toEqual([true, true, true]);

    // Laid out like a Pro Controller: the left's d-pad, L, SL; the right's A, ZR and stick.
    left.emit(0x30, joyConState("left", { left: 0x02 | 0x40 | 0x20, shared: 0x01, battery: 0x60 }));
    right.emit(0x30, joyConState("right", { right: 0x08 | 0x80, stick: [2048 + 1500, 2048], battery: 0x40 }));
    const b = (i: number) => rec.buttons.get(`${pair.id}:${i}`) ?? 0;
    expect([b(12), b(4), b(19), b(8), b(1), b(7), b(0)]).toEqual([1, 1, 1, 1, 1, 1, 0]);
    expect(rec.axes.get(`${pair.id}:2`)).toBe(1);
    expect(rec.batteries.get(pair.id)).toEqual([0.5, false]); // the lower of the two

    // Rumble: low band on the left, high band on the right.
    const output = adapter.output(null);
    output.rumble(pair.id, 0.5, 1, 100);
    expect([...left.last(0x10).subarray(1, 5)]).toEqual([0x74, 0x00, 0x3d, 0x62]);
    expect([...right.last(0x10).subarray(1, 5)]).toEqual([0x74, 0xc8, 0x3d, 0x40]);

    // Motion: the right Joy-Con's, in the combined (upright) axes.
    output.setSensors!(pair.id, true);
    await tick();
    const imuOn = (d: FakeDevice) => d.sent.some((s) => s.id === 0x01 && s.data[9] === 0x40 && s.data[10] === 1);
    expect([imuOn(left), imuOn(right)]).toEqual([false, true]);
    right.emit(0x30, joyConState("right", { accel: [0, 0, 4096], gyro: [10 + 1337, 20, 30] }));
    const gyro = rec.sensors.get(`${pair.id}:gyro`)!;
    expect(gyro[2]).toBeCloseTo(-DPS * RAD, 4);
    expect(rec.sensors.get(`${pair.id}:accel`)![1]).toBeCloseTo(-G, 4);
    output.rumble(pair.id, 0, 0, 0);
    adapter.stop();
    expect(connectedNow(rec.log)).toEqual([]);
  });

  it("when the right goes, the left becomes a mini pad under the same id; when the left goes, the right gets its own", async () => {
    const { left, right, fire, rec, pads, adapter } = await pairUp();
    const pairId = rec.infos.at(-1)!.id;
    rec.log.length = 0;
    fire("disconnect", right);
    expect(rec.log).toEqual([
      ["disconnect", pairId],
      ["connect", pairId, "switch"],
    ]);
    expect(rec.infos.at(-1)).toMatchObject({ name: "Joy-Con (L)", product: JOYCON_LEFT });
    expect(pads.map((p) => adapter.owns(p))).toEqual([true, false, false]);
    left.emit(0x30, joyConState("left", { left: 0x08 }));
    expect(rec.buttons.get(`${pairId}:0`)).toBe(1); // mini layout again

    // The right comes back: they join again.
    fire("connect", right);
    await settle();
    expect(rec.infos.at(-1)).toMatchObject({ name: "Joy-Con (L/R)", id: pairId });
    expect(connectedNow(rec.log)).toEqual([pairId]);

    rec.log.length = 0;
    fire("disconnect", left);
    const rightId = rec.infos.at(-1)!.id;
    expect(rec.infos.at(-1)).toMatchObject({ name: "Joy-Con (R)", product: JOYCON_RIGHT });
    expect(rightId).not.toBe(pairId);
    expect(connectedNow([["connect", pairId], ...rec.log])).toEqual([rightId]);
    adapter.stop();
  });
});
